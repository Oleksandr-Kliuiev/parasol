using Crm.SharedKernel.Results;

namespace Crm.Activities.Contracts;

public sealed record TaskWorkRef(Guid Id, Guid OrganizationId, Guid TicketId);

/// <summary>Generic task identity, independent of any technical observation source.</summary>
public interface ITaskWorkApi
{
    /// <summary>
    /// Called after the customer/link/ticket lease. Holds the exact live Task and its current association stable until
    /// the callback commits. The callback runs once; neither transient faults nor uncertain acknowledgement replay it.
    /// </summary>
    Task<Result<T>> WithCurrentAsync<T>(Guid organizationId, Guid activityId, Guid ticketId,
        Func<TaskWorkRef, CancellationToken, Task<Result<T>>> action, CancellationToken cancellationToken);
}
