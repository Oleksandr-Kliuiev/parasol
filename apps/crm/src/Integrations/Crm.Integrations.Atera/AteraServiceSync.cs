using System.Globalization;
using Crm.Customers.Contracts;
using Crm.Identity.Contracts;
using Crm.Integrations.Core;
using Crm.Integrations.Core.Actions;
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

    public async Task<IReadOnlyDictionary<long, TicketOwnerBinding>> TicketOwnersAsync(CancellationToken ct) =>
        AteraTicketOwners.Resolve(await db.ExternalLinks.AsNoTracking()
            .Where(row => row.System == AteraTypes.System && row.ExternalType == AteraTypes.Customer).ToListAsync(ct));

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
    AteraTicketMirror mirror,
    IServiceApi service,
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
            // Links and suppressions as they stand when the read begins: a rebind during the read waits for the next one.
            var mapping = await mirror.SnapshotAsync(ct);
            var since = time.GetUtcNow().AddDays(-options.Value.RecentTicketDays);
            var statuses = recent ? [null] : options.Value.OpenTicketStatuses.Cast<string?>().ToList();
            var collected = new List<AteraTicket>();

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

            var batch = await mapping.MapAsync(collected, ct);
            progress.Changed = await service.UpsertTicketsAsync(batch.Tickets, ct);
            progress.Message = $"changed {progress.Changed}, skipped (customer not linked) {batch.Unlinked}{(stoppedEarly ? ", stopped after pages outside the window" : string.Empty)}";
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
    ILogger<AteraWorkHoursSyncJob> logger,
    IntegrationDbContext db)
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
            // M39.3: hours the CRM recorded in Atera come back carrying their entry's marker (or the id Atera answered with); the
            // CRM entry is the one that counts, so such a row is never imported as a second entry.
            var recordedIds = (await db.VendorActions.AsNoTracking()
                    .Where(a => a.System == AteraTypes.System && a.Kind == AteraTimeRecordAction.KindName && a.Reference != null &&
                                (a.Status == VendorActionStatus.Succeeded || a.Status == VendorActionStatus.Skipped))
                    .Select(a => a.Reference!).ToListAsync(ct))
                .ToHashSet(StringComparer.Ordinal);
            var fromCrm = 0;
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
                    if (AteraTimeMarker.Read(hours.Description) is not null || recordedIds.Contains(hours.Id))
                    {
                        fromCrm++;
                        continue;
                    }

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
                               $"recorded from the CRM {fromCrm}, tickets unreadable {unreadable}, rows without duration {dropped}";
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
                    AteraServiceMapping.Url(options.Value.DeviceUrlTemplate, agent.AgentId), agent.SerialNumber, agent.MacAddresses));
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

/// <summary>
/// Open Critical and Warning alerts per organization (BR-SRV-04), kept with a lifecycle (M38): an alert keeps its CRM id from one
/// read to the next and is resolved when a complete read no longer lists it. Only a read of every page is a snapshot; a page
/// that cannot be read fails the run before anything is stored.
/// </summary>
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
            var alerts = new List<ExternalAlert>();
            // Every alert Atera reports open, linked or not: one whose customer lost its link is still open, not resolved.
            var open = new HashSet<string>(StringComparer.Ordinal);
            var unlinked = 0;
            await foreach (var alert in client.GetAlertsAsync("Open", ct))
            {
                progress.Read++;
                open.Add(alert.AlertId);
                if (AteraServiceMapping.SeverityOf(alert.Severity) is not { } severity)
                {
                    continue;
                }

                if (alert.CustomerId is not { } customerId || !customers.TryGetValue(customerId, out var organizationId))
                {
                    unlinked++;
                    continue;
                }

                alerts.Add(new ExternalAlert(
                    alert.AlertId, organizationId, severity, alert.Title, alert.DeviceName, alert.CreatedAt,
                    customerId.ToString(CultureInfo.InvariantCulture), AteraServiceMapping.Url(options.Value.AlertUrlTemplate, alert.AlertId)));
            }

            // The enumeration throws on any page it cannot read, so arriving here means every page was read.
            var result = await service.ApplyAlertSnapshotAsync(new AlertSnapshot(AteraTypes.System, AlertKind.Monitoring, alerts, open, IsComplete: true), ct);
            progress.Changed = result.Changed;
            progress.Message = $"open alerts {alerts.Count}: new {result.Opened}, reopened {result.Reopened}, changed {result.Updated}, " +
                               $"resolved {result.Resolved}; skipped (customer not linked) {unlinked}";
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
