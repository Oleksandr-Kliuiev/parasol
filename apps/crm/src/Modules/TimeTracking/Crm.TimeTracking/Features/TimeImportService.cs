using Crm.Billing.Contracts;
using Crm.Identity.Contracts;
using Crm.Infrastructure.Persistence;
using Crm.TimeTracking.Contracts;
using Crm.TimeTracking.Domain;
using Crm.TimeTracking.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace Crm.TimeTracking.Features;

/// <summary>
/// Work hours coming from the service desk (BR-TIM-01/02). An entry that changed after it was invoiced is flagged for Finance instead of
/// being rewritten; an approved entry that changed is withdrawn so it is approved again with the new hours.
/// </summary>
internal sealed partial class TimeImportService(TimeTrackingDbContext db, TimeApprovalService approvals, TimeBankTransaction financial, TimeBillingGuard billing,
    IUserDirectory users) : ITimeTrackingApi
{
    public async Task<IReadOnlyList<BillableTime>> GetBillableTimeAsync(DateOnly periodStart, DateOnly periodEnd, CancellationToken cancellationToken)
    {
        var rows = await (
                from allocation in db.TimeAllocations.AsNoTracking()
                join entry in db.TimeEntries.AsNoTracking() on allocation.TimeEntryId equals entry.Id
                where entry.WorkDate >= periodStart && entry.WorkDate <= periodEnd &&
                      (entry.Status == TimeEntryStatus.Approved || entry.Status == TimeEntryStatus.Invoiced)
                select new
                {
                    entry.Id,
                    AllocationId = allocation.Id,
                    entry.OrganizationId,
                    allocation.Classification,
                    entry.WorkDate,
                    allocation.Hours,
                    allocation.BilledHours,
                    allocation.Rate,
                    allocation.Amount,
                    allocation.HourBankId,
                    entry.WorkType,
                    entry.AfterHours,
                    entry.Onsite,
                    entry.Description,
                    entry.ExternalTicketId,
                    entry.TicketTitle,
                    entry.TechnicianName,
                    entry.Status,
                })
            .ToListAsync(cancellationToken);

        var claims = await billing.ReadEntriesAsync(rows.Select(r => new TimeBillingEntry(r.Id, r.OrganizationId)).Distinct().ToList(), cancellationToken);
        if (claims.Any(c => !c.Proven)) throw new TimeBillingReviewException();
        var owners = rows.GroupBy(r => r.Id).ToDictionary(g => g.Key, g => g.First().OrganizationId);
        if (claims.Any(c => c.EntryIds.Any(id => owners.TryGetValue(id, out var owner) && owner != c.OrganizationId)))
            throw new TimeBillingReviewException();
        var exported = claims.Where(c => c.Exported).SelectMany(c => c.AllocationIds).ToHashSet();
        var knownEntries = claims.Where(c => c.Exported).SelectMany(c => c.EntryIds).ToHashSet();
        var active = rows.GroupBy(r => r.Id).ToDictionary(g => g.Key, g => g.Select(r => r.AllocationId).ToHashSet());
        if (claims.Where(c => c.Exported).Any(c => c.EntryIds.Any(id => active.TryGetValue(id, out var allocations)
            && !c.AllocationIds.Any(allocations.Contains)))) throw new TimeBillingReviewException();
        if (rows.Any(r => r.Status == TimeEntryStatus.Invoiced && knownEntries.Contains(r.Id) && !exported.Contains(r.AllocationId)))
            throw new TimeBillingReviewException();
        // An entry remains Approved while only a subset was exported (for example an excluded Rate alongside Info).
        // Billing must omit the exported allocations only, preserving the remaining obligation for a later basis.
        // Keep the old terminal fallback solely where no exact historical source snapshot is available.
        return rows
            .Select(r => new BillableTime(
                r.Id, r.AllocationId, r.OrganizationId, r.Classification, r.WorkDate, r.Hours, r.BilledHours, r.Rate, r.Amount,
                r.HourBankId, r.WorkType, r.AfterHours, r.Onsite, r.Description, r.ExternalTicketId, r.TicketTitle, r.TechnicianName,
                exported.Contains(r.AllocationId) || r.Status == TimeEntryStatus.Invoiced && !knownEntries.Contains(r.Id)))
            .ToList();
    }

    public async Task<IReadOnlyList<HoursByOrganization>> GetHoursByOrganizationAsync(
        DateOnly periodStart, DateOnly periodEnd, CancellationToken cancellationToken)
    {
        var rows = await db.TimeEntries.AsNoTracking()
            .Where(e => e.WorkDate >= periodStart && e.WorkDate <= periodEnd && e.Status != TimeEntryStatus.New)
            .GroupBy(e => e.OrganizationId)
            .Select(g => new { OrganizationId = g.Key, Hours = g.Sum(e => e.Hours), Amount = g.Sum(e => e.Amount ?? 0m) })
            .ToListAsync(cancellationToken);
        // Aggregate the allocations separately so joining them cannot multiply an entry's hours or amount.
        var billed = await (
                from allocation in db.TimeAllocations.AsNoTracking()
                join entry in db.TimeEntries.AsNoTracking() on allocation.TimeEntryId equals entry.Id
                where entry.WorkDate >= periodStart && entry.WorkDate <= periodEnd && entry.Status != TimeEntryStatus.New
                group allocation by entry.OrganizationId into totals
                select new { OrganizationId = totals.Key, Hours = totals.Sum(a => a.BilledHours) })
            .ToDictionaryAsync(g => g.OrganizationId, g => g.Hours, cancellationToken);

        return rows
            .Select(r => new HoursByOrganization(
                r.OrganizationId,
                decimal.Round(r.Hours, 2),
                decimal.Round(billed.GetValueOrDefault(r.OrganizationId), 2),
                decimal.Round(r.Amount, 2)))
            .ToList();
    }

    public async Task<IReadOnlyList<ProjectHours>> GetProjectHoursAsync(IReadOnlyCollection<Guid> projectIds, CancellationToken cancellationToken)
    {
        if (projectIds.Count == 0)
        {
            return [];
        }

        var rows = await db.TimeEntries.AsNoTracking()
            .Where(e => e.ProjectId != null && projectIds.Contains(e.ProjectId!.Value))
            .GroupBy(e => e.ProjectId!.Value)
            .Select(g => new { ProjectId = g.Key, Hours = g.Sum(e => e.Hours), BillableHours = g.Sum(e => e.Billable ? e.Hours : 0m), Amount = g.Sum(e => e.Amount ?? 0m) })
            .ToListAsync(cancellationToken);

        return rows
            .Select(r => new ProjectHours(
                r.ProjectId,
                decimal.Round(r.Hours, 2),
                decimal.Round(r.BillableHours, 2),
                decimal.Round(r.Amount, 2)))
            .ToList();
    }

    public async Task<IReadOnlyList<TechnicianUtilization>> GetUtilizationAsync(int year, int month, CancellationToken cancellationToken)
    {
        var monthStart = new DateOnly(year, month, 1);
        var monthEnd = monthStart.AddMonths(1).AddDays(-1);
        var unapproved = await db.TimeEntries.AsNoTracking()
            .Where(e => e.WorkDate >= monthStart && e.WorkDate <= monthEnd && e.Status == TimeEntryStatus.New)
            // Match the old ordinal in-memory name grouping, including case and trailing spaces.
            .GroupBy(e => new { e.TechnicianId, Name = EF.Functions.Collate(e.TechnicianName ?? "—", "Latin1_General_100_BIN2"), NameLength = EF.Functions.DataLength(e.TechnicianName ?? "—") })
            .Select(g => new { g.Key.TechnicianId, g.Key.Name, Hours = g.Sum(e => e.Hours) })
            .ToListAsync(cancellationToken);
        var allocations = await (
                from allocation in db.TimeAllocations.AsNoTracking()
                join entry in db.TimeEntries.AsNoTracking() on allocation.TimeEntryId equals entry.Id
                where entry.WorkDate >= monthStart && entry.WorkDate <= monthEnd
                group allocation by new { entry.TechnicianId, Name = EF.Functions.Collate(entry.TechnicianName ?? "—", "Latin1_General_100_BIN2"), NameLength = EF.Functions.DataLength(entry.TechnicianName ?? "—") } into totals
                select new
                {
                    totals.Key.TechnicianId,
                    totals.Key.Name,
                    Billed = totals.Sum(a => a.Classification == TimeClassification.Rate ? a.BilledHours : 0m),
                    Covered = totals.Sum(a => a.Classification == TimeClassification.Covered ? a.Hours : 0m),
                    Bank = totals.Sum(a => a.Classification == TimeClassification.HourBank ? a.Hours : 0m),
                    NonBillable = totals.Sum(a => a.Classification == TimeClassification.NonBillable ? a.Hours : 0m),
                })
            .ToListAsync(cancellationToken);

        // Entries still waiting for approval have no allocations yet; their hours count as not yet billable.
        var approvedByTechnician = allocations.ToDictionary(a => (a.TechnicianId, a.Name));
        var pendingByTechnician = unapproved.ToDictionary(e => (e.TechnicianId, e.Name), e => e.Hours);
        var keys = approvedByTechnician.Keys.Concat(pendingByTechnician.Keys).Distinct();

        var rows = keys
            .Select(key =>
            {
                var mine = approvedByTechnician.GetValueOrDefault(key);
                var nonBillable = (mine?.NonBillable ?? 0m) + pendingByTechnician.GetValueOrDefault(key);
                return (key.TechnicianId, key.Name, Billed: mine?.Billed ?? 0m, Covered: mine?.Covered ?? 0m, Bank: mine?.Bank ?? 0m, NonBillable: nonBillable);
            })
            .ToList();
        // One person is one row under the name the time-entry list shows: hours entered in the CRM store no name, and hours
        // imported under a name meet them by the person's id (the dashboard showed "—" for CRM-entered time). Without an id
        // only the name tells people apart, still compared ordinally. A person the directory does not know keeps the
        // imported name with the most hours (ties in ordinal order), so the row's name never depends on read order.
        var ids = rows.Where(r => r.TechnicianId != null).Select(r => r.TechnicianId!.Value).Distinct().ToList();
        var names = ids.Count == 0 ? new Dictionary<Guid, UserSummary>() : await users.GetUsersAsync(ids, cancellationToken);
        return rows
            .GroupBy(r => r.TechnicianId is { } id ? (object)id : r.Name)
            .Select(g =>
            {
                var id = g.First().TechnicianId;
                var name = id is { } technician && names.TryGetValue(technician, out var user) ? user.DisplayName
                    : g.Where(r => r.Name != "—").OrderByDescending(r => r.Billed + r.Covered + r.Bank + r.NonBillable)
                        .ThenBy(r => r.Name, StringComparer.Ordinal).Select(r => r.Name).FirstOrDefault() ?? "—";
                var billed = g.Sum(r => r.Billed); var covered = g.Sum(r => r.Covered); var bank = g.Sum(r => r.Bank); var nonBillable = g.Sum(r => r.NonBillable);
                return new TechnicianUtilization(id, name, decimal.Round(billed, 2), decimal.Round(covered, 2), decimal.Round(bank, 2),
                    decimal.Round(nonBillable, 2), decimal.Round(billed + covered + bank + nonBillable, 2));
            })
            .OrderByDescending(u => u.TotalHours)
            .ToList();
    }

}
