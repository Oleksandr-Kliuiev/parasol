using System.Globalization;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Crm.Licensing.Contracts;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Crm.Integrations.PartnerCenter;

public interface IPartnerBillingClient
{
    bool IsEnabled { get; }

    /// <summary>
    /// What Microsoft charged the partner on one invoice (FR-LIC-04). The export is asynchronous: it is requested, polled
    /// until it succeeds, and then read from the manifest's blobs.
    /// </summary>
    Task<IReadOnlyList<ExternalBilledLine>> GetBilledLinesAsync(string invoiceId, CancellationToken cancellationToken);
}

/// <summary>
/// Microsoft partner billing reconciliation through Graph (docs/05 §2.4): <c>POST …/billed/export</c> → poll the operation →
/// read the manifest → download the line files. Only the fields the CRM compares are kept. Every link after the first request
/// comes from Microsoft's answers and goes through <see cref="PartnerBillingLinks"/>: the Graph token only to the Graph origin.
/// </summary>
internal sealed class PartnerBillingClient(
    HttpClient http,
    PartnerCenterTokenProvider tokens,
    IOptions<PartnerCenterOptions> options,
    TimeProvider time,
    ILogger<PartnerBillingClient> logger) : IPartnerBillingClient
{
    /// <summary>The export takes minutes for a large partner; polling stops well before a job would look hung.</summary>
    private const int MaxPolls = 60;

    public bool IsEnabled => options.Value.IsConfigured && options.Value.BillingReconciliationEnabled;

    public async Task<IReadOnlyList<ExternalBilledLine>> GetBilledLinesAsync(string invoiceId, CancellationToken cancellationToken)
    {
        var operationUrl = await StartExportAsync(invoiceId, cancellationToken);
        var manifestUrl = await WaitForManifestAsync(operationUrl, cancellationToken);
        var blobs = await ReadManifestAsync(manifestUrl, cancellationToken);

        var lines = new List<ExternalBilledLine>();
        foreach (var blob in blobs)
        {
            using var response = await GetLinkAsync(blob, cancellationToken);
            response.EnsureSuccessStatusCode();
            var content = await response.Content.ReadAsStringAsync(cancellationToken);
            lines.AddRange(ParseLines(content, invoiceId));
        }

        logger.LogInformation("Partner billing export for invoice {Invoice} returned {Count} lines.", invoiceId, lines.Count);
        return lines;
    }

    private async Task<string> StartExportAsync(string invoiceId, CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, "reports/partners/billing/reconciliation/billed/export")
        {
            Content = JsonContent.Create(new { invoiceId, attributeSet = "full" }),
        };
        await AuthorizeAsync(request, cancellationToken);
        using var response = await http.SendAsync(request, cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);
        return response.Headers.Location?.ToString()
               ?? await ReadOperationLocationAsync(response, cancellationToken)
               ?? throw new PartnerCenterApiException(response.StatusCode, "The billing export did not return an operation link.");
    }

    private async Task<string> WaitForManifestAsync(string operationUrl, CancellationToken cancellationToken)
    {
        for (var attempt = 0; attempt < MaxPolls; attempt++)
        {
            using var response = await GetLinkAsync(operationUrl, cancellationToken);
            await EnsureSuccessAsync(response, cancellationToken);
            using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync(cancellationToken));
            var status = document.RootElement.TryGetProperty("status", out var value) ? value.GetString() : null;
            if (string.Equals(status, "succeeded", StringComparison.OrdinalIgnoreCase))
            {
                return document.RootElement.TryGetProperty("resourceLocation", out var location) && location.GetString() is { Length: > 0 } url
                    ? url
                    : throw new PartnerCenterApiException(
                        System.Net.HttpStatusCode.OK, "The billing export succeeded but returned no manifest.");
            }

            if (string.Equals(status, "failed", StringComparison.OrdinalIgnoreCase))
            {
                throw new PartnerCenterApiException(System.Net.HttpStatusCode.OK, "Microsoft reported that the billing export failed.");
            }

            await Task.Delay(TimeSpan.FromSeconds(attempt == 0 ? 2 : 5), time, cancellationToken);
        }

        throw new PartnerCenterApiException(System.Net.HttpStatusCode.RequestTimeout, "The billing export did not finish in time.");
    }

    private async Task<IReadOnlyList<string>> ReadManifestAsync(string manifestUrl, CancellationToken cancellationToken)
    {
        using var response = await GetLinkAsync(manifestUrl, cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync(cancellationToken));
        if (!document.RootElement.TryGetProperty("blobs", out var blobs) || blobs.ValueKind != JsonValueKind.Array)
        {
            return [];
        }

        return blobs.EnumerateArray()
            .Select(blob => blob.TryGetProperty("blobUri", out var uri) || blob.TryGetProperty("url", out uri) ? uri.GetString() : null)
            .OfType<string>()
            .ToList();
    }

    /// <summary>The export is JSON lines; a whole array is accepted as well, because the shape differs between attribute sets.</summary>
    internal static IReadOnlyList<ExternalBilledLine> ParseLines(string content, string invoiceId)
    {
        var lines = new List<ExternalBilledLine>();
        var trimmed = content.TrimStart();
        if (trimmed.StartsWith('['))
        {
            using var document = JsonDocument.Parse(trimmed);
            lines.AddRange(document.RootElement.EnumerateArray().Select(e => ReadLine(e, invoiceId)).OfType<ExternalBilledLine>());
            return lines;
        }

        foreach (var row in content.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            using var document = JsonDocument.Parse(row);
            if (ReadLine(document.RootElement, invoiceId) is { } line)
            {
                lines.Add(line);
            }
        }

        return lines;
    }

    internal static ExternalBilledLine? ReadLine(JsonElement e, string invoiceId)
    {
        var customerId = Text(e, "customerId", "partnerId");
        var offerId = Text(e, "offerId", "productId", "skuId");
        if (customerId is null || offerId is null)
        {
            return null;
        }

        var start = Date(e, "chargeStartDate", "billingPeriodStartDate") ?? DateOnly.FromDateTime(DateTime.UtcNow);
        var end = Date(e, "chargeEndDate", "billingPeriodEndDate") ?? start;
        var quantity = Number(e, "quantity", "unitCount") ?? 0m;
        var unitPrice = Number(e, "effectiveUnitPrice", "unitPrice") ?? 0m;
        var total = Number(e, "totalForCustomer", "subtotal", "total") ?? decimal.Round(quantity * unitPrice, 2);
        return new ExternalBilledLine(
            MsBillingSource.GraphExport,
            start,
            end,
            Text(e, "invoiceNumber") ?? invoiceId,
            customerId,
            Text(e, "customerName"),
            Text(e, "subscriptionId", "entitlementId"),
            offerId,
            Text(e, "offerName", "skuName", "productName"),
            quantity,
            unitPrice,
            total,
            Text(e, "currency", "billingCurrency") ?? "NOK");
    }

    /// <summary>
    /// A GET of a link the export named (DEV-21): the Graph token goes only with a link on the configured Graph origin, a signed
    /// storage link is sent without it, and any other link fails before a request is made (<see cref="PartnerBillingLinks"/>).
    /// </summary>
    private async Task<HttpResponseMessage> GetLinkAsync(string link, CancellationToken cancellationToken)
    {
        var (uri, destination) = PartnerBillingLinks.Classify(options.Value.GraphBaseUrl, link, options.Value.BillingStorageHostSuffixes);
        using var request = new HttpRequestMessage(HttpMethod.Get, uri);
        if (destination == PartnerBillingLinks.Destination.Graph)
        {
            await AuthorizeAsync(request, cancellationToken);
        }

        return await http.SendAsync(request, cancellationToken);
    }

    private async Task AuthorizeAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var token = await tokens.GetTokenAsync(PartnerCenterTokenProvider.GraphResource, cancellationToken);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
    }

    private static async Task<string?> ReadOperationLocationAsync(HttpResponseMessage response, CancellationToken cancellationToken)
    {
        var body = await response.Content.ReadAsStringAsync(cancellationToken);
        if (string.IsNullOrWhiteSpace(body))
        {
            return null;
        }

        using var document = JsonDocument.Parse(body);
        return document.RootElement.TryGetProperty("id", out var id) && id.GetString() is { Length: > 0 } value
            ? $"reports/partners/billing/operations/{value}"
            : null;
    }

    private static async Task EnsureSuccessAsync(HttpResponseMessage response, CancellationToken cancellationToken)
    {
        if (response.IsSuccessStatusCode)
        {
            return;
        }

        var body = await response.Content.ReadAsStringAsync(cancellationToken);
        throw new PartnerCenterApiException(
            response.StatusCode,
            $"Partner billing {(int)response.StatusCode} for {response.RequestMessage?.RequestUri?.AbsolutePath}: {(body.Length > 300 ? body[..300] : body)}");
    }

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

    private static decimal? Number(JsonElement e, params string[] names)
    {
        foreach (var name in names)
        {
            if (e.ValueKind != JsonValueKind.Object || !e.TryGetProperty(name, out var value))
            {
                continue;
            }

            if (value.ValueKind == JsonValueKind.Number && value.TryGetDecimal(out var number))
            {
                return number;
            }

            if (value.ValueKind == JsonValueKind.String &&
                decimal.TryParse(value.GetString(), NumberStyles.Number, CultureInfo.InvariantCulture, out var parsed))
            {
                return parsed;
            }
        }

        return null;
    }

    private static DateOnly? Date(JsonElement e, params string[] names) =>
        Text(e, names) is { } text && DateTimeOffset.TryParse(text, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var parsed)
            ? DateOnly.FromDateTime(parsed.UtcDateTime)
            : null;
}
