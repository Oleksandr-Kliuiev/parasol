using Crm.Activities.Contracts;
using Crm.Sales.Persistence;
using Crm.SharedKernel.Domain;
using Microsoft.EntityFrameworkCore;

namespace Crm.Sales.Features;

/// <summary>Keeps the "last activity" of a deal current, so the stale-deal warning is based on real contact (BR-SAL-03).</summary>
internal sealed class OpportunityActivityHandler(SalesDbContext db) : IDomainEventHandler<ActivityLogged>
{
    public async Task HandleAsync(ActivityLogged domainEvent, CancellationToken cancellationToken)
    {
        if (domainEvent.OpportunityId is not { } opportunityId)
        {
            return;
        }

        if (await db.Opportunities.SingleOrDefaultAsync(o => o.Id == opportunityId, cancellationToken) is { } opportunity)
        {
            opportunity.RecordActivity(domainEvent.At);
            await db.SaveChangesAsync(cancellationToken);
        }
    }
}
