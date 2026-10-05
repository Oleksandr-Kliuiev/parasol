using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;
using Crm.Licensing.Contracts;
using Microsoft.Extensions.Options;

namespace Crm.Integrations.PartnerCenter;

public sealed record PcCustomer(string CustomerId, string Name, string? Domain, string? TenantId, string? OrganizationNumber);

public sealed class PartnerCenterApiException(HttpStatusCode status, string message) : Exception(message)
{
    public HttpStatusCode Status { get; } = status;
}

/// <summary>Licences of one SKU in a customer tenant as Partner Center reports them (FR-LIC-03).</summary>
public sealed record PcSubscribedSku(string SkuId, string SkuPartNumber, int Purchased, int Assigned);

/// <summary>An invoice Microsoft sent the partner; the billing export is requested per invoice (FR-LIC-04).</summary>
public sealed record PcInvoice(string Id, DateOnly? InvoiceDate, string? Currency, decimal Total);

/// <summary>
/// The licence reading of one tenant. <paramref name="Limitation"/> is set when the tenant could not be read at all (no GDAP
/// relationship, expired or without the role): that is a visible limitation of the run, not an empty tenant.
/// </summary>
public sealed record PcSkuReading(IReadOnlyList<PcSubscribedSku> Skus, string? Limitation = null)
{
    public static PcSkuReading Limited(string reason) => new([], reason);
}

public interface IPartnerCenterClient
{
    IAsyncEnumerable<PcCustomer> GetCustomersAsync(CancellationToken cancellationToken);

    /// <summary>Subscriptions of one CSP customer, already mapped to the CRM vocabulary.</summary>
    Task<IReadOnlyList<ExternalSubscription>> GetSubscriptionsAsync(PcCustomer customer, CancellationToken cancellationToken);

    /// <summary>
    /// "Bought / assigned" per SKU in the customer's tenant, read through the GDAP relationship (FR-LIC-03). A customer without
    /// a live GDAP relationship answers 401/403/404: the reading carries that as a limitation, never as an empty tenant.
    /// </summary>
    Task<PcSkuReading> GetSubscribedSkusAsync(PcCustomer customer, CancellationToken cancellationToken);

    /// <summary>The partner's own invoices, newest first, so the reconciliation knows which exports to ask for.</summary>
    Task<IReadOnlyList<PcInvoice>> GetInvoicesAsync(CancellationToken cancellationToken);
}

/// <summary>Exchanges the service account's refresh token for Partner Center access tokens and caches them until they expire.</summary>
internal sealed class PartnerCenterTokenProvider(HttpClient http, IOptions<PartnerCenterOptions> options, TimeProvider time) : IDisposable
{
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly Dictionary<string, (string Token, DateTimeOffset ExpiresAt)> _tokens = new(StringComparer.OrdinalIgnoreCase);

    public const string PartnerCenterResource = "https://api.partnercenter.microsoft.com";
    public const string GraphResource = "https://graph.microsoft.com";

    public async Task<string> GetTokenAsync(CancellationToken cancellationToken) =>
        await GetTokenAsync(PartnerCenterResource, cancellationToken);

    /// <summary>The same service account is used for Partner Center and for the billing export in Graph; each audience caches its own token.</summary>
    public async Task<string> GetTokenAsync(string resource, CancellationToken cancellationToken)
    {
        var now = time.GetUtcNow();
        if (_tokens.TryGetValue(resource, out var cached) && cached.ExpiresAt > now.AddMinutes(1))
        {
            return cached.Token;
        }

        await _gate.WaitAsync(cancellationToken);
        try
        {
            if (_tokens.TryGetValue(resource, out var stored) && stored.ExpiresAt > time.GetUtcNow().AddMinutes(1))
            {
                return stored.Token;
            }

            var o = options.Value;
            using var request = new HttpRequestMessage(HttpMethod.Post, o.EffectiveTokenUrl)
            {
                Content = new FormUrlEncodedContent(new Dictionary<string, string>
                {
                    ["grant_type"] = "refresh_token",
                    ["client_id"] = o.ClientId ?? string.Empty,
                    ["client_secret"] = o.ClientSecret ?? string.Empty,
                    ["refresh_token"] = o.RefreshToken ?? string.Empty,
                    ["resource"] = resource,
                    ["scope"] = "openid",
                }),
            };
            using var response = await http.SendAsync(request, cancellationToken);
            var body = await response.Content.ReadAsStringAsync(cancellationToken);
            if (!response.IsSuccessStatusCode)
            {
                throw new PartnerCenterApiException(response.StatusCode, $"Partner Center token request failed: {Trim(body)}");
            }

            using var document = JsonDocument.Parse(body);
            var accessToken = (document.RootElement.TryGetProperty("access_token", out var token) ? token.GetString() : null)
                              ?? throw new PartnerCenterApiException(response.StatusCode, "Partner Center returned no access token.");
            var seconds = document.RootElement.TryGetProperty("expires_in", out var expires) && expires.ValueKind == JsonValueKind.String
                ? long.Parse(expires.GetString()!, CultureInfo.InvariantCulture)
                : expires.ValueKind == JsonValueKind.Number ? expires.GetInt64() : 3600;
            _tokens[resource] = (accessToken, time.GetUtcNow().AddSeconds(seconds));
            return accessToken;
        }
        finally
        {
            _gate.Release();
        }
    }

    public void Dispose() => _gate.Dispose();

    private static string Trim(string body) => body.Length > 300 ? body[..300] : body;
}

internal sealed class PartnerCenterAuthHandler(PartnerCenterTokenProvider tokens) : DelegatingHandler
{
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", await tokens.GetTokenAsync(cancellationToken));
        request.Headers.TryAddWithoutValidation("MS-CorrelationId", Guid.NewGuid().ToString());
        return await base.SendAsync(request, cancellationToken);
    }
}

/// <summary>
/// Partner Center REST client (docs/05 §2.3). Only reads. Fields are read defensively: the shapes differ between the direct and
/// indirect models, and the contract is confirmed in the PoC with the company's credentials.
/// </summary>
internal sealed class PartnerCenterClient(HttpClient http, IOptions<PartnerCenterOptions> options) : IPartnerCenterClient
{
    /// <summary>Pages read at most from one list; reaching it is an error, because stopping there would drop the rest unseen.</summary>
    internal const int MaxPages = 1000;

    public async IAsyncEnumerable<PcCustomer> GetCustomersAsync([System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken cancellationToken)
    {
        var size = Math.Clamp(options.Value.PageSize, 1, 500);
        await foreach (var item in ReadItemsAsync($"v1/customers?size={size}", allowNotFound: false, cancellationToken))
        {
            if (ReadCustomer(item) is { } customer)
            {
                yield return customer;
            }
        }
    }

    public async Task<IReadOnlyList<ExternalSubscription>> GetSubscriptionsAsync(PcCustomer customer, CancellationToken cancellationToken)
    {
        var result = new List<ExternalSubscription>();
        await foreach (var item in ReadItemsAsync($"v1/customers/{customer.CustomerId}/subscriptions", allowNotFound: true, cancellationToken))
        {
            if (ReadSubscription(item, customer) is { } subscription)
            {
                result.Add(subscription);
            }
        }

        return result;
    }

    /// <summary>
    /// Every item of a list, following the continuation token (request header <c>MS-ContinuationToken</c>, answered in the body,
    /// in <c>links.next</c> or in the response header) until Partner Center stops sending one. A list longer than
    /// <see cref="MaxPages"/> pages, or a token that does not move, fails the read: a silent cut-off would look like a complete list.
    /// </summary>
    private async IAsyncEnumerable<JsonElement> ReadItemsAsync(
        string url, bool allowNotFound, [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken cancellationToken)
    {
        string? continuation = null;
        var seenTokens = new HashSet<string>(StringComparer.Ordinal);
        for (var page = 0; page < MaxPages; page++)
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, url);
            if (continuation is not null)
            {
                request.Headers.TryAddWithoutValidation("MS-ContinuationToken", continuation);
            }

            using var response = await http.SendAsync(request, cancellationToken);
            if (allowNotFound && response.StatusCode == HttpStatusCode.NotFound)
            {
                yield break;
            }

            await EnsureSuccessAsync(response, cancellationToken);
            using var document = await JsonDocument.ParseAsync(await response.Content.ReadAsStreamAsync(cancellationToken), cancellationToken: cancellationToken);
            var root = document.RootElement;
            if (root.ValueKind == JsonValueKind.Object && root.TryGetProperty("items", out var items) && items.ValueKind == JsonValueKind.Array)
            {
                foreach (var item in items.EnumerateArray())
                {
                    yield return item.Clone();
                }
            }

            continuation = ContinuationOf(root, response);
            if (string.IsNullOrEmpty(continuation))
            {
                yield break;
            }

            if (!seenTokens.Add(continuation))
            {
                throw new PartnerCenterApiException(HttpStatusCode.OK, $"Partner Center repeated a continuation token for {PathOf(url)}; the list cannot be read completely.");
            }
        }

        throw new PartnerCenterApiException(HttpStatusCode.OK, $"Partner Center list {PathOf(url)} has more than {MaxPages} pages; it was not read completely.");
    }

    internal static string? ContinuationOf(JsonElement root, HttpResponseMessage response)
    {
        if (root.ValueKind == JsonValueKind.Object)
        {
            if (root.TryGetProperty("continuationToken", out var token) && token.ValueKind == JsonValueKind.String && token.GetString() is { Length: > 0 } fromBody)
            {
                return fromBody;
            }

            if (root.TryGetProperty("links", out var links) && links.ValueKind == JsonValueKind.Object &&
                links.TryGetProperty("next", out var next) && next.ValueKind == JsonValueKind.Object &&
                next.TryGetProperty("headers", out var headers) && headers.ValueKind == JsonValueKind.Array)
            {
                foreach (var header in headers.EnumerateArray())
                {
                    if (header.TryGetProperty("key", out var key) && string.Equals(key.GetString(), "MS-ContinuationToken", StringComparison.OrdinalIgnoreCase) &&
                        header.TryGetProperty("value", out var value) && value.GetString() is { Length: > 0 } fromLink)
                    {
                        return fromLink;
                    }
                }
            }
        }

        return response.Headers.TryGetValues("MS-ContinuationToken", out var values) && values.FirstOrDefault() is { Length: > 0 } fromHeader ? fromHeader : null;
    }

    private static string PathOf(string url) => url.Split('?')[0];

    internal static PcCustomer? ReadCustomer(JsonElement e)
    {
        var id = Text(e, "id") ?? Text(e, "customerId");
        if (id is null)
        {
            return null;
        }

        var company = e.TryGetProperty("companyProfile", out var profile) ? profile : default;
        var billing = e.TryGetProperty("billingProfile", out var billingProfile) ? billingProfile : default;
        var name = (company.ValueKind == JsonValueKind.Object ? Text(company, "companyName") : null)
                   ?? (billing.ValueKind == JsonValueKind.Object ? Text(billing, "companyName") : null)
                   ?? id;
        return new PcCustomer(
            id,
            name,
            company.ValueKind == JsonValueKind.Object ? Text(company, "domain") : null,
            company.ValueKind == JsonValueKind.Object ? Text(company, "tenantId") : null,
            // Norwegian organization number, when the partner keeps it in the billing profile.
            billing.ValueKind == JsonValueKind.Object ? Digits(Text(billing, "companyRegistrationNumber") ?? Text(billing, "organizationNumber")) : null);
    }

    internal static ExternalSubscription? ReadSubscription(JsonElement e, PcCustomer customer)
    {
        var id = Text(e, "id");
        var offerId = Text(e, "offerId");
        if (id is null || offerId is null)
        {
            return null;
        }

        var quantity = Int(e, "quantity") ?? 0;
        return new ExternalSubscription(
            SubscriptionSource.PartnerCenter,
            customer.CustomerId,
            customer.Name,
            customer.TenantId,
            customer.OrganizationNumber,
            id,
            offerId,
            Text(e, "offerName", "friendlyName"),
            Text(e, "productId", "skuId"),
            quantity,
            ParseStatus(Text(e, "status")),
            ParseTerm(Text(e, "termDuration")),
            ParseCycle(Text(e, "billingCycle")),
            Date(e, "creationDate", "effectiveStartDate"),
            Date(e, "commitmentEndDate"),
            Date(e, "commitmentEndDate", "effectiveEndDate"),
            Bool(e, "autoRenewEnabled") ?? Bool(e, "isAutoRenewEnabled") ?? false,
            Timestamp(e, "creationDate"),
            Decimal(e, "unitPrice"),
            null);
    }

    public async Task<PcSkuReading> GetSubscribedSkusAsync(PcCustomer customer, CancellationToken cancellationToken)
    {
        using var response = await http.GetAsync($"v1/customers/{customer.CustomerId}/subscribedskus", cancellationToken);
        if (response.StatusCode is HttpStatusCode.NotFound or HttpStatusCode.Forbidden or HttpStatusCode.Unauthorized)
        {
            // No GDAP relationship, it expired, or it lacks the role: the tenant has no reading today and the run says so.
            return PcSkuReading.Limited(response.StatusCode switch
            {
                HttpStatusCode.NotFound => "tenant not found through GDAP (404)",
                HttpStatusCode.Unauthorized => "no access to the tenant, GDAP relationship missing or expired (401)",
                _ => "no access to the tenant, GDAP relationship missing, expired or without the role (403)",
            });
        }

        await EnsureSuccessAsync(response, cancellationToken);
        using var document = await JsonDocument.ParseAsync(await response.Content.ReadAsStreamAsync(cancellationToken), cancellationToken: cancellationToken);
        if (!document.RootElement.TryGetProperty("items", out var items) || items.ValueKind != JsonValueKind.Array)
        {
            return new PcSkuReading([]);
        }

        return new PcSkuReading(items.EnumerateArray().Select(ReadSubscribedSku).OfType<PcSubscribedSku>().ToList());
    }

    public async Task<IReadOnlyList<PcInvoice>> GetInvoicesAsync(CancellationToken cancellationToken)
    {
        var invoices = new List<PcInvoice>();
        // 403 is a configuration fault (the account may not read invoices) and fails the run; only "no invoices" (404) is empty.
        await foreach (var item in ReadItemsAsync("v1/invoices?size=50", allowNotFound: true, cancellationToken))
        {
            if (ReadInvoice(item) is { } invoice)
            {
                invoices.Add(invoice);
            }
        }

        return invoices.OrderByDescending(i => i.InvoiceDate ?? DateOnly.MinValue).ToList();
    }

    internal static PcInvoice? ReadInvoice(JsonElement e)
    {
        var id = Text(e, "id", "invoiceNumber");
        return id is null
            ? null
            : new PcInvoice(id, Date(e, "invoiceDate", "billingPeriodStartDate"), Text(e, "currencyCode", "currencySymbol"), Decimal(e, "totalCharges") ?? 0m);
    }

    /// <summary>
    /// Partner Center and Graph name these numbers differently (<c>prepaidUnits.enabled</c> vs <c>activeUnits</c>), so both
    /// spellings are accepted; assigned comes from <c>consumedUnits</c>.
    /// </summary>
    internal static PcSubscribedSku? ReadSubscribedSku(JsonElement e)
    {
        var skuPartNumber = Text(e, "skuPartNumber", "productSku");
        var skuId = Text(e, "skuId", "id") ?? skuPartNumber;
        if (skuPartNumber is null || skuId is null)
        {
            return null;
        }

        var prepaid = e.TryGetProperty("prepaidUnits", out var units) && units.ValueKind == JsonValueKind.Object ? units : default;
        var purchased = (prepaid.ValueKind == JsonValueKind.Object ? Int(prepaid, "enabled") : null)
                        ?? Int(e, "activeUnits")
                        ?? Int(e, "totalUnits")
                        ?? 0;
        var assigned = Int(e, "consumedUnits") ?? Int(e, "assignedUnits") ?? 0;
        return new PcSubscribedSku(skuId, skuPartNumber, purchased, assigned);
    }

    private static async Task EnsureSuccessAsync(HttpResponseMessage response, CancellationToken cancellationToken)
    {
        if (response.IsSuccessStatusCode)
        {
            return;
        }

        var body = await response.Content.ReadAsStringAsync(cancellationToken);
        throw new PartnerCenterApiException(response.StatusCode,
            $"Partner Center {(int)response.StatusCode} for {response.RequestMessage?.RequestUri?.AbsolutePath}: {(body.Length > 400 ? body[..400] : body)}");
    }

    private static SubscriptionStatus ParseStatus(string? value) => value?.ToLowerInvariant() switch
    {
        "suspended" => SubscriptionStatus.Suspended,
        "deleted" or "expired" => SubscriptionStatus.Deleted,
        "pending" => SubscriptionStatus.Pending,
        _ => SubscriptionStatus.Active,
    };

    private static SubscriptionTerm ParseTerm(string? value) => value?.ToUpperInvariant() switch
    {
        "P1M" => SubscriptionTerm.P1M,
        "P1Y" => SubscriptionTerm.P1Y,
        "P3Y" => SubscriptionTerm.P3Y,
        _ => SubscriptionTerm.Unknown,
    };

    private static SubscriptionBillingCycle ParseCycle(string? value) => value?.ToLowerInvariant() switch
    {
        "monthly" => SubscriptionBillingCycle.Monthly,
        "annual" or "yearly" => SubscriptionBillingCycle.Annual,
        _ => SubscriptionBillingCycle.Unknown,
    };

    private static string? Text(JsonElement e, params string[] names)
    {
        foreach (var name in names)
        {
            if (e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String &&
                value.GetString() is { Length: > 0 } text)
            {
                return text.Trim();
            }
        }

        return null;
    }

    private static int? Int(JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var number)
            ? number
            : null;

    private static bool? Bool(JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var value) && value.ValueKind is JsonValueKind.True or JsonValueKind.False
            ? value.GetBoolean()
            : null;

    private static decimal? Decimal(JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number && value.TryGetDecimal(out var number)
            ? number
            : null;

    private static DateOnly? Date(JsonElement e, params string[] names) =>
        Timestamp(e, names) is { } timestamp ? DateOnly.FromDateTime(timestamp.UtcDateTime) : null;

    private static DateTimeOffset? Timestamp(JsonElement e, params string[] names) =>
        Text(e, names) is { } text && DateTimeOffset.TryParse(text, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var parsed) ? parsed : null;

    private static string? Digits(string? value)
    {
        var digits = new string((value ?? string.Empty).Where(char.IsAsciiDigit).ToArray());
        return digits.Length == 9 ? digits : null;
    }
}
