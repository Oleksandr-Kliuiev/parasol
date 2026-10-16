using System.Globalization;
using Crm.Customers.Contracts;
using Crm.Identity.Contracts;
using Crm.Integrations.Core;
using Crm.Integrations.Core.Persistence;
using Crm.Privacy.Contracts;
using Crm.Service.Contracts;
using Crm.SharedKernel.Domain;
using Crm.SharedKernel.Operations;
using Crm.TimeTracking.Contracts;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Crm.Integrations.Atera;

/// <summary>Maps Atera service data to the CRM vocabulary. Field names are read tolerantly in the client; here only the meaning is mapped.</summary>
internal static class AteraServiceMapping
{
    public static DeviceType DeviceTypeOf(string? osType, string? os)
    {
        var text = $"{osType} {os}".ToLowerInvariant();
        if (text.Contains("server", StringComparison.Ordinal) || text.Contains("domain controller", StringComparison.Ordinal))
        {
            return DeviceType.Server;
        }

        if (text.Contains("work station", StringComparison.Ordinal) || text.Contains("workstation", StringComparison.Ordinal) ||
            text.Contains("laptop", StringComparison.Ordinal) || text.Contains("desktop", StringComparison.Ordinal) ||
            text.Contains("windows 1", StringComparison.Ordinal) || text.Contains("mac", StringComparison.Ordinal))
        {
            return DeviceType.Workstation;
        }

        return text.Contains("network", StringComparison.Ordinal) || text.Contains("snmp", StringComparison.Ordinal) || text.Contains("printer", StringComparison.Ordinal)
            ? DeviceType.Network
            : DeviceType.Other;
    }

    /// <summary>Only Critical and Warning alerts reach the CRM (BR-SRV-04).</summary>
    public static AlertSeverity? SeverityOf(string severity) => severity.ToLowerInvariant() switch
    {
        "critical" => AlertSeverity.Critical,
        "warning" => AlertSeverity.Warning,
        _ => null,
    };

    public static string? Url(string? template, object id) =>
        string.IsNullOrWhiteSpace(template) ? null : string.Format(CultureInfo.InvariantCulture, template, id);

    public static TechnicianRef? Technician(string? externalId, string? email, string? name) =>
        string.IsNullOrWhiteSpace(externalId) && string.IsNullOrWhiteSpace(email)
            ? null
            : new TechnicianRef(AteraTypes.System, externalId ?? email!, email, name);
}

/// <summary>Links from Atera ids to CRM records, loaded once per run.</summary>
public sealed class AteraLinkIndex(IntegrationDbContext db)
{
    public async Task<IReadOnlyDictionary<long, Guid>> CustomersAsync(CancellationToken ct) => await LoadAsync(AteraTypes.Customer, ct);

    public async Task<IReadOnlyDictionary<long, Guid>> ContactsAsync(CancellationToken ct) => await LoadAsync(AteraTypes.Contact, ct);

    private async Task<IReadOnlyDictionary<long, Guid>> LoadAsync(string externalType, CancellationToken ct)
    {
        var links = await db.ExternalLinks.AsNoTracking()
            .Where(l => l.System == AteraTypes.System && l.ExternalType == externalType)
            .Select(l => new { l.ExternalId, l.EntityId })
            .ToListAsync(ct);
        var result = new Dictionary<long, Guid>();
        foreach (var link in links)
        {
            if (long.TryParse(link.ExternalId, CultureInfo.InvariantCulture, out var id))
            {
                result[id] = link.EntityId;
            }
        }

        return result;
    }
}

/// <summary>
/// Mirrors Atera tickets (BR-SRV-01). The frequent run reads open tickets; the hourly run walks recent tickets so closed ones and late
/// changes are picked up. Tickets of customers that are not linked to an organization are skipped.
/// </summary>
public sealed class AteraTicketSyncJob(
    IAteraClient client,
    AteraLinkIndex links,
    IServiceApi service,
    ITechnicianDirectory technicians,
    SyncRunner runner,
    TimeProvider time,
    IOptions<AteraOptions> options,
    ILogger<AteraTicketSyncJob> logger,
    ISuppressionList suppressions)
{
    public const string OpenJobId = "atera-tickets";
    public const string RecentJobId = "atera-tickets-recent";

    public async Task RunAsync(bool recent, CancellationToken cancellationToken)
    {
        if (!options.Value.IsConfigured)
        {
            logger.LogInformation("Atera ticket sync skipped: integration not configured.");
            return;
        }

        await runner.RunAsync(AteraTypes.System, recent ? RecentJobId : OpenJobId, async (progress, ct) =>
        {
            var customers = await links.CustomersAsync(ct);
            var contacts = await links.ContactsAsync(ct);
            // DEV-11: a ticket's end user who was erased at their request is mirrored without name, address or contact.
            var suppressed = await suppressions.SnapshotAsync(ct);
            var since = time.GetUtcNow().AddDays(-options.Value.RecentTicketDays);
            var statuses = recent ? [null] : options.Value.OpenTicketStatuses.Cast<string?>().ToList();
            var collected = new List<AteraTicket>();
            var skipped = 0;

            // The list is newest first by ticket id, but a ticket's last activity can be recent while its id is old, so the first
            // old ticket proves nothing. The recent pass stops only after RecentStopPages consecutive pages' worth of tickets
            // with neither creation nor activity inside the window; any ticket inside the window resets the count (DEV-19).
            var stopAfter = Math.Max(1, options.Value.RecentStopPages) * Math.Clamp(options.Value.ItemsInPage, 1, 50);
            var stoppedEarly = false;
            foreach (var status in statuses)
            {
                var outsideWindow = 0;
                await foreach (var ticket in client.GetTicketsAsync(status, ct))
                {
                    progress.Read++;
                    if (recent && ticket.CreatedAt < since && (ticket.LastActivityAt ?? DateTimeOffset.MinValue) < since)
                    {
                        if (++outsideWindow >= stopAfter)
                        {
                            stoppedEarly = true;
                            break;
                        }

                        continue;
                    }

                    outsideWindow = 0;
                    collected.Add(ticket);
                }
            }

            var technicianMap = await technicians.ResolveAsync(
                collected.Select(t => AteraServiceMapping.Technician(t.TechnicianId?.ToString(CultureInfo.InvariantCulture), t.TechnicianEmail, t.TechnicianName))
                    .OfType<TechnicianRef>().DistinctBy(t => t.ExternalId).ToList(),
                ct);

            var tickets = new List<ExternalTicket>();
            foreach (var ticket in collected.DistinctBy(t => t.TicketId))
            {
                if (ticket.CustomerId is not { } customerId || !customers.TryGetValue(customerId, out var organizationId))
                {
                    skipped++;
                    continue;
                }

                var technicianKey = ticket.TechnicianId?.ToString(CultureInfo.InvariantCulture) ?? ticket.TechnicianEmail;
                var endUserSuppressed = suppressed.IsSuppressed(
                    ticket.EndUserEmail,
                    ticket.EndUserId is { } suppressedId ? new ExternalReference(AteraTypes.System, AteraTypes.Contact, suppressedId.ToString(CultureInfo.InvariantCulture)) : null);
                tickets.Add(new ExternalTicket(
                    AteraTypes.System, ticket.TicketId, organizationId,
                    !endUserSuppressed && ticket.EndUserId is { } endUserId && contacts.TryGetValue(endUserId, out var contactId) ? contactId : null,
                    ticket.Title, ticket.Status, ticket.Priority, ticket.Impact, ticket.Type, ticket.Source,
                    technicianKey is not null && technicianMap.TryGetValue(technicianKey, out var userId) ? userId : null,
                    ticket.TechnicianName, endUserSuppressed ? null : ticket.EndUserName, endUserSuppressed ? null : ticket.EndUserEmail,
                    ticket.CreatedAt, ticket.FirstResponseAt, ticket.ResolvedAt,
                    ticket.LastActivityAt, AteraServiceMapping.Url(options.Value.TicketUrlTemplate, ticket.TicketId)));
            }

            progress.Changed = await service.UpsertTicketsAsync(tickets, ct);
            progress.Message = $"changed {progress.Changed}, skipped (customer not linked) {skipped}{(stoppedEarly ? ", stopped after pages outside the window" : string.Empty)}";
        }, cancellationToken);
    }
}

/// <summary>Imports ticket work hours as time entries (FR-TIM-01); the CRM decides afterwards how they are billed.</summary>
public sealed class AteraWorkHoursSyncJob(
    IAteraClient client,
    IServiceApi service,
    ITimeTrackingApi timeTracking,
    ITechnicianDirectory technicians,
    SyncRunner runner,
    TimeProvider time,
    IOptions<AteraOptions> options,
    ILogger<AteraWorkHoursSyncJob> logger)
{
    public const string JobId = "atera-work-hours";

    /// <summary>Consecutive unreadable tickets after which the pass gives up: the provider, not a ticket, is the problem.</summary>
    private const int MaxConsecutiveFailures = 5;

    public async Task RunAsync(CancellationToken cancellationToken)
    {
        if (!options.Value.IsConfigured)
        {
            logger.LogInformation("Atera work hours sync skipped: integration not configured.");
            return;
        }

        await runner.RunAsync(AteraTypes.System, JobId, async (progress, ct) =>
        {
            var since = time.GetUtcNow().AddDays(-options.Value.RecentTicketDays);
            var tickets = await service.GetActiveTicketsAsync(AteraTypes.System, since, ct);
            var records = new List<(AteraWorkHours Hours, TicketRef Ticket)>();
            var consecutiveFailures = 0;
            var dropped = 0;
            var unreadable = 0;
            foreach (var ticket in tickets)
            {
                AteraWorkHoursResult fetched;
                try
                {
                    fetched = await client.GetWorkHoursAsync(ticket.ExternalId, ct);
                    consecutiveFailures = 0;
                }
                catch (Exception ex) when (ex is HttpRequestException or AteraApiException or TimeoutException or Polly.Timeout.TimeoutRejectedException or System.Text.Json.JsonException ||
                                           (ex is TaskCanceledException && !ct.IsCancellationRequested))
                {
                    // One ticket that cannot be read after the retries must not cost the other tickets' hours: what was read is
                    // imported, the failure is counted, and the run does not count as a complete success (DEV-19).
                    progress.Failed++;
                    unreadable++;
                    logger.LogWarning("Atera work hours of ticket {TicketId} could not be read ({ErrorType})", ticket.ExternalId, ex.GetType().Name);
                    if (++consecutiveFailures >= MaxConsecutiveFailures)
                    {
                        // Atera is down, not one ticket: stop instead of waiting out every remaining ticket.
                        break;
                    }

                    continue;
                }

                dropped += fetched.Dropped;
                foreach (var hours in fetched.Records)
                {
                    progress.Read++;
                    records.Add((hours, ticket));
                }
            }

            // Rows without an id or a usable duration are not imported; they count as failures so the pass is not reported as
            // complete while hours may be missing from billing.
            progress.Failed += dropped;

            var technicianMap = await technicians.ResolveAsync(
                records.Select(r => AteraServiceMapping.Technician(r.Hours.TechnicianId, r.Hours.TechnicianEmail, r.Hours.TechnicianName))
                    .OfType<TechnicianRef>().DistinctBy(t => t.ExternalId).ToList(),
                ct);

            var entries = records.Select(r => new ExternalTimeEntry(
                AteraTypes.System,
                r.Hours.Id,
                r.Ticket.OrganizationId,
                r.Ticket.Id,
                r.Ticket.ExternalId,
                r.Ticket.Title,
                r.Hours.TechnicianId is { } key && technicianMap.TryGetValue(key, out var userId) ? userId : null,
                r.Hours.TechnicianId,
                r.Hours.TechnicianName,
                DateOnly.FromDateTime((r.Hours.StartedAt ?? time.GetUtcNow()).UtcDateTime),
                r.Hours.StartedAt,
                r.Hours.EndedAt,
                r.Hours.Hours,
                r.Hours.WorkType,
                r.Hours.Billable,
                r.Hours.Onsite,
                r.Hours.Description)).ToList();

            var result = await timeTracking.ImportAsync(entries, ct);
            progress.Changed = result.Created + result.Updated;
            progress.Message = $"tickets {tickets.Count}, new {result.Created}, updated {result.Updated}, unchanged {result.Unchanged}, needs review {result.NeedsReview}, " +
                               $"tickets unreadable {unreadable}, rows without duration {dropped}";
            if (unreadable > 0 && unreadable >= tickets.Count)
            {
                throw new AteraApiException(System.Net.HttpStatusCode.BadGateway, "No ticket's work hours could be read.");
            }
        }, cancellationToken);
    }
}

/// <summary>Nightly agent snapshot: the device list per organization and the daily counts used to bill per-device contract lines (BR-SRV-03).</summary>
public sealed class AteraAgentSyncJob(
    IAteraClient client,
    AteraLinkIndex links,
    IServiceApi service,
    SyncRunner runner,
    TimeProvider time,
    IOptions<AteraOptions> options,
    ILogger<AteraAgentSyncJob> logger)
{
    public const string JobId = "atera-agents";

    private static readonly TimeZoneInfo Oslo = TimeZoneInfo.FindSystemTimeZoneById("Europe/Oslo");

    public async Task RunAsync(CancellationToken cancellationToken)
    {
        if (!options.Value.IsConfigured)
        {
            logger.LogInformation("Atera agent sync skipped: integration not configured.");
            return;
        }

        await runner.RunAsync(AteraTypes.System, JobId, async (progress, ct) =>
        {
            var customers = await links.CustomersAsync(ct);
            var byOrganization = new Dictionary<Guid, List<ExternalDevice>>();
            var skipped = 0;
            await foreach (var agent in client.GetAgentsAsync(ct))
            {
                progress.Read++;
                if (!customers.TryGetValue(agent.CustomerId, out var organizationId))
                {
                    skipped++;
                    continue;
                }

                byOrganization.TryAdd(organizationId, []);
                byOrganization[organizationId].Add(new ExternalDevice(
                    agent.AgentId, agent.MachineName, AteraServiceMapping.DeviceTypeOf(agent.OsType, agent.Os), agent.Os, agent.Online, agent.LastSeenAt,
                    AteraServiceMapping.Url(options.Value.DeviceUrlTemplate, agent.AgentId)));
            }

            // Linked organizations without agents lose their devices too.
            foreach (var organizationId in customers.Values.Distinct())
            {
                byOrganization.TryAdd(organizationId, []);
            }

            foreach (var (organizationId, devices) in byOrganization)
            {
                await service.ReplaceDevicesAsync(organizationId, AteraTypes.System, devices, ct);
                progress.Changed += devices.Count;
            }

            var today = DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(time.GetUtcNow(), Oslo).DateTime);
            var organizations = await service.TakeDeviceSnapshotAsync(today, ct);
            progress.Message = $"devices {progress.Changed} in {byOrganization.Count} organizations, snapshot for {organizations}, skipped (customer not linked) {skipped}";
        }, cancellationToken);
    }
}

/// <summary>Open Critical and Warning alerts per organization (BR-SRV-04).</summary>
public sealed class AteraAlertSyncJob(
    IAteraClient client,
    AteraLinkIndex links,
    IServiceApi service,
    SyncRunner runner,
    IOptions<AteraOptions> options,
    ILogger<AteraAlertSyncJob> logger)
{
    public const string JobId = "atera-alerts";

    public async Task RunAsync(CancellationToken cancellationToken)
    {
        if (!options.Value.IsConfigured)
        {
            logger.LogInformation("Atera alert sync skipped: integration not configured.");
            return;
        }

        await runner.RunAsync(AteraTypes.System, JobId, async (progress, ct) =>
        {
            var customers = await links.CustomersAsync(ct);
            var byOrganization = new Dictionary<Guid, List<ExternalAlert>>();
            await foreach (var alert in client.GetAlertsAsync("Open", ct))
            {
                progress.Read++;
                if (AteraServiceMapping.SeverityOf(alert.Severity) is not { } severity ||
                    alert.CustomerId is not { } customerId || !customers.TryGetValue(customerId, out var organizationId))
                {
                    continue;
                }

                byOrganization.TryAdd(organizationId, []);
                byOrganization[organizationId].Add(new ExternalAlert(alert.AlertId, severity, alert.Title, alert.DeviceName, alert.CreatedAt));
            }

            await service.ReplaceOpenAlertsAsync(AteraTypes.System, byOrganization.ToDictionary(x => x.Key, x => (IReadOnlyCollection<ExternalAlert>)x.Value), ct);
            progress.Changed = byOrganization.Sum(x => x.Value.Count);
            progress.Message = $"open alerts {progress.Changed} in {byOrganization.Count} organizations";
        }, cancellationToken);
    }
}

/// <summary>A CRM user asked for a ticket: queue it, or say straight away that writing to Atera is off.</summary>
internal sealed class AteraTicketRequestedHandler(
    ExternalLinkService links,
    OutboundQueue queue,
    IServiceApi service,
    IOptions<AteraOptions> options) : IDomainEventHandler<TicketRequested>
{
    public async Task HandleAsync(TicketRequested domainEvent, CancellationToken cancellationToken)
    {
        if (!options.Value.IsConfigured || !options.Value.WriteEnabled)
        {
            await service.FailTicketRequestAsync(domainEvent.RequestId, "Creating tickets in Atera is switched off (Integrations:Atera:WriteEnabled).", cancellationToken);
            return;
        }

        if (await links.FindByEntityAsync(EntityTypes.Organization, domainEvent.OrganizationId, AteraTypes.System, AteraTypes.Customer, cancellationToken) is null)
        {
            await service.FailTicketRequestAsync(domainEvent.RequestId, "The organization is not linked to a customer in Atera.", cancellationToken);
            return;
        }

        await queue.EnqueueAsync(AteraTypes.System, AteraTypes.CreateTicket, EntityTypes.TicketRequest, domainEvent.RequestId, null, cancellationToken);
    }
}

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

        var customerId = long.Parse(customerLink.ExternalId, CultureInfo.InvariantCulture);
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

        long endUserId;
        var contactLink = request.ContactId is { } contactId
            ? await links.FindByEntityAsync(EntityTypes.Contact, contactId, System, AteraTypes.Contact, cancellationToken)
            : null;
        if (contactLink is not null)
        {
            endUserId = long.Parse(contactLink.ExternalId, CultureInfo.InvariantCulture);
        }
        else if (request.ContactId is { } newContactId && await customers.GetContactForSyncAsync(newContactId, cancellationToken) is { } contact)
        {
            endUserId = await EnsureContactAsync(operation, request, customerId, newContactId, contact, cancellationToken);
        }
        else
        {
            await service.FailTicketRequestAsync(request.Id, "Choose a contact for the ticket.", cancellationToken);
            throw new PermanentOutboundException("The ticket has no contact.");
        }

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
    private async Task<long> EnsureContactAsync(
        OutboundOperation operation, TicketRequestView request, long customerId, Guid contactId, ContactSyncView contact, CancellationToken cancellationToken)
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

        var link = await links.LinkAsync(EntityTypes.Contact, contactId, System, AteraTypes.Contact, atera.Value.ToString(CultureInfo.InvariantCulture),
            LinkMethod.Exported, operation.RequestedBy, cancellationToken);
        if (!link.IsSuccess)
        {
            // The contact exists in Atera (its id is in the journal); without the link no later attempt may create it again.
            await service.FailTicketRequestAsync(request.Id, $"The Atera contact {atera} could not be linked: {link.Error!.Message}", cancellationToken);
            throw new PermanentOutboundException(link.Error!.Message);
        }

        return atera.Value;
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
