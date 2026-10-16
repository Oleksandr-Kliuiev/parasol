using System.Text.Json;
using static Crm.Integrations.Core.Parasol.AtlasProjectionJson;

namespace Crm.Integrations.Core.Parasol;

internal static class AtlasObservationQueueProjection
{
    internal static AtlasObservationQueuePage Read(JsonElement root, AtlasCustomerReference expected,
        AtlasObservationSelection selection, IReadOnlyList<AtlasDeviceView> devices, string? previousCursor)
    {
        Object(root);
        var countsJson = root.GetProperty("counts"); Object(countsJson);
        var counts = Severities.ToDictionary(s => s, s => Count(countsJson.GetProperty(s)), StringComparer.Ordinal);
        var total = Count(root.GetProperty("total"));
        Require(counts.Values.Sum(v => (long)v) == total);
        foreach (var severity in Severities.Except(selection.Severities, StringComparer.Ordinal)) Require(counts[severity] == 0);
        var items = AtlasObservationProjection.ReadItems(root, expected, devices, 25, selection.Statuses);
        Require(total >= items.Count && items.All(i => selection.Severities.Contains(i.Severity, StringComparer.Ordinal)));
        var cursorJson = root.GetProperty("nextCursor");
        var nextCursor = cursorJson.ValueKind == JsonValueKind.Null ? null : cursorJson.GetString();
        var truncated = root.GetProperty("truncated").GetBoolean();
        Require(truncated == (nextCursor is not null));
        Require(nextCursor is null || AtlasObservationCursor.IsAtlasCursor(nextCursor) && nextCursor != previousCursor && items.Count == 25 && total > items.Count);
        // Total/counts describe the entire selection. A terminal continuation can be empty after concurrent changes.
        foreach (var severity in Severities)
        {
            var returned = items.Count(i => i.Severity == severity);
            Require(previousCursor is null && nextCursor is null ? returned == counts[severity] : returned <= counts[severity]);
        }
        return new(total, counts, items, nextCursor);
    }
}
