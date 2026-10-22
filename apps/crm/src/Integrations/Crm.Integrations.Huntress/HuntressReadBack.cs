using System.Globalization;
using Crm.Security.Contracts;
using Crm.Service.Contracts;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Crm.Integrations.Huntress;

/// <summary>
/// The read after an action (M41): the record the action changed is read again from Huntress on the actions' budget and written into
/// the mirrors at once, so people see the result without waiting for the next scheduled read. The CRM never takes the action's word
/// for it: an alert is resolved only when Huntress shows the record closed. A read that fails changes nothing; the scheduled read
/// confirms it then.
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
    /// The incident again, with its plan and comments. When Huntress has closed it, its alert is resolved: a person asked for that
    /// from Parasoll, so nothing waits for another confirmation.
    /// </summary>
    public async Task IncidentAsync(long id, CancellationToken ct)
    {
        try
        {
            var incident = await client.GetIncidentAsync(id, ct);
            if (incident is null)
            {
                await security.CloseMissingIncidentsAsync(HuntressTypes.System, [id], ct);
                await service.ResolveAlertAsync(HuntressTypes.System, HuntressMapping.IncidentAlertId(id), ct);
                return;
            }

            var organizations = await links.OrganizationsAsync(ct);
            if (!organizations.TryGetValue(incident.OrganizationId, out var organizationId))
            {
                return;
            }

            var remediations = incident.AllRemediations ? incident.Remediations : await client.GetRemediationsAsync(id, ct);
            var comments = await client.GetCommentsAsync(id, ct);
            var host = (await security.GetIncidentAsync(HuntressTypes.System, id, ct))?.DeviceName;
            await security.ApplyIncidentsAsync([HuntressMapping.Reading(incident, organizationId, host, options.Value.IncidentUrlTemplate, remediations, comments)], ct);
            if (!HuntressMapping.IsOpen(incident.Status))
            {
                await service.ResolveAlertAsync(HuntressTypes.System, HuntressMapping.IncidentAlertId(id), ct);
            }
        }
        catch (Exception ex) when (HuntressFailures.IsReadFailure(ex, ct))
        {
            logger.LogWarning("Huntress incident {IncidentId} could not be read after the action ({ErrorType}); the scheduled read confirms it", id, ex.GetType().Name);
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
    /// have a status of sent", "already resolved", "does not support isolation"). Timeouts and 5xx prove nothing about a write.
    /// </summary>
    public static bool IsRejection(System.Net.HttpStatusCode status) =>
        status is System.Net.HttpStatusCode.BadRequest or System.Net.HttpStatusCode.Unauthorized or System.Net.HttpStatusCode.Forbidden
            or System.Net.HttpStatusCode.NotFound or System.Net.HttpStatusCode.Conflict or System.Net.HttpStatusCode.UnprocessableEntity;
}
