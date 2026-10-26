using Crm.Infrastructure.Persistence;
using Crm.SharedKernel.Results;
using Crm.TimeTracking.Domain;
using Crm.TimeTracking.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;

namespace Crm.TimeTracking.Features;

internal sealed partial class TimeEntryService
{
    private TimeTrackingDbContext CreateWriteContext() => new(new DbContextOptionsBuilder<TimeTrackingDbContext>(dbOptions)
        .UseSqlServer(sql => sql.ExecutionStrategy(d => new NonRetryingExecutionStrategy(d))).Options);

    private async Task<Result<TimeEntryDto>?> FindCreateReplayAsync(Guid requestId, string intentHash, CancellationToken ct)
    {
        // Receipt facts never change. This check holds no work/customer lease and is deliberately before live source
        // validation: a retry of already accepted hours reads history even if that Task was unlinked in the meantime.
        await using var read = CreateWriteContext();
        var receipt = await read.TimeEntryCreateReceipts.AsNoTracking().SingleOrDefaultAsync(r => r.ClientRequestId == requestId, ct);
        if (receipt is null) return null;
        if (!Matches(receipt, intentHash)) return CreateRequestConflict;
        var entry = await read.TimeEntries.Include(e => e.Allocations).SingleOrDefaultAsync(e => e.Id == receipt.TimeEntryId, ct);
        if (entry is null || !CanEdit(entry)) return CreateRequestUnavailable;
        var names = await customers.GetOrganizationNamesAsync([entry.OrganizationId], ct);
        var projectNames = await projects.GetProjectNamesAsync(entry.ProjectId is { } projectId ? [projectId] : [], ct);
        var technicians = await users.GetUsersAsync(entry.TechnicianId is { } technician ? [technician] : [], ct);
        var locked = await read.TimePeriods.AsNoTracking().AnyAsync(p => p.Year == entry.Year && p.Month == entry.Month && p.IsClosed, ct);
        return WriteDto(read, entry, names.GetValueOrDefault(entry.OrganizationId), entry.ProjectId is { } project ? projectNames.GetValueOrDefault(project) : null,
            entry.TechnicianId is { } t && technicians.TryGetValue(t, out var user) ? user.DisplayName : entry.TechnicianName, locked);
    }

    private bool Matches(TimeEntryCreateReceipt receipt, string intentHash) =>
        receipt.RequestedBy == currentUser.UserId && string.Equals(receipt.IntentHash, intentHash, StringComparison.Ordinal);

    private static TimeEntryDto WriteDto(TimeTrackingDbContext context, TimeEntry entry, string? organizationName, string? projectName, string? technicianName, bool locked) =>
        new(entry.Id, entry.Source, entry.OrganizationId, organizationName, entry.TechnicianId, technicianName, entry.ExternalTicketId, entry.TicketTitle,
            entry.WorkDate, entry.StartedAt, entry.Hours, entry.WorkType, entry.Billable, entry.Onsite, entry.AfterHours, entry.Description,
            entry.ProjectId, projectName, entry.Status, entry.Amount, entry.ReviewNote, locked, entry.CurrentAllocations
                .Select(a => new AllocationDto(a.Classification, a.Hours, a.BilledHours, a.Rate, a.Amount, a.HourBankId)).ToList(),
            context.GetETag(entry), entry.TicketId, entry.SourceActivityId);

    private static Error CreateRequestConflict => Error.Conflict("TIM_CREATE_REQUEST_CONFLICT", "This request was already used for different work. Review your saved hours.");
    private static Error CreateRequestUnavailable => Error.Conflict("TIM_CREATE_REQUEST_UNAVAILABLE", "The previously accepted time entry is unavailable. Review your saved hours.");
}
