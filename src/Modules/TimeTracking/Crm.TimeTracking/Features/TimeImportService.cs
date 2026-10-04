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
            .Select(e => new { e.OrganizationId, e.Hours, e.Amount, Billed = e.Allocations.Sum(a => a.BilledHours) })
            .ToListAsync(cancellationToken);

        return rows
            .GroupBy(r => r.OrganizationId)
            .Select(g => new HoursByOrganization(
                g.Key,
                decimal.Round(g.Sum(r => r.Hours), 2),
                decimal.Round(g.Sum(r => r.Billed), 2),
                decimal.Round(g.Sum(r => r.Amount ?? 0m), 2)))
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
            .Select(e => new { ProjectId = e.ProjectId!.Value, e.Hours, e.Billable, e.Amount })
            .ToListAsync(cancellationToken);

        return rows
            .GroupBy(r => r.ProjectId)
            .Select(g => new ProjectHours(
                g.Key,
                decimal.Round(g.Sum(r => r.Hours), 2),
                decimal.Round(g.Where(r => r.Billable).Sum(r => r.Hours), 2),
                decimal.Round(g.Sum(r => r.Amount ?? 0m), 2)))
            .ToList();
    }

    public async Task<IReadOnlyList<TechnicianUtilization>> GetUtilizationAsync(int year, int month, CancellationToken cancellationToken)
    {
        var monthStart = new DateOnly(year, month, 1);
        var monthEnd = monthStart.AddMonths(1).AddDays(-1);
        var entries = await db.TimeEntries.AsNoTracking()
            .Where(e => e.WorkDate >= monthStart && e.WorkDate <= monthEnd)
            .Select(e => new { e.Id, e.TechnicianId, e.TechnicianName, e.Hours, e.Status })
            .ToListAsync(cancellationToken);
        var allocations = await (
                from allocation in db.TimeAllocations.AsNoTracking()
                join entry in db.TimeEntries.AsNoTracking() on allocation.TimeEntryId equals entry.Id
                where entry.WorkDate >= monthStart && entry.WorkDate <= monthEnd
                select new { entry.TechnicianId, entry.TechnicianName, allocation.Classification, allocation.Hours, allocation.BilledHours })
            .ToListAsync(cancellationToken);

        // Entries still waiting for approval have no allocations yet; their hours count as not yet billable.
        var unapproved = entries.Where(e => e.Status is TimeEntryStatus.New).ToList();

        var keys = allocations.Select(a => (a.TechnicianId, Name: a.TechnicianName ?? "—"))
            .Concat(unapproved.Select(e => (e.TechnicianId, Name: e.TechnicianName ?? "—")))
            .Distinct()
            .ToList();

        return keys
            .Select(key =>
            {
                var mine = allocations.Where(a => a.TechnicianId == key.TechnicianId && (a.TechnicianName ?? "—") == key.Name).ToList();
                var pending = unapproved.Where(e => e.TechnicianId == key.TechnicianId && (e.TechnicianName ?? "—") == key.Name).Sum(e => e.Hours);
                var billed = mine.Where(a => a.Classification == TimeClassification.Rate).Sum(a => a.BilledHours);
                var covered = mine.Where(a => a.Classification == TimeClassification.Covered).Sum(a => a.Hours);
                var bank = mine.Where(a => a.Classification == TimeClassification.HourBank).Sum(a => a.Hours);
                var nonBillable = mine.Where(a => a.Classification == TimeClassification.NonBillable).Sum(a => a.Hours) + pending;
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
