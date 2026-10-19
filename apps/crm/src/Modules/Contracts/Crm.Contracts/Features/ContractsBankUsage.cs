using Crm.Contracts.Contracts;
using Crm.Contracts.Domain;
using Crm.Contracts.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crm.Contracts.Features;

internal sealed partial class ContractsApi
{
    public async Task<IReadOnlyList<HourBankReviewRef>> GetHourBankReviewRefsAsync(IReadOnlyCollection<Guid> ids, CancellationToken ct)
    {
        var rows = await db.HourBanks.IgnoreQueryFilters().AsNoTracking().Where(b => ids.Contains(b.Id))
            .Select(b => new { b.Id, b.OrganizationId, b.Name, b.Status, b.IsDeleted }).ToListAsync(ct);
        return rows.Select(b => new HourBankReviewRef(b.Id, b.OrganizationId, b.Name, b.Status.ToString(), b.IsDeleted)).ToList();
    }

    public async Task<IReadOnlyList<SourceBankUsage>> GetSourceBankUsageAsync(string sourceType, string sourceIdPrefix, CancellationToken ct)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(sourceType); ArgumentException.ThrowIfNullOrWhiteSpace(sourceIdPrefix);
        await using var joined = await financial.JoinAsync(db, options => new ContractsDbContext(options), ct);
        var read = joined ?? db; var reversal = sourceType + "Reversal";
        var rows = await read.HourBankEntries.IgnoreQueryFilters().AsNoTracking().Where(e =>
            (e.SourceType == sourceType || e.SourceType == reversal) && e.SourceId != null && e.SourceId.StartsWith(sourceIdPrefix))
            .Select(e => new { e.HourBankId, e.SourceId, e.SourceType, e.Kind, e.Date, e.Hours, e.OverageHours, e.IsDeleted }).ToListAsync(ct);
        return rows.GroupBy(e => e.SourceId!).Select(group =>
        {
            var original = group.Where(e => e.SourceType == sourceType).ToList();
            var returned = group.Where(e => e.SourceType == reversal).ToList();
            var first = original.FirstOrDefault() ?? group.First();
            var used = original.Sum(e => -e.Hours); var restored = returned.Sum(e => e.Hours);
            var consistent = original.Count == 1 && returned.Count <= 1 && original[0].Kind == HourBankEntryKind.Consumption
                && original[0].Hours <= 0 && group.All(e => !e.IsDeleted && e.HourBankId == first.HourBankId && e.Date == first.Date)
                && (returned.Count == 0 || returned[0].Kind == HourBankEntryKind.Adjustment && restored == used);
            return new SourceBankUsage(group.Key, first.HourBankId, first.Date, original.Sum(e => -e.Hours + e.OverageHours), used, restored, consistent);
        }).ToList();
    }
}
