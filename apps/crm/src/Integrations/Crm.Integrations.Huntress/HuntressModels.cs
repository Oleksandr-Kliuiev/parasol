using System.Net;

namespace Crm.Integrations.Huntress;

/// <summary>The names the CRM keeps Huntress's records under (external records, links, mirrors, actions).</summary>
public static class HuntressTypes
{
    public const string System = "huntress";

    /// <summary>A Huntress organization: one customer of the partner's account, linked to a CRM organization by a person.</summary>
    public const string Organization = "Organization";
}

/// <summary>The account the API credentials belong to (<c>GET /v1/account</c>): the connection test reads it.</summary>
public sealed record HuntressAccount(long Id, string? Name, string? Subdomain, string? Status);

/// <summary>
/// An organization of the account (<c>GET /v1/organizations</c>). Huntress keeps no organization number, so a link to a CRM
/// organization is always a person's decision on the mapping screen.
/// </summary>
public sealed record HuntressOrganization(
    long Id,
    string Name,
    string? Key,
    int? AgentsCount,
    int? IncidentReportsCount,
    int? BillableIdentityCount,
    int? SatLearnerCount,
    int? LogSourcesCount,
    DateTimeOffset? CreatedAt,
    DateTimeOffset? UpdatedAt);

/// <summary>
/// What Huntress counts for one organization's products (<c>actual_usages</c> of <c>GET /v1/organizations/{id}</c>): the EDR agents it
/// bills, and among them those it calls unresponsive, outdated and isolated; identities, learners and log sources it bills.
/// </summary>
public sealed record HuntressUsage(
    long OrganizationId,
    int? BillableAgents,
    int? UnresponsiveAgents,
    int? OutdatedAgents,
    int? IsolatedAgents,
    int? BillableIdentities,
    int? SatLearners,
    int? BillableLogSources);

/// <summary>
/// A Huntress agent (<c>GET /v1/agents</c>). <see cref="LastCallbackAt"/> is the last time Huntress reached the host; the Defender
/// fields are Huntress's view of Microsoft Defender (Managed Antivirus) on it, <see cref="LastSurveyAt"/> when it last reported them;
/// <see cref="FirewallStatus"/> says whether the host is isolated (<c>Isolated</c>, <c>Pending Isolation</c>, <c>Pending Release</c>).
/// </summary>
public sealed record HuntressAgent(long Id, long OrganizationId, string Hostname, string? Platform, string? Os, string? Version, DateTimeOffset? LastCallbackAt)
{
    public string? SerialNumber { get; init; }

    public IReadOnlyList<string> MacAddresses { get; init; } = [];

    public IReadOnlyList<string> Ipv4Addresses { get; init; } = [];

    public string? ExternalIp { get; init; }

    public string? DomainName { get; init; }

    public string? OsBuildVersion { get; init; }

    public string? EdrVersion { get; init; }

    public string? DefenderStatus { get; init; }

    public string? DefenderSubstatus { get; init; }

    public string? DefenderPolicyStatus { get; init; }

    public DateTimeOffset? LastSurveyAt { get; init; }

    public string? FirewallStatus { get; init; }

    public IReadOnlyList<string> Tags { get; init; } = [];

    public DateTimeOffset? CreatedAt { get; init; }
}

/// <summary>
/// An incident report (<c>GET /v1/incident_reports</c>). <see cref="Status"/> is Huntress's: <c>sent</c> (waiting for the partner),
/// <c>auto_remediating</c>, <c>closed</c>, <c>dismissed</c>, <c>partner_dismissed</c>, <c>deleting</c>, and <c>draft</c> (back at the SOC,
/// for example after its plan was rejected; only a read by id shows it). <see cref="Remediations"/> are the first ten the report
/// carries; <see cref="AllRemediations"/> is false when it has more, and the remediations route is read for them.
/// </summary>
public sealed record HuntressIncident(
    long Id,
    long OrganizationId,
    long? AgentId,
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
    IReadOnlyList<HuntressRemediation> Remediations,
    bool AllRemediations);

/// <summary>
/// A step of an incident's remediation plan. <see cref="Type"/> is <c>assisted</c> (Huntress carries it out once approved),
/// <c>manual</c> (a person does it and marks it done) or <c>containment</c>; <see cref="Status"/> is <c>unapproved</c>, <c>approved</c>,
/// <c>completed</c>, <c>failed</c> or <c>cancelled</c>. <see cref="Parameters"/> is the step's detail as Huntress wrote it (JSON).
/// </summary>
public sealed record HuntressRemediation(
    long Id, string Type, string? Action, string? Parameters, string Status, DateTimeOffset? ApprovedAt, string? ApprovedBy, DateTimeOffset? CompletedAt);

/// <summary>A comment on an incident report; Huntress's own are signed by its SOC, not by an analyst.</summary>
public sealed record HuntressComment(long Id, string Body, string? Author, DateTimeOffset CreatedAt, DateTimeOffset? UpdatedAt);

/// <summary>Escalations ask the partner to decide something; platform actions report something that keeps Huntress from protecting.</summary>
public enum HuntressNoticeKind
{
    Escalation,
    PlatformAction,
}

/// <summary>
/// An escalation or a platform action (<c>GET /v1/escalations</c>, <c>/v1/platform_actions</c>): <c>open</c>, <c>overdue</c> or
/// <c>resolved</c>. <see cref="TypeCode"/> is stable and safe to branch on; <see cref="Entities"/> (the hosts or identities it is
/// about) come only with a read by id, and are null until then.
/// </summary>
public sealed record HuntressNotice(
    HuntressNoticeKind Kind,
    long Id,
    IReadOnlyList<long> OrganizationIds,
    string Status,
    string Severity,
    string Subject,
    string? Type,
    string? TypeCode,
    string? Subtype,
    DateTimeOffset CreatedAt,
    DateTimeOffset? ResolvedAt,
    DateTimeOffset? UpdatedAt)
{
    public IReadOnlyList<HuntressEntity>? Entities { get; init; }

    /// <summary>False when Huntress has more entities than it returned.</summary>
    public bool AllEntities { get; init; } = true;
}

/// <summary>What a notice is about: an agent (its host name), an identity (its account), a mailbox; as Huntress names it.</summary>
public sealed record HuntressEntity(string Type, string? Id, string? Name);

/// <summary>A summary report (<c>GET /v1/reports</c>): the period, a few of its figures and Huntress's link to the PDF.</summary>
public sealed record HuntressReport(
    long Id,
    long OrganizationId,
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
    DateTimeOffset? CreatedAt,
    DateTimeOffset? UpdatedAt);

/// <summary>
/// Why a remediation plan is sent back to the SOC (<c>bulk_rejection</c>). <see cref="Reason"/> is one of Huntress's codes; the name,
/// phone and e-mail of the person are left to the user the API key belongs to, so the CRM sends none.
/// </summary>
public sealed record HuntressRejection(string Comment, bool Useful, string Reason);

/// <summary>
/// The answer a resolution of an escalation carries. Without a determination it is a plain resolution (for unwanted-access
/// escalations a dismissal until the next occurrence); with one, it says whether the access was expected, for the identity only,
/// and never revokes or disables the identity from here.
/// </summary>
public sealed record HuntressEscalationAnswer(string? Determination)
{
    public static HuntressEscalationAnswer Close { get; } = new((string?)null);
}

public sealed class HuntressApiException(HttpStatusCode status, string message) : Exception(message)
{
    public HttpStatusCode Status { get; } = status;
}
