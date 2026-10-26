using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.Options;

namespace Crm.Integrations.Atera;

/// <summary>
/// Atera API v3 client. Responses are read by field name with fallbacks (e.g. ContactID / EndUserID) because the public
/// documentation is behind a login and SDKs disagree; the exact contract is confirmed in the PoC with the company's key.
/// </summary>
internal sealed partial class AteraClient(HttpClient http, IOptions<AteraOptions> options) : IAteraClient
{
    public IAsyncEnumerable<AteraCustomer> GetCustomersAsync(CancellationToken cancellationToken) =>
        GetPagedAsync("customers", ReadCustomer, cancellationToken);

    public IAsyncEnumerable<AteraContact> GetContactsAsync(CancellationToken cancellationToken) =>
        GetPagedAsync("contacts", ReadContact, cancellationToken);

    public async Task<AteraCustomer?> GetCustomerAsync(long customerId, CancellationToken cancellationToken)
    {
        using var response = await http.GetAsync($"customers/{customerId}", cancellationToken);
        if (response.StatusCode == HttpStatusCode.NotFound)
        {
            return null;
        }

        await EnsureSuccessAsync(response, cancellationToken);
        using var document = await JsonDocument.ParseAsync(await response.Content.ReadAsStreamAsync(cancellationToken), cancellationToken: cancellationToken);
        return ReadCustomer(document.RootElement);
    }

    public async Task<long> CreateCustomerAsync(AteraCustomerWrite customer, CancellationToken cancellationToken)
    {
        using var response = await http.PostAsJsonAsync("customers", customer, cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);
        using var document = await JsonDocument.ParseAsync(await response.Content.ReadAsStreamAsync(cancellationToken), cancellationToken: cancellationToken);
        // Atera answers creates with an action result; the new id is ActionID (CustomerID on some versions).
        return Long(document.RootElement, "ActionID", "CustomerID", "id")
               ?? throw new AteraApiException(response.StatusCode, "Atera did not return the id of the created customer.");
    }

    public async Task UpdateCustomerAsync(long customerId, AteraCustomerWrite customer, CancellationToken cancellationToken)
    {
        using var response = await http.PutAsJsonAsync($"customers/{customerId}", customer, cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);
    }

    public async Task<long> CreateContactAsync(AteraContactWrite contact, CancellationToken cancellationToken)
    {
        using var response = await http.PostAsJsonAsync("contacts", contact, cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);
        using var document = await JsonDocument.ParseAsync(await response.Content.ReadAsStreamAsync(cancellationToken), cancellationToken: cancellationToken);
        return Long(document.RootElement, "ActionID", "EndUserID", "ContactID", "id")
               ?? throw new AteraApiException(response.StatusCode, "Atera did not return the id of the created contact.");
    }

    public async Task<string?> GetCustomerFieldAsync(long customerId, string fieldName, CancellationToken cancellationToken)
    {
        using var response = await http.GetAsync($"customvalues/customerfield/{customerId}/{Uri.EscapeDataString(fieldName)}", cancellationToken);
        if (response.StatusCode == HttpStatusCode.NotFound)
        {
            return null;
        }

        await EnsureSuccessAsync(response, cancellationToken);
        using var document = await JsonDocument.ParseAsync(await response.Content.ReadAsStreamAsync(cancellationToken), cancellationToken: cancellationToken);
        // Documented as a list of values; tolerate a single object too.
        var root = document.RootElement;
        var item = root.ValueKind == JsonValueKind.Array ? root.EnumerateArray().FirstOrDefault() : root;
        return item.ValueKind == JsonValueKind.Object ? Text(item, "ValueAsString", "Value") : null;
    }

    public async Task SetCustomerFieldAsync(long customerId, string fieldName, string value, CancellationToken cancellationToken)
    {
        using var response = await http.PutAsJsonAsync($"customvalues/customerfield/{customerId}/{Uri.EscapeDataString(fieldName)}", new Dictionary<string, string> { ["Value"] = value }, cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);
    }
}
