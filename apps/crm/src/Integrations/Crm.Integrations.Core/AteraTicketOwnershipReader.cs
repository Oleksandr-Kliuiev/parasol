using System.Data;
using System.Globalization;
using Crm.Integrations.Core.Persistence;
using Crm.Service.Contracts;
using Crm.SharedKernel.Results;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;

namespace Crm.Integrations.Core;

/// <summary>Strict Atera owner proofs shared by imports and saved-ticket work. No HTTP or cross-module SQL.</summary>
public static class AteraTicketOwners
{
    public static IReadOnlyDictionary<long, TicketOwnerBinding> Resolve(IEnumerable<ExternalLink> links)
    {
        // Case-insensitive SQL collations must never turn a different namespace into a proof.
        var candidates = links.Where(row => row.EntityType == EntityTypes.Organization && row.System == "atera" && row.ExternalType == "Customer")
            .Select(row => (Row: row, Number: long.TryParse(row.ExternalId, NumberStyles.Integer, CultureInfo.InvariantCulture, out var number) ? number : 0))
            .Where(item => item.Number > 0).GroupBy(item => item.Number);
        var result = new Dictionary<long, TicketOwnerBinding>();
        foreach (var group in candidates)
        {
            var rows = group.ToList();
            // Reject even a canonical row if another spelling would claim the same numeric customer.
            if (rows.Count != 1 || rows[0].Row.ExternalId != group.Key.ToString(CultureInfo.InvariantCulture)) continue;
            var row = rows[0].Row;
            if (row.Id != Guid.Empty && row.EntityId != Guid.Empty)
                result.Add(group.Key, new(row.Id, row.EntityId, group.Key));
        }
        return result;
    }
}

internal sealed class AteraTicketOwnershipReader(DbContextOptions<IntegrationDbContext> options) : ITicketOwnershipApi
{
    public async Task<Result<T>> WithCurrentAsync<T>(Guid organizationId,
        Func<TicketOwnerBinding?, CancellationToken, Task<Result<T>>> action, CancellationToken cancellationToken)
    {
        var leaseOptions = new DbContextOptionsBuilder<IntegrationDbContext>(options)
            .UseSqlServer(sql => sql.ExecutionStrategy(dependencies => new NonRetryingExecutionStrategy(dependencies))).Options;
        await using var db = new IntegrationDbContext(leaseOptions);
        await using var lease = await db.Database.BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken);
        // Lock the whole small Customer namespace, including alias rows and insertion gaps. Ordinary generic link writes
        // and merge handlers therefore serialize with this lease, without having to know an application-lock convention.
        var links = await db.ExternalLinks.AsNoTracking().Where(row => row.System == "atera" && row.ExternalType == "Customer")
            .ToListAsync(cancellationToken);
        var bindings = AteraTicketOwners.Resolve(links).Values.Where(binding => binding.OrganizationId == organizationId).ToList();
        var result = await action(bindings.Count == 1 ? bindings[0] : null, cancellationToken);
        await lease.CommitAsync(cancellationToken);
        return result;
    }
}
