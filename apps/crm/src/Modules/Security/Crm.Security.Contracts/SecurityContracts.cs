namespace Crm.Security.Contracts;

/// <summary>
/// An incident report of a security source (Huntress, M41) as read, with the CRM organization its source organization is linked to.
/// <paramref name="Status"/> and <paramref name="Severity"/> are the source's words (<c>sent</c>, <c>closed</c>, <c>draft</c>…;
/// <c>low</c>, <c>high</c>, <c>critical</c>); <paramref name="Url"/> comes from configuration only, never from a guessed address.
/// </summary>
public sealed record ExternalIncident(
    string System,
    long ExternalId,
    Guid OrganizationId,
    long ExternalOrganizationId,
    string? AgentExternalId,
    string? DeviceName,
    string Status,
    string Severity,
    string Subject,
    string? Summary,
    string? Body,
    string? Platform,
    IReadOnlyList<string> IndicatorTypes,
    IReadOnlyDictionary<string, int> IndicatorCounts,
    DateTimeOffset? SentAt,
    DateTimeOffset? ClosedAt,
    DateTimeOffset? StatusUpdatedAt,
    DateTimeOffset? UpdatedAt,
    string? Url);

/// <summary>One step of an incident's remediation plan as the source has it now.</summary>
public sealed record ExternalRemediation(
    long ExternalId, string Type, string? Action, string? Parameters, string Status, DateTimeOffset? ApprovedAt, string? ApprovedBy, DateTimeOffset? CompletedAt);

/// <summary>One comment of an incident as the source has it now.</summary>
public sealed record ExternalIncidentComment(long ExternalId, string Body, string? Author, DateTimeOffset CreatedAt, DateTimeOffset? UpdatedAt);

/// <summary>
/// One read of an incident: the report, and its plan and comments when this read included them. A list that is null was not read
/// this time and stays as stored; an empty list says the source has none. <paramref name="ReadAt"/> is when the read began (null:
/// now): a reading older than the stored one (a scheduled read that began before an action's read-back) is not applied.
/// </summary>
public sealed record IncidentReading(
    ExternalIncident Incident, IReadOnlyList<ExternalRemediation>? Remediations, IReadOnlyList<ExternalIncidentComment>? Comments,
    DateTimeOffset? ReadAt = null);

/// <summary>Escalations ask the partner to decide; platform actions report what keeps the source from protecting a customer.</summary>
public enum NoticeKind
{
    Escalation,
    PlatformAction,
}

/// <summary>What a notice is about, as the source names it: a host, an identity, a mailbox.</summary>
public sealed record NoticeEntity(string Type, string? Id, string? Name);

/// <summary>
/// An escalation or a platform action as read (<c>open</c>, <c>overdue</c>, <c>resolved</c>). <paramref name="OrganizationId"/> is the
/// CRM organization of the first linked source organization, null when none is linked (an account-wide notice).
/// <paramref name="Entities"/> null means they were not read this time and stay as stored. <paramref name="ReadAt"/> is when the read
/// began (null: now): a reading older than the stored one is not applied.
/// </summary>
public sealed record ExternalNotice(
    string System,
    NoticeKind Kind,
    long ExternalId,
    Guid? OrganizationId,
    IReadOnlyList<long> ExternalOrganizationIds,
    string Status,
    string Severity,
    string Subject,
    string? Type,
    string? TypeCode,
    string? Subtype,
    IReadOnlyList<NoticeEntity>? Entities,
    bool AllEntities,
    DateTimeOffset CreatedAt,
    DateTimeOffset? ResolvedAt,
    DateTimeOffset? UpdatedAt,
    string? Url,
    DateTimeOffset? ReadAt = null);

/// <summary>A summary report of one customer's period, read only: the PDF stays with the source (M43 files it).</summary>
public sealed record ExternalReport(
    string System,
    long ExternalId,
    Guid OrganizationId,
    long ExternalOrganizationId,
    string Type,
    DateOnly? PeriodStart,
    DateOnly? PeriodEnd,
    string? Url,
    int? AgentsCount,
    int? IncidentsReported,
    int? IncidentsResolved,
    long? SignalsDetected,
    long? SignalsInvestigated,
    long? EventsAnalyzed,
    DateTimeOffset? CreatedAt);

/// <summary>What the source counts for one of its organizations linked to a CRM organization (M41: Huntress's actual usage).</summary>
public sealed record ExternalUsage(
    string System,
    long ExternalOrganizationId,
    Guid OrganizationId,
    string Name,
    int? AgentsCount,
    int? BillableAgents,
    int? UnresponsiveAgents,
    int? OutdatedAgents,
    int? IsolatedAgents,
    int? BillableIdentities,
    int? SatLearners,
    int? BillableLogSources);

/// <summary>A step of a stored plan, as an action plans from it.</summary>
public sealed record RemediationView(long ExternalId, string Type, string? Action, string Status, DateTimeOffset? CompletedAt);

/// <summary>
/// A stored incident as an action or a reader sees it. <paramref name="IsOpen"/> is true while the source has not closed it (sent,
/// auto-remediating, or a draft back at the SOC).
/// </summary>
public sealed record IncidentView(
    Guid Id,
    string System,
    long ExternalId,
    Guid OrganizationId,
    long ExternalOrganizationId,
    string? AgentExternalId,
    string? DeviceName,
    string Status,
    string Severity,
    string Subject,
    bool IsOpen,
    string? Url,
    DateTimeOffset? UpdatedAt,
    DateTimeOffset? CommentsReadAt,
    IReadOnlyList<RemediationView> Remediations);

/// <summary>A stored escalation or platform action as an action or a reader sees it, with the entities last read.</summary>
public sealed record NoticeView(
    Guid Id,
    string System,
    NoticeKind Kind,
    long ExternalId,
    Guid? OrganizationId,
    long? ExternalOrganizationId,
    string Status,
    string Severity,
    string Subject,
    string? TypeCode,
    bool IsOpen,
    string? Url,
    DateTimeOffset? UpdatedAt,
    DateTimeOffset? EntitiesReadAt,
    IReadOnlyList<NoticeEntity> Entities);

/// <summary>What one apply changed; a refreshed read time alone is not a change.</summary>
public sealed record SecurityApplyResult(int Added, int Updated)
{
    public static SecurityApplyResult None { get; } = new(0, 0);

    public int Changed => Added + Updated;

    public static SecurityApplyResult operator +(SecurityApplyResult a, SecurityApplyResult b) => new(a.Added + b.Added, a.Updated + b.Updated);
}

/// <summary>
/// Public API of the Security module (M41): the mirror of a security source's incidents, escalations, platform actions, reports and
/// usage, written by its integration and read by its actions. The source is the system of record; the alerts people work with stay
/// in the Service module.
/// </summary>
public interface ISecurityApi
{
    /// <summary>Stores what one read found about these incidents: the reports, and their plans and comments where read.</summary>
    Task<SecurityApplyResult> ApplyIncidentsAsync(IReadOnlyCollection<IncidentReading> readings, CancellationToken cancellationToken);

    /// <summary>The source no longer knows these incidents (deleted there): they are kept as history, closed.</summary>
    Task<int> CloseMissingIncidentsAsync(string system, IReadOnlyCollection<long> externalIds, CancellationToken cancellationToken);

    /// <summary>The incidents stored as open, for a reader to look up the ones its list of open incidents no longer names.</summary>
    Task<IReadOnlyList<IncidentView>> GetOpenIncidentsAsync(string system, CancellationToken cancellationToken);

    /// <summary>A stored incident with its plan; null when the CRM has none.</summary>
    Task<IncidentView?> GetIncidentAsync(string system, long externalId, CancellationToken cancellationToken);

    /// <summary>Stores what one read found about these escalations or platform actions.</summary>
    Task<SecurityApplyResult> ApplyNoticesAsync(IReadOnlyCollection<ExternalNotice> notices, CancellationToken cancellationToken);

    /// <summary>The source no longer knows these notices: they are kept as history, resolved.</summary>
    Task<int> CloseMissingNoticesAsync(string system, NoticeKind kind, IReadOnlyCollection<long> externalIds, CancellationToken cancellationToken);

    /// <summary>The notices of one kind stored as open or overdue.</summary>
    Task<IReadOnlyList<NoticeView>> GetOpenNoticesAsync(string system, NoticeKind kind, CancellationToken cancellationToken);

    /// <summary>A stored notice; null when the CRM has none.</summary>
    Task<NoticeView?> GetNoticeAsync(string system, NoticeKind kind, long externalId, CancellationToken cancellationToken);

    /// <summary>Stores the summary reports read; a report read again replaces its figures.</summary>
    Task<SecurityApplyResult> ApplyReportsAsync(IReadOnlyCollection<ExternalReport> reports, CancellationToken cancellationToken);

    /// <summary>Stores what the source counts for its organizations now, one row per source organization.</summary>
    Task<SecurityApplyResult> ApplyUsageAsync(IReadOnlyCollection<ExternalUsage> usages, CancellationToken cancellationToken);
}
