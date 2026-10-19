using System.Data;
using Crm.Activities.Contracts;
using Crm.Activities.Persistence;
using Crm.Authorization;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Results;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;

namespace Crm.Activities.Features;

internal sealed class TaskWorkApi(DbContextOptions<ActivitiesDbContext> options, ICurrentUser currentUser) : ITaskWorkApi
{
    public async Task<Result<T>> WithCurrentAsync<T>(Guid organizationId, Guid activityId, Guid ticketId,
        Func<TaskWorkRef, CancellationToken, Task<Result<T>>> action, CancellationToken cancellationToken)
    {
        if (currentUser.UserId is null || !currentUser.HasPermission(Permissions.ActivitiesRead))
            return Error.Forbidden("ACT_WORK_FORBIDDEN", "Activity access is required.");
        if (organizationId == Guid.Empty || activityId == Guid.Empty || ticketId == Guid.Empty) return Unavailable();
        // Global order: customer > Atera links > saved ticket (caller) > exact Activity > Time.
        // A fresh non-retrying context prevents stale tracked rows and prevents callback replay.
        await using var db = new ActivitiesDbContext(NonRetryingOptions(options));
        await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken);
        var task = await db.Activities.AsNoTracking().SingleOrDefaultAsync(a => a.Id == activityId &&
            a.OrganizationId == organizationId && a.Type == ActivityType.Task && a.LinkedTicketId == ticketId, cancellationToken);
        if (task is null) return Unavailable();
        var result = await action(new(task.Id, task.OrganizationId, ticketId), cancellationToken);
        // There are no writes in this transaction. Disposal releases the read lease even after callback failure.
        return result;
    }

    internal static DbContextOptions<ActivitiesDbContext> NonRetryingOptions(DbContextOptions<ActivitiesDbContext> options) =>
        new DbContextOptionsBuilder<ActivitiesDbContext>(options)
            .UseSqlServer(sql => sql.ExecutionStrategy(d => new NonRetryingExecutionStrategy(d))).Options;

    private static Error Unavailable() => Error.NotFound("ACT_TASK_UNAVAILABLE", "The task or its ticket association is unavailable.");
}
