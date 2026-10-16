using System.Text.Json;

namespace Crm.Integrations.Core.Parasol;

public sealed record AtlasWorkspaceView(Guid CustomerId, string Status, AtlasWorkspaceSummary? Summary = null);
public sealed record AtlasWorkspaceSummary(string Mode, DateTimeOffset GeneratedAt, string Completeness,
    int KnownDevices, int KnownPeople, int ActiveObservations, IReadOnlyDictionary<string, int> SeverityCounts,
    IReadOnlyList<AtlasResourceSummary> Resources);
public sealed record AtlasResourceSummary(string Source, string ResourceType, string Status, DateTimeOffset? AsOf,
    DateTimeOffset? LastSuccessAt, int? ReturnedItems, bool Truncated);

/// <summary>Closed projection: no source payloads, person/device names, financial values or connection identifiers leave the BFF.</summary>
internal static class AtlasWorkspaceProjection
{
    internal static AtlasWorkspaceSummary Read(JsonElement root, AtlasCustomerReference expected)
    {
        Require(Text(root, "contractVersion") == "ClientContextV1");
        Require(Text(root, "workspaceId") == expected.WorkspaceId && Text(root, "clientId") == expected.ClientId);
        var mode = Choice(root, "mode", ["db", "fixture"]);
        var completeness = Choice(root, "completeness", ["PARTIAL", "COMPLETE", "COMPLETE_FIXTURE"]);
        Require((mode == "fixture") == (completeness == "COMPLETE_FIXTURE"));
        var observations = root.GetProperty("observations");
        var counts = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var severity in new[] { "INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL" })
            counts.Add(severity, Count(observations.GetProperty("counts").GetProperty(severity)));
        var total = Count(observations.GetProperty("total"));
        Require(counts.Values.Sum(v => (long)v) == total);
        var resources = new List<AtlasResourceSummary>();
        foreach (var resource in root.GetProperty("resources").EnumerateArray())
        {
            Require(resources.Count < 100);
            var source = Choice(resource, "source", ["atera", "huntress", "microsoft365", "poweroffice"]);
            var type = Choice(resource, "resourceType", ["customer", "organization", "agent", "contact", "alert", "ticket", "incident"]);
            var status = Choice(resource, "status", ["OK", "STALE", "ERROR", "MISSING", "FIXTURE"]);
            var items = resource.GetProperty("items");
            var available = status is "OK" or "STALE" or "FIXTURE";
            Require(available ? items.ValueKind == JsonValueKind.Array : items.ValueKind == JsonValueKind.Null);
            resources.Add(new(source, type, status, Date(resource, "asOf"), Date(resource, "lastSuccessAt"),
                available ? items.GetArrayLength() : null, resource.GetProperty("truncated").GetBoolean()));
        }
        return new(mode, Date(root, "generatedAt") ?? throw new JsonException(), completeness,
            root.GetProperty("devices").GetArrayLength(), root.GetProperty("people").GetArrayLength(), total, counts, resources);
    }

    private static string Text(JsonElement value, string key) => value.GetProperty(key).GetString() ?? throw new JsonException();
    private static string Choice(JsonElement value, string key, string[] allowed)
    {
        var text = Text(value, key);
        Require(allowed.Contains(text, StringComparer.Ordinal));
        return text;
    }
    private static int Count(JsonElement value)
    {
        Require(value.TryGetInt32(out var count) && count >= 0);
        return count;
    }
    private static DateTimeOffset? Date(JsonElement value, string key)
    {
        var date = value.GetProperty(key);
        if (date.ValueKind == JsonValueKind.Null) return null;
        return date.GetDateTimeOffset();
    }
    private static void Require(bool condition)
    {
        if (!condition) throw new JsonException("Invalid Atlas workspace response.");
    }
}
