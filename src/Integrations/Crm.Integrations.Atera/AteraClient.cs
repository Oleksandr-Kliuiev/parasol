using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.Options;

namespace Crm.Integrations.Atera;

/// <summary>Atera customer, normalized. Stored as the external record payload, so field order and names must stay stable.</summary>
public sealed record AteraCustomer(
    long CustomerId,
    string Name,
    string? BusinessNumber,
    string? Domain,
    string? Address,
    string? City,
    string? ZipCode,
    string? Country,
    string? Phone,
    string? Website,
    DateTimeOffset? LastModified);

public sealed record AteraContact(
    long ContactId,
    long CustomerId,
    string? FirstName,
    string? LastName,
    string? Email,
    string? JobTitle,
    string? Phone,
    string? MobilePhone,
    bool InIgnoreMode,
    DateTimeOffset? LastModified);

public sealed record AteraCustomerWrite(
    string CustomerName,
    string? BusinessNumber,
    string? Domain,
    string? Address,
    string? City,
    string? ZipCode,
    string? Country,
    string? Phone,
    string? Website);

public sealed record AteraTicket(
    long TicketId,
    long? CustomerId,
    long? EndUserId,
    string Title,
    string Status,
    string? Priority,
    string? Impact,
    string? Type,
    string? Source,
    long? TechnicianId,
    string? TechnicianEmail,
    string? TechnicianName,
    string? EndUserName,
    string? EndUserEmail,
    DateTimeOffset CreatedAt,
    DateTimeOffset? FirstResponseAt,
    DateTimeOffset? ResolvedAt,
    DateTimeOffset? LastActivityAt);

public sealed record AteraWorkHours(
    string Id,
    long TicketId,
    string? TechnicianId,
    string? TechnicianEmail,
    string? TechnicianName,
    DateTimeOffset? StartedAt,
    DateTimeOffset? EndedAt,
    decimal Hours,
    bool Billable,
    bool Onsite,
    string? WorkType,
    string? Description);

public sealed record AteraAgent(string AgentId, long CustomerId, string MachineName, string? OsType, string? Os, bool Online, DateTimeOffset? LastSeenAt);

public sealed record AteraAlert(string AlertId, long? CustomerId, string Title, string Severity, string? DeviceName, DateTimeOffset CreatedAt);

public sealed record AteraTicketWrite(
    string TicketTitle,
    string Description,
    string TicketPriority,
    string TicketImpact,
    string TicketStatus,
    string TicketType,
    long EndUserID);

public sealed record AteraContactWrite(long CustomerID, string Firstname, string Lastname, string? Email, string? Phone);

public sealed class AteraApiException(HttpStatusCode status, string message) : Exception(message)
{
    public HttpStatusCode Status { get; } = status;
}

public interface IAteraClient
{
    IAsyncEnumerable<AteraCustomer> GetCustomersAsync(CancellationToken cancellationToken);

    IAsyncEnumerable<AteraContact> GetContactsAsync(CancellationToken cancellationToken);

    Task<AteraCustomer?> GetCustomerAsync(long customerId, CancellationToken cancellationToken);

    Task<long> CreateCustomerAsync(AteraCustomerWrite customer, CancellationToken cancellationToken);

    Task UpdateCustomerAsync(long customerId, AteraCustomerWrite customer, CancellationToken cancellationToken);

    /// <summary>Current value of a customer custom field, or null when it is not set.</summary>
    Task<string?> GetCustomerFieldAsync(long customerId, string fieldName, CancellationToken cancellationToken);

    Task SetCustomerFieldAsync(long customerId, string fieldName, string value, CancellationToken cancellationToken);

    /// <summary>Tickets, newest first; <paramref name="status"/> filters by ticket status (Open, Pending, Resolved, Closed).</summary>
    IAsyncEnumerable<AteraTicket> GetTicketsAsync(string? status, CancellationToken cancellationToken);

    Task<IReadOnlyList<AteraWorkHours>> GetWorkHoursAsync(long ticketId, CancellationToken cancellationToken);

    IAsyncEnumerable<AteraAgent> GetAgentsAsync(CancellationToken cancellationToken);

    IAsyncEnumerable<AteraAlert> GetAlertsAsync(string? status, CancellationToken cancellationToken);

    Task<long> CreateTicketAsync(AteraTicketWrite ticket, CancellationToken cancellationToken);

    Task<long> CreateContactAsync(AteraContactWrite contact, CancellationToken cancellationToken);
}

/// <summary>
/// Atera API v3 client. Responses are read by field name with fallbacks (e.g. ContactID / EndUserID) because the public
/// documentation is behind a login and SDKs disagree; the exact contract is confirmed in the PoC with the company's key.
/// </summary>
internal sealed class AteraClient(HttpClient http, IOptions<AteraOptions> options) : IAteraClient
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

    public IAsyncEnumerable<AteraTicket> GetTicketsAsync(string? status, CancellationToken cancellationToken) =>
        GetPagedAsync("tickets", ReadTicket, cancellationToken, status is null ? null : $"ticketStatus={Uri.EscapeDataString(status)}");

    public async Task<IReadOnlyList<AteraWorkHours>> GetWorkHoursAsync(long ticketId, CancellationToken cancellationToken)
    {
        using var response = await http.GetAsync($"tickets/{ticketId}/workhoursrecords", cancellationToken);
        if (response.StatusCode is HttpStatusCode.NotFound or HttpStatusCode.NoContent)
        {
            return [];
        }

        await EnsureSuccessAsync(response, cancellationToken);
        using var document = await JsonDocument.ParseAsync(await response.Content.ReadAsStreamAsync(cancellationToken), cancellationToken: cancellationToken);
        var root = document.RootElement;
        // Work hours come back either as a bare array or wrapped in the usual paged envelope.
        var items = root.ValueKind == JsonValueKind.Array ? root : TryGet(root, out var wrapped, "items", "Items") ? wrapped : default;
        if (items.ValueKind != JsonValueKind.Array)
        {
            return [];
        }

        return items.EnumerateArray().Select(e => ReadWorkHours(e, ticketId)).OfType<AteraWorkHours>().ToList();
    }

    public IAsyncEnumerable<AteraAgent> GetAgentsAsync(CancellationToken cancellationToken) =>
        GetPagedAsync("agents", ReadAgent, cancellationToken);

    public IAsyncEnumerable<AteraAlert> GetAlertsAsync(string? status, CancellationToken cancellationToken) =>
        GetPagedAsync("alerts", ReadAlert, cancellationToken, status is null ? null : $"alertStatus={Uri.EscapeDataString(status)}");

    public async Task<long> CreateTicketAsync(AteraTicketWrite ticket, CancellationToken cancellationToken)
    {
        using var response = await http.PostAsJsonAsync("tickets", ticket, cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);
        using var document = await JsonDocument.ParseAsync(await response.Content.ReadAsStreamAsync(cancellationToken), cancellationToken: cancellationToken);
        return Long(document.RootElement, "ActionID", "TicketID", "id")
               ?? throw new AteraApiException(response.StatusCode, "Atera did not return the id of the created ticket.");
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

    private async IAsyncEnumerable<T> GetPagedAsync<T>(
        string resource,
        Func<JsonElement, T?> read,
        [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken cancellationToken,
        string? filter = null)
        where T : class
    {
        var size = Math.Clamp(options.Value.ItemsInPage, 1, 50);
        for (int page = 1; page <= 100_000; page++)
        {
            using var response = await http.GetAsync($"{resource}?page={page}&itemsInPage={size}{(filter is null ? string.Empty : "&" + filter)}", cancellationToken);
            await EnsureSuccessAsync(response, cancellationToken);
            using var document = await JsonDocument.ParseAsync(await response.Content.ReadAsStreamAsync(cancellationToken), cancellationToken: cancellationToken);
            var root = document.RootElement;
            if (!TryGet(root, out var items, "items", "Items") || items.ValueKind != JsonValueKind.Array)
            {
                throw new AteraApiException(response.StatusCode, $"Unexpected Atera response for {resource}: no items array.");
            }

            foreach (var element in items.EnumerateArray())
            {
                if (read(element) is { } item)
                {
                    yield return item;
                }
            }

            var totalPages = Long(root, "totalPages", "TotalPages");
            if (items.GetArrayLength() < size || (totalPages is { } total && page >= total))
            {
                yield break;
            }
        }
    }

    internal static AteraCustomer? ReadCustomer(JsonElement e) =>
        Long(e, "CustomerID", "customerID", "Id") is { } id
            ? new AteraCustomer(
                id,
                Text(e, "CustomerName", "Name") ?? $"#{id}",
                Text(e, "BusinessNumber"),
                Text(e, "Domain"),
                Text(e, "Address"),
                Text(e, "City"),
                Text(e, "ZipCodeStr", "ZipCode"),
                Text(e, "Country"),
                Text(e, "Phone"),
                Text(e, "Website"),
                Date(e, "LastModified", "LastModifiedDate", "ModifiedOn"))
            : null;

    internal static AteraContact? ReadContact(JsonElement e) =>
        Long(e, "EndUserID", "ContactID", "Id") is { } id && Long(e, "CustomerID") is { } customerId
            ? new AteraContact(
                id,
                customerId,
                Text(e, "Firstname", "FirstName"),
                Text(e, "Lastname", "LastName"),
                Text(e, "Email"),
                Text(e, "JobTitle"),
                Text(e, "Phone"),
                Text(e, "MobilePhone"),
                Bool(e, "InIgnoreMode") ?? false,
                Date(e, "LastModified", "LastModifiedDate", "ModifiedOn"))
            : null;

    internal static AteraTicket? ReadTicket(JsonElement e) =>
        Long(e, "TicketID", "TicketId", "Id") is { } id
            ? new AteraTicket(
                id,
                Long(e, "CustomerID", "CustomerId"),
                Long(e, "EndUserID", "EndUserId", "ContactID"),
                Text(e, "TicketTitle", "Title") ?? $"#{id}",
                Text(e, "TicketStatus", "Status") ?? "Open",
                Text(e, "TicketPriority", "Priority"),
                Text(e, "TicketImpact", "Impact"),
                Text(e, "TicketType", "Type"),
                Text(e, "TicketSource", "Source"),
                Long(e, "TechnicianContactID", "TechnicianID"),
                Text(e, "TechnicianEmail"),
                Text(e, "TechnicianFullName", "TechnicianName"),
                string.Join(' ', new[] { Text(e, "EndUserFirstName", "EndUserFirstname"), Text(e, "EndUserLastName", "EndUserLastname") }.Where(s => s is not null)) is { Length: > 0 } name ? name : null,
                Text(e, "EndUserEmail"),
                Date(e, "TicketCreatedDate", "Created", "CreatedDate") ?? DateTimeOffset.MinValue,
                Date(e, "FirstResponseDate", "FirstCommentDate"),
                Date(e, "TicketResolvedDate", "ClosedDate", "ResolvedDate"),
                Date(e, "LastEndUserCommentTimestamp", "LastTechnicianCommentTimestamp", "TicketLastModified", "LastModified"))
            : null;

    internal static AteraWorkHours? ReadWorkHours(JsonElement e, long ticketId)
    {
        var id = Text(e, "WorkHoursID", "WorkHourID", "ID", "Id");
        var minutes = Decimal(e, "TimeSpentInMinutes", "TotalMinutes", "DurationInMinutes", "Duration");
        var started = Date(e, "StartWorkHour", "StartTime", "Started");
        var ended = Date(e, "EndWorkHour", "EndTime", "Ended");
        var hours = minutes is { } m ? m / 60m : started is { } s2 && ended is { } e2 ? (decimal)(e2 - s2).TotalHours : (decimal?)null;
        if (id is null || hours is not { } value || value <= 0)
        {
            return null;
        }

        var onsite = Bool(e, "IsOnsite", "OnSite", "Onsite") ?? false;
        return new AteraWorkHours(
            id,
            Long(e, "TicketID") ?? ticketId,
            Text(e, "TechnicianContactID", "TechnicianID", "TechnicianEmail"),
            Text(e, "TechnicianEmail"),
            Text(e, "TechnicianFullName", "TechnicianName"),
            started,
            ended,
            decimal.Round(value, 2),
            Bool(e, "Billable", "IsBillable") ?? true,
            onsite,
            Text(e, "WorkType", "ActivityType") ?? (onsite ? "Onsite" : "Remote"),
            Text(e, "Description", "Comment", "WorkHoursDescription"));
    }

    internal static AteraAgent? ReadAgent(JsonElement e) =>
        Text(e, "AgentID", "AgentId", "MachineID", "DeviceGuid") is { } agentId && Long(e, "CustomerID") is { } customerId
            ? new AteraAgent(
                agentId,
                customerId,
                Text(e, "MachineName", "DeviceName", "Name") ?? agentId,
                Text(e, "OSType", "DeviceType", "MachineRole"),
                Text(e, "OS", "OperatingSystem"),
                Bool(e, "Online", "IsOnline") ?? false,
                Date(e, "LastSeen", "LastSeenDate", "LastRebootTime", "Modified"))
            : null;

    internal static AteraAlert? ReadAlert(JsonElement e) =>
        Text(e, "AlertID", "AlertId", "Id") is { } alertId
            ? new AteraAlert(
                alertId,
                Long(e, "CustomerID"),
                Text(e, "Title", "AlertMessage", "Message") ?? alertId,
                Text(e, "Severity", "AlertSeverity") ?? "Information",
                Text(e, "DeviceName", "MachineName"),
                Date(e, "Created", "CreatedDate", "AlertCreated") ?? DateTimeOffset.MinValue)
            : null;

    private static decimal? Decimal(JsonElement e, params string[] names) =>
        TryGet(e, out var v, names)
            ? v.ValueKind == JsonValueKind.Number && v.TryGetDecimal(out var n) ? n
            : v.ValueKind == JsonValueKind.String && decimal.TryParse(v.GetString(), NumberStyles.Number, CultureInfo.InvariantCulture, out var p) ? p : null
            : null;

    private static bool TryGet(JsonElement element, out JsonElement value, params string[] names)
    {
        foreach (var name in names)
        {
            if (element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out value) && value.ValueKind != JsonValueKind.Null)
            {
                return true;
            }
        }

        value = default;
        return false;
    }

    private static string? Text(JsonElement e, params string[] names) =>
        TryGet(e, out var v, names) ? (v.ValueKind == JsonValueKind.String ? v.GetString() : v.GetRawText()) is { Length: > 0 } s ? s.Trim() : null : null;

    private static long? Long(JsonElement e, params string[] names) =>
        TryGet(e, out var v, names)
            ? v.ValueKind == JsonValueKind.Number && v.TryGetInt64(out var n) ? n
            : v.ValueKind == JsonValueKind.String && long.TryParse(v.GetString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var p) ? p : null
            : null;

    private static bool? Bool(JsonElement e, params string[] names) =>
        TryGet(e, out var v, names) && v.ValueKind is JsonValueKind.True or JsonValueKind.False ? v.GetBoolean() : null;

    private static DateTimeOffset? Date(JsonElement e, params string[] names) =>
        Text(e, names) is { } s && DateTimeOffset.TryParse(s, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var d) ? d : null;

    private static async Task EnsureSuccessAsync(HttpResponseMessage response, CancellationToken cancellationToken)
    {
        if (response.IsSuccessStatusCode)
        {
            return;
        }

        var body = await response.Content.ReadAsStringAsync(cancellationToken);
        throw new AteraApiException(response.StatusCode,
            $"Atera {(int)response.StatusCode} for {response.RequestMessage?.Method} {response.RequestMessage?.RequestUri?.AbsolutePath}: {(body.Length > 500 ? body[..500] : body)}");
    }
}
