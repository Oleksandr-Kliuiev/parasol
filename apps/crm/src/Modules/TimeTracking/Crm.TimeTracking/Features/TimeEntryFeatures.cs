using System.Globalization;
using Crm.Authorization;
using Crm.Catalog.Contracts;
using Crm.Customers.Contracts;
using Crm.Identity.Contracts;
using Crm.Infrastructure.Persistence;
using Crm.Projects.Contracts;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Results;
using Crm.TimeTracking.Contracts;
using Crm.TimeTracking.Domain;
using Crm.TimeTracking.Persistence;
using FluentValidation;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Crm.TimeTracking.Features;

internal sealed partial class TimeEntryService(
    TimeTrackingDbContext db,
    DbContextOptions<TimeTrackingDbContext> dbOptions,
    Crm.Service.Contracts.ITicketWorkApi tickets,
    Crm.Activities.Contracts.ITaskWorkApi tasks,
    ICustomersApi customers,
    ICatalogApi catalog,
    IProjectsApi projects,
    IUserDirectory users,
    ICurrentUser currentUser,
    TimeProvider time,
    IOptions<TimeTrackingOptions> options)
{
    public async Task<TimeEntryPage> ListAsync(TimeQuery query, CancellationToken ct)
    {
        var entries = db.TimeEntries.AsQueryable();
        if (query.MineOnly || !currentUser.HasPermission(Permissions.TimeRead))
        {
            var userId = currentUser.UserId;
            entries = entries.Where(e => e.TechnicianId == userId);
        }

        if (query.Year is { } year)
        {
            var from = query.Month is { } month ? new DateOnly(year, month, 1) : new DateOnly(year, 1, 1);
            var to = query.Month is not null ? from.AddMonths(1) : from.AddYears(1);
            entries = entries.Where(e => e.WorkDate >= from && e.WorkDate < to);
        }

        if (query.From is { } fromDate)
        {
            entries = entries.Where(e => e.WorkDate >= fromDate);
        }

        if (query.To is { } toDate)
        {
            entries = entries.Where(e => e.WorkDate <= toDate);
        }

        if (query.OrganizationId is { } organizationId)
        {
            entries = entries.Where(e => e.OrganizationId == organizationId);
        }

        if (query.TechnicianId is { } technicianId)
        {
            entries = entries.Where(e => e.TechnicianId == technicianId);
        }

        if (query.Status is { } status)
        {
            entries = entries.Where(e => e.Status == status);
        }

        if (query.Source is { } source)
        {
            entries = entries.Where(e => e.Source == source);
        }

        // The summary is one SQL aggregate over the whole filter, never a sum of the rows on the page (DEV-12).
        var totals = await entries
            .GroupBy(_ => 1)
            .Select(g => new
            {
                Count = g.Count(),
                Hours = g.Sum(e => e.Hours),
                Billable = g.Sum(e => e.Billable ? e.Hours : 0m),
                Approved = g.Sum(e => e.Status == TimeEntryStatus.Approved || e.Status == TimeEntryStatus.Invoiced ? e.Hours : 0m),
                New = g.Sum(e => e.Status == TimeEntryStatus.New ? e.Hours : 0m),
                Amount = g.Sum(e => e.Amount ?? 0m),
            })
            .SingleOrDefaultAsync(ct);

        // Newest work date first, then id: the order the cursor continues.
        if (KeysetCursor.Decode(query.Cursor) is { } cursor &&
            DateOnly.TryParseExact(cursor.SortKey, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var date))
        {
            entries = entries.Where(e => e.WorkDate < date || (e.WorkDate == date && e.Id.CompareTo(cursor.Id) > 0));
        }

        var limit = KeysetCursor.ClampLimit(query.Limit);
        // Tracked on purpose: each row carries its ETag, so the timesheet can edit an entry without fetching it again.
        var page = await entries.Include(e => e.Allocations).OrderByDescending(e => e.WorkDate).ThenBy(e => e.Id).Take(limit + 1).ToListAsync(ct);
        var rows = page.Take(limit).ToList();
        var closed = await ClosedPeriodsAsync(ct);
        var dtos = await ToDtosAsync(rows, closed, ct);
        var summary = new TimeSummaryDto(totals?.Hours ?? 0m, totals?.Billable ?? 0m, totals?.Approved ?? 0m, totals?.New ?? 0m, totals?.Amount ?? 0m);
        var periodClosed = query is { Year: { } y, Month: { } m } && closed.Contains((y, m));
        var last = rows.LastOrDefault();
        return new TimeEntryPage(
            dtos, summary, periodClosed,
            page.Count > limit && last is not null ? new KeysetCursor(last.WorkDate.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture), last.Id).Encode() : null,
            totals?.Count ?? 0);
    }

    public async Task<Result> AdjustAsync(Guid id, AdjustTimeEntryRequest request, CancellationToken ct)
    {
        if (await db.TimeEntries.SingleOrDefaultAsync(e => e.Id == id, ct) is not { } entry)
        {
            return TimeErrors.NotFound(id);
        }

        if ((await ClosedPeriodsAsync(ct)).Contains((entry.Year, entry.Month)))
        {
            return TimeErrors.PeriodClosed;
        }

        var result = entry.Adjust(request.Billable, request.WorkType, request.AfterHours);
        if (!result.IsSuccess)
        {
            return result;
        }

        await db.SaveChangesAsync(ct);
        return Result.Success();
    }

    public async Task<Result> DeleteAsync(Guid id, CancellationToken ct)
    {
        if (await db.TimeEntries.Include(e => e.Allocations).SingleOrDefaultAsync(e => e.Id == id, ct) is not { } entry)
        {
            return TimeErrors.NotFound(id);
        }

        if (!CanEdit(entry))
        {
            return TimeErrors.Forbidden;
        }

        if (entry.Source != TimeSource.Crm || entry.Status != TimeEntryStatus.New)
        {
            return Error.Conflict("TIM_NOT_DELETABLE", "Only new entries made in the CRM can be deleted.");
        }

        if ((await ClosedPeriodsAsync(ct)).Contains((entry.Year, entry.Month)))
        {
            return TimeErrors.PeriodClosed;
        }

        entry.MarkDeleted();
        await db.SaveChangesAsync(ct);
        return Result.Success();
    }

    public async Task<IReadOnlyList<PeriodDto>> ListPeriodsAsync(int year, CancellationToken ct)
    {
        var periods = await db.TimePeriods.AsNoTracking().Where(p => p.Year == year).ToListAsync(ct);
        var from = new DateOnly(year, 1, 1);
        var to = from.AddYears(1);
        var stats = await db.TimeEntries.AsNoTracking()
            .Where(e => e.WorkDate >= from && e.WorkDate < to)
            .GroupBy(e => e.WorkDate.Month)
            .Select(g => new { Month = g.Key, New = g.Count(e => e.Status == TimeEntryStatus.New), Hours = g.Sum(e => e.Hours) })
            .ToListAsync(ct);
        var closedBy = await users.GetUsersAsync(periods.Where(p => p.ClosedBy != null).Select(p => p.ClosedBy!.Value).Distinct().ToList(), ct);

        return Enumerable.Range(1, 12).Select(month =>
        {
            var period = periods.FirstOrDefault(p => p.Month == month);
            var stat = stats.FirstOrDefault(s => s.Month == month);
            return new PeriodDto(
                year, month, period?.IsClosed ?? false, period?.ClosedAt,
                period?.ClosedBy is { } by && closedBy.TryGetValue(by, out var user) ? user.DisplayName : null,
                period?.ReopenReason, stat?.New ?? 0, stat?.Hours ?? 0);
        }).ToList();
    }

    public async Task<Result<PeriodDto>> ClosePeriodAsync(int year, int month, CancellationToken ct)
    {
        var from = new DateOnly(year, month, 1);
        var to = from.AddMonths(1);
        var newEntries = await db.TimeEntries.CountAsync(e => e.WorkDate >= from && e.WorkDate < to && e.Status == TimeEntryStatus.New, ct);
        if (newEntries > 0)
        {
            return Error.Conflict("TIM_UNAPPROVED_ENTRIES", $"{newEntries} entries are still waiting for approval.",
                new Dictionary<string, object?> { ["newEntries"] = newEntries });
        }

        var period = await db.TimePeriods.SingleOrDefaultAsync(p => p.Year == year && p.Month == month, ct);
        if (period is null)
        {
            period = new TimePeriod(year, month);
            db.TimePeriods.Add(period);
        }

        period.Close(currentUser.UserId, time.GetUtcNow());
        await db.SaveChangesAsync(ct);
        return (await ListPeriodsAsync(year, ct)).First(p => p.Month == month);
    }

    public async Task<Result<PeriodDto>> ReopenPeriodAsync(int year, int month, string reason, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(reason))
        {
            return Error.Validation("TIM_REASON_REQUIRED", "Give a reason for reopening the period; it is written to the audit log.");
        }

        if (await db.TimePeriods.SingleOrDefaultAsync(p => p.Year == year && p.Month == month, ct) is not { } period || !period.IsClosed)
        {
            return Error.NotFound("TIM_PERIOD_NOT_CLOSED", "The period is not closed.");
        }

        period.Reopen(reason, time.GetUtcNow());
        await db.SaveChangesAsync(ct);
        return (await ListPeriodsAsync(year, ct)).First(p => p.Month == month);
    }

    public async Task<IReadOnlyList<string>> WorkTypesAsync(CancellationToken ct)
    {
        var fromCatalog = await catalog.GetWorkTypesAsync(ct);
        return fromCatalog.Concat(options.Value.WorkTypes).Distinct(StringComparer.OrdinalIgnoreCase).Order(StringComparer.OrdinalIgnoreCase).ToList();
    }

    /// <summary>
    /// Hours go only to a project the caller may see (DEV-09), of the entry's organization and still taking hours — otherwise
    /// they could land on, and the answer would name, any project.
    /// </summary>
    private async Task<Error?> ProjectNotBookableAsync(Guid? projectId, Guid organizationId, CancellationToken ct)
    {
        if (projectId is not { } id)
        {
            return null;
        }

        if (await projects.GetProjectAsync(id, ct) is not { } project)
        {
            return TimeErrors.ProjectNotAvailable;
        }

        if (project.OrganizationId != organizationId)
        {
            return TimeErrors.ProjectOtherOrganization;
        }

        return project.AcceptsHours ? null : TimeErrors.ProjectClosed;
    }

    private bool CanEdit(TimeEntry entry) =>
        currentUser.HasPermission(Permissions.TimeManage) || (entry.TechnicianId == currentUser.UserId && currentUser.HasPermission(Permissions.TimeOwn));

    private Task<Guid?> ResolveTechnicianAsync(Guid? requested)
    {
        if (requested is null || requested == currentUser.UserId)
        {
            return Task.FromResult(currentUser.UserId);
        }

        return Task.FromResult(currentUser.HasPermission(Permissions.TimeManage) ? requested : null);
    }

    private async Task<HashSet<(int Year, int Month)>> ClosedPeriodsAsync(CancellationToken ct) =>
        (await db.TimePeriods.AsNoTracking().Where(p => p.IsClosed).Select(p => new { p.Year, p.Month }).ToListAsync(ct))
        .Select(p => (p.Year, p.Month)).ToHashSet();

    private async Task<IReadOnlyList<TimeEntryDto>> ToDtosAsync(IReadOnlyList<TimeEntry> entries, HashSet<(int, int)> closed, CancellationToken ct)
    {
        var organizations = await customers.GetOrganizationNamesAsync(entries.Select(e => e.OrganizationId).Distinct().ToList(), ct);
        var projectNames = await projects.GetProjectNamesAsync(
            entries.Where(e => e.ProjectId != null).Select(e => e.ProjectId!.Value).Distinct().ToList(), ct);
        var technicians = await users.GetUsersAsync(entries.Where(e => e.TechnicianId != null).Select(e => e.TechnicianId!.Value).Distinct().ToList(), ct);
        return entries.Select(e => new TimeEntryDto(
            e.Id, e.Source, e.OrganizationId, organizations.GetValueOrDefault(e.OrganizationId),
            e.TechnicianId, e.TechnicianId is { } t && technicians.TryGetValue(t, out var user) ? user.DisplayName : e.TechnicianName,
            e.ExternalTicketId, e.TicketTitle, e.WorkDate, e.StartedAt, e.Hours, e.WorkType, e.Billable, e.Onsite, e.AfterHours, e.Description,
            e.ProjectId, e.ProjectId is { } p && projectNames.TryGetValue(p, out var projectName) ? projectName : null,
            e.Status, e.Amount, e.ReviewNote, closed.Contains((e.Year, e.Month)),
            e.CurrentAllocations
                .Select(a => new AllocationDto(a.Classification, a.Hours, a.BilledHours, a.Rate, a.Amount, a.HourBankId)).ToList(),
            db.Entry(e).State == EntityState.Detached ? string.Empty : db.GetETag(e), e.TicketId, e.SourceActivityId)).ToList();
    }
}
