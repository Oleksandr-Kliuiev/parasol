using System.Globalization;
using System.Text.Json;

namespace Crm.Integrations.Huntress;

/// <summary>
/// Reads Huntress's JSON by the names its reference gives them (snake case). A record without its id, or an agent or a report
/// without its organization, cannot be kept and is not read: a list holding one fails as a whole.
/// </summary>
internal sealed partial class HuntressClient
{
    internal static HuntressAccount? ReadAccount(JsonElement e) =>
        Long(e, "id") is { } id ? new HuntressAccount(id, Text(e, "name"), Text(e, "subdomain"), Text(e, "status")) : null;

    internal static HuntressOrganization? ReadOrganization(JsonElement e) =>
        Long(e, "id") is { } id
            ? new HuntressOrganization(
                id,
                Text(e, "name") ?? $"#{id.ToString(CultureInfo.InvariantCulture)}",
                Text(e, "key"),
                Int(e, "agents_count"),
                Int(e, "incident_reports_count"),
                Int(e, "billable_identity_count"),
                Int(e, "sat_learner_count"),
                Int(e, "logs_sources_count"),
                Date(e, "created_at"),
                Date(e, "updated_at"))
            : null;

    /// <summary>
    /// The usage of one organization (<c>actual_usages</c>). The reference types the field as a string with an object as its example,
    /// so a string holding JSON is read as well; identities are summed over the identity providers of the organization.
    /// </summary>
    internal static HuntressUsage? ReadUsage(JsonElement e)
    {
        if (Long(e, "id") is not { } id)
        {
            return null;
        }

        var usage = Object(e, "actual_usages");
        var edr = usage is { } u ? Object(u, "edr") : null;
        var identities = usage is { } v && TryGet(v, out var itdr, "itdr") && itdr.ValueKind == JsonValueKind.Array
            ? itdr.EnumerateArray().Select(item => Int(item, "billable_identities_count")).Where(n => n is not null).Sum(n => n!.Value)
            : (int?)null;
        return new HuntressUsage(
            id,
            edr is { } a ? Int(a, "billable_agents_count") : null,
            edr is { } b ? Int(b, "unresponsive_agents_count") : null,
            edr is { } c ? Int(c, "outdated_agents_count") : null,
            edr is { } d ? Int(d, "isolated_agents_count") : null,
            identities ?? Int(e, "billable_identity_count"),
            (usage is { } s && Object(s, "sat") is { } sat ? Int(sat, "learners_count") : null) ?? Int(e, "sat_learner_count"),
            (usage is { } l && Object(l, "siem") is { } siem ? Int(siem, "billable_log_sources_count") : null) ?? Int(e, "logs_sources_count"));
    }

    internal static HuntressAgent? ReadAgent(JsonElement e) =>
        Long(e, "id") is { } id && Long(e, "organization_id") is { } organizationId
            ? new HuntressAgent(
                id,
                organizationId,
                Text(e, "hostname") ?? $"#{id.ToString(CultureInfo.InvariantCulture)}",
                Text(e, "platform")?.ToLowerInvariant(),
                Text(e, "os"),
                Text(e, "version"),
                Date(e, "last_callback_at"))
            {
                SerialNumber = Text(e, "serial_number"),
                MacAddresses = Texts(e, "mac_addresses"),
                // The primary address first, then every other one the host reports.
                Ipv4Addresses = new[] { Text(e, "ipv4_address") }.OfType<string>().Concat(Texts(e, "ipv4_addresses"))
                    .Distinct(StringComparer.OrdinalIgnoreCase).ToList(),
                ExternalIp = Text(e, "external_ip"),
                DomainName = Text(e, "domain_name"),
                OsBuildVersion = Text(e, "os_build_version"),
                EdrVersion = Text(e, "edr_version"),
                DefenderStatus = Text(e, "defender_status"),
                DefenderSubstatus = Text(e, "defender_substatus"),
                DefenderPolicyStatus = Text(e, "defender_policy_status"),
                LastSurveyAt = Date(e, "last_survey_at"),
                FirewallStatus = Text(e, "firewall_status"),
                Tags = Texts(e, "tags"),
                CreatedAt = Date(e, "created_at"),
            }
            : null;

    internal static HuntressIncident? ReadIncident(JsonElement e)
    {
        if (Long(e, "id") is not { } id || Long(e, "organization_id") is not { } organizationId || Text(e, "status") is not { } status)
        {
            return null;
        }

        // The report carries its first ten remediations as { items, has_more, total_count }; tolerate a bare list too.
        var remediations = new List<HuntressRemediation>();
        var all = true;
        if (TryGet(e, out var plan, "remediations"))
        {
            var items = plan.ValueKind == JsonValueKind.Array ? plan : TryGet(plan, out var inner, "items") ? inner : default;
            if (items.ValueKind == JsonValueKind.Array)
            {
                foreach (var item in items.EnumerateArray())
                {
                    remediations.Add(ReadRemediation(item) ?? throw new JsonException($"Incident report {id} holds a remediation without an id."));
                }
            }

            all = !(plan.ValueKind == JsonValueKind.Object && Bool(plan, "has_more") == true);
        }

        return new HuntressIncident(
            id,
            organizationId,
            Long(e, "agent_id"),
            status.ToLowerInvariant(),
            (Text(e, "severity") ?? "low").ToLowerInvariant(),
            Text(e, "subject") ?? $"#{id.ToString(CultureInfo.InvariantCulture)}",
            Text(e, "summary"),
            Text(e, "body"),
            Text(e, "platform")?.ToLowerInvariant(),
            Texts(e, "indicator_types"),
            Counts(e, "indicator_counts"),
            Date(e, "sent_at"),
            Date(e, "closed_at"),
            Date(e, "status_updated_at"),
            Date(e, "updated_at"),
            remediations.OrderBy(r => r.Id).ToList(),
            all);
    }

    internal static HuntressRemediation? ReadRemediation(JsonElement e) =>
        Long(e, "id") is { } id
            ? new HuntressRemediation(
                id,
                (Text(e, "type") ?? "manual").ToLowerInvariant(),
                Text(e, "action"),
                TryGet(e, out var parameters, "parameters") ? (parameters.ValueKind == JsonValueKind.String ? parameters.GetString() : parameters.GetRawText()) : null,
                (Text(e, "status") ?? "unapproved").ToLowerInvariant(),
                Date(e, "approved_at"),
                TryGet(e, out var by, "approved_by") && by.ValueKind == JsonValueKind.Object ? Text(by, "name") ?? Text(by, "email") : null,
                Date(e, "completed_at"))
            : null;

    internal static HuntressComment? ReadComment(JsonElement e) =>
        Long(e, "id") is { } id && Date(e, "created_at") is { } created
            ? new HuntressComment(id, Text(e, "body") ?? string.Empty, Text(e, "author"), created, Date(e, "updated_at"))
            : null;

    internal static HuntressNotice? ReadNotice(HuntressNoticeKind kind, JsonElement e)
    {
        if (Long(e, "id") is not { } id || Text(e, "status") is not { } status)
        {
            return null;
        }

        // Organizations come as { id, name } objects (the reference's example), ids are taken from bare numbers too.
        var organizations = TryGet(e, out var list, "organizations") && list.ValueKind == JsonValueKind.Array
            ? list.EnumerateArray().Select(o => o.ValueKind == JsonValueKind.Object ? Long(o, "id") : Number(o)).OfType<long>().Distinct().ToList()
            : [];
        List<HuntressEntity>? entities = null;
        var all = true;
        if (TryGet(e, out var found, "entities") && found.ValueKind == JsonValueKind.Object && TryGet(found, out var items, "items") &&
            items.ValueKind == JsonValueKind.Array)
        {
            entities = items.EnumerateArray().Where(i => i.ValueKind == JsonValueKind.Object).Select(ReadEntity).ToList();
            all = Bool(found, "has_more") != true;
        }

        return new HuntressNotice(
            kind,
            id,
            organizations,
            status.ToLowerInvariant(),
            (Text(e, "severity") ?? "low").ToLowerInvariant(),
            Text(e, "subject") ?? $"#{id.ToString(CultureInfo.InvariantCulture)}",
            Text(e, "type"),
            Text(e, "type_code"),
            Text(e, "subtype"),
            Date(e, "created_at") ?? Date(e, "updated_at") ?? DateTimeOffset.MinValue,
            Date(e, "resolved_at"),
            Date(e, "updated_at"))
        {
            Entities = entities,
            AllEntities = all,
        };
    }

    /// <summary>An entity of a notice by the name a person knows it by: a host name, an account, a mailbox.</summary>
    private static HuntressEntity ReadEntity(JsonElement e)
    {
        var details = TryGet(e, out var d, "details") && d.ValueKind == JsonValueKind.Object ? d : default;
        var name = details.ValueKind == JsonValueKind.Object
            ? Text(details, "hostname") ?? Text(details, "display_name") ?? Text(details, "name") ?? Text(details, "email") ?? Text(details, "username")
              ?? Text(details, "user_principal_name")
            : null;
        return new HuntressEntity(Text(e, "type") ?? "Unknown", Text(e, "id"), name ?? Text(e, "name"));
    }

    internal static HuntressReport? ReadReport(JsonElement e)
    {
        if (Long(e, "id") is not { } id || Long(e, "organization_id") is not { } organizationId)
        {
            return null;
        }

        // The period is written "start...end".
        var period = Text(e, "period")?.Split("...", StringSplitOptions.TrimEntries);
        return new HuntressReport(
            id,
            organizationId,
            (Text(e, "type") ?? "monthly_summary").ToLowerInvariant(),
            period is [var start, _] ? Day(start) : null,
            period is [_, var end] ? Day(end) : null,
            Text(e, "url"),
            Int(e, "agents_count"),
            Int(e, "incidents_reported"),
            Int(e, "incidents_resolved"),
            Long(e, "signals_detected"),
            Long(e, "signals_investigated"),
            Long(e, "events_analyzed"),
            Date(e, "created_at"),
            Date(e, "updated_at"));
    }

    private static DateOnly? Day(string text) =>
        DateOnly.TryParseExact(text, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var day) ? day : null;

    /// <summary>An object, or a string that holds one (as the reference types <c>actual_usages</c>).</summary>
    private static JsonElement? Object(JsonElement e, string name)
    {
        if (!TryGet(e, out var v, name))
        {
            return null;
        }

        if (v.ValueKind == JsonValueKind.Object)
        {
            return v;
        }

        if (v.ValueKind == JsonValueKind.String && v.GetString() is { Length: > 1 } text && text.TrimStart().StartsWith('{'))
        {
            try
            {
                using var document = JsonDocument.Parse(text);
                return document.RootElement.Clone();
            }
            catch (JsonException)
            {
                return null;
            }
        }

        return null;
    }

    /// <summary>A map of names to whole numbers; a value that is not one is left out.</summary>
    private static Dictionary<string, int> Counts(JsonElement e, string name) =>
        TryGet(e, out var v, name) && v.ValueKind == JsonValueKind.Object
            ? v.EnumerateObject().Where(p => p.Value.ValueKind == JsonValueKind.Number && p.Value.TryGetInt32(out _))
                .ToDictionary(p => p.Name, p => p.Value.GetInt32(), StringComparer.Ordinal)
            : new Dictionary<string, int>(StringComparer.Ordinal);

    /// <summary>A list of texts: a JSON array of strings; an entry that is not text is left out.</summary>
    private static List<string> Texts(JsonElement e, string name) =>
        TryGet(e, out var v, name) && v.ValueKind == JsonValueKind.Array
            ? v.EnumerateArray().Where(item => item.ValueKind == JsonValueKind.String).Select(item => item.GetString()!.Trim())
                .Where(s => s.Length > 0).Distinct(StringComparer.OrdinalIgnoreCase).ToList()
            : [];

    private static bool TryGet(JsonElement element, out JsonElement value, string name)
    {
        if (element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out value) && value.ValueKind != JsonValueKind.Null)
        {
            return true;
        }

        value = default;
        return false;
    }

    private static string? Text(JsonElement e, string name)
    {
        if (!TryGet(e, out var v, name))
        {
            return null;
        }

        var text = (v.ValueKind == JsonValueKind.String ? v.GetString() : v.GetRawText())?.Trim();
        return string.IsNullOrEmpty(text) ? null : text;
    }

    private static long? Number(JsonElement v) =>
        v.ValueKind == JsonValueKind.Number && v.TryGetInt64(out var n) ? n
        : v.ValueKind == JsonValueKind.String && long.TryParse(v.GetString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var p) ? p : null;

    private static long? Long(JsonElement e, string name) => TryGet(e, out var v, name) ? Number(v) : null;

    private static int? Int(JsonElement e, string name) => Long(e, name) is { } n && n is >= int.MinValue and <= int.MaxValue ? (int)n : null;

    private static bool? Bool(JsonElement e, string name) =>
        TryGet(e, out var v, name) && v.ValueKind is JsonValueKind.True or JsonValueKind.False ? v.GetBoolean() : null;

    private static DateTimeOffset? Date(JsonElement e, string name) =>
        Text(e, name) is { } s && DateTimeOffset.TryParse(s, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var d) ? d : null;
}
