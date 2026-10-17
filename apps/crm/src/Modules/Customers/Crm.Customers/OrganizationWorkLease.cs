using System.Data;
using Crm.Customers.Contracts;
using Crm.Customers.Persistence;
using Crm.SharedKernel.Results;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;

namespace Crm.Customers;

internal sealed class OrganizationWorkLease(DbContextOptions<CustomersDbContext> options) : IOrganizationWorkLease
{
    public async Task<Result<T>> WithUsableAsync<T>(Guid organizationId,
        Func<OrganizationRef, CancellationToken, Task<Result<T>>> action, CancellationToken cancellationToken)
    {
        // A dedicated nonretrying context never replays a callback whose write may already have committed.
        var leaseOptions = new DbContextOptionsBuilder<CustomersDbContext>(options)
            .UseSqlServer(sql => sql.ExecutionStrategy(dependencies => new NonRetryingExecutionStrategy(dependencies))).Options;
        await using var db = new CustomersDbContext(leaseOptions);
        await using var lease = await db.Database.BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken);
        // Serializable retains ordinary SQL S/range locks; merge/delete/update cannot bypass them with a missing applock.
        var organization = await db.Organizations.AsNoTracking().Where(row => row.Id == organizationId)
            .Select(row => new OrganizationRef(row.Id, row.Name, row.OrgNumber, row.Status, row.AccountManagerId))
            .SingleOrDefaultAsync(cancellationToken);
        if (organization is null)
            return Error.NotFound("CUS_ORGANIZATION_UNAVAILABLE", "The customer is unavailable.");
        var result = await action(organization, cancellationToken);
        await lease.CommitAsync(cancellationToken);
        return result;
    }
}
