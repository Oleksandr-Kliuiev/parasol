using Crm.SharedKernel.Application;
using Crm.SharedKernel.Results;

namespace Crm.Service.Contracts;

/// <summary>A saved ticket with an exact, currently verified Atera customer binding. ImportedAt is local import time.</summary>
public sealed record TicketWorkRef(Guid Id, Guid OrganizationId, long ExternalId, string Title, string Status, DateTimeOffset ImportedAt);

public interface ITicketWorkApi
{
    Task<Result<TicketWorkRef>> GetAsync(Guid organizationId, Guid ticketId, CancellationToken cancellationToken);
    Task<Result<PagedResult<TicketWorkRef>>> ListAsync(Guid organizationId, int? limit, string? cursor, CancellationToken cancellationToken);

    /// <summary>Holds customer, owner-link and ticket read leases until action completes. The action is called at most once.
    /// The action may commit local Activity/Time work; it must not call providers or acquire earlier locks.</summary>
    Task<Result<T>> WithCurrentAsync<T>(Guid organizationId, Guid ticketId,
        Func<TicketWorkRef, CancellationToken, Task<Result<T>>> action, CancellationToken cancellationToken);
}
