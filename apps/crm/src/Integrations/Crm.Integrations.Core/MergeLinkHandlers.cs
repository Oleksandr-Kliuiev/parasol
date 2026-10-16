using Crm.Customers.Contracts;
using Crm.Integrations.Core.Persistence;
using Crm.SharedKernel.Domain;
using Microsoft.EntityFrameworkCore;

namespace Crm.Integrations.Core;

/// <summary>
/// Keeps external links pointing at the surviving organization after a merge. If the target already has a link for the
/// same system and type, the source's link stays on the (now hidden) source and shows up for manual review.
/// </summary>
internal sealed class OrganizationsMergedLinkHandler(IntegrationDbContext db, ICustomersApi customers) :
    IDomainEventHandler<OrganizationsMerged>,
    IDomainEventHandler<OrganizationMergeUndone>
{
    public async Task HandleAsync(OrganizationsMerged domainEvent, CancellationToken cancellationToken)
    {
        // Delivered after the undo (retried or replayed): the links stay where the undo left them (DEV-07).
        if (await customers.IsMergeUndoneAsync(domainEvent.MergeId, cancellationToken))
        {
            return;
        }

        var sourceLinks = await db.ExternalLinks
            .Where(l => l.EntityType == EntityTypes.Organization && l.EntityId == domainEvent.SourceOrganizationId)
            .ToListAsync(cancellationToken);
        var targetKeys = await db.ExternalLinks
            .Where(l => l.EntityType == EntityTypes.Organization && l.EntityId == domainEvent.TargetOrganizationId)
            .Select(l => new { l.System, l.ExternalType })
            .ToListAsync(cancellationToken);

        foreach (var link in sourceLinks.Where(l => !targetKeys.Any(t => t.System == l.System && t.ExternalType == l.ExternalType)))
        {
            link.PreviousEntityId = link.EntityId;
            link.MovedByMergeId = domainEvent.MergeId;
            link.EntityId = domainEvent.TargetOrganizationId;
        }

        await db.SaveChangesAsync(cancellationToken);
    }

    public async Task HandleAsync(OrganizationMergeUndone domainEvent, CancellationToken cancellationToken)
    {
        var moved = await db.ExternalLinks.Where(l => l.MovedByMergeId == domainEvent.MergeId).ToListAsync(cancellationToken);
        foreach (var link in moved)
        {
            link.EntityId = link.PreviousEntityId ?? link.EntityId;
            link.PreviousEntityId = null;
            link.MovedByMergeId = null;
        }

        await db.SaveChangesAsync(cancellationToken);
    }
}
