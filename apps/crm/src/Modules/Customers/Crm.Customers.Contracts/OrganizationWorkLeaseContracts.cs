using Crm.SharedKernel.Results;

namespace Crm.Customers.Contracts;

/// <summary>A nonreplaying, read-only organization lease for another module's local write.
/// Take before integration-link, Service-ticket, Activity and Time locks. The callback runs at most once.</summary>
public interface IOrganizationWorkLease
{
    Task<Result<T>> WithUsableAsync<T>(Guid organizationId,
        Func<OrganizationRef, CancellationToken, Task<Result<T>>> action, CancellationToken cancellationToken);
}
