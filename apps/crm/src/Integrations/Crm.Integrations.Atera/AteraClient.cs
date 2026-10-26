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
    DateTimeOffset? LastActivityAt,
    string? Description = null);

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

/// <summary>All work-hour rows of one ticket; <paramref name="Dropped"/> counts rows that could not be used (no id, no or empty duration).</summary>
public sealed record AteraWorkHoursResult(IReadOnlyList<AteraWorkHours> Records, int Dropped);

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

    /// <summary>Every page of the ticket's work hours; rows that cannot be used are counted, never silently lost (DEV-19).</summary>
    Task<AteraWorkHoursResult> GetWorkHoursAsync(long ticketId, CancellationToken cancellationToken);

    /// <summary>One customer's tickets, newest first; used to find a ticket whose creation got no answer.</summary>
    IAsyncEnumerable<AteraTicket> GetCustomerTicketsAsync(long customerId, CancellationToken cancellationToken);

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
        GetPagedAsync("tickets", ReadTicket, cancellationToken, status is null ? null : $"ticketStatus={Uri.EscapeDataString(status)}", TicketKey);

    public IAsyncEnumerable<AteraTicket> GetCustomerTicketsAsync(long customerId, CancellationToken cancellationToken) =>
        GetPagedAsync($"tickets/customer/{customerId}", ReadTicket, cancellationToken, null, TicketKey);

    private static string TicketKey(AteraTicket ticket) => ticket.TicketId.ToString(CultureInfo.InvariantCulture);

    /// <summary>Upper bound for one ticket's work-hour pages; reaching it is an error, not the end of the list.</summary>
    private const int MaxWorkHourPages = 200;

    public async Task<AteraWorkHoursResult> GetWorkHoursAsync(long ticketId, CancellationToken cancellationToken)
    {
        var size = Math.Clamp(options.Value.ItemsInPage, 1, 50);
        var records = new List<AteraWorkHours>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var dropped = 0;
        string? next = $"tickets/{ticketId}/workhoursrecords?page=1&itemsInPage={size}";
        for (var page = 1; next is not null; page++)
        {
            if (page > MaxWorkHourPages)
            {
                throw new AteraApiException(HttpStatusCode.OK, $"Work hours of ticket {ticketId} span more than {MaxWorkHourPages} pages.");
            }

            using var response = await http.GetAsync(next, cancellationToken);
            if (response.StatusCode is HttpStatusCode.NotFound or HttpStatusCode.NoContent)
            {
                break;
            }

            await EnsureSuccessAsync(response, cancellationToken);
            using var document = await JsonDocument.ParseAsync(await response.Content.ReadAsStreamAsync(cancellationToken), cancellationToken: cancellationToken);
            var root = document.RootElement;
            // Work hours come back either as a bare array (one page) or wrapped in the usual paged envelope.
            var items = root.ValueKind == JsonValueKind.Array ? root : TryGet(root, out var wrapped, "items", "Items") ? wrapped : default;
            if (items.ValueKind != JsonValueKind.Array)
            {
                break;
            }

            foreach (var element in items.EnumerateArray())
            {
                if (ReadWorkHours(element, ticketId) is { } hours)
                {
                    if (seen.Add(hours.Id))
                    {
                        records.Add(hours);
                    }
                }
                else
                {
                    dropped++;
                }
            }

            next = root.ValueKind == JsonValueKind.Object ? NextPage(root, page, size, items.GetArrayLength(), ticketId) : null;
        }

        return new AteraWorkHoursResult(records, dropped);
    }

    /// <summary>The page after this one: the envelope's <c>nextLink</c> when it has one, else the next number while <c>totalPages</c> says there is more.</summary>
    private string? NextPage(JsonElement root, int page, int size, int count, long ticketId)
    {
        if (Text(root, "nextLink", "NextLink") is { } link)
        {
            // Followed only on Atera's own host: the client's base address decides where requests go.
            if (!Uri.TryCreate(link, UriKind.Absolute, out var absolute))
            {
                return link.TrimStart('/');
            }

            var basePath = http.BaseAddress?.AbsolutePath ?? "/";
            return absolute.PathAndQuery.StartsWith(basePath, StringComparison.OrdinalIgnoreCase) ? absolute.PathAndQuery[basePath.Length..] : absolute.PathAndQuery.TrimStart('/');
        }

        var totalPages = Long(root, "totalPages", "TotalPages");
        return totalPages is { } total && page < total && count > 0
            ? $"tickets/{ticketId}/workhoursrecords?page={page + 1}&itemsInPage={size}"
            : null;
    }

    public IAsyncEnumerable<AteraAgent> GetAgentsAsync(CancellationToken cancellationToken) =>
        GetPagedAsync("agents", ReadAgent, cancellationToken);

    /// <summary>
    /// The alert mirror resolves what a complete read no longer lists (M38), so this read must not lose anything quietly: the
    /// previous page is read again for alerts that moved across the boundary, and an alert without an id fails the read.
    /// </summary>
    public IAsyncEnumerable<AteraAlert> GetAlertsAsync(string? status, CancellationToken cancellationToken) =>
        GetPagedAsync("alerts", ReadAlert, cancellationToken, status is null ? null : $"alertStatus={Uri.EscapeDataString(status)}", a => a.AlertId, strict: true);

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

    /// <summary>
    /// Reads a paged list. With <paramref name="key"/> the previous page is read once more after the next one: a list that changes
    /// while it is read (a ticket closing leaves a status-filtered list, a new one pushes the rest down) shifts items across the
    /// page boundary, and the overlap catches what moved to the tail of the page already read. Items are yielded once. A
    /// <paramref name="strict"/> read fails on an item it cannot understand instead of leaving it out.
    /// </summary>
    private async IAsyncEnumerable<T> GetPagedAsync<T>(
        string resource,
        Func<JsonElement, T?> read,
        [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken cancellationToken,
        string? filter = null,
        Func<T, string>? key = null,
        bool strict = false)
        where T : class
    {
        var size = Math.Clamp(options.Value.ItemsInPage, 1, 50);
        var seen = key is null ? null : new HashSet<string>(StringComparer.Ordinal);
        for (int page = 1; page <= 100_000; page++)
        {
            var (items, last) = await ReadPageAsync(resource, page, size, filter, read, strict, cancellationToken);
            foreach (var item in items)
            {
                if (seen is null || seen.Add(key!(item)))
                {
                    yield return item;
                }
            }

            if (key is not null && page > 1)
            {
                var (previous, _) = await ReadPageAsync(resource, page - 1, size, filter, read, strict, cancellationToken);
                foreach (var item in previous)
                {
                    if (seen!.Add(key(item)))
                    {
                        yield return item;
                    }
                }
            }

            if (last)
            {
                yield break;
            }
        }

        throw new AteraApiException(HttpStatusCode.OK, $"Atera {resource} has more than 100000 pages.");
    }

    private async Task<(List<T> Items, bool Last)> ReadPageAsync<T>(
        string resource, int page, int size, string? filter, Func<JsonElement, T?> read, bool strict, CancellationToken cancellationToken)
        where T : class
    {
        using var response = await http.GetAsync($"{resource}?page={page}&itemsInPage={size}{(filter is null ? string.Empty : "&" + filter)}", cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);
        using var document = await JsonDocument.ParseAsync(await response.Content.ReadAsStreamAsync(cancellationToken), cancellationToken: cancellationToken);
        var root = document.RootElement;
        if (!TryGet(root, out var items, "items", "Items") || items.ValueKind != JsonValueKind.Array)
        {
            throw new AteraApiException(response.StatusCode, $"Unexpected Atera response for {resource}: no items array.");
        }

        var result = new List<T>();
        foreach (var element in items.EnumerateArray())
        {
            if (read(element) is { } item)
            {
                result.Add(item);
            }
            else if (strict)
            {
                throw new AteraApiException(response.StatusCode, $"Atera {resource} page {page} holds an item that cannot be read.");
            }
        }

        var totalPages = Long(root, "totalPages", "TotalPages");
        return (result, items.GetArrayLength() < size || (totalPages is { } total && page >= total));
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
                Date(e, "LastEndUserCommentTimestamp", "LastTechnicianCommentTimestamp", "TicketLastModified", "LastModified"),
                Text(e, "TicketDescription", "Description"))
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
