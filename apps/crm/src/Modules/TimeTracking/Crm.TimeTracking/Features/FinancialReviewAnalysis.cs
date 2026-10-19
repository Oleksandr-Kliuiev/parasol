using System.Globalization;
using Crm.Billing.Contracts;
using Crm.Contracts.Contracts;
using Crm.TimeTracking.Contracts;
using Crm.TimeTracking.Domain;

namespace Crm.TimeTracking.Features;

internal sealed record FinancialReviewAnalysis(IReadOnlyList<FinancialReviewFinding> Findings,
    IReadOnlyList<FinancialBankReview> Banks, IReadOnlyList<FinancialBillingReview> Billing)
{
    internal bool RequiresReview => Findings.Any(f => f.Level == FinancialFindingLevel.Review);

    internal static FinancialReviewAnalysis Evaluate(TimeEntry entry, IReadOnlyCollection<Guid> historicalAllocationIds,
        IReadOnlyList<SourceBankUsage> receipts, IReadOnlyList<HourBankReviewRef> references,
        IReadOnlyList<TimeBillingClaim> claims, bool closed)
    {
        var findings = new Dictionary<string, FinancialFindingLevel>(StringComparer.Ordinal);
        void Add(string code, FinancialFindingLevel level = FinancialFindingLevel.Review) => findings[code] = level;
        if (!string.IsNullOrWhiteSpace(entry.ReviewNote)) Add("SAVED_REVIEW_NOTE");
        if (closed) Add("PERIOD_CLOSED", FinancialFindingLevel.Info);
        var active = entry.CurrentAllocations.ToList();
        var allocated = active.Where(a => a.HourBankId is not null).GroupBy(a => a.HourBankId!.Value)
            .ToDictionary(g => g.Key, g => g.Sum(a => a.Hours));
        foreach (var receipt in receipts)
        {
            var parts = receipt.SourceId.Split(':');
            if (!receipt.Consistent || parts.Length != 3 || !int.TryParse(parts[1], NumberStyles.None, CultureInfo.InvariantCulture, out var approval)
                || approval < 1 || approval > entry.ApprovalCount + 1
                || receipt.SourceId != string.Create(CultureInfo.InvariantCulture, $"{entry.Id}:{approval}:{receipt.HourBankId}"))
            { Add("BANK_HISTORY_UNPROVEN"); continue; }
            if (approval == entry.ApprovalCount + 1) Add("BANK_PENDING_APPROVAL");
            if (approval < entry.ApprovalCount && receipt.ConsumedHours != receipt.ReturnedHours) Add("BANK_HISTORY_UNPROVEN");
            if (approval == entry.ApprovalCount && entry.Status != TimeEntryStatus.New && receipt.Date != entry.WorkDate) Add("BANK_HISTORY_UNPROVEN");
        }
        var refs = references.ToDictionary(r => r.Id);
        var banks = new List<FinancialBankReview>();
        foreach (var id in receipts.Select(r => r.HourBankId).Concat(allocated.Keys).Distinct().Order())
        {
            var rows = receipts.Where(r => r.HourBankId == id).ToList();
            var expected = allocated.GetValueOrDefault(id); var consumed = rows.Sum(r => r.ConsumedHours);
            var returned = rows.Sum(r => r.ReturnedHours); var net = consumed - returned;
            if (expected != net) Add("BANK_ALLOCATION_MISMATCH");
            var reference = refs.GetValueOrDefault(id); var same = reference?.OrganizationId == entry.OrganizationId;
            if (reference is null || !same || reference.Deleted && (net != 0 || expected != 0)) Add("BANK_REFERENCE_UNAVAILABLE");
            banks.Add(new(id, same ? reference?.Name : null, reference is null ? "Missing" : !same ? "OtherOrganization" : reference.Deleted ? "Deleted" : reference.Status,
                reference is not null && same && !reference.Deleted, expected, consumed, returned, net, rows.Count));
        }

        var currentIds = active.Select(a => a.Id).ToHashSet(); var ownedIds = historicalAllocationIds.ToHashSet();
        var exported = new HashSet<Guid>(); var billing = new List<FinancialBillingReview>();
        foreach (var group in claims.GroupBy(c => c.BasisId).OrderBy(g => g.Key))
        {
            var proven = group.All(c => c.Proven && c.OrganizationId == entry.OrganizationId);
            var current = proven && group.All(c => c.EntryIds.Contains(entry.Id)
                && c.AllocationIds.Any(ownedIds.Contains)
                && c.AllocationIds.Where(ownedIds.Contains).All(currentIds.Contains));
            if (!proven || !current) Add("BILLING_SOURCE_UNPROVEN");
            var matching = group.SelectMany(c => c.AllocationIds).Where(currentIds.Contains).Distinct().ToList();
            var sent = group.Any(c => c.Exported);
            if (sent && proven && current) exported.UnionWith(matching);
            billing.Add(new(group.Key, sent, proven, current, matching.Count));
        }
        if (billing.Count > 0) Add("BILLING_PROTECTED", FinancialFindingLevel.Info);
        if (exported.Count > 0 && exported.Count < currentIds.Count) Add("PARTIAL_EXPORT", FinancialFindingLevel.Info);
        if (entry.Status == TimeEntryStatus.Invoiced && (currentIds.Count == 0 || !currentIds.IsSubsetOf(exported))) Add("BILLING_SOURCE_UNPROVEN");
        return new(findings.Select(f => new FinancialReviewFinding(f.Key, f.Value)).ToList(), banks, billing);
    }
}
