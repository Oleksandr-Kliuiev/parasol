using System.Globalization;
using Crm.Customers.Contracts;
using Crm.Identity.Contracts;
using Crm.Integrations.Core;
using Crm.Integrations.Core.Persistence;
using Crm.Service.Contracts;
using Crm.SharedKernel.Domain;
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
    ILogger<AteraTicketSyncJob> logger)
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
            var since = time.GetUtcNow().AddDays(-options.Value.RecentTicketDays);
            var statuses = recent ? [null] : options.Value.OpenTicketStatuses.Cast<string?>().ToList();
            var collected = new List<AteraTicket>();
            var skipped = 0;

            foreach (var status in statuses)
            {
                var olderPages = 0;
                await foreach (var ticket in client.GetTicketsAsync(status, ct))
                {
                    progress.Read++;
                    if (recent && ticket.CreatedAt < since && ticket.LastActivityAt < since)
                    {
                        // Atera returns the newest tickets first; stop once a whole page is older than the window.
                        if (++olderPages > options.Value.ItemsInPage)
                        {
                            break;
                        }

                        continue;
                    }

                    olderPages = 0;
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
                tickets.Add(new ExternalTicket(
                    AteraTypes.System, ticket.TicketId, organizationId,
                    ticket.EndUserId is { } endUserId && contacts.TryGetValue(endUserId, out var contactId) ? contactId : null,
                    ticket.Title, ticket.Status, ticket.Priority, ticket.Impact, ticket.Type, ticket.Source,
                    technicianKey is not null && technicianMap.TryGetValue(technicianKey, out var userId) ? userId : null,
                    ticket.TechnicianName, ticket.EndUserName, ticket.EndUserEmail, ticket.CreatedAt, ticket.FirstResponseAt, ticket.ResolvedAt,
                    ticket.LastActivityAt, AteraServiceMapping.Url(options.Value.TicketUrlTemplate, ticket.TicketId)));
            }

            progress.Changed = await service.UpsertTicketsAsync(tickets, ct);
            progress.Message = $"changed {progress.Changed}, skipped (customer not linked) {skipped}";
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
            foreach (var ticket in tickets)
            {
                foreach (var hours in await client.GetWorkHoursAsync(ticket.ExternalId, ct))
                {
                    progress.Read++;
                    records.Add((hours, ticket));
                }
            }

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
            progress.Message = $"tickets {tickets.Count}, new {result.Created}, updated {result.Updated}, unchanged {result.Unchanged}, needs review {result.NeedsReview}";
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

/// <summary>Creates the ticket in Atera, creating the contact there first when needed (BR-SRV-02).</summary>
internal sealed class AteraCreateTicketHandler(
    IAteraClient client,
    IServiceApi service,
    ICustomersApi customers,
    ExternalLinkService links,
    IOptions<AteraOptions> options) : IOutboundHandler
{
    public string System => AteraTypes.System;

    public string Operation => AteraTypes.CreateTicket;

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
            endUserId = await client.CreateContactAsync(new AteraContactWrite(
                customerId, string.IsNullOrWhiteSpace(contact.FirstName) ? "-" : contact.FirstName, string.IsNullOrWhiteSpace(contact.LastName) ? "-" : contact.LastName,
                contact.Email, contact.Phone ?? contact.MobilePhone), cancellationToken);
            await links.LinkAsync(EntityTypes.Contact, newContactId, System, AteraTypes.Contact, endUserId.ToString(CultureInfo.InvariantCulture),
                LinkMethod.Exported, operation.RequestedBy, cancellationToken);
        }
        else
        {
            await service.FailTicketRequestAsync(request.Id, "Choose a contact for the ticket.", cancellationToken);
            throw new PermanentOutboundException("The ticket has no contact.");
        }

        var ticketId = await client.CreateTicketAsync(new AteraTicketWrite(
            request.Title, request.Description, request.Priority, "Minor", "Open", request.Type, endUserId), cancellationToken);
        await service.CompleteTicketRequestAsync(request.Id, ticketId, AteraServiceMapping.Url(options.Value.TicketUrlTemplate, ticketId), cancellationToken);
        return new OutboundResult($"Created Atera ticket {ticketId}.");
    }
}
