using Crm.Integrations.Core.Persistence;
using Crm.SharedKernel.Domain;
using Crm.SharedKernel.Results;
using Microsoft.EntityFrameworkCore;

namespace Crm.Integrations.Core;

public static class EntityTypes
{
    public const string Organization = "Organization";
    public const string Contact = "Contact";
    public const string Product = "Product";

    /// <summary>Not a link target: outbound operations that carry a request instead of a record use it as the entity type.</summary>
    public const string TicketRequest = "TicketRequest";
}

public sealed partial class ExternalLinkService(IntegrationDbContext db, TimeProvider timeProvider)
{
    public Task<ExternalLink?> FindByExternalAsync(string system, string externalType, string externalId, CancellationToken cancellationToken) =>
        db.ExternalLinks.AsNoTracking()
            .SingleOrDefaultAsync(l => l.System == system && l.ExternalType == externalType && l.ExternalId == externalId, cancellationToken);

    public Task<ExternalLink?> FindByEntityAsync(string entityType, Guid entityId, string system, string externalType, CancellationToken cancellationToken) =>
        db.ExternalLinks.AsNoTracking()
            .SingleOrDefaultAsync(l => l.EntityType == entityType && l.EntityId == entityId && l.System == system && l.ExternalType == externalType, cancellationToken);

    public async Task<IReadOnlyList<ExternalLink>> ForEntityAsync(string entityType, Guid entityId, CancellationToken cancellationToken) =>
        await db.ExternalLinks.AsNoTracking()
            .Where(l => l.EntityType == entityType && l.EntityId == entityId)
            .OrderBy(l => l.System).ThenBy(l => l.ExternalType)
            .ToListAsync(cancellationToken);

    /// <summary>Which of the given CRM records are linked in a system, mapped to their external id.</summary>
    public async Task<IReadOnlyDictionary<Guid, string>> LinkedEntitiesAsync(
        string entityType, string system, string externalType, IReadOnlyCollection<Guid> entityIds, CancellationToken cancellationToken)
    {
        if (entityIds.Count == 0)
        {
            return new Dictionary<Guid, string>();
        }

        var ids = entityIds.Distinct().ToList();
        var rows = await db.ExternalLinks.AsNoTracking()
            .Where(l => l.EntityType == entityType && l.System == system && l.ExternalType == externalType && ids.Contains(l.EntityId))
            .Select(l => new { l.EntityId, l.ExternalId })
            .ToListAsync(cancellationToken);
        return rows.ToDictionary(r => r.EntityId, r => r.ExternalId);
    }

    public async Task<Result<ExternalLink>> LinkAsync(
        string entityType, Guid entityId, string system, string externalType, string externalId, LinkMethod method, Guid? userId, CancellationToken cancellationToken)
    {
        var existingForExternal = await FindByExternalAsync(system, externalType, externalId, cancellationToken);
        if (existingForExternal is not null)
        {
            return existingForExternal.EntityId == entityId
                ? existingForExternal
                : Error.Conflict("INT_EXTERNAL_ALREADY_LINKED", "The external record is already linked to another CRM record.",
                    new Dictionary<string, object?> { ["entityId"] = existingForExternal.EntityId });
        }

        var existingForEntity = await FindByEntityAsync(entityType, entityId, system, externalType, cancellationToken);
        if (existingForEntity is not null)
        {
            return Error.Conflict("INT_ENTITY_ALREADY_LINKED", "The CRM record is already linked to another record in this system.",
                new Dictionary<string, object?> { ["externalId"] = existingForEntity.ExternalId });
        }

        var link = new ExternalLink
        {
            Id = SequentialId.New(),
            EntityType = entityType,
            EntityId = entityId,
            System = system,
            ExternalType = externalType,
            ExternalId = externalId,
            Method = method,
            LinkedAt = timeProvider.GetUtcNow(),
            LinkedBy = userId,
        };
        db.ExternalLinks.Add(link);
        await db.SaveChangesAsync(cancellationToken);
        return link;
    }

    public async Task<bool> UnlinkAsync(Guid linkId, CancellationToken cancellationToken) =>
        await db.ExternalLinks.Where(l => l.Id == linkId).ExecuteDeleteAsync(cancellationToken) > 0;
}
