using System.Text.Json;
using System.Text.RegularExpressions;
using static Crm.Integrations.Core.Parasol.AtlasProjectionJson;

namespace Crm.Integrations.Core.Parasol;

internal static class AtlasObservationProjection
{
    internal static AtlasObservationList Read(JsonElement page, AtlasCustomerReference expected, string mode,
        int total, IReadOnlyDictionary<string, int> counts, IReadOnlyList<AtlasDeviceView> devices)
    {
        var ids = new HashSet<string>(StringComparer.Ordinal);
        var items = new List<(AtlasObservationView View, DateTimeOffset CreatedAt)>();
        var byDevice = devices.ToDictionary(d => d.Id, StringComparer.Ordinal);
        foreach (var row in Array(page, "items", 100))
        {
            Scope(row, expected);
            var id = Text(row, "id");
            Require(ids.Add(id));
            var severity = Choice(row, "severity", Severities);
            var priority = Choice(row, "priority", ["NORMAL", "URGENT"]);
            Require(priority == (severity is "HIGH" or "CRITICAL" ? "URGENT" : "NORMAL"));
            var kind = Choice(row, "kind", ["DISK_CAPACITY", "SECURITY_INCIDENT"]);
            var domain = Choice(row, "domain", ["OPERATIONS", "SECURITY"]);
            Require(domain == (kind == "DISK_CAPACITY" ? "OPERATIONS" : "SECURITY"));
            var source = Choice(row, "source", Sources);
            var entityId = NullableId(row, "entityId");
            var device = entityId is not null && byDevice.TryGetValue(entityId, out var found) && found.Sources.Contains(source) ? found : null;
            var deviceStatus = entityId is null ? "UNRESOLVED" : device is null ? "UNAVAILABLE" : "CONFIRMED";
            var created = Date(row, "createdAt") ?? throw new JsonException();
            var updated = Date(row, "updatedAt") ?? throw new JsonException();
            Require(updated >= created);
            items.Add((new(id, Text(row, "summary", 300, allowEmpty: true, multiline: true), source, Choice(row, "resourceType", ResourceTypes),
                kind, domain, severity, priority, Choice(row, "route", ["MONITOR", "INVESTIGATE", "HUMAN_REVIEW"]),
                Choice(row, "status", ["OPEN", "ACKNOWLEDGED"]), Date(row, "occurredAt") ?? throw new JsonException(),
                updated, deviceStatus, device?.Id), created));
        }
        var truncated = page.GetProperty("truncated").GetBoolean();
        var cursor = page.GetProperty("nextCursor");
        Require(total >= items.Count && truncated == (total > items.Count));
        Require(truncated ? items.Count > 0 && cursor.ValueKind == JsonValueKind.String
            && Regex.IsMatch(cursor.GetString()!, @"\A[A-Za-z0-9_-]{1,400}\z", RegexOptions.CultureInvariant) : cursor.ValueKind == JsonValueKind.Null);
        Require(mode != "fixture" || !truncated);
        foreach (var severity in Severities)
        {
            var returned = items.Count(i => i.View.Severity == severity);
            Require(truncated ? returned <= counts[severity] : returned == counts[severity]);
        }
        return new(items.OrderByDescending(i => System.Array.IndexOf(Severities, i.View.Severity))
            .ThenByDescending(i => i.CreatedAt).ThenBy(i => i.View.Id, StringComparer.Ordinal).Select(i => i.View).ToArray(), truncated);
    }
}
