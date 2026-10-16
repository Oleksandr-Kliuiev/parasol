using Crm.Billing.Contracts;
using Crm.Identity.Contracts;
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
internal sealed class TimeImportService(TimeTrackingDbContext db, TimeApprovalService approvals) : ITimeTrackingApi
{
    public async Task<TimeImportResult> ImportAsync(IReadOnlyCollection<ExternalTimeEntry> entries, CancellationToken cancellationToken)
    {
        int created = 0, updated = 0, unchanged = 0, review = 0;
        var closedPeriods = await db.TimePeriods.AsNoTracking().Where(p => p.IsClosed).Select(p => new { p.Year, p.Month }).ToListAsync(cancellationToken);
        bool IsClosed(DateOnly date) => closedPeriods.Any(p => p.Year == date.Year && p.Month == date.Month);

        foreach (var group in entries.GroupBy(e => e.System))
        {
            var source = Enum.TryParse<TimeSource>(group.Key, ignoreCase: true, out var parsed) ? parsed : TimeSource.Atera;
            var ids = group.Select(e => e.ExternalId).Distinct().ToList();
            var existing = await db.TimeEntries.Include(e => e.Allocations)
                .Where(e => e.Source == source && e.ExternalId != null && ids.Contains(e.ExternalId))
                .ToDictionaryAsync(e => e.ExternalId!, cancellationToken);

            foreach (var incoming in group.DistinctBy(e => e.ExternalId))
            {
                if (!existing.TryGetValue(incoming.ExternalId, out var entry))
                {
                    entry = TimeEntry.FromSource(incoming);
                    if (IsClosed(entry.WorkDate))
                    {
                        entry.FlagForReview("Arrived after the period was closed.");
                        review++;
                    }

                    db.TimeEntries.Add(entry);
                    created++;
                    continue;
                }

                if (entry.Status == TimeEntryStatus.Invoiced)
                {
                    if (entry.DiffersFrom(incoming))
                    {
                        entry.FlagForReview("Changed in the service desk after it was invoiced; correct it in the next period.");
                        review++;
                    }

                    continue;
                }

                if (!entry.DiffersFrom(incoming))
                {
                    unchanged++;
                    continue;
                }

                if (entry.Status is TimeEntryStatus.Approved or TimeEntryStatus.NonBillable)
                {
                    if (IsClosed(entry.WorkDate))
                    {
                        entry.FlagForReview("Changed in the service desk while the period is closed.");
                        review++;
                        continue;
                    }

                    await approvals.WithdrawAsync(entry, cancellationToken);
                }

                entry.ApplySource(incoming);
                updated++;
            }

            await db.SaveChangesAsync(cancellationToken);
        }

        return new TimeImportResult(created, updated, unchanged, review);
    }

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

        // Allocations of a withdrawn approval are soft-deleted and filtered out by the query filter, so what is left is current.
        return rows
            .Select(r => new BillableTime(
                r.Id, r.AllocationId, r.OrganizationId, r.Classification, r.WorkDate, r.Hours, r.BilledHours, r.Rate, r.Amount,
                r.HourBankId, r.WorkType, r.AfterHours, r.Onsite, r.Description, r.ExternalTicketId, r.TicketTitle, r.TechnicianName,
                r.Status == TimeEntryStatus.Invoiced))
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

        return keys
            .Select(key =>
            {
                var mine = approvedByTechnician.GetValueOrDefault(key);
                var billed = mine?.Billed ?? 0m;
                var covered = mine?.Covered ?? 0m;
                var bank = mine?.Bank ?? 0m;
                var nonBillable = (mine?.NonBillable ?? 0m) + pendingByTechnician.GetValueOrDefault(key);
                return new TechnicianUtilization(
                    key.TechnicianId,
                    key.Name,
                    decimal.Round(billed, 2),
                    decimal.Round(covered, 2),
                    decimal.Round(bank, 2),
                    decimal.Round(nonBillable, 2),
                    decimal.Round(billed + covered + bank + nonBillable, 2));
            })
            .OrderByDescending(u => u.TotalHours)
            .ToList();
    }

}

/// <summary>
/// Approved hours become invoiced once their basis left the CRM (BR-BIL-08); from then on corrections go into a later
/// period. Billing names the entries; this module changes them, in its own transaction with its receipt (DEV-07).
/// </summary>
internal sealed class BasisExportedHandler(TimeTrackingDbContext db, IBillingApi billing, ILogger<BasisExportedHandler> logger)
    : Crm.SharedKernel.Domain.IDomainEventHandler<BillingBasisExported>
{
    public async Task HandleAsync(BillingBasisExported domainEvent, CancellationToken cancellationToken)
    {
        var ids = await billing.GetInvoicedTimeEntryIdsAsync(domainEvent.BasisId, cancellationToken);
        if (ids.Count == 0)
        {
            return;
        }

        var entries = await db.TimeEntries.Where(e => ids.Contains(e.Id) && e.Status == TimeEntryStatus.Approved).ToListAsync(cancellationToken);
        foreach (var entry in entries)
        {
            entry.MarkInvoiced();
        }

        await db.SaveChangesAsync(cancellationToken);
        logger.LogInformation("Basis {BasisId} exported as {OrderNo}: {Count} time entries marked invoiced.", domainEvent.BasisId, domainEvent.OrderNo, entries.Count);
    }
}

/// <summary>An administrator mapped an Atera technician to a CRM user: entries imported earlier get their technician.</summary>
internal sealed class TechnicianMappingHandler(TimeTrackingDbContext db) : Crm.SharedKernel.Domain.IDomainEventHandler<TechnicianMappingChanged>
{
    public async Task HandleAsync(TechnicianMappingChanged domainEvent, CancellationToken cancellationToken)
    {
        if (domainEvent.UserId is not { } userId)
        {
            return;
        }

        await db.TimeEntries
            .Where(e => e.TechnicianExternalId == domainEvent.ExternalId && e.TechnicianId != userId)
            .ExecuteUpdateAsync(u => u.SetProperty(e => e.TechnicianId, userId), cancellationToken);
    }
}
