using System.Data;
using Crm.Authorization;
using Crm.Infrastructure.Persistence;
using Crm.Service.Contracts;
using Crm.SharedKernel.Results;
using Crm.TimeTracking.Domain;
using Crm.TimeTracking.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;

namespace Crm.TimeTracking.Features;

internal sealed partial class TimeEntryService
{
    public Task<Result<TimeEntryDto>> CreateAsync(TimeEntryRequest request, CancellationToken ct) => WriteAsync(null, request, null, ct);

    public Task<Result<TimeEntryDto>> UpdateAsync(Guid id, TimeEntryRequest request, string ifMatch, CancellationToken ct) =>
        WriteAsync(id, request, ifMatch, ct);

    private async Task<Result<TimeEntryDto>> WriteAsync(Guid? id, TimeEntryRequest request, string? ifMatch, CancellationToken ct)
    {
        if (id is null && request.ClientRequestId == Guid.Empty)
            return Error.Validation("TIM_CREATE_REQUEST_INVALID", "The create request identity is invalid.");
        if (request.OrganizationId == Guid.Empty || request.TicketId == Guid.Empty || request.SourceActivityId == Guid.Empty ||
            (request.SourceActivityId is not null && request.TicketId is null))
            return Error.Validation("TIM_TICKET_INVALID", "Choose the saved ticket and its current task.");
        if (currentUser.UserId is null || !(currentUser.HasPermission(Permissions.TimeOwn) || currentUser.HasPermission(Permissions.TimeManage)))
            return TimeErrors.Forbidden;
        if (request.TicketId is not null && !currentUser.HasPermission(Permissions.ServiceRead))
            return Error.Forbidden("TIM_WORK_FORBIDDEN", "Saved service access is required.");
        if (request.SourceActivityId is not null && !currentUser.HasPermission(Permissions.ActivitiesRead))
            return Error.Forbidden("TIM_WORK_FORBIDDEN", "Activity access is required.");
        var createRequestId = id is null ? request.ClientRequestId : null;
        string? intentHash = null;
        if (createRequestId is { } requestId)
        {
            var technician = await ResolveTechnicianAsync(request.TechnicianId);
            if (technician is null) return TimeErrors.Forbidden;
            intentHash = TimeEntryCreateIntent.Hash(request, technician.Value);
            if (await FindCreateReplayAsync(requestId, intentHash, ct) is { } accepted) return accepted;
        }
        if (await customers.GetOrganizationAsync(request.OrganizationId, ct) is null)
            return Error.Validation("TIM_UNKNOWN_ORGANIZATION", "The organization does not exist.");

        // Resolve display names before acquiring the ordered work leases. No Customers re-entry while Activities/Time
        // locks are held; the financial entry stores IDs and its own ticket snapshot, not these display names.
        var organizations = await customers.GetOrganizationNamesAsync([request.OrganizationId], ct);
        var projectNames = await projects.GetProjectNamesAsync(request.ProjectId is { } p ? [p] : [], ct);
        async Task<Result<TimeEntryDto>> Commit(TicketWorkRef? ticket, CancellationToken token)
        {
            await using var writeDb = CreateWriteContext();
            // No execution-strategy callback: financial creation and its audit are never replayed.
            await using var transaction = await writeDb.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, token);
            var admission = await TimeRowAdmission.DiscoverAsync(writeDb, id is { } existingId ? [existingId] : [],
                MonthMode.Shared, [request.WorkDate], token);
            if (!admission.IsSuccess) return admission.Error!;
            if (createRequestId is { } requestId)
            {
                // Primary-key range lock serializes duplicate admissions, including two absent-key reads. The receipt
                // and the financial row/audit are saved in this one transaction; no task/provider callback is replayed.
                var receipt = await writeDb.TimeEntryCreateReceipts
                    .FromSqlInterpolated($"SELECT * FROM [time].[TimeEntryCreateReceipts] WITH (UPDLOCK, HOLDLOCK) WHERE [ClientRequestId] = {requestId}")
                    .SingleOrDefaultAsync(token);
                if (receipt is not null)
                {
                    if (!Matches(receipt, intentHash!)) return CreateRequestConflict;
                    var accepted = await writeDb.TimeEntries.Include(e => e.Allocations).SingleOrDefaultAsync(e => e.Id == receipt.TimeEntryId, token);
                    if (accepted is null || !CanEdit(accepted)) return CreateRequestUnavailable;
                    var acceptedTechnicians = await users.GetUsersAsync(accepted.TechnicianId is { } technician ? [technician] : [], token);
                    var locked = await writeDb.TimePeriods.AsNoTracking().AnyAsync(p => p.Year == accepted.Year && p.Month == accepted.Month && p.IsClosed, token);
                    return WriteDto(writeDb, accepted, organizations.GetValueOrDefault(accepted.OrganizationId),
                        accepted.ProjectId is { } acceptedProject ? projectNames.GetValueOrDefault(acceptedProject) : null,
                        accepted.TechnicianId is { } t && acceptedTechnicians.TryGetValue(t, out var user) ? user.DisplayName : accepted.TechnicianName, locked);
                }
            }
            TimeEntry? entry = null;
            if (id is { } entryId)
            {
                entry = await writeDb.TimeEntries.FromSqlInterpolated($"SELECT * FROM [time].[TimeEntries] WITH (UPDLOCK, HOLDLOCK) WHERE [Id] = {entryId}")
                    .Include(e => e.Allocations).SingleOrDefaultAsync(token);
                if (entry is null) return TimeErrors.NotFound(entryId);
                if (!admission.Value.Covers(entry.WorkDate)) return MonthAdmission.Changed;
                if (!CanEdit(entry)) return TimeErrors.Forbidden;
                if (!writeDb.ApplyIfMatch(entry, ifMatch!)) return TimeErrors.InvalidETag;
                if (writeDb.IsStale(entry)) return Error.PreconditionFailed("CONCURRENCY_CONFLICT", "The time entry changed. Reload it and review your changes.");
            }
            var closed = await MonthAdmission.ClosedAsync(writeDb, admission.Value, token);
            if (closed.Contains(TimeMonth.Of(request.WorkDate)) || entry is not null && closed.Contains(TimeMonth.Of(entry.WorkDate)))
                return TimeErrors.PeriodClosed;
            var technicianId = await ResolveTechnicianAsync(request.TechnicianId ?? entry?.TechnicianId);
            if (technicianId is null) return TimeErrors.Forbidden;
            if ((entry is null || request.ProjectId != entry.ProjectId || request.OrganizationId != entry.OrganizationId) &&
                await ProjectNotBookableAsync(request.ProjectId, request.OrganizationId, token) is { } projectError)
                return projectError;
            var details = new ManualTimeEntry(request.OrganizationId, technicianId.Value, request.WorkDate, request.Hours,
                request.WorkType, request.Billable, request.Onsite, request.AfterHours, request.Description,
                ticket?.Id, ticket?.ExternalId ?? request.ExternalTicketId, ticket?.Title ?? request.TicketTitle,
                request.ProjectId, ticket is null ? null : request.SourceActivityId);
            if (entry is null)
            {
                var created = TimeEntry.CreateManual(details);
                if (!created.IsSuccess) return created.Error!;
                entry = created.Value; writeDb.TimeEntries.Add(entry);
            }
            else
            {
                var updated = entry.Update(details);
                if (!updated.IsSuccess) return updated.Error!;
            }
            if (createRequestId is { } acceptedRequestId)
                writeDb.TimeEntryCreateReceipts.Add(new() { ClientRequestId = acceptedRequestId, RequestedBy = currentUser.UserId!.Value,
                    IntentHash = intentHash!, TimeEntryId = entry.Id, AcceptedAt = time.GetUtcNow() });
            var technicians = await users.GetUsersAsync([technicianId.Value], token);
            await writeDb.SaveChangesAsync(token);
            await transaction.CommitAsync(token);
            return WriteDto(writeDb, entry, organizations.GetValueOrDefault(entry.OrganizationId),
                entry.ProjectId is { } project ? projectNames.GetValueOrDefault(project) : null,
                technicians.GetValueOrDefault(technicianId.Value)?.DisplayName, false);
        }
        Result<TimeEntryDto> result;
        if (request.TicketId is not { } ticketId) result = await Commit(null, ct);
        else result = await tickets.WithCurrentAsync(request.OrganizationId, ticketId, async (ticket, token) =>
        {
            if (request.SourceActivityId is not { } activityId) return await Commit(ticket, token);
            return await tasks.WithCurrentAsync(request.OrganizationId, activityId, ticketId, (_, taskToken) => Commit(ticket, taskToken), token);
        }, ct);
        // Another attempt may have committed between the initial receipt check and a now-invalid source lease.
        // Adopt that history instead of turning the already accepted request into a second financial admission.
        if (!result.IsSuccess && createRequestId is { } replayId && await FindCreateReplayAsync(replayId, intentHash!, ct) is { } replay)
            return replay;
        return result;
    }
}
