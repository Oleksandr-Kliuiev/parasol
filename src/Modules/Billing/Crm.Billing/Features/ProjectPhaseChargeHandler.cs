using Crm.Billing.Domain;
using Crm.Billing.Persistence;
using Crm.Projects.Contracts;
using Crm.SharedKernel.Domain;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace Crm.Billing.Features;

/// <summary>
/// A completed project phase that the customer pays for waits for the next run, like an accepted quote does (docs/02 §4.10).
/// Keyed by the phase, so completing it twice queues one charge.
/// </summary>
internal sealed class ProjectPhaseChargeHandler(
    BillingDbContext db, ILogger<ProjectPhaseChargeHandler> logger) : IDomainEventHandler<ProjectPhaseBillable>
{
    public const string SourceType = "project-phase";

    public async Task HandleAsync(ProjectPhaseBillable domainEvent, CancellationToken cancellationToken)
    {
        var existing = await db.PendingCharges.IgnoreQueryFilters()
            .SingleOrDefaultAsync(c => c.SourceType == SourceType && c.SourceLineId == domainEvent.PhaseId, cancellationToken);
        if (existing is { IsDeleted: false })
        {
            return;
        }

        if (existing is not null)
        {
            // Completed again after a reopen: the withdrawn item comes back with its id, so the charge register still sees
            // whatever an earlier basis billed with it instead of a new obligation (ADR-013).
            existing.Requeue(domainEvent.ProductId, domainEvent.Description, domainEvent.Amount, domainEvent.CompletedOn);
            await db.SaveChangesAsync(cancellationToken);
            logger.LogInformation("Project phase {Phase} completed again: its charge is queued again.", domainEvent.PhaseId);
            return;
        }

        db.PendingCharges.Add(PendingCharge.Create(
            domainEvent.OrganizationId,
            domainEvent.ProductId,
            domainEvent.Description,
            1m,
            domainEvent.Amount,
            0m,
            25m,
            SourceType,
            domainEvent.ProjectId,
            domainEvent.PhaseId,
            domainEvent.CompletedOn));
        await db.SaveChangesAsync(cancellationToken);
        logger.LogInformation("Project phase {Phase} completed: {Amount} queued for the next billing run.", domainEvent.PhaseId, domainEvent.Amount);
    }
}

/// <summary>Reopening a phase takes its charge back, as long as no basis has been exported with it (BR-BIL-09).</summary>
internal sealed class ProjectPhaseChargeCancelledHandler(
    BillingDbContext db, ILogger<ProjectPhaseChargeCancelledHandler> logger) : IDomainEventHandler<ProjectPhaseBillingCancelled>
{
    public async Task HandleAsync(ProjectPhaseBillingCancelled domainEvent, CancellationToken cancellationToken)
    {
        var charge = await db.PendingCharges.SingleOrDefaultAsync(
            c => c.SourceType == ProjectPhaseChargeHandler.SourceType && c.SourceLineId == domainEvent.PhaseId, cancellationToken);
        if (charge is null || charge.InvoicedBasisId is not null)
        {
            return;
        }

        charge.MarkDeleted();
        await db.SaveChangesAsync(cancellationToken);
        logger.LogInformation("Project phase {Phase} was reopened; its queued charge was withdrawn.", domainEvent.PhaseId);
    }
}
