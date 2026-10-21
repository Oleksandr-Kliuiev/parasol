using System.Globalization;
using Crm.Customers.Contracts;
using Crm.Infrastructure.Persistence;
using Crm.Integrations.Core.Persistence;
using Crm.Notifications.Contracts;
using Crm.Service.Contracts;
using Crm.SharedKernel.Domain;
using Microsoft.EntityFrameworkCore;

namespace Crm.Integrations.Core.Actions;

/// <summary>
/// An action ended without a clear answer, so a person has to check at the vendor (M39). Written to the outbox with that outcome, by the
/// worker's attempt or a restore's reconciliation; the event carries the action's id only.
/// </summary>
public sealed record VendorActionNeedsCheck(Guid ActionId) : DomainEvent;

/// <summary>When the person who asked hears of an action without a clear answer (M39).</summary>
public static class VendorActionNotices
{
    /// <summary>
    /// The pause before the notice: the confirmation that followed the action asks the person there and then, and an action they
    /// settled meanwhile needs no notice.
    /// </summary>
    public static readonly TimeSpan Delay = TimeSpan.FromMinutes(2);

    /// <summary>The outbox row of <see cref="VendorActionNeedsCheck"/>, saved with the outcome and delivered after <see cref="Delay"/>.</summary>
    public static OutboxMessage Message(Guid actionId, DateTimeOffset now)
    {
        var message = OutboxMessage.For(new VendorActionNeedsCheck(actionId), now, null);
        message.NextAttemptAt = now + Delay;
        return message;
    }
}

/// <summary>
/// Tells the person who asked for an action that it ended without a clear answer (M39): a notice in the bell and the digest that leads to
/// the ticket with the action's card open, where they check at the vendor and record what they found. The notice stores the kind and its
/// parameters (the vendor, the kind, the ticket number, the customer), never a sentence; an action already settled needs none. A handler
/// changes its own module only (DEV-07), so the notice goes to the Notifications module as <see cref="NotificationRequested"/>.
/// </summary>
internal sealed class VendorActionNeedsCheckHandler(
    IntegrationDbContext db, IServiceApi service, ICustomersApi customers, TimeProvider time) : IDomainEventHandler<VendorActionNeedsCheck>
{
    public async Task HandleAsync(VendorActionNeedsCheck domainEvent, CancellationToken cancellationToken)
    {
        var action = await db.VendorActions.AsNoTracking().SingleOrDefaultAsync(a => a.Id == domainEvent.ActionId, cancellationToken);
        if (action is not { Status: VendorActionStatus.Uncertain })
        {
            return;
        }

        var number = VendorActionTargets.TicketOf(action);
        var ticket = number is { } ticketNumber ? await service.GetTicketAsync(action.System, ticketNumber, cancellationToken) : null;
        var organizationId = ticket?.OrganizationId ?? action.OrganizationId;
        var parameters = new Dictionary<string, string>(StringComparer.Ordinal) { ["system"] = action.System, ["kind"] = action.Kind };
        if (number is { } shown)
        {
            parameters["ticket"] = shown.ToString(CultureInfo.InvariantCulture);
        }

        if (organizationId is { } organization &&
            (await customers.GetOrganizationNamesAsync([organization], cancellationToken)).GetValueOrDefault(organization) is { } name)
        {
            parameters["organization"] = name;
        }

        db.OutboxMessages.Add(OutboxMessage.For(new NotificationRequested(new NotificationRequest(
            NotificationKind.VendorActionUncertain,
            action.RequestedBy,
            // An action ends without a clear answer once: its id is the natural key.
            $"vendor-action:{action.Id:N}:uncertain",
            parameters,
            organizationId,
            ticket is null ? null : $"/tickets?ticket={ticket.Id:D}&action={action.Id:D}",
            Warning: true)), time.GetUtcNow(), null));
        await db.SaveChangesAsync(cancellationToken);
    }
}

/// <summary>The targets of one page of a list, whose action facts it shows beside its rows (M39).</summary>
public sealed record VendorActionLookupRequest(string? System, string? TargetType, IReadOnlyList<string>? TargetIds);

/// <summary>
/// The actions on one target, counted: waiting for the worker (scheduled, queued, sending), done (succeeded, or already so at the
/// vendor), and waiting for a person (<c>Uncertain</c>) with the newest of those, so a row can open it.
/// </summary>
public sealed record VendorActionTargetFacts(string TargetId, int Waiting, int Done, int Uncertain, Guid? CheckId);

/// <summary>The facts of the targets that have any action the caller may read; a target without one is left out.</summary>
public sealed record VendorActionLookup(IReadOnlyList<VendorActionTargetFacts> Items);
