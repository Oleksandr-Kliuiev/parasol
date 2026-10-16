using System.Text.Json;
using static Crm.Integrations.Core.Parasol.AtlasProjectionJson;

namespace Crm.Integrations.Core.Parasol;

/// <summary>Closed projection: technical fields only; no people, payloads, financial values or source connection identifiers.</summary>
internal static class AtlasWorkspaceProjection
{
    internal static AtlasWorkspaceSummary Read(JsonElement root, AtlasCustomerReference expected)
    {
        Require(Text(root, "contractVersion") == "ClientContextV1");
        Scope(root, expected);
        var mode = Choice(root, "mode", ["db", "fixture"]);
        var completeness = Choice(root, "completeness", ["PARTIAL", "COMPLETE", "COMPLETE_FIXTURE"]);
        Require((mode == "fixture") == (completeness == "COMPLETE_FIXTURE"));
        var observations = root.GetProperty("observations");
        Object(observations); Object(observations.GetProperty("counts"));
        var counts = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var severity in Severities)
            counts.Add(severity, Count(observations.GetProperty("counts").GetProperty(severity)));
        var total = Count(observations.GetProperty("total"));
        Require(counts.Values.Sum(v => (long)v) == total);
        var resources = new List<AtlasResourceSummary>();
        foreach (var resource in Array(root, "resources", 100))
        {
            Object(resource);
            var source = Choice(resource, "source", Sources);
            var type = Choice(resource, "resourceType", ResourceTypes);
            var status = Choice(resource, "status", ["OK", "STALE", "ERROR", "MISSING", "FIXTURE"]);
            var items = resource.GetProperty("items");
            var available = status is "OK" or "STALE" or "FIXTURE";
            Require(available ? items.ValueKind == JsonValueKind.Array && items.GetArrayLength() <= 1000 : items.ValueKind == JsonValueKind.Null);
            resources.Add(new(source, type, status, Date(resource, "asOf"), Date(resource, "lastSuccessAt"),
                available ? items.GetArrayLength() : null, resource.GetProperty("truncated").GetBoolean()));
        }
        var devices = AtlasDeviceProjection.Read(root, expected);
        var page = AtlasObservationProjection.Read(observations, expected, mode, total, counts, devices);
        return new(mode, Date(root, "generatedAt") ?? throw new JsonException(), completeness,
            devices.Count, root.GetProperty("people").GetArrayLength(), total, counts, resources, devices, page);
    }
}
