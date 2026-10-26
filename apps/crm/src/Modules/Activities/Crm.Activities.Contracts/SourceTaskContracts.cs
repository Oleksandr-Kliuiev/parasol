using Crm.SharedKernel.Results;

namespace Crm.Activities.Contracts;

public sealed record SourceTaskIdentity(string System, string WorkspaceId, string ClientId, string ObservationId, string TargetKind);
public sealed record SourceTaskDraft(SourceTaskIdentity Source, Guid OrganizationId, Guid AssigneeId,
    DateTimeOffset? DueAt, ActivityPriority Priority);
public sealed record SourceTaskRef(Guid ActivityId, Guid OrganizationId, ActivityStatus Status, Guid? AssigneeId,
    DateTimeOffset? DueAt, bool Created, bool IsAvailable);
public sealed record SourceTaskDetails(SourceTaskIdentity Source, SourceTaskRef Task);
/// <summary>Some observations of one mapped Atlas client whose tasks a list of one customer wants to show.</summary>
public sealed record SourceTaskQuery(string WorkspaceId, string ClientId, Guid OrganizationId, IReadOnlyCollection<string> ObservationIds);
/// <summary>The task an observation already has, with its assignee's name, for a row that says so without a dialog.</summary>
public sealed record SourceTaskLookup(Guid OrganizationId, string ObservationId, SourceTaskRef Task, string? AssigneeName);

/// <summary>Internal module boundary for a durable, idempotent CRM-only follow-up. Technical source text is never copied.</summary>
public interface IActivitiesApi
{
    Task<Result<SourceTaskRef>> CreateTaskOnceAsync(SourceTaskDraft draft, CancellationToken cancellationToken);
    Task<Result<SourceTaskRef?>> FindSourceTaskAsync(SourceTaskIdentity source, Guid organizationId, CancellationToken cancellationToken);
    Task<Result<SourceTaskDetails>> GetSourceTaskAsync(Guid activityId, CancellationToken cancellationToken);

    /// <summary>
    /// The tasks some observations already have, each only for the customer that asked: at most
    /// <see cref="SourceTaskLookupLimits.MaxObservations"/> ids in one call, what one screen shows, never a scan of all links.
    /// </summary>
    Task<Result<IReadOnlyList<SourceTaskLookup>>> FindSourceTasksAsync(IReadOnlyCollection<SourceTaskQuery> queries,
        CancellationToken cancellationToken);
}

public static class SourceTaskLookupLimits
{
    /// <summary>
    /// What one screen shows: a page of 50 rows of one customer, the three urgent rows My day shows for each of its 50
    /// customers, or the ten the observation queue shows for each of them.
    /// </summary>
    public const int MaxObservations = 500;
}
