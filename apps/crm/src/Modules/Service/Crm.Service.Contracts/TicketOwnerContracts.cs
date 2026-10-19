using Crm.SharedKernel.Results;

namespace Crm.Service.Contracts;

/// <summary>The exact current Organization/atera/Customer external-link row, never inferred from a numeric alias.</summary>
public sealed record TicketOwnerBinding(Guid LinkId, Guid OrganizationId, long CustomerId);

/// <summary>Implemented by Integrations. A null binding means absent, noncanonical or ambiguous ownership.</summary>
public interface ITicketOwnershipApi
{
    Task<Result<T>> WithCurrentAsync<T>(Guid organizationId,
        Func<TicketOwnerBinding?, CancellationToken, Task<Result<T>>> action, CancellationToken cancellationToken);
}
