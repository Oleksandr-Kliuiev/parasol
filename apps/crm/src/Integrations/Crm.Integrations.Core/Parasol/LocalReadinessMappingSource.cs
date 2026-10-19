using Crm.Customers.Contracts;
using Crm.Integrations.Core.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crm.Integrations.Core.Parasol;

internal sealed record LocalMappingLink(Guid Id, string System, string ExternalType, string ExternalId, string EntityType,
    Guid EntityId, int IdentityMatches, int CustomerMatches);
internal sealed record LocalMappingReference(Guid Id, string System, string ExternalType, string ExternalId, bool IsGone,
    int? PayloadBytes, string Payload);
internal sealed record LocalMappingSnapshot(int StoredLinks, int UnlinkedStoredReferences, IReadOnlyList<LocalMappingLink> Links,
    IReadOnlyList<LocalMappingReference> References, IReadOnlyList<Guid> LiveCustomerIds);
internal interface ILocalMappingSource
{
    Task<LocalMappingSnapshot> ReadAsync(CancellationToken ct);
}

/// <summary>Bounded local projection. Duplicate counts intentionally range over all links, including rows outside the cap.</summary>
internal sealed class LocalReadinessMappingSource(IntegrationDbContext db, ICustomersApi customers) : ILocalMappingSource
{
    public async Task<LocalMappingSnapshot> ReadAsync(CancellationToken ct)
    {
        var links = db.ExternalLinks.AsNoTracking().Where(link => link.System == CustomerIdentityContract.System
            && link.ExternalType == CustomerIdentityContract.ExternalType);
        var total = await links.CountAsync(ct);
        var selected = await links.OrderBy(link => link.Id).Take(LocalReadinessMappings.Limit)
            .Select(link => new LocalMappingLink(link.Id, link.System, link.ExternalType, link.ExternalId, link.EntityType, link.EntityId,
                db.ExternalLinks.Count(other => other.System == link.System && other.ExternalType == link.ExternalType && other.ExternalId == link.ExternalId),
                db.ExternalLinks.Count(other => other.System == link.System && other.ExternalType == link.ExternalType
                    && other.EntityType == EntityTypes.Organization && other.EntityId == link.EntityId)))
            .ToListAsync(ct);
        var keys = selected.Select(link => link.ExternalId).Distinct(StringComparer.Ordinal).ToArray();
        var records = db.ExternalRecords.AsNoTracking().Where(record => record.System == CustomerIdentityContract.System
            && record.ExternalType == CustomerIdentityContract.ExternalType);
        var references = await records.Where(record => keys.Contains(record.ExternalId)).OrderBy(record => record.Id)
            .Select(record => new LocalMappingReference(record.Id, record.System, record.ExternalType, record.ExternalId, record.IsGone,
                EF.Functions.DataLength(record.Payload), record.Payload.Substring(0, 4096))).ToListAsync(ct);
        var unlinked = await records.CountAsync(record => !record.IsGone && !db.ExternalLinks.Any(link => link.System == record.System
            && link.ExternalType == record.ExternalType && link.ExternalId == record.ExternalId), ct);
        var names = await customers.GetOrganizationNamesAsync(selected.Where(link => link.EntityType == EntityTypes.Organization)
            .Select(link => link.EntityId).Distinct().ToArray(), ct);
        // Names never leave this boundary or enter diagnostic fingerprints.
        return new(total, unlinked, selected, references, names.Keys.Order().ToArray());
    }
}
