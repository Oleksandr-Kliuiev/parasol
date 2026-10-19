using Crm.SharedKernel.Results;

namespace Crm.Activities.Contracts;

public sealed record SourceTaskIdentity(string System, string WorkspaceId, string ClientId, string ObservationId, string TargetKind);
public sealed record SourceTaskDraft(SourceTaskIdentity Source, Guid OrganizationId, Guid AssigneeId,
    DateTimeOffset? DueAt, ActivityPriority Priority);
public sealed record SourceTaskRef(Guid ActivityId, Guid OrganizationId, ActivityStatus Status, Guid? AssigneeId,
    DateTimeOffset? DueAt, bool Created, bool IsAvailable);
public sealed record SourceTaskDetails(SourceTaskIdentity Source, SourceTaskRef Task);

/// <summary>Internal module boundary for a durable, idempotent CRM-only follow-up. Technical source text is never copied.</summary>
public interface IActivitiesApi
{
    Task<Result<SourceTaskRef>> CreateTaskOnceAsync(SourceTaskDraft draft, CancellationToken cancellationToken);
    Task<Result<SourceTaskRef?>> FindSourceTaskAsync(SourceTaskIdentity source, Guid organizationId, CancellationToken cancellationToken);
    Task<Result<SourceTaskDetails>> GetSourceTaskAsync(Guid activityId, CancellationToken cancellationToken);
}
