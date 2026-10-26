using System.Globalization;
using Crm.Identity.Contracts;
using Crm.Privacy.Contracts;
using Crm.Service.Contracts;
using Microsoft.Extensions.Options;

namespace Crm.Integrations.Atera;

/// <summary>Tickets ready for the mirror, the ones left out because their customer has no link, and those whose end user is suppressed.</summary>
public sealed record AteraTicketBatch(IReadOnlyList<ExternalTicket> Tickets, int Unlinked, IReadOnlySet<long> Withheld);

/// <summary>
/// Turns Atera tickets into the CRM's ticket mirror (BR-SRV-01), the one place the rules live for the ticket reads and the ticket
/// actions (M39.2): a ticket belongs to the organization its customer is linked to (tickets of unlinked customers are left out),
/// its end user becomes a CRM contact through the contact link, its technician a CRM user through the technician mapping, and an end
/// user erased at their request (DEV-11) is mirrored without name, address or contact.
/// </summary>
public sealed class AteraTicketMirror(AteraLinkIndex links, ITechnicianDirectory technicians, ISuppressionList suppressions, IOptions<AteraOptions> options)
{
    /// <summary>
    /// The links and suppressions a read maps with, taken before Atera is read: a ticket keeps the exact owner (link and customer) that
    /// held when the read began, and a rebind during the read waits for the next one (M22 provenance).
    /// </summary>
    public async Task<AteraTicketMapping> SnapshotAsync(CancellationToken ct) =>
        new(await links.TicketOwnersAsync(ct), await links.ContactsAsync(ct), await suppressions.SnapshotAsync(ct), technicians, options.Value.TicketUrlTemplate);

    /// <summary>A snapshot taken now, for a read of one ticket (after an action).</summary>
    public async Task<AteraTicketBatch> MapAsync(IReadOnlyCollection<AteraTicket> source, CancellationToken ct) =>
        await (await SnapshotAsync(ct)).MapAsync(source, ct);
}

/// <summary>The snapshot of one read (<see cref="AteraTicketMirror.SnapshotAsync"/>) and the mapping it does.</summary>
public sealed class AteraTicketMapping(
    IReadOnlyDictionary<long, TicketOwnerBinding> owners,
    IReadOnlyDictionary<long, Guid> contacts,
    ISuppressionCheck suppressed,
    ITechnicianDirectory technicians,
    string? ticketUrlTemplate)
{
    public async Task<AteraTicketBatch> MapAsync(IReadOnlyCollection<AteraTicket> source, CancellationToken ct)
    {
        var technicianMap = await technicians.ResolveAsync(
            source.Select(t => AteraServiceMapping.Technician(t.TechnicianId?.ToString(CultureInfo.InvariantCulture), t.TechnicianEmail, t.TechnicianName))
                .OfType<TechnicianRef>().DistinctBy(t => t.ExternalId).ToList(),
            ct);

        var tickets = new List<ExternalTicket>();
        var withheld = new HashSet<long>();
        var unlinked = 0;
        foreach (var ticket in source.DistinctBy(t => t.TicketId))
        {
            if (ticket.CustomerId is not { } customerId || !owners.TryGetValue(customerId, out var owner))
            {
                unlinked++;
                continue;
            }

            var technicianKey = ticket.TechnicianId?.ToString(CultureInfo.InvariantCulture) ?? ticket.TechnicianEmail;
            var endUserSuppressed = suppressed.IsSuppressed(
                ticket.EndUserEmail,
                ticket.EndUserId is { } suppressedId ? new ExternalReference(AteraTypes.System, AteraTypes.Contact, suppressedId.ToString(CultureInfo.InvariantCulture)) : null);
            if (endUserSuppressed)
            {
                withheld.Add(ticket.TicketId);
            }

            tickets.Add(new ExternalTicket(
                AteraTypes.System, ticket.TicketId, owner.OrganizationId,
                !endUserSuppressed && ticket.EndUserId is { } endUserId && contacts.TryGetValue(endUserId, out var contactId) ? contactId : null,
                ticket.Title, ticket.Status, ticket.Priority, ticket.Impact, ticket.Type, ticket.Source,
                technicianKey is not null && technicianMap.TryGetValue(technicianKey, out var userId) ? userId : null,
                ticket.TechnicianName, endUserSuppressed ? null : ticket.EndUserName, endUserSuppressed ? null : ticket.EndUserEmail,
                ticket.CreatedAt, ticket.FirstResponseAt, ticket.ResolvedAt,
                ticket.LastActivityAt, AteraServiceMapping.Url(ticketUrlTemplate, ticket.TicketId),
                owner.CustomerId, owner.LinkId));
        }

        return new AteraTicketBatch(tickets, unlinked, withheld);
    }
}
