using System.Globalization;
using Crm.Customers.Contracts;
using Crm.Integrations.Core;
using Crm.Integrations.Core.Persistence;
using Crm.Service.Contracts;
using Crm.SharedKernel.Operations;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Crm.Integrations.Atera;

/// <summary>
/// Creates the ticket in Atera, creating the contact there first when needed (BR-SRV-02). Atera has no idempotency key and does
/// not search by reference, so every create is bracketed by the external effect journal and the ticket carries the request's
/// marker in its description: when an earlier send may have happened, the customer's tickets are searched for the marker before
/// anything is sent, and when it is not found a person is asked instead of sending again (DEV-19).
/// </summary>
internal sealed class AteraCreateTicketHandler(
    IAteraClient client,
    IServiceApi service,
    ICustomersApi customers,
    ExternalLinkService links,
    IExternalEffectJournal journal,
    IOptions<AteraOptions> options,
    ILogger<AteraCreateTicketHandler> logger) : IOutboundHandler
{
    /// <summary>The journal kind of the ticket POST itself, written right before it (DEV-13). The reference is the Atera ticket id.</summary>
    public const string TicketEffect = "ticket-post";

    /// <summary>The journal kind of the contact POST. The reference is the Atera contact id.</summary>
    public const string ContactEffect = "contact-post";

    /// <summary>How far before the first uncertain attempt tickets are still looked at when searching for the marker.</summary>
    private static readonly TimeSpan SearchMargin = TimeSpan.FromHours(1);

    /// <summary>Pages of one customer's tickets read at most while searching; the newest come first.</summary>
    private const int MaxSearchPages = 20;

    private const int MaxContactOwnerRows = 1000;
    private static readonly TimeSpan ContactOwnerBudget = TimeSpan.FromSeconds(10);

    public string System => AteraTypes.System;

    public string Operation => AteraTypes.CreateTicket;

    /// <summary>The text that identifies a request in the ticket description; <see cref="AteraTicketMarker.Of"/> is the one place that builds it.</summary>
    public static string Marker(Guid requestId) => AteraTicketMarker.Of(requestId);

    public async Task<OutboundResult> ExecuteAsync(OutboundOperation operation, CancellationToken cancellationToken)
    {
        if (await service.GetTicketRequestAsync(operation.EntityId, cancellationToken) is not { Status: TicketRequestStatus.Pending } request)
        {
            return OutboundResult.NothingToDo;
        }

        if (!options.Value.WriteEnabled)
        {
            await service.FailTicketRequestAsync(request.Id, "Creating tickets in Atera is switched off.", cancellationToken);
            return new OutboundResult("Writing to Atera is disabled.");
        }

        var customerLink = await links.FindByEntityAsync(EntityTypes.Organization, request.OrganizationId, System, AteraTypes.Customer, cancellationToken);
        if (customerLink is null)
        {
            await service.FailTicketRequestAsync(request.Id, "The organization is not linked to a customer in Atera.", cancellationToken);
            throw new PermanentOutboundException("The organization is not linked to a customer in Atera.");
        }

        if (!long.TryParse(customerLink.ExternalId, NumberStyles.None, CultureInfo.InvariantCulture, out var customerId) || customerId <= 0)
            await RefuseAsync(request, "The customer mapping needs review before creating a ticket.", cancellationToken);
        if (options.Value.WriteAllowedCustomerIds.Count > 0 && !options.Value.WriteAllowedCustomerIds.Contains(customerLink.ExternalId))
        {
            await service.FailTicketRequestAsync(request.Id, "The customer is not in WriteAllowedCustomerIds.", cancellationToken);
            return new OutboundResult($"Atera customer {customerLink.ExternalId} is not in WriteAllowedCustomerIds; skipped.");
        }

        // An earlier attempt may have created the ticket without the answer reaching us (or without the local write that records it).
        var earlier = (await journal.ForEntityAsync(EntityTypes.TicketRequest, request.Id, cancellationToken))
            .Where(e => e.System == System && e.Kind == TicketEffect).ToList();
        if (ExternalEffects.MayExist(earlier))
        {
            return await SettleEarlierAttemptAsync(request, customerId, earlier, cancellationToken);
        }

        var contact = await RequireEligibleContactAsync(request, customerLink, cancellationToken);
        long endUserId;
        ExternalLink resolvedContact;
        var contactLink = request.ContactId is { } contactId
            ? await links.FindByEntityAsync(EntityTypes.Contact, contactId, System, AteraTypes.Contact, cancellationToken)
            : null;
        if (contactLink is not null)
        {
            resolvedContact = contactLink;
            if (!long.TryParse(contactLink.ExternalId, NumberStyles.None, CultureInfo.InvariantCulture, out endUserId) || endUserId <= 0)
                await RefuseAsync(request, "The contact mapping needs review before creating a ticket.", cancellationToken);
            await RequireContactOwnerAsync(request, endUserId, customerId, cancellationToken);
        }
        else if (request.ContactId is { } newContactId)
        {
            (endUserId, resolvedContact) = await EnsureContactAsync(operation, request, customerLink, customerId, newContactId, contact, cancellationToken);
        }
        else
        {
            await service.FailTicketRequestAsync(request.Id, "Choose a contact for the ticket.", cancellationToken);
            throw new PermanentOutboundException("The ticket has no contact.");
        }

        // A contact create or owner lookup may outlive a CRM affiliation, merge or link replacement.
        await RequireEligibleContactAsync(request, customerLink, cancellationToken);
        var currentContact = await links.FindByEntityAsync(EntityTypes.Contact, contact.Id, System, AteraTypes.Contact, cancellationToken);
        if (currentContact is null || currentContact.Id != resolvedContact.Id ||
            !string.Equals(currentContact.ExternalId, resolvedContact.ExternalId, StringComparison.Ordinal))
            await RefuseAsync(request, "The contact mapping changed; review the request before creating a ticket.", cancellationToken);
        var effect = await journal.BeginAsync(new ExternalEffect(System, TicketEffect, EntityTypes.TicketRequest, request.Id, operation.Id), cancellationToken);
        long ticketId;
        try
        {
            ticketId = await client.CreateTicketAsync(new AteraTicketWrite(
                request.Title, AteraTicketMarker.Embed(request.Description, request.Id), request.Priority, "Minor", "Open", request.Type, endUserId), cancellationToken);
        }
        catch (AteraApiException rejected) when (IsRejection(rejected.Status))
        {
            // Atera answered and refused: nothing was created.
            await journal.CompleteAsync(effect, EffectPhase.Failed, null, cancellationToken);
            await service.FailTicketRequestAsync(request.Id, $"Atera rejected the ticket ({(int)rejected.Status}).", cancellationToken);
            throw new PermanentOutboundException($"Atera rejected the ticket ({(int)rejected.Status}).");
        }

        // The ticket id is on record (journal and outbound result) before the local write that completes the request: when that
        // write fails the next attempt finds the id and completes without sending.
        await journal.CompleteAsync(effect, EffectPhase.Sent, ticketId.ToString(CultureInfo.InvariantCulture), cancellationToken);
        await service.CompleteTicketRequestAsync(request.Id, ticketId, AteraServiceMapping.Url(options.Value.TicketUrlTemplate, ticketId), cancellationToken);
        return new OutboundResult($"Created Atera ticket {ticketId}.", ticketId.ToString(CultureInfo.InvariantCulture));
    }

    private async Task<OutboundResult> SettleEarlierAttemptAsync(
        TicketRequestView request, long customerId, IReadOnlyList<ExternalEffectEntry> earlier, CancellationToken cancellationToken)
    {
        long? ticketId = long.TryParse(ExternalEffects.LatestReference(earlier), NumberStyles.Integer, CultureInfo.InvariantCulture, out var reported) ? reported : null;
        if (ticketId is null)
        {
            var since = earlier.Min(e => e.At) - SearchMargin;
            ticketId = await FindByMarkerAsync(customerId, request.Id, since, cancellationToken);
        }

        if (ticketId is { } found)
        {
            logger.LogInformation("Atera ticket for request {RequestId} already exists; the request is completed without sending again.", request.Id);
            await service.CompleteTicketRequestAsync(request.Id, found, AteraServiceMapping.Url(options.Value.TicketUrlTemplate, found), cancellationToken);
            return new OutboundResult($"Atera ticket {found} already existed.", found.ToString(CultureInfo.InvariantCulture));
        }

        var message = $"An earlier send to Atera got no answer and no ticket with {Marker(request.Id)} was found; check Atera before creating the ticket again.";
        await service.FailTicketRequestAsync(request.Id, message, cancellationToken);
        throw new PermanentOutboundException(message);
    }

    private async Task<long?> FindByMarkerAsync(long customerId, Guid requestId, DateTimeOffset since, CancellationToken cancellationToken)
    {
        var marker = Marker(requestId);
        var older = 0;
        var read = 0;
        var pageSize = Math.Clamp(options.Value.ItemsInPage, 1, 50);
        await foreach (var ticket in client.GetCustomerTicketsAsync(customerId, cancellationToken))
        {
            if (ticket.Description?.Contains(marker, StringComparison.Ordinal) == true)
            {
                return ticket.TicketId;
            }

            // Newest first: two pages of tickets from before the first uncertain attempt end the search.
            older = ticket.CreatedAt < since ? older + 1 : 0;
            if (older >= 2 * pageSize || ++read >= MaxSearchPages * pageSize)
            {
                break;
            }
        }

        return null;
    }

    /// <summary>The Atera contact for a CRM contact that has none yet: found when an earlier create may have happened, else created.</summary>
    private async Task<(long Id, ExternalLink Link)> EnsureContactAsync(
        OutboundOperation operation, TicketRequestView request, ExternalLink customerLink, long customerId, Guid contactId, ContactSyncView contact, CancellationToken cancellationToken)
    {
        var earlier = (await journal.ForEntityAsync(EntityTypes.Contact, contactId, cancellationToken))
            .Where(e => e.System == System && e.Kind == ContactEffect).ToList();
        long? atera = null;
        if (ExternalEffects.MayExist(earlier))
        {
            atera = long.TryParse(ExternalEffects.LatestReference(earlier), NumberStyles.Integer, CultureInfo.InvariantCulture, out var reported)
                ? reported
                : await FindContactAsync(customerId, contact.Email, cancellationToken);
            if (atera is null)
            {
                var message = "An earlier contact create in Atera got no answer and no matching contact was found; check Atera before creating the ticket again.";
                await service.FailTicketRequestAsync(request.Id, message, cancellationToken);
                throw new PermanentOutboundException(message);
            }
        }
        else
        {
            contact = await RequireEligibleContactAsync(request, customerLink, cancellationToken);
            var effect = await journal.BeginAsync(new ExternalEffect(System, ContactEffect, EntityTypes.Contact, contactId, operation.Id), cancellationToken);
            try
            {
                atera = await client.CreateContactAsync(new AteraContactWrite(
                    customerId, string.IsNullOrWhiteSpace(contact.FirstName) ? "-" : contact.FirstName, string.IsNullOrWhiteSpace(contact.LastName) ? "-" : contact.LastName,
                    contact.Email, contact.Phone ?? contact.MobilePhone), cancellationToken);
            }
            catch (AteraApiException rejected) when (IsRejection(rejected.Status))
            {
                await journal.CompleteAsync(effect, EffectPhase.Failed, null, cancellationToken);
                await service.FailTicketRequestAsync(request.Id, $"Atera rejected the contact ({(int)rejected.Status}).", cancellationToken);
                throw new PermanentOutboundException($"Atera rejected the contact ({(int)rejected.Status}).");
            }

            await journal.CompleteAsync(effect, EffectPhase.Sent, atera.Value.ToString(CultureInfo.InvariantCulture), cancellationToken);
        }

        // The journal is keyed by CRM person, not customer; verify ownership before adopting any known or recovered ID.
        await RequireContactOwnerAsync(request, atera.Value, customerId, cancellationToken);
        await RequireEligibleContactAsync(request, customerLink, cancellationToken);
        var link = await links.LinkAsync(EntityTypes.Contact, contactId, System, AteraTypes.Contact, atera.Value.ToString(CultureInfo.InvariantCulture),
            LinkMethod.Exported, operation.RequestedBy, cancellationToken);
        if (!link.IsSuccess)
        {
            // The contact exists in Atera (its id is in the journal); without the link no later attempt may create it again.
            await service.FailTicketRequestAsync(request.Id, $"The Atera contact {atera} could not be linked: {link.Error!.Message}", cancellationToken);
            throw new PermanentOutboundException(link.Error!.Message);
        }

        return (atera.Value, link.Value);
    }

    private async Task<ContactSyncView> RequireEligibleContactAsync(TicketRequestView request, ExternalLink expectedCustomer, CancellationToken ct)
    {
        var current = await service.GetTicketRequestAsync(request.Id, ct);
        if (current is not { Status: TicketRequestStatus.Pending })
            throw new PermanentOutboundException("The ticket request is no longer pending.");
        var organization = await customers.GetOrganizationAsync(request.OrganizationId, ct);
        var contact = request.ContactId is { } id ? await customers.GetContactForSyncAsync(id, ct) : null;
        var link = await links.FindByEntityAsync(EntityTypes.Organization, request.OrganizationId, System, AteraTypes.Customer, ct);
        if (current.OrganizationId != request.OrganizationId || current.ContactId != request.ContactId ||
            organization is null || contact is null || !contact.IsUsableFor(request.OrganizationId) ||
            link is null || link.Id != expectedCustomer.Id || !string.Equals(link.ExternalId, expectedCustomer.ExternalId, StringComparison.Ordinal))
            await RefuseAsync(request, "The customer, contact affiliation or customer mapping changed; review the request before creating a ticket.", ct);
        return contact!;
    }

    private async Task RequireContactOwnerAsync(TicketRequestView request, long contactId, long customerId, CancellationToken ct)
    {
        if (contactId <= 0)
            await RefuseAsync(request, "Atera contact ownership could not be verified; review the request before creating a ticket.", ct);
        // A saved link/mirror is only last-known ownership. Use the existing read API, never an e-mail substitution or a second create.
        using var budget = CancellationTokenSource.CreateLinkedTokenSource(ct);
        budget.CancelAfter(ContactOwnerBudget);
        var read = 0;
        try
        {
            await foreach (var contact in client.GetContactsAsync(budget.Token))
            {
                if (contact.ContactId == contactId)
                {
                    if (contact.CustomerId != customerId || contact.InIgnoreMode)
                        await RefuseAsync(request, "The linked Atera contact is unavailable for this customer; review its mapping.", ct);
                    return;
                }
                if (++read >= MaxContactOwnerRows) break;
            }
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            await RefuseAsync(request, "Atera contact ownership could not be verified; review the request before creating a ticket.", ct);
        }
        await RefuseAsync(request, "Atera contact ownership could not be verified; review the request before creating a ticket.", ct);
    }

    private async Task RefuseAsync(TicketRequestView request, string message, CancellationToken ct)
    {
        await service.FailTicketRequestAsync(request.Id, message, ct);
        throw new PermanentOutboundException(message);
    }

    private async Task<long?> FindContactAsync(long customerId, string? email, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(email))
        {
            return null;
        }

        long? found = null;
        await foreach (var contact in client.GetContactsAsync(cancellationToken))
        {
            if (contact.CustomerId == customerId && string.Equals(contact.Email?.Trim(), email.Trim(), StringComparison.OrdinalIgnoreCase))
            {
                if (found is not null && found != contact.ContactId)
                {
                    return null;
                }

                found = contact.ContactId;
            }
        }

        return found;
    }

    /// <summary>A refusal Atera answered with, so nothing exists. Timeouts, conflicts and throttling prove nothing.</summary>
    internal static bool IsRejection(global::System.Net.HttpStatusCode status) =>
        (int)status is >= 400 and < 500 && status is not (global::System.Net.HttpStatusCode.RequestTimeout or global::System.Net.HttpStatusCode.Conflict or global::System.Net.HttpStatusCode.TooManyRequests);
}

/// <summary>The marker that ties an Atera ticket to the CRM request that created it.</summary>
internal static class AteraTicketMarker
{
    public static string Of(Guid requestId) => $"[CRM-TR:{requestId:D}]";

    public static string Embed(string description, Guid requestId) =>
        string.IsNullOrWhiteSpace(description) ? Of(requestId) : $"{description.TrimEnd()}\n\n{Of(requestId)}";
}
