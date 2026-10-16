using Crm.Billing.Domain;
using Crm.Billing.Persistence;
using Crm.Projects.Contracts;
using Crm.SharedKernel.Domain;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace Crm.Billing.Features;

/// <summary>
/// A completed project phase that the customer pays for waits for the next run, like an accepted quote does (docs/02 §4.10).
/// Keyed by the phase, so completing it twice queues one charge; ordered by event time, so a completion delivered after a
/// later reopening (a retry, a replay) does not bring the withdrawn charge back (DEV-07).
/// </summary>
internal sealed class ProjectPhaseChargeHandler(
    BillingDbContext db, IProjectsApi projects, ILogger<ProjectPhaseChargeHandler> logger) : IDomainEventHandler<ProjectPhaseBillable>
{
    public const string SourceType = "project-phase";

    public async Task HandleAsync(ProjectPhaseBillable domainEvent, CancellationToken cancellationToken)
    {
        var existing = await db.PendingCharges.IgnoreQueryFilters()
            .SingleOrDefaultAsync(c => c.SourceType == SourceType && c.SourceLineId == domainEvent.PhaseId, cancellationToken);
        if (existing is not null && existing.DecidedSince(domainEvent.OccurredAt))
        {
            logger.LogInformation("Project phase {Phase}: a completion from {OccurredAt} is older than the charge's last change; ignored.",
                domainEvent.PhaseId, domainEvent.OccurredAt);
            return;
        }

        if (existing is { IsDeleted: false })
        {
            return;
        }

        // Reopened (or removed) since the completion: the completion is history, whatever order the events arrive in.
        if (await projects.IsPhaseCompletedAsync(domainEvent.PhaseId, cancellationToken) is not true)
        {
            logger.LogInformation("Project phase {Phase} is no longer completed; its completion queues nothing.", domainEvent.PhaseId);
            return;
        }

        if (existing is not null)
        {
            // Completed again after a reopen: the withdrawn item comes back with its id, so the charge register still sees
            // whatever an earlier basis billed with it instead of a new obligation (ADR-013).
            existing.Requeue(domainEvent.ProductId, domainEvent.Description, domainEvent.Amount, domainEvent.CompletedOn, domainEvent.OccurredAt);
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
            domainEvent.CompletedOn,
            domainEvent.OccurredAt));
        await db.SaveChangesAsync(cancellationToken);
        logger.LogInformation("Project phase {Phase} completed: {Amount} queued for the next billing run.", domainEvent.PhaseId, domainEvent.Amount);
    }
}

/// <summary>
/// Reopening a phase takes its charge back, as long as no basis has been exported with it (BR-BIL-09) and no later completion
/// has decided otherwise (DEV-07).
/// </summary>
internal sealed class ProjectPhaseChargeCancelledHandler(
    BillingDbContext db, IProjectsApi projects, ILogger<ProjectPhaseChargeCancelledHandler> logger) : IDomainEventHandler<ProjectPhaseBillingCancelled>
{
    public async Task HandleAsync(ProjectPhaseBillingCancelled domainEvent, CancellationToken cancellationToken)
    {
        var charge = await db.PendingCharges.SingleOrDefaultAsync(
            c => c.SourceType == ProjectPhaseChargeHandler.SourceType && c.SourceLineId == domainEvent.PhaseId, cancellationToken);
        if (charge is null || charge.InvoicedBasisId is not null)
        {
            return;
        }

        if (charge.DecidedSince(domainEvent.OccurredAt) || await projects.IsPhaseCompletedAsync(domainEvent.PhaseId, cancellationToken) is true)
        {
            logger.LogInformation("Project phase {Phase}: the reopening from {OccurredAt} was overtaken by a later completion; ignored.",
                domainEvent.PhaseId, domainEvent.OccurredAt);
            return;
        }

        charge.Withdraw(domainEvent.OccurredAt);
        await db.SaveChangesAsync(cancellationToken);
        logger.LogInformation("Project phase {Phase} was reopened; its queued charge was withdrawn.", domainEvent.PhaseId);
    }
}
