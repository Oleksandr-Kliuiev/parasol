using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Options;

namespace Crm.Integrations.PowerOffice;

/// <summary>OAuth 2.0 client credentials token (valid 20 minutes), cached and shared by all requests.</summary>
public sealed class PowerOfficeTokenProvider(IHttpClientFactory httpClientFactory, IOptions<PowerOfficeOptions> options, TimeProvider timeProvider) : IDisposable
{
    public const string HttpClientName = "poweroffice-token";
    private readonly SemaphoreSlim _gate = new(1, 1);
    private string? _token;
    private DateTimeOffset _expiresAt;

    public async Task<string> GetTokenAsync(CancellationToken cancellationToken)
    {
        if (_token is not null && timeProvider.GetUtcNow() < _expiresAt)
        {
            return _token;
        }

        await _gate.WaitAsync(cancellationToken);
        try
        {
            if (_token is not null && timeProvider.GetUtcNow() < _expiresAt)
            {
                return _token;
            }

            var o = options.Value;
            using var request = new HttpRequestMessage(HttpMethod.Post, o.EffectiveTokenUrl)
            {
                Content = new FormUrlEncodedContent([new KeyValuePair<string, string>("grant_type", "client_credentials")]),
            };
            request.Headers.Authorization = new AuthenticationHeaderValue(
                "Basic", Convert.ToBase64String(Encoding.UTF8.GetBytes($"{o.ApplicationKey}:{o.ClientKey}")));
            request.Headers.Add("Ocp-Apim-Subscription-Key", o.SubscriptionKey);

            using var response = await httpClientFactory.CreateClient(HttpClientName).SendAsync(request, cancellationToken);
            if (!response.IsSuccessStatusCode)
            {
                throw new HttpRequestException($"PowerOffice token request failed with {(int)response.StatusCode}. Check the application, client and subscription keys.", null, response.StatusCode);
            }

            var token = await response.Content.ReadFromJsonAsync<TokenResponse>(cancellationToken)
                        ?? throw new HttpRequestException("Empty token response from PowerOffice.");
            _token = token.AccessToken;
            _expiresAt = timeProvider.GetUtcNow().AddSeconds((token.ExpiresIn ?? 1200) - 60);
            return _token;
        }
        finally
        {
            _gate.Release();
        }
    }

    public void Invalidate() => _token = null;

    public void Dispose() => _gate.Dispose();
}

/// <summary>Adds the bearer token and subscription key; on 401 fetches a new token once and retries.</summary>
internal sealed class PowerOfficeAuthHandler(PowerOfficeTokenProvider tokens, IOptions<PowerOfficeOptions> options) : DelegatingHandler
{
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        await Authorize(request, cancellationToken);
        var response = await base.SendAsync(request, cancellationToken);
        if (response.StatusCode != HttpStatusCode.Unauthorized)
        {
            return response;
        }

        response.Dispose();
        tokens.Invalidate();
        await Authorize(request, cancellationToken);
        return await base.SendAsync(request, cancellationToken);
    }

    private async Task Authorize(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", await tokens.GetTokenAsync(cancellationToken));
        request.Headers.Remove("Ocp-Apim-Subscription-Key");
        request.Headers.Add("Ocp-Apim-Subscription-Key", options.Value.SubscriptionKey);
    }
}

public sealed class PowerOfficeApiException(HttpStatusCode status, string message) : Exception(message)
{
    public HttpStatusCode Status { get; } = status;
}

public interface IPowerOfficeClient
{
    IAsyncEnumerable<PoCustomer> GetCustomersAsync(DateTimeOffset? changedSince, CancellationToken cancellationToken);

    IAsyncEnumerable<PoContactPerson> GetContactPersonsAsync(DateTimeOffset? changedSince, CancellationToken cancellationToken);

    IAsyncEnumerable<PoProduct> GetProductsAsync(DateTimeOffset? changedSince, CancellationToken cancellationToken);

    Task<PoCustomer?> GetCustomerAsync(long id, CancellationToken cancellationToken);

    Task<PoCustomer?> FindCustomerAsync(string? externalImportReference, string? organizationNumber, CancellationToken cancellationToken);

    Task<PoCustomer> CreateCustomerAsync(PoCustomerPost customer, CancellationToken cancellationToken);

    Task<PoCustomer> PatchCustomerAsync(long id, IReadOnlyList<PatchOperation> operations, CancellationToken cancellationToken);

    Task<PoContactPerson?> GetContactPersonAsync(long customerId, long id, CancellationToken cancellationToken);

    Task<PoContactPerson?> FindContactPersonAsync(string externalCode, CancellationToken cancellationToken);

    Task<PoContactPerson> CreateContactPersonAsync(long customerId, PoContactPersonPost person, CancellationToken cancellationToken);

    Task<PoContactPerson> PatchContactPersonAsync(long customerId, long id, IReadOnlyList<PatchOperation> operations, CancellationToken cancellationToken);

    /// <summary>Looks a sales order up by the reference the CRM sent, so a repeated export cannot create a second order (BR-BIL-05).</summary>
    Task<PoSalesOrder?> FindSalesOrderAsync(string externalImportReference, CancellationToken cancellationToken);

    Task<PoSalesOrder> CreateSalesOrderAsync(PoSalesOrderPost order, CancellationToken cancellationToken);

    IAsyncEnumerable<PoOutgoingInvoice> GetOutgoingInvoicesAsync(DateTimeOffset? changedSince, CancellationToken cancellationToken);
}

internal sealed class PowerOfficeClient(HttpClient http, IOptions<PowerOfficeOptions> options) : IPowerOfficeClient
{
    private const int MaxPages = 10_000;

    public IAsyncEnumerable<PoCustomer> GetCustomersAsync(DateTimeOffset? changedSince, CancellationToken cancellationToken) =>
        GetPagedAsync<PoCustomer>("Customers", changedSince, cancellationToken);

    public IAsyncEnumerable<PoContactPerson> GetContactPersonsAsync(DateTimeOffset? changedSince, CancellationToken cancellationToken) =>
        GetPagedAsync<PoContactPerson>("ContactPersons", changedSince, cancellationToken);

    public IAsyncEnumerable<PoProduct> GetProductsAsync(DateTimeOffset? changedSince, CancellationToken cancellationToken) =>
        GetPagedAsync<PoProduct>("Products", changedSince, cancellationToken);

    public async Task<PoCustomer?> GetCustomerAsync(long id, CancellationToken cancellationToken)
    {
        using var response = await http.GetAsync($"Customers/{id}", cancellationToken);
        if (response.StatusCode is HttpStatusCode.NotFound or HttpStatusCode.NoContent)
        {
            return null;
        }

        await EnsureSuccessAsync(response, cancellationToken);
        return await response.Content.ReadFromJsonAsync<PoCustomer>(PoJson.Options, cancellationToken);
    }

    public async Task<PoCustomer?> FindCustomerAsync(string? externalImportReference, string? organizationNumber, CancellationToken cancellationToken)
    {
        foreach (var (name, value) in new[] { ("externalImportReference", externalImportReference), ("organizationNumbers", organizationNumber) })
        {
            if (string.IsNullOrWhiteSpace(value))
            {
                continue;
            }

            using var response = await http.GetAsync($"Customers?{name}={Uri.EscapeDataString(value)}&PageSize=2", cancellationToken);
            if (response.StatusCode == HttpStatusCode.NoContent)
            {
                continue;
            }

            await EnsureSuccessAsync(response, cancellationToken);
            var found = await response.Content.ReadFromJsonAsync<List<PoCustomer>>(PoJson.Options, cancellationToken) ?? [];
            if (found.Count > 0)
            {
                return found[0];
            }
        }

        return null;
    }

    public async Task<PoCustomer> CreateCustomerAsync(PoCustomerPost customer, CancellationToken cancellationToken)
    {
        using var response = await http.PostAsJsonAsync("Customers", customer, PoJson.Options, cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);
        return await response.Content.ReadFromJsonAsync<PoCustomer>(PoJson.Options, cancellationToken)
               ?? throw new PowerOfficeApiException(response.StatusCode, "PowerOffice returned no customer.");
    }

    public async Task<PoCustomer> PatchCustomerAsync(long id, IReadOnlyList<PatchOperation> operations, CancellationToken cancellationToken)
    {
        using var content = new StringContent(JsonSerializer.Serialize(operations, PoJson.Options), Encoding.UTF8, "application/json-patch+json");
        using var response = await http.PatchAsync($"Customers/{id}", content, cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);
        return await response.Content.ReadFromJsonAsync<PoCustomer>(PoJson.Options, cancellationToken)
               ?? throw new PowerOfficeApiException(response.StatusCode, "PowerOffice returned no customer.");
    }

    public async Task<PoContactPerson?> GetContactPersonAsync(long customerId, long id, CancellationToken cancellationToken)
    {
        using var response = await http.GetAsync($"ContactPersons/{customerId}/{id}", cancellationToken);
        if (response.StatusCode is HttpStatusCode.NotFound or HttpStatusCode.NoContent)
        {
            return null;
        }

        await EnsureSuccessAsync(response, cancellationToken);
        return await response.Content.ReadFromJsonAsync<PoContactPerson>(PoJson.Options, cancellationToken);
    }

    public async Task<PoContactPerson?> FindContactPersonAsync(string externalCode, CancellationToken cancellationToken)
    {
        using var response = await http.GetAsync($"ContactPersons?externalCodes={Uri.EscapeDataString(externalCode)}&PageSize=2", cancellationToken);
        if (response.StatusCode == HttpStatusCode.NoContent)
        {
            return null;
        }

        await EnsureSuccessAsync(response, cancellationToken);
        return (await response.Content.ReadFromJsonAsync<List<PoContactPerson>>(PoJson.Options, cancellationToken))?.FirstOrDefault();
    }

    public async Task<PoContactPerson> CreateContactPersonAsync(long customerId, PoContactPersonPost person, CancellationToken cancellationToken)
    {
        using var response = await http.PostAsJsonAsync($"ContactPersons/{customerId}", person, PoJson.Options, cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);
        return await response.Content.ReadFromJsonAsync<PoContactPerson>(PoJson.Options, cancellationToken)
               ?? throw new PowerOfficeApiException(response.StatusCode, "PowerOffice returned no contact person.");
    }

    public async Task<PoContactPerson> PatchContactPersonAsync(long customerId, long id, IReadOnlyList<PatchOperation> operations, CancellationToken cancellationToken)
    {
        using var content = new StringContent(JsonSerializer.Serialize(operations, PoJson.Options), Encoding.UTF8, "application/json-patch+json");
        using var response = await http.PatchAsync($"ContactPersons/{customerId}/{id}", content, cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);
        return await response.Content.ReadFromJsonAsync<PoContactPerson>(PoJson.Options, cancellationToken)
               ?? throw new PowerOfficeApiException(response.StatusCode, "PowerOffice returned no contact person.");
    }

    public async Task<PoSalesOrder?> FindSalesOrderAsync(string externalImportReference, CancellationToken cancellationToken)
    {
        using var response = await http.GetAsync($"SalesOrders?externalImportReferences={Uri.EscapeDataString(externalImportReference)}&PageSize=2", cancellationToken);
        if (response.StatusCode is HttpStatusCode.NoContent or HttpStatusCode.NotFound)
        {
            return null;
        }

        await EnsureSuccessAsync(response, cancellationToken);
        var found = await response.Content.ReadFromJsonAsync<List<PoSalesOrder>>(PoJson.Options, cancellationToken) ?? [];
        // The filter is a convenience of the API; the reference is compared again so a broader match cannot be mistaken for ours.
        return found.FirstOrDefault(o => string.Equals(o.ExternalImportReference, externalImportReference, StringComparison.Ordinal));
    }

    public async Task<PoSalesOrder> CreateSalesOrderAsync(PoSalesOrderPost order, CancellationToken cancellationToken)
    {
        using var response = await http.PostAsJsonAsync("SalesOrders", order, PoJson.Options, cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);
        return await response.Content.ReadFromJsonAsync<PoSalesOrder>(PoJson.Options, cancellationToken)
               ?? throw new PowerOfficeApiException(response.StatusCode, "PowerOffice returned no sales order.");
    }

    public IAsyncEnumerable<PoOutgoingInvoice> GetOutgoingInvoicesAsync(DateTimeOffset? changedSince, CancellationToken cancellationToken) =>
        GetPagedAsync<PoOutgoingInvoice>("OutgoingInvoices", changedSince, cancellationToken);

    private async IAsyncEnumerable<T> GetPagedAsync<T>(string resource, DateTimeOffset? changedSince, [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken cancellationToken)
    {
        var pageSize = Math.Clamp(options.Value.PageSize, 1, 20_000);
        var filter = changedSince is { } since ? $"&lastChangedDateTimeOffsetGreaterThan={Uri.EscapeDataString(since.ToString("O"))}" : string.Empty;
        for (int page = 1; page <= MaxPages; page++)
        {
            using var response = await http.GetAsync($"{resource}?PageNumber={page}&PageSize={pageSize}{filter}", cancellationToken);
            if (response.StatusCode == HttpStatusCode.NoContent)
            {
                yield break;
            }

            await EnsureSuccessAsync(response, cancellationToken);
            var items = await response.Content.ReadFromJsonAsync<List<T>>(PoJson.Options, cancellationToken)
                ?? throw new JsonException("PowerOffice returned a null page instead of a record array.");
            // The server may cap the page size below what was asked for, so a short page does not mean the last one: only 204
            // or an empty page ends the enumeration.
            if (items.Count == 0)
            {
                yield break;
            }

            foreach (var item in items)
            {
                yield return item;
            }
        }

        // Ending quietly here would let the caller advance its cursor over records it never read.
        throw new PowerOfficeApiException(HttpStatusCode.OK, $"PowerOffice {resource} did not end after {MaxPages} pages.");
    }

    private static async Task EnsureSuccessAsync(HttpResponseMessage response, CancellationToken cancellationToken)
    {
        if (response.IsSuccessStatusCode)
        {
            return;
        }

        var body = await response.Content.ReadAsStringAsync(cancellationToken);
        throw new PowerOfficeApiException(response.StatusCode,
            $"PowerOffice {(int)response.StatusCode} for {response.RequestMessage?.Method} {response.RequestMessage?.RequestUri?.AbsolutePath}: {(body.Length > 500 ? body[..500] : body)}");
    }
}
