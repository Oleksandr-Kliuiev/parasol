using Crm.SharedKernel.Results;

namespace Crm.Activities.Contracts;

/// <summary>
/// What a task was made from, as its source names it: the system (<c>atera</c>), the kind of item (<c>alert</c>), the source's own
/// customer and item ids, and what was made (<c>Task</c>). It never names a CRM row, so the receipt outlives a mirror rebuilt by a sync.
/// </summary>
public sealed record SourceTaskIdentity(string System, string SourceKind, string ExternalCustomerId, string ExternalId, string TargetKind);
public sealed record SourceTaskDraft(SourceTaskIdentity Source, Guid OrganizationId, Guid AssigneeId,
    DateTimeOffset? DueAt, ActivityPriority Priority, string Subject);
/// <summary>A task made from a source; its subject, assignee and due date are empty once the task was deleted or erased.</summary>
public sealed record SourceTaskRef(Guid ActivityId, Guid OrganizationId, ActivityStatus Status, Guid? AssigneeId,
    DateTimeOffset? DueAt, bool Created, bool IsAvailable, string? Subject = null);
public sealed record SourceTaskDetails(SourceTaskIdentity Source, SourceTaskRef Task);
/// <summary>Some sources of one customer whose tasks a list wants to show.</summary>
public sealed record SourceTaskQuery(Guid OrganizationId, IReadOnlyCollection<SourceTaskIdentity> Sources);
/// <summary>The task a source already has, with its assignee's name, for a row that says so without a dialog.</summary>
public sealed record SourceTaskLookup(Guid OrganizationId, SourceTaskIdentity Source, SourceTaskRef Task, string? AssigneeName);

/// <summary>
/// Internal module boundary for a durable, idempotent CRM follow-up of an item another system reports (an Atera alert). The first
/// writer owns the task; a repeat returns it. The source's own text reaches the task only as the subject the employee confirmed.
/// </summary>
public interface IActivitiesApi
{
    Task<Result<SourceTaskRef>> CreateTaskOnceAsync(SourceTaskDraft draft, CancellationToken cancellationToken);
    Task<Result<SourceTaskRef?>> FindSourceTaskAsync(SourceTaskIdentity source, Guid organizationId, CancellationToken cancellationToken);

    /// <summary>The source of a task; a receipt of a system the CRM no longer reads is not found (<c>ACT_SOURCE_UNSUPPORTED</c>).</summary>
    Task<Result<SourceTaskDetails>> GetSourceTaskAsync(Guid activityId, CancellationToken cancellationToken);

    /// <summary>
    /// The tasks some sources already have, each only for the customer that asked: at most
    /// <see cref="SourceTaskLookupLimits.MaxSources"/> sources in one call, what one screen shows, never a scan of all links.
    /// </summary>
    Task<Result<IReadOnlyList<SourceTaskLookup>>> FindSourceTasksAsync(IReadOnlyCollection<SourceTaskQuery> queries,
        CancellationToken cancellationToken);
}

public static class SourceTaskLookupLimits
{
    /// <summary>What one screen shows: a page of alerts (50 at most), or the few urgent ones My day shows.</summary>
    public const int MaxSources = 500;
}
