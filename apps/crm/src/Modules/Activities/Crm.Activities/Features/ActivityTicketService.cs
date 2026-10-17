using System.Data;
using Crm.Activities.Contracts;
using Crm.Activities.Domain;
using Crm.Activities.Persistence;
using Crm.Authorization;
using Crm.Customers.Contracts;
using Crm.Infrastructure.Persistence;
using Crm.Service.Contracts;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Results;
using Microsoft.EntityFrameworkCore;

namespace Crm.Activities.Features;

public sealed record ActivityTicketRequest(Guid OrganizationId, Guid? TicketId);
public sealed record ActivityTicketDto(Guid ActivityId, Guid OrganizationId, Guid? TicketId, TicketWorkRef? Ticket, bool Available, string Etag);

internal sealed class ActivityTicketService(DbContextOptions<ActivitiesDbContext> options, ITicketWorkApi tickets,
    IOrganizationWorkLease organizations, ICurrentUser currentUser)
{
    private bool CanRead => currentUser.UserId is not null && currentUser.HasPermission(Permissions.ActivitiesRead)
        && currentUser.HasPermission(Permissions.ServiceRead);

    public async Task<Result<ActivityTicketDto>> GetAsync(Guid id, Guid organizationId, CancellationToken ct)
    {
        if (!CanRead) return Forbidden();
        if (id == Guid.Empty || organizationId == Guid.Empty) return Unavailable();
        // First obtain only the candidate identity. A later exact Task read checks that the association did not change.
        await using var lookup = new ActivitiesDbContext(TaskWorkApi.NonRetryingOptions(options));
        var candidate = await lookup.Activities.AsNoTracking().SingleOrDefaultAsync(a =>
            a.Id == id && a.OrganizationId == organizationId && a.Type == ActivityType.Task, ct);
        if (candidate is null) return Unavailable();
        if (candidate.LinkedTicketId is { } ticketId)
        {
            var verified = await tickets.WithCurrentAsync(organizationId, ticketId,
                (ticket, token) => ReadCurrentAsync(id, organizationId, ticket, token), ct);
            if (verified.IsSuccess) return verified;
            // An unavailable mirror keeps its exact GUID visible so it can be explicitly unlinked. No title is disclosed.
            if (verified.Error!.Type != ErrorType.NotFound) return verified.Error;
        }
        return await organizations.WithUsableAsync(organizationId,
            (_, token) => ReadCurrentAsync(id, organizationId, null, token), ct);
    }

    private async Task<Result<ActivityTicketDto>> ReadCurrentAsync(Guid id, Guid organizationId, TicketWorkRef? ticket, CancellationToken ct)
    {
        await using var db = new ActivitiesDbContext(TaskWorkApi.NonRetryingOptions(options));
        var task = await FindAsync(db, id, organizationId, ct);
        if (task is null) return Unavailable();
        return Ref(db, task, task.LinkedTicketId == ticket?.Id ? ticket : null);
    }

    public async Task<Result<ActivityTicketDto>> PutAsync(Guid id, ActivityTicketRequest request, string ifMatch, CancellationToken ct)
    {
        if (!CanRead || !currentUser.HasPermission(Permissions.ActivitiesWrite)) return Forbidden();
        if (id == Guid.Empty || request.OrganizationId == Guid.Empty) return Unavailable();
        if (request.TicketId == Guid.Empty) return Error.Validation("ACT_TICKET_INVALID", "Choose a saved ticket.");
        if (request.TicketId is { } ticketId)
            return await tickets.WithCurrentAsync(request.OrganizationId, ticketId,
                (ticket, token) => WriteAsync(id, request.OrganizationId, ticket, ifMatch, token), ct);
        // Explicit unlink remains possible even if the old mirror was retained/deleted or its Atera link changed.
        return await organizations.WithUsableAsync(request.OrganizationId,
            (_, token) => WriteAsync(id, request.OrganizationId, null, ifMatch, token), ct);
    }

    private async Task<Result<ActivityTicketDto>> WriteAsync(Guid id, Guid organizationId, TicketWorkRef? ticket, string ifMatch, CancellationToken ct)
    {
        await using var db = new ActivitiesDbContext(TaskWorkApi.NonRetryingOptions(options));
        await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.Serializable, ct);
        var task = await db.Activities.FromSqlInterpolated($"SELECT * FROM [activities].[Activities] WITH (UPDLOCK, HOLDLOCK) WHERE [Id] = {id}")
            .SingleOrDefaultAsync(a => a.OrganizationId == organizationId && a.Type == ActivityType.Task, ct);
        if (task is null) return Unavailable();
        if (!db.ApplyIfMatch(task, ifMatch)) return Error.PreconditionFailed("INVALID_ETAG", "The If-Match header is not a valid ETag.");
        if (db.IsStale(task)) return Error.PreconditionFailed("CONCURRENCY_CONFLICT", "The task changed. Reload it and review the association.");
        var changed = task.LinkTicket(ticket?.Id);
        if (!changed.IsSuccess) return changed.Error!;
        await db.SaveChangesAsync(ct);
        await transaction.CommitAsync(ct);
        return Ref(db, task, ticket);
    }

    private static Task<Activity?> FindAsync(ActivitiesDbContext db, Guid id, Guid organizationId, CancellationToken ct) =>
        db.Activities.SingleOrDefaultAsync(a => a.Id == id && a.OrganizationId == organizationId && a.Type == ActivityType.Task, ct);
    private static ActivityTicketDto Ref(ActivitiesDbContext db, Activity task, TicketWorkRef? ticket) =>
        new(task.Id, task.OrganizationId, task.LinkedTicketId, ticket, ticket is not null, db.GetETag(task));
    private static Error Unavailable() => Error.NotFound("ACT_TASK_UNAVAILABLE", "The task is unavailable.");
    private static Error Forbidden() => Error.Forbidden("ACT_WORK_FORBIDDEN", "Activity and saved service access are required.");
}
