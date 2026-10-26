using System.Globalization;
using Crm.Security.Contracts;
using Crm.Service.Contracts;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Crm.Integrations.Huntress;

/// <summary>What a person's action says about the closing of its incident (M41).</summary>
public enum IncidentClosing
{
    /// <summary>
    /// The action does not close the incident (approve, send back, comment): when Huntress shows it closed anyway, the scheduled read
    /// decides, and an urgent one waits for a person to confirm it.
    /// </summary>
    NotAsked,

    /// <summary>The action may have closed it (the last manual step marked done, a close found already made): closed means a person did it.</summary>
    MayClose,

    /// <summary>Huntress accepted the person's request to close it: its alert closes even when the read after it fails.</summary>
    Closed,
}

/// <summary>
/// The read after an action (M41): the record the action changed is read again from Huntress on the actions' budget and written into
/// the mirrors at once, so people see the result without waiting for the next scheduled read. An incident's alert is resolved here only
/// when a person closed the incident (<see cref="IncidentClosing"/>) and Huntress shows it closed, or accepted the close; a read that
/// fails otherwise changes nothing, and the scheduled read confirms it then.
/// </summary>
public sealed class HuntressReadBack(
    IHuntressActionClient client,
    HuntressLinkIndex links,
    ISecurityApi security,
    IServiceApi service,
    TimeProvider time,
    IOptions<HuntressOptions> options,
    ILogger<HuntressReadBack> logger)
{
    /// <summary>
    /// The incident again, with its plan (and its comments after a comment). When a person closed it from Parasoll and Huntress shows it closed (or accepted
    /// the close), its alert is resolved: nothing waits for another confirmation. Any other action leaves the alert to the scheduled
    /// read, so an urgent incident Huntress closed by itself still waits for a person.
    /// </summary>
    public async Task IncidentAsync(long id, IncidentClosing closing, CancellationToken ct, bool withComments = false)
    {
        var alertId = HuntressMapping.IncidentAlertId(id);
        try
        {
            var incident = await client.GetIncidentAsync(id, ct);
            if (incident is null)
            {
                await security.CloseMissingIncidentsAsync(HuntressTypes.System, [id], ct);
                if (closing != IncidentClosing.NotAsked)
                {
                    await service.ResolveAlertAsync(HuntressTypes.System, alertId, ct);
                }

                return;
            }

            var organizations = await links.OrganizationsAsync(ct);
            if (!organizations.TryGetValue(incident.OrganizationId, out var organizationId))
            {
                return;
            }

            var remediations = incident.AllRemediations ? incident.Remediations : await client.GetRemediationsAsync(id, ct);
            // The comments only after a comment: no other action changes them, and each read spends the actions' small budget.
            var comments = withComments ? await client.GetCommentsAsync(id, ct) : null;
            var host = (await security.GetIncidentAsync(HuntressTypes.System, id, ct))?.DeviceName;
            await security.ApplyIncidentsAsync([HuntressMapping.Reading(incident, organizationId, host, options.Value.IncidentUrlTemplate, remediations, comments)], ct);
            if (!HuntressMapping.IsOpen(incident.Status) && closing != IncidentClosing.NotAsked)
            {
                await service.ResolveAlertAsync(HuntressTypes.System, alertId, ct);
            }
        }
        catch (Exception ex) when (HuntressFailures.IsReadFailure(ex, ct))
        {
            logger.LogWarning("Huntress incident {IncidentId} could not be read after the action ({ErrorType}); the scheduled read confirms it", id, ex.GetType().Name);
            if (closing == IncidentClosing.Closed)
            {
                // Huntress accepted the person's close: the alert does not wait for the next read to find it closed and ask again.
                await service.ResolveAlertAsync(HuntressTypes.System, alertId, ct);
            }
        }
    }

    /// <summary>The escalation again; when Huntress has resolved it, its alert is resolved too.</summary>
    public async Task NoticeAsync(HuntressNoticeKind kind, long id, CancellationToken ct)
    {
        var alertId = HuntressMapping.NoticeAlertId(HuntressMapping.Kind(kind), id);
        try
        {
            var notice = await client.GetNoticeAsync(kind, id, ct);
            if (notice is null)
            {
                await security.CloseMissingNoticesAsync(HuntressTypes.System, HuntressMapping.Kind(kind), [id], ct);
                await service.ResolveAlertAsync(HuntressTypes.System, alertId, ct);
                return;
            }

            var organizations = await links.OrganizationsAsync(ct);
            var organizationId = notice.OrganizationIds.Where(organizations.ContainsKey).Select(o => (Guid?)organizations[o]).FirstOrDefault();
            var template = kind == HuntressNoticeKind.Escalation ? options.Value.EscalationUrlTemplate : options.Value.PlatformActionUrlTemplate;
            await security.ApplyNoticesAsync([HuntressMapping.Notice(notice, organizationId, HuntressMapping.Url(template, id))], ct);
            if (!HuntressAlertSyncJob.OpenNoticeStatuses.Contains(notice.Status))
            {
                await service.ResolveAlertAsync(HuntressTypes.System, alertId, ct);
            }
        }
        catch (Exception ex) when (HuntressFailures.IsReadFailure(ex, ct))
        {
            logger.LogWarning("Huntress {Kind} {NoticeId} could not be read after the action ({ErrorType}); the scheduled read confirms it", kind, id, ex.GetType().Name);
        }
    }

    /// <summary>
    /// The agent again into the device mirror (its isolation now); an agent Huntress no longer knows (uninstalled) is marked removed and
    /// its machine matched again, as a complete read would.
    /// </summary>
    public async Task AgentAsync(long id, Guid organizationId, CancellationToken ct)
    {
        var externalId = id.ToString(CultureInfo.InvariantCulture);
        try
        {
            if (await client.GetAgentAsync(id, ct) is { } agent)
            {
                await service.ApplyDeviceAsync(organizationId, HuntressTypes.System, HuntressMapping.Device(agent, options.Value.AgentUrlTemplate, time.GetUtcNow()), ct);
            }
            else
            {
                await service.RemoveDeviceAsync(HuntressTypes.System, externalId, ct);
            }
        }
        catch (Exception ex) when (HuntressFailures.IsReadFailure(ex, ct))
        {
            logger.LogWarning("Huntress agent {AgentId} could not be read after the action ({ErrorType}); the scheduled read confirms it", id, ex.GetType().Name);
        }
    }
}

/// <summary>What counts as a read that failed, as opposed to an answer: nothing is known, so nothing is decided.</summary>
internal static class HuntressFailures
{
    public static bool IsReadFailure(Exception ex, CancellationToken ct) =>
        ex is HttpRequestException or HuntressApiException or TimeoutException or Polly.Timeout.TimeoutRejectedException or System.Text.Json.JsonException ||
        (ex is TaskCanceledException && !ct.IsCancellationRequested);

    /// <summary>
    /// Huntress answered and refused: nothing changed. Its reference documents 409 and 422 as refusals of the record's state ("must
    /// have a status of sent", "already resolved", "does not support isolation"). Timeouts and 5xx prove nothing about a write; a 429
    /// that outlasted the retries is <see cref="IsBusy"/>.
    /// </summary>
    public static bool IsRejection(System.Net.HttpStatusCode status) =>
        status is System.Net.HttpStatusCode.BadRequest or System.Net.HttpStatusCode.Unauthorized or System.Net.HttpStatusCode.Forbidden
            or System.Net.HttpStatusCode.NotFound or System.Net.HttpStatusCode.Conflict or System.Net.HttpStatusCode.UnprocessableEntity;

    /// <summary>The account's request limit answered every try: Huntress processed nothing, so the attempt can come again later.</summary>
    public static bool IsBusy(System.Net.HttpStatusCode status) => status == System.Net.HttpStatusCode.TooManyRequests;
}
