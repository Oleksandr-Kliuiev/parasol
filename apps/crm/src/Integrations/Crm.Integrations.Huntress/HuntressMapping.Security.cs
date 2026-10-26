using System.Globalization;
using Crm.Security.Contracts;
using Crm.Service.Contracts;

namespace Crm.Integrations.Huntress;

/// <summary>Huntress's incidents and notices in the security mirror and as the CRM's alerts (M41).</summary>
internal static partial class HuntressMapping
{
    /// <summary>
    /// An incident still waits for someone: the partner (<c>sent</c>), Huntress's automation (<c>auto_remediating</c>) or the SOC after a
    /// rejected plan (<c>draft</c>).
    /// </summary>
    public static bool IsOpen(string status) => status is "sent" or "auto_remediating" or "draft";

    public static IncidentReading Reading(
        HuntressIncident incident, Guid organizationId, string? host, string? urlTemplate,
        IReadOnlyList<HuntressRemediation>? remediations, IReadOnlyList<HuntressComment>? comments) => new(
        new ExternalIncident(
            HuntressTypes.System, incident.Id, organizationId, incident.OrganizationId, incident.AgentId?.ToString(CultureInfo.InvariantCulture), host,
            incident.Status, incident.Severity, incident.Subject, incident.Summary, incident.Body, incident.Platform, incident.IndicatorTypes,
            incident.IndicatorCounts, incident.SentAt, incident.ClosedAt, incident.StatusUpdatedAt, incident.UpdatedAt, Url(urlTemplate, incident.Id)),
        remediations?.Select(r => new ExternalRemediation(r.Id, r.Type, r.Action, r.Parameters, r.Status, r.ApprovedAt, r.ApprovedBy, r.CompletedAt)).ToList(),
        comments?.Select(c => new ExternalIncidentComment(c.Id, c.Body, c.Author, c.CreatedAt, c.UpdatedAt)).ToList());

    public static ExternalNotice Notice(HuntressNotice notice, Guid? organizationId, string? url) => new(
        HuntressTypes.System, Kind(notice.Kind), notice.Id, organizationId, notice.OrganizationIds, notice.Status, notice.Severity, notice.Subject,
        notice.Type, notice.TypeCode, notice.Subtype, notice.Entities?.Select(e => new NoticeEntity(e.Type, e.Id, e.Name)).ToList(), notice.AllEntities,
        notice.CreatedAt, notice.ResolvedAt, notice.UpdatedAt, url);

    /// <summary>
    /// An open incident as an alert: its subject as the title, the agent it is about by Huntress's id, the time the SOC sent it. An
    /// urgent one (critical or high) that Huntress closes waits in the CRM for a person to confirm it.
    /// </summary>
    public static ExternalAlert Alert(HuntressIncident incident, Guid organizationId, string? host, string? urlTemplate, DateTimeOffset now) => new(
        IncidentAlertId(incident.Id), organizationId, Severity(incident.Severity), incident.Subject, host,
        incident.SentAt ?? incident.StatusUpdatedAt ?? incident.UpdatedAt ?? now,
        incident.OrganizationId.ToString(CultureInfo.InvariantCulture), Url(urlTemplate, incident.Id),
        DeviceExternalId: incident.AgentId?.ToString(CultureInfo.InvariantCulture), ConfirmClose: true);

    /// <summary>
    /// An open escalation or platform action as an alert of the first linked organization it names. The host it is about, when it
    /// names exactly one agent, lets the alert find the customer's device by name.
    /// </summary>
    public static ExternalAlert Alert(HuntressNotice notice, Guid organizationId, long externalOrganizationId, string? url)
    {
        var agents = notice.Entities?.Where(e => string.Equals(e.Type, "Agent", StringComparison.OrdinalIgnoreCase) && e.Name is not null).ToList() ?? [];
        return new ExternalAlert(
            NoticeAlertId(Kind(notice.Kind), notice.Id), organizationId, Severity(notice.Severity), notice.Subject, agents.Count == 1 ? agents[0].Name : null,
            notice.CreatedAt, externalOrganizationId.ToString(CultureInfo.InvariantCulture), url,
            DeviceExternalId: agents.Count == 1 ? agents[0].Id : null);
    }
}
