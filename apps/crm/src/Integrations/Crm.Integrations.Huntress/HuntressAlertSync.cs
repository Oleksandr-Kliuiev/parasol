using System.Globalization;
using Crm.Integrations.Core;
using Crm.Security.Contracts;
using Crm.Service.Contracts;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Crm.Integrations.Huntress;

/// <summary>
/// Huntress's incident reports, escalations and platform actions (M41): their detail into the security module, and the open ones
/// as alerts of kind Security, so they stand in <c>/alerts</c>, My day and the customer's Drift tab beside Atera's. Only a read of
/// every list is applied. A stored open record the lists no longer name is read by id before anything is decided: a report sent
/// back to the SOC (a draft) is still open, a closed one closes, one Huntress no longer knows is kept as history. An urgent incident
/// Huntress closes is not closed in the CRM by the read: it waits for a person to confirm it.
/// </summary>
public sealed class HuntressAlertSyncJob(
    IHuntressClient client,
    HuntressLinkIndex links,
    IServiceApi service,
    ISecurityApi security,
    SyncRunner runner,
    TimeProvider time,
    IOptions<HuntressOptions> options,
    ILogger<HuntressAlertSyncJob> logger)
{
    public const string JobId = "huntress-alerts";

    /// <summary>The statuses Huntress lists an incident report under while it waits for the partner or its automation.</summary>
    public static readonly string[] OpenIncidentStatuses = ["sent", "auto_remediating"];

    /// <summary>The statuses of an escalation or a platform action that waits for the partner.</summary>
    public static readonly string[] OpenNoticeStatuses = ["open", "overdue"];

    public async Task RunAsync(CancellationToken cancellationToken)
    {
        if (!options.Value.IsConfigured)
        {
            logger.LogInformation("Huntress alert sync skipped: integration not configured.");
            return;
        }

        await runner.RunAsync(HuntressTypes.System, JobId, async (progress, ct) =>
        {
            var o = options.Value;
            var organizations = await links.OrganizationsAsync(ct);
            var hosts = (await service.GetCurrentDevicesAsync(HuntressTypes.System, ct)).ToDictionary(d => d.ExternalId, d => d.MachineName, StringComparer.Ordinal);
            var now = time.GetUtcNow();

            // Incident reports: every open one, then each stored open one the lists no longer name, by id.
            var open = new Dictionary<long, HuntressIncident>();
            foreach (var status in OpenIncidentStatuses)
            {
                await foreach (var incident in client.GetIncidentsAsync(status, ct))
                {
                    progress.Read++;
                    open[incident.Id] = incident;
                }
            }

            var storedIncidents = await security.GetOpenIncidentsAsync(HuntressTypes.System, ct);
            var closedIncidents = new List<HuntressIncident>();
            var goneIncidents = new List<long>();
            foreach (var stored in storedIncidents.Where(s => !open.ContainsKey(s.ExternalId)))
            {
                switch (await client.GetIncidentAsync(stored.ExternalId, ct))
                {
                    case null:
                        goneIncidents.Add(stored.ExternalId);
                        break;
                    case { } live when HuntressMapping.IsOpen(live.Status):
                        open[live.Id] = live;
                        break;
                    case { } live:
                        closedIncidents.Add(live);
                        break;
                }
            }

            var readings = new List<IncidentReading>();
            var unlinked = 0;
            var storedById = storedIncidents.ToDictionary(s => s.ExternalId);
            foreach (var incident in open.Values.Concat(closedIncidents))
            {
                if (!organizations.TryGetValue(incident.OrganizationId, out var organizationId))
                {
                    // A closed report of an organization no longer linked is written closed under the customer it was stored for, its plan
                    // and comments as last read; left open, it would be read again by id on every run.
                    if (!HuntressMapping.IsOpen(incident.Status) && storedById.TryGetValue(incident.Id, out var known))
                    {
                        readings.Add(HuntressMapping.Reading(incident, known.OrganizationId, known.DeviceName, o.IncidentUrlTemplate, null, null) with { ReadAt = now });
                    }

                    unlinked++;
                    continue;
                }

                // The plan: the ten the report carries, or every step when it has more. The comments of every report read now: Huntress
                // says nothing about a new comment on the report itself.
                var remediations = incident.AllRemediations ? incident.Remediations : await client.GetRemediationsAsync(incident.Id, ct);
                var comments = await client.GetCommentsAsync(incident.Id, ct);
                readings.Add(HuntressMapping.Reading(incident, organizationId, Host(hosts, incident.AgentId), o.IncidentUrlTemplate, remediations, comments) with { ReadAt = now });
            }

            // Escalations and platform actions: every open or overdue one; the entities of one that is new or changed since they were read.
            var notices = new List<ExternalNotice>();
            var openNotices = new List<(HuntressNotice Notice, (Guid Id, long ExternalId)? Organization)>();
            var goneNotices = new Dictionary<NoticeKind, List<long>>();
            foreach (var kind in new[] { HuntressNoticeKind.Escalation, HuntressNoticeKind.PlatformAction })
            {
                var listed = new Dictionary<long, HuntressNotice>();
                foreach (var status in OpenNoticeStatuses)
                {
                    await foreach (var notice in client.GetNoticesAsync(kind, status, ct))
                    {
                        progress.Read++;
                        listed[notice.Id] = notice;
                    }
                }

                var stored = (await security.GetOpenNoticesAsync(HuntressTypes.System, HuntressMapping.Kind(kind), ct)).ToDictionary(n => n.ExternalId);
                var resolved = new List<HuntressNotice>();
                goneNotices[HuntressMapping.Kind(kind)] = [];
                foreach (var missing in stored.Values.Where(s => !listed.ContainsKey(s.ExternalId)))
                {
                    switch (await client.GetNoticeAsync(kind, missing.ExternalId, ct))
                    {
                        case null:
                            goneNotices[HuntressMapping.Kind(kind)].Add(missing.ExternalId);
                            break;
                        case { } live when OpenNoticeStatuses.Contains(live.Status):
                            listed[live.Id] = live;
                            break;
                        case { } live:
                            resolved.Add(live);
                            break;
                    }
                }

                // The entities of a notice that is new or changed since they were read come with a read by id; an unchanged one keeps
                // the stored ones, which still name what it is about (the mirror then keeps them as read before).
                var kept = new HashSet<long>();
                foreach (var notice in listed.Values.Where(n => n.Entities is null).ToList())
                {
                    if (stored.TryGetValue(notice.Id, out var known) && known.EntitiesReadAt is { } read && !(notice.UpdatedAt > read))
                    {
                        listed[notice.Id] = notice with { Entities = known.Entities.Select(e => new HuntressEntity(e.Type, e.Id, e.Name)).ToList() };
                        kept.Add(notice.Id);
                    }
                    else
                    {
                        listed[notice.Id] = await client.GetNoticeAsync(kind, notice.Id, ct) ?? notice;
                    }
                }

                foreach (var notice in listed.Values.Concat(resolved))
                {
                    // The first organization it names that is linked: a notice about the whole account belongs to no customer.
                    var organization = notice.OrganizationIds.Where(organizations.ContainsKey).Select(id => ((Guid Id, long ExternalId)?)(organizations[id], id))
                        .FirstOrDefault();
                    notices.Add(HuntressMapping.Notice(kept.Contains(notice.Id) ? notice with { Entities = null } : notice, organization?.Id, NoticeUrl(o, kind, notice.Id))
                        with { ReadAt = now });
                    if (OpenNoticeStatuses.Contains(notice.Status))
                    {
                        openNotices.Add((notice, organization));
                    }
                }
            }

            // Every list and every lookup was read (a failure throws before this): store the detail, then the alerts.
            var incidents = await security.ApplyIncidentsAsync(readings, ct);
            var deleted = await security.CloseMissingIncidentsAsync(HuntressTypes.System, goneIncidents, ct);
            var noticesStored = await security.ApplyNoticesAsync(notices, ct);
            foreach (var (kind, ids) in goneNotices)
            {
                deleted += await security.CloseMissingNoticesAsync(HuntressTypes.System, kind, ids, ct);
            }

            var alerts = new List<ExternalAlert>();
            var openIds = new HashSet<string>(StringComparer.Ordinal);
            foreach (var incident in open.Values)
            {
                openIds.Add(HuntressMapping.IncidentAlertId(incident.Id));
                if (organizations.TryGetValue(incident.OrganizationId, out var organizationId))
                {
                    alerts.Add(HuntressMapping.Alert(incident, organizationId, Host(hosts, incident.AgentId), o.IncidentUrlTemplate, now));
                }
            }

            foreach (var (notice, organization) in openNotices)
            {
                openIds.Add(HuntressMapping.NoticeAlertId(HuntressMapping.Kind(notice.Kind), notice.Id));
                if (organization is { } linked)
                {
                    alerts.Add(HuntressMapping.Alert(notice, linked.Id, linked.ExternalId, NoticeUrl(o, notice.Kind, notice.Id)));
                }
            }

            // The read began at `now`: an alert a person's action resolved since then stays resolved (M41).
            var result = await service.ApplyAlertSnapshotAsync(
                new AlertSnapshot(HuntressTypes.System, AlertKind.Security, alerts, openIds, IsComplete: true, ReadStartedAt: now), ct);
            progress.Changed = incidents.Changed + noticesStored.Changed + result.Changed;
            progress.Message = string.Create(CultureInfo.InvariantCulture,
                $"incidents open {open.Count}, closed {closedIncidents.Count}, gone {goneIncidents.Count}; notices open {openNotices.Count}; " +
                $"alerts {alerts.Count}: new {result.Opened}, reopened {result.Reopened}, changed {result.Updated}, resolved {result.Resolved}, " +
                $"waiting for confirmation {result.AwaitingConfirmation}; kept as history {deleted}; skipped (organization not linked) {unlinked}");
        }, cancellationToken);
    }

    private static string? Host(Dictionary<string, string> hosts, long? agentId) =>
        agentId is { } id && hosts.TryGetValue(id.ToString(CultureInfo.InvariantCulture), out var name) ? name : null;

    private static string? NoticeUrl(HuntressOptions o, HuntressNoticeKind kind, long id) =>
        HuntressMapping.Url(kind == HuntressNoticeKind.Escalation ? o.EscalationUrlTemplate : o.PlatformActionUrlTemplate, id);
}
