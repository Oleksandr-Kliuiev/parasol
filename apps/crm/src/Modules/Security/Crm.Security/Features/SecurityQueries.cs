using System.Text.Json;
using Crm.Customers.Contracts;
using Crm.Security.Contracts;
using Crm.Security.Domain;
using Crm.Security.Persistence;
using Crm.SharedKernel.Operations;
using Crm.SharedKernel.Results;
using Microsoft.EntityFrameworkCore;

namespace Crm.Security.Features;

/// <summary>One kind of indicator an incident found, and how many of it.</summary>
public sealed record IndicatorItem(string Type, int Count);

/// <summary>One line of a remediation step's detail as the source wrote it: what (a path, a key, an account) and its value.</summary>
public sealed record RemediationDetailItem(string? Name, string Value);

/// <summary>One step of an incident's plan in the incident's panel.</summary>
public sealed record RemediationItem(
    long ExternalId,
    string Type,
    string? Action,
    IReadOnlyList<RemediationDetailItem> Details,
    string Status,
    DateTimeOffset? ApprovedAt,
    string? ApprovedBy,
    DateTimeOffset? CompletedAt);

/// <summary>One comment of an incident in its panel.</summary>
public sealed record IncidentCommentItem(long ExternalId, string Body, string? Author, DateTimeOffset CreatedAt, DateTimeOffset? UpdatedAt);

/// <summary>
/// An incident with what the panel of its alert shows (M41): the SOC's summary, the indicators, the plan and the comments, with the
/// times each was last read. <paramref name="IsOpen"/> is the source's view; the alert keeps the CRM's.
/// </summary>
public sealed record IncidentDetail(
    Guid Id,
    string System,
    long ExternalId,
    Guid OrganizationId,
    string? OrganizationName,
    long ExternalOrganizationId,
    string? AgentExternalId,
    string? DeviceName,
    string Status,
    bool IsOpen,
    string Severity,
    string Subject,
    string? Summary,
    string? Body,
    string? Platform,
    IReadOnlyList<IndicatorItem> Indicators,
    DateTimeOffset? SentAt,
    DateTimeOffset? ClosedAt,
    DateTimeOffset? UpdatedAt,
    string? Url,
    DateTimeOffset ReadAt,
    DateTimeOffset? RemediationsReadAt,
    DateTimeOffset? CommentsReadAt,
    IReadOnlyList<RemediationItem> Remediations,
    IReadOnlyList<IncidentCommentItem> Comments);

/// <summary>An escalation or a platform action with what its alert's panel shows (M41).</summary>
public sealed record NoticeDetail(
    Guid Id,
    string System,
    NoticeKind Kind,
    long ExternalId,
    Guid? OrganizationId,
    string? OrganizationName,
    string Status,
    bool IsOpen,
    string Severity,
    string Subject,
    string? Type,
    string? TypeCode,
    string? Subtype,
    IReadOnlyList<NoticeEntity> Entities,
    bool AllEntities,
    DateTimeOffset CreatedAt,
    DateTimeOffset? ResolvedAt,
    DateTimeOffset? UpdatedAt,
    string? Url,
    DateTimeOffset ReadAt,
    DateTimeOffset? EntitiesReadAt);

/// <summary>What the source counts for one of its organizations linked to the customer.</summary>
public sealed record UsageItem(
    string System,
    long ExternalOrganizationId,
    string Name,
    int? AgentsCount,
    int? BillableAgents,
    int? UnresponsiveAgents,
    int? OutdatedAgents,
    int? IsolatedAgents,
    int? BillableIdentities,
    int? SatLearners,
    int? BillableLogSources,
    DateTimeOffset ReadAt);

/// <summary>One summary report of the customer, newest period first.</summary>
public sealed record ReportItem(
    string System,
    long ExternalId,
    string Type,
    DateOnly? PeriodStart,
    DateOnly? PeriodEnd,
    int? AgentsCount,
    int? IncidentsReported,
    int? IncidentsResolved,
    long? SignalsDetected,
    long? SignalsInvestigated,
    string? Url);

/// <summary>The latest finished read of one job of a security source: when it started, whether it read everything, whether it is late.</summary>
public sealed record SecurityRead(string System, string Job, DateTimeOffset? StartedAt, bool Complete, bool Late);

/// <summary>
/// A customer's security at a glance (M41): what the source counts and its reports, with the reads they come from. Incidents,
/// escalations and platform actions are alerts and live in the customer's alert list.
/// </summary>
public sealed record SecurityOverview(IReadOnlyList<UsageItem> Usage, IReadOnlyList<ReportItem> Reports, int ReportsTotal, IReadOnlyList<SecurityRead> Reads);

/// <summary>What the interface reads from the security mirror (M41).</summary>
internal sealed class SecurityQueries(SecurityDbContext db, ICustomersApi customers, IEnumerable<ISyncCompletenessSource> completeness)
{
    /// <summary>The reports a customer's overview lists: a year and a month.</summary>
    public const int ReportLimit = 13;

    /// <summary>The runs the overview's figures come from, named as the integration records them (system, job).</summary>
    private static readonly (string System, string Job)[] OverviewSources = [("huntress", "huntress-organizations"), ("huntress", "huntress-reports")];

    public async Task<Result<IncidentDetail>> IncidentAsync(string system, long externalId, CancellationToken ct)
    {
        var incident = await db.Incidents.AsNoTracking().Include(i => i.Remediations).Include(i => i.Comments).AsSplitQuery()
            .SingleOrDefaultAsync(i => i.System == system && i.ExternalId == externalId, ct);
        if (incident is null)
        {
            return Error.NotFound("SEC_INCIDENT_NOT_FOUND", "The incident is not stored in the CRM.");
        }

        var name = (await customers.GetOrganizationNamesAsync([incident.OrganizationId], ct)).GetValueOrDefault(incident.OrganizationId);
        return new IncidentDetail(
            incident.Id, incident.System, incident.ExternalId, incident.OrganizationId, name, incident.ExternalOrganizationId, incident.AgentExternalId,
            incident.DeviceName, incident.Status, incident.IsOpen, incident.Severity, incident.Subject, incident.Summary, incident.Body, incident.Platform,
            Indicators(incident), incident.SentAt, incident.ClosedAt, incident.UpdatedAtSource, incident.Url, incident.ReadAt, incident.RemediationsReadAt,
            incident.CommentsReadAt,
            incident.Remediations.OrderBy(r => r.ExternalId).Select(r => new RemediationItem(
                r.ExternalId, r.Type, r.Action, Details(r.Parameters), r.Status, r.ApprovedAt, r.ApprovedBy, r.CompletedAt)).ToList(),
            incident.Comments.OrderBy(c => c.CreatedAtSource).ThenBy(c => c.ExternalId)
                .Select(c => new IncidentCommentItem(c.ExternalId, c.Body, c.Author, c.CreatedAtSource, c.UpdatedAtSource)).ToList());
    }

    public async Task<Result<NoticeDetail>> NoticeAsync(string system, NoticeKind kind, long externalId, CancellationToken ct)
    {
        var notice = await db.Notices.AsNoTracking().SingleOrDefaultAsync(n => n.System == system && n.Kind == kind && n.ExternalId == externalId, ct);
        if (notice is null)
        {
            return Error.NotFound("SEC_NOTICE_NOT_FOUND", "The notice is not stored in the CRM.");
        }

        var name = notice.OrganizationId is { } organization
            ? (await customers.GetOrganizationNamesAsync([organization], ct)).GetValueOrDefault(organization)
            : null;
        return new NoticeDetail(
            notice.Id, notice.System, notice.Kind, notice.ExternalId, notice.OrganizationId, name, notice.Status, notice.IsOpen, notice.Severity, notice.Subject,
            notice.Type, notice.TypeCode, notice.Subtype, notice.ReadEntities(), notice.AllEntities, notice.CreatedAtSource, notice.ResolvedAtSource,
            notice.UpdatedAtSource, notice.Url, notice.ReadAt, notice.EntitiesReadAt);
    }

    public async Task<SecurityOverview> OverviewAsync(Guid organizationId, CancellationToken ct)
    {
        var usage = await db.ProductUsages.AsNoTracking().Where(u => u.OrganizationId == organizationId)
            .OrderBy(u => u.Name).ThenBy(u => u.ExternalOrganizationId)
            .Select(u => new UsageItem(u.System, u.ExternalOrganizationId, u.Name, u.AgentsCount, u.BillableAgents, u.UnresponsiveAgents, u.OutdatedAgents,
                u.IsolatedAgents, u.BillableIdentities, u.SatLearners, u.BillableLogSources, u.ReadAt))
            .ToListAsync(ct);
        var reports = db.SummaryReports.AsNoTracking().Where(r => r.OrganizationId == organizationId);
        var total = await reports.CountAsync(ct);
        var latest = await reports.OrderByDescending(r => r.PeriodStart).ThenByDescending(r => r.ExternalId).Take(ReportLimit)
            .Select(r => new ReportItem(r.System, r.ExternalId, r.Type, r.PeriodStart, r.PeriodEnd, r.AgentsCount, r.IncidentsReported, r.IncidentsResolved,
                r.SignalsDetected, r.SignalsInvestigated, r.Url))
            .ToListAsync(ct);
        // A source switched off and never read has said nothing, so its reads are left out and the panel has nothing to show.
        var reads = new List<SecurityRead>(OverviewSources.Length);
        foreach (var (system, job) in OverviewSources)
        {
            var read = await LatestReadAsync(system, job, ct);
            if (read.StartedAt is not null || completeness.Any(c => c.IsConnected(system)))
            {
                reads.Add(read);
            }
        }

        return new SecurityOverview(usage, latest, total, reads);
    }

    private async Task<SecurityRead> LatestReadAsync(string system, string job, CancellationToken ct)
    {
        foreach (var source in completeness)
        {
            if (await source.LatestAsync(system, job, ct) is { } latest)
            {
                return new SecurityRead(system, job, latest.StartedAt, latest.Complete, latest.Late);
            }
        }

        return new SecurityRead(system, job, null, false, false);
    }

    private static List<IndicatorItem> Indicators(Incident incident)
    {
        var counts = new Dictionary<string, int>(StringComparer.Ordinal);
        if (!string.IsNullOrEmpty(incident.IndicatorCounts))
        {
            try
            {
                counts = JsonSerializer.Deserialize<Dictionary<string, int>>(incident.IndicatorCounts) ?? counts;
            }
            catch (JsonException)
            {
                // Counts that cannot be read are left out; the kinds below still show.
            }
        }

        var types = incident.IndicatorTypes?.Split(',') ?? [];
        // The kinds found, with their counts; a kind counted but not named is shown when its count is above zero.
        return types.Select(t => new IndicatorItem(t, counts.GetValueOrDefault(t)))
            .Concat(counts.Where(c => c.Value > 0 && !types.Contains(c.Key)).Select(c => new IndicatorItem(c.Key, c.Value)))
            .ToList();
    }

    /// <summary>
    /// A step's detail as lines: Huntress writes a list of <c>{name, description}</c> for an assisted or manual step and a plain text
    /// for a containment; anything else is shown as written.
    /// </summary>
    internal static IReadOnlyList<RemediationDetailItem> Details(string? parameters)
    {
        if (string.IsNullOrWhiteSpace(parameters))
        {
            return [];
        }

        try
        {
            using var document = JsonDocument.Parse(parameters);
            var root = document.RootElement;
            if (root.ValueKind == JsonValueKind.Array)
            {
                return root.EnumerateArray().Select(item => item.ValueKind switch
                {
                    JsonValueKind.Object => new RemediationDetailItem(
                        Text(item, "name") ?? Text(item, "key"), Text(item, "description") ?? Text(item, "value") ?? item.GetRawText()),
                    JsonValueKind.String => new RemediationDetailItem(null, item.GetString() ?? string.Empty),
                    _ => new RemediationDetailItem(null, item.GetRawText()),
                }).Where(d => d.Value.Length > 0).ToList();
            }

            return root.ValueKind == JsonValueKind.String ? [new RemediationDetailItem(null, root.GetString() ?? string.Empty)] : [new RemediationDetailItem(null, parameters)];
        }
        catch (JsonException)
        {
            return [new RemediationDetailItem(null, parameters)];
        }
    }

    private static string? Text(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind != JsonValueKind.Null ? (v.ValueKind == JsonValueKind.String ? v.GetString() : v.GetRawText()) : null;
}
