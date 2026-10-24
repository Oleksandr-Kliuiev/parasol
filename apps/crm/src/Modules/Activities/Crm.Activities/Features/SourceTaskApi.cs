using Crm.Activities.Contracts;
using Crm.Activities.Domain;
using Crm.Activities.Persistence;
using Crm.Authorization;
using Crm.Customers.Contracts;
using Crm.Identity.Contracts;
using Crm.Infrastructure.Persistence;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Results;
using Microsoft.EntityFrameworkCore;

namespace Crm.Activities.Features;

internal sealed class SourceTaskApi(ActivitiesDbContext db, ICustomersApi customers, IUserDirectory users,
    ICurrentUser currentUser, TimeProvider time) : IActivitiesApi
{
    private bool CanRead => currentUser.UserId is not null && currentUser.HasPermission(Permissions.ActivitiesRead)
        && currentUser.HasPermission(Permissions.ServiceRead);

    public async Task<Result<SourceTaskRef>> CreateTaskOnceAsync(SourceTaskDraft draft, CancellationToken cancellationToken)
    {
        if (!CanRead || !currentUser.HasPermission(Permissions.ActivitiesWrite)) return Forbidden();
        if (draft is null || !SourceTaskIdentityRules.IsValid(draft.Source) || draft.OrganizationId == Guid.Empty
            || draft.AssigneeId == Guid.Empty || draft.Priority is not (ActivityPriority.Normal or ActivityPriority.High)
            || draft.DueAt is { Year: < 2000 or > 2100 } || SourceTaskIdentityRules.Subject(draft.Subject) is null)
            return Error.Validation("ACT_SOURCE_TASK_INVALID", "Choose a supported source, subject, employee, priority and due date.");
        // Lock order: this Customers read-only lease, then the Activities write.
        // A read-only lease failing after the Activities commit is harmless: a retry adopts the permanent receipt.
        return await customers.WithUsableOrganizationAsync(draft.OrganizationId, async (_, ct) =>
            await db.Database.CreateExecutionStrategy().ExecuteAsync(async () =>
            {
                db.ChangeTracker.Clear(); // This service owns this request's Activities unit of work, including staged audit/outbox.
                try { return await CreateInTransactionAsync(draft, ct); }
                catch (DbUpdateException ex) when (ex.IsUniqueViolation())
                {
                    // The failed transaction was disposed before this read. Never leave its Task/audit/outbox tracked.
                    db.ChangeTracker.Clear();
                    var winner = await FindOwnedAsync(draft.Source, draft.OrganizationId, ct);
                    if (!winner.IsSuccess) return winner.Error!;
                    if (winner.Value is { } task) return task;
                    throw;
                }
            }), cancellationToken);
    }

    private async Task<Result<SourceTaskRef>> CreateInTransactionAsync(SourceTaskDraft draft, CancellationToken ct)
    {
        await using var transaction = await db.Database.BeginTransactionAsync(ct);
        var existing = await FindOwnedAsync(draft.Source, draft.OrganizationId, ct);
        if (!existing.IsSuccess) return existing.Error!;
        if (existing.Value is { } known) return known;
        if (await users.GetProfileAsync(draft.AssigneeId, ct) is not { IsActive: true } assignee
            || !IsEligibleAssignee(assignee))
            return Error.Validation("ACT_SOURCE_TASK_ASSIGNEE_INVALID", "Choose an active employee who works on tasks and service data.");
        var created = Activity.Create(new(ActivityType.Task, draft.OrganizationId, null, null, null,
            SourceTaskIdentityRules.Subject(draft.Subject)!, null, draft.DueAt, draft.Priority, draft.AssigneeId), time.GetUtcNow());
        if (!created.IsSuccess) return created.Error!;
        var task = created.Value;
        db.Activities.Add(task);
        db.SourceTaskLinks.Add(new()
        {
            SourceKey = SourceTaskIdentityRules.Key(draft.Source), ActivityId = task.Id,
            System = draft.Source.System, SourceKind = draft.Source.SourceKind, ExternalCustomerId = draft.Source.ExternalCustomerId,
            ExternalId = draft.Source.ExternalId, TargetKind = draft.Source.TargetKind,
            CreatedAt = time.GetUtcNow(), CreatedBy = currentUser.UserId!.Value,
        });
        await db.SaveChangesAsync(ct);
        await transaction.CommitAsync(ct);
        return Ref(task, created: true);
    }

    public async Task<Result<SourceTaskRef?>> FindSourceTaskAsync(SourceTaskIdentity source, Guid organizationId, CancellationToken cancellationToken)
    {
        if (!CanRead) return Forbidden();
        if (!SourceTaskIdentityRules.IsValid(source) || organizationId == Guid.Empty)
            return Error.Validation("ACT_SOURCE_TASK_INVALID", "Choose a supported source and customer.");
        return await FindOwnedAsync(source, organizationId, cancellationToken);
    }

    public async Task<Result<SourceTaskDetails>> GetSourceTaskAsync(Guid activityId, CancellationToken cancellationToken)
    {
        if (!CanRead) return Forbidden();
        var link = await db.SourceTaskLinks.AsNoTracking().SingleOrDefaultAsync(l => l.ActivityId == activityId, cancellationToken);
        if (link is null) return Error.NotFound("ACT_SOURCE_TASK_NOT_FOUND", "The task source is unavailable.");
        // A receipt of a system the CRM no longer reads (the retired workspace) is history only: nothing behind it can be opened.
        if (!SourceTaskIdentityRules.IsSupported(link.System)) return Unsupported();
        var task = await db.Activities.IgnoreQueryFilters().AsNoTracking().SingleOrDefaultAsync(a => a.Id == activityId, cancellationToken);
        if (task is null) return Error.Conflict("ACT_SOURCE_TASK_INCONSISTENT", "The task needs review.");
        return new SourceTaskDetails(link.Source, Ref(task));
    }

    public async Task<Result<IReadOnlyList<SourceTaskLookup>>> FindSourceTasksAsync(IReadOnlyCollection<SourceTaskQuery> queries,
        CancellationToken cancellationToken)
    {
        if (!CanRead) return Forbidden();
        var asked = (queries ?? []).SelectMany(q => (q.Sources ?? []).Distinct().Select(source => (q.OrganizationId, Source: source))).ToList();
        if (asked.Count is 0 or > SourceTaskLookupLimits.MaxSources || asked.Any(a => a.OrganizationId == Guid.Empty)
            || !asked.All(a => SourceTaskIdentityRules.IsValid(a.Source)))
            return Error.Validation("ACT_SOURCE_TASK_INVALID", $"Choose up to {SourceTaskLookupLimits.MaxSources} supported sources of known customers.");
        var byKey = asked.ToLookup(a => SourceTaskIdentityRules.Key(a.Source), StringComparer.Ordinal);
        var keys = byKey.Select(group => group.Key).ToList();
        var links = await db.SourceTaskLinks.AsNoTracking().Where(l => keys.Contains(l.SourceKey)).ToListAsync(cancellationToken);
        if (links.Count == 0) return Result<IReadOnlyList<SourceTaskLookup>>.Success([]);
        var activityIds = links.Select(l => l.ActivityId).ToList();
        var tasks = await db.Activities.IgnoreQueryFilters().AsNoTracking().Where(a => activityIds.Contains(a.Id)).ToDictionaryAsync(a => a.Id, cancellationToken);
        // Only a task of the customer that asked: one whose customer changed (a merge) or that is missing is explained by the
        // exact preview of the dialog (FindOwnedAsync), not shown in a list row.
        var owned = links.SelectMany(l => byKey[l.SourceKey].Select(a => (Asked: a, Link: l)))
            .Where(o => tasks.TryGetValue(o.Link.ActivityId, out var task) && task.OrganizationId == o.Asked.OrganizationId)
            .Select(o => (o.Asked, Task: tasks[o.Link.ActivityId])).ToList();
        var assignees = owned.Where(o => !o.Task.IsDeleted && o.Task.AssigneeId is not null).Select(o => o.Task.AssigneeId!.Value).Distinct().ToList();
        var names = assignees.Count == 0 ? new Dictionary<Guid, UserSummary>() : await users.GetUsersAsync(assignees, cancellationToken);
        return owned.Select(o => new SourceTaskLookup(o.Asked.OrganizationId, o.Asked.Source, Ref(o.Task),
            !o.Task.IsDeleted && o.Task.AssigneeId is { } assignee && names.TryGetValue(assignee, out var user) ? user.DisplayName : null)).ToList();
    }

    private async Task<Result<SourceTaskRef?>> FindOwnedAsync(SourceTaskIdentity source, Guid organizationId, CancellationToken ct)
    {
        var key = SourceTaskIdentityRules.Key(source);
        var link = await db.SourceTaskLinks.AsNoTracking().SingleOrDefaultAsync(l => l.SourceKey == key, ct);
        if (link is null) return Result<SourceTaskRef?>.Success(null);
        var task = await db.Activities.IgnoreQueryFilters().AsNoTracking().SingleOrDefaultAsync(a => a.Id == link.ActivityId, ct);
        if (task is null) return Error.Conflict("ACT_SOURCE_TASK_INCONSISTENT", "The task needs review.");
        // Ownership follows the Activity's current customer after a merge, never a stale receipt customer snapshot.
        if (task.OrganizationId != organizationId)
            return Error.Conflict("ACT_SOURCE_TASK_CUSTOMER_CHANGED", "This alert already has a task whose customer needs review.");
        return Ref(task);
    }

    internal static bool IsEligibleAssignee(UserProfile profile)
    {
        var permissions = Permissions.ForRoles(profile.Roles ?? []);
        return profile.IsActive && permissions.Contains(Permissions.ActivitiesWrite) && permissions.Contains(Permissions.ServiceRead);
    }

    internal static Error Unsupported() =>
        Error.NotFound("ACT_SOURCE_UNSUPPORTED", "This task was made from a source the CRM no longer reads.");

    private static SourceTaskRef Ref(Activity task, bool created = false) => new(task.Id, task.OrganizationId, task.Status,
        task.IsDeleted ? null : task.AssigneeId, task.IsDeleted ? null : task.DueAt, created, !task.IsDeleted, task.IsDeleted ? null : task.Subject);
    private static Error Forbidden() => Error.Forbidden("ACT_SOURCE_TASK_FORBIDDEN", "Service and CRM activity access are required.");
}
