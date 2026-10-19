using System.Text.Json;
using Crm.Billing.Contracts;
using Crm.Billing.Domain;
using Crm.TimeTracking.Contracts;

namespace Crm.Billing.Features;

internal static class TimeBillingSources
{
    internal static IReadOnlyList<TimeBillingSelection> Selections(IEnumerable<BillingBasis> bases) => bases
        .SelectMany(b => b.BilledLines.Select(l => Read(b.Id, l.SourceOrganizationId ?? b.OrganizationId, l.SourceRefs,
            l.Origin == BillingLineOrigin.Collected && l.Group is BillingGroup.HourlyWork or BillingGroup.Info, false)))
        .OfType<TimeBillingClaim>().Select(c => new TimeBillingSelection(c.OrganizationId, c.EntryIds, c.AllocationIds, c.Proven)).ToList();

    internal static TimeBillingClaim? Read(Guid basis, Guid organization, string? json, bool timeLine, bool exported)
    {
        try
        {
            if (json is null) return timeLine ? Unknown() : null;
            using var document = JsonDocument.Parse(json);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("timeEntryIds", out var entries))
                return timeLine ? Unknown() : null;
            var entryIds = Ids(entries);
            var allocationIds = root.TryGetProperty("allocationIds", out var allocations) ? Ids(allocations) : [];
            var uniqueFields = root.EnumerateObject().GroupBy(p => p.Name, StringComparer.Ordinal).All(g => g.Count() == 1);
            return new(basis, organization, entryIds, allocationIds,
                uniqueFields && Valid(entries, entryIds) && root.TryGetProperty("allocationIds", out allocations) && Valid(allocations, allocationIds), exported);
        }
        catch (JsonException) { return timeLine ? Unknown() : null; }
        TimeBillingClaim Unknown() => new(basis, organization, [], [], false, exported);
    }

    private static List<Guid> Ids(JsonElement value) => value.ValueKind != JsonValueKind.Array ? [] : value.EnumerateArray()
        .Where(e => e.ValueKind == JsonValueKind.String).Select(e => Guid.TryParse(e.GetString(), out var id) ? id : Guid.Empty)
        .Where(id => id != Guid.Empty).ToList();

    private static bool Valid(JsonElement value, List<Guid> ids) => value.ValueKind == JsonValueKind.Array && ids.Count > 0
        && value.GetArrayLength() == ids.Count && ids.Distinct().Count() == ids.Count;
}
