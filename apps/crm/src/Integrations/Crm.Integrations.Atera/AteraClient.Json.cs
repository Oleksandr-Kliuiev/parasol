using System.Globalization;
using System.Text.Json;

namespace Crm.Integrations.Atera;

/// <summary>Reads Atera's JSON by field name with fallbacks; the meaning is mapped in AteraServiceMapping.</summary>
internal sealed partial class AteraClient
{
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
            Text(e, "Description", "Comment", "Comments", "WorkHoursDescription"));
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
                // M40: a reboot or a change of the item is no contact; an agent without LastSeen has no last contact.
                Date(e, "LastSeen", "LastSeenDate"))
            {
                SerialNumber = Text(e, "VendorSerialNumber"),
                MacAddresses = Texts(e, "MacAddresses"),
                DeviceGuid = Text(e, "DeviceGuid"),
                AppViewUrl = Text(e, "AppViewUrl"),
                Inventory = new AteraAgentInventory(
                    Text(e, "Vendor"),
                    Text(e, "VendorBrandModel", "ProductName"),
                    Text(e, "Motherboard"),
                    Text(e, "Processor"),
                    Int(e, "ProcessorCoresCount"),
                    Text(e, "ProcessorClock"),
                    Int(e, "Memory"),
                    Text(e, "BiosVersion"),
                    Text(e, "OSVersion"),
                    Text(e, "OSBuild"),
                    Texts(e, "IpAddresses"),
                    Text(e, "ReportedFromIP"),
                    Text(e, "DomainName"),
                    Text(e, "CurrentLoggedUsers"),
                    Text(e, "LastLoginUser"),
                    Date(e, "LastRebootTime"),
                    Disks(e),
                    Text(e, "AgentVersion")),
            }
            : null;

    /// <summary>The disks of an agent (<c>HardwareDisks</c>); an entry that is not an object is left out.</summary>
    private static List<AteraDisk> Disks(JsonElement e) =>
        TryGet(e, out var v, "HardwareDisks") && v.ValueKind == JsonValueKind.Array
            ? v.EnumerateArray().Where(d => d.ValueKind == JsonValueKind.Object)
                .Select(d => new AteraDisk(Text(d, "Drive"), Double(d, "Free"), Double(d, "Used"), Double(d, "Total"))).ToList()
            : [];

    /// <summary>
    /// One patch list of an agent (M40). The OpenAPI file names the fields in camel case and older copies in Pascal case, so both
    /// are read; an entry without a name is no update and is left out.
    /// </summary>
    internal static AteraPatchList ReadPatches(JsonElement e, bool installed)
    {
        var list = installed ? new[] { "installedUpdates", "InstalledUpdates" } : ["availableUpdates", "AvailableUpdates"];
        var patches = TryGet(e, out var v, list) && v.ValueKind == JsonValueKind.Array
            ? v.EnumerateArray().Where(p => p.ValueKind == JsonValueKind.Object)
                .Select(p => Text(p, "name", "Name") is { } name
                    ? new AteraPatch(Text(p, "kbId", "KBId", "KbId"), name, Text(p, "class", "Class"),
                        installed ? Date(p, "installDate", "InstallDate") : null, installed ? null : Text(p, "status", "Status"))
                    : null)
                .OfType<AteraPatch>().ToList()
            : [];
        return new AteraPatchList(Date(e, "timestamp", "Timestamp"), patches);
    }

    /// <summary>A list of values: a JSON array of texts, or one text that lists them separated by commas or semicolons.</summary>
    private static List<string> Texts(JsonElement e, params string[] names)
    {
        if (!TryGet(e, out var v, names))
        {
            return [];
        }

        var values = v.ValueKind == JsonValueKind.Array
            ? v.EnumerateArray().Select(item => item.ValueKind == JsonValueKind.String ? item.GetString() : null)
            : v.ValueKind == JsonValueKind.String ? (v.GetString() ?? string.Empty).Split([',', ';']) : [];
        return values.Select(s => s?.Trim()).OfType<string>().Where(s => s.Length > 0).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
    }

    internal static AteraAlert? ReadAlert(JsonElement e) =>
        Text(e, "AlertID", "AlertId", "Id") is { } alertId
            ? new AteraAlert(
                alertId,
                Long(e, "CustomerID"),
                Text(e, "Title", "AlertMessage", "Message") ?? alertId,
                Text(e, "Severity", "AlertSeverity") ?? "Information",
                Text(e, "DeviceName", "MachineName"),
                Date(e, "Created", "CreatedDate", "AlertCreated") ?? DateTimeOffset.MinValue)
            {
                AgentId = Text(e, "AgentId", "AgentID"),
                DeviceGuid = Text(e, "DeviceGuid"),
                Archived = Bool(e, "Archived") ?? false,
            }
            : null;

    /// <summary>
    /// A comment, read by field name with fallbacks: Atera nests the author either flat (<c>TechnicianContactID</c>, <c>EnduserID</c>)
    /// or in the details object a comment is posted with. Without an id or a time it cannot be kept, so it is not read.
    /// </summary>
    internal static AteraComment? ReadComment(JsonElement e, long ticketId)
    {
        if (Text(e, "CommentID", "CommentId", "ID", "Id") is not { } id ||
            Date(e, "CommentTimestampUTC", "CommentDate", "Date", "Created", "CreatedDate") is not { } created)
        {
            return null;
        }

        var technicianDetails = TryGet(e, out var technician, "TechnicianCommentDetails") && technician.ValueKind == JsonValueKind.Object ? technician : default;
        var endUserDetails = TryGet(e, out var endUser, "EnduserCommentDetails", "EndUserCommentDetails") && endUser.ValueKind == JsonValueKind.Object ? endUser : default;
        var technicianId = Text(e, "TechnicianContactID", "TechnicianID", "TechnicianId")
                           ?? (technicianDetails.ValueKind == JsonValueKind.Object ? Text(technicianDetails, "TechnicianId", "TechnicianID", "TechnicianContactID") : null);
        var endUserId = Text(e, "EnduserID", "EndUserID", "EnduserId", "EndUserId")
                        ?? (endUserDetails.ValueKind == JsonValueKind.Object ? Text(endUserDetails, "EnduserId", "EndUserId", "EnduserID") : null);
        var isInternal = Bool(e, "IsInternal", "Internal")
                         ?? (technicianDetails.ValueKind == JsonValueKind.Object ? Bool(technicianDetails, "IsInternal") : null) ?? false;
        // Only technicians write internal notes, so an internal comment without a named author is still a technician's.
        var author = technicianId is not null || technicianDetails.ValueKind == JsonValueKind.Object || isInternal ? AteraCommentAuthor.Technician
            : endUserId is not null || endUserDetails.ValueKind == JsonValueKind.Object ? AteraCommentAuthor.EndUser
            : AteraCommentAuthor.Unknown;
        var name = Text(e, "TechnicianFullName", "EndUserFullName", "FullName", "CreatorName", "Name")
                   ?? (string.Join(' ', new[] { Text(e, "FirstName", "Firstname"), Text(e, "LastName", "Lastname") }.Where(s => s is not null)) is { Length: > 0 } full ? full : null);
        return new AteraComment(
            id,
            Long(e, "TicketID", "TicketId") ?? ticketId,
            Text(e, "CommentText", "Comment", "Text", "Body") ?? string.Empty,
            isInternal,
            author,
            author == AteraCommentAuthor.Technician ? technicianId : endUserId,
            name,
            Text(e, "Email", "TechnicianEmail", "EndUserEmail", "EnduserEmail"),
            created);
    }

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

    private static int? Int(JsonElement e, params string[] names) => Long(e, names) is { } n && n is >= int.MinValue and <= int.MaxValue ? (int)n : null;

    private static double? Double(JsonElement e, params string[] names) =>
        TryGet(e, out var v, names)
            ? v.ValueKind == JsonValueKind.Number && v.TryGetDouble(out var n) ? n
            : v.ValueKind == JsonValueKind.String && double.TryParse(v.GetString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var p) ? p : null
            : null;

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
