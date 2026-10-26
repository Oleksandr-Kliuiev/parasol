namespace Crm.Integrations.Huntress;

/// <summary>
/// Huntress API v1 (M41), as its reference describes it (<c>https://api.huntress.io/docs</c>, OpenAPI <c>/v1/swagger_doc.json</c>).
/// The reads of the scheduled jobs take this client, which spends the read budget; the actions take
/// <see cref="IHuntressActionClient"/>, the same calls on a budget of their own.
/// </summary>
public interface IHuntressClient
{
    /// <summary>The account of the credentials; the connection test reads it.</summary>
    Task<HuntressAccount> GetAccountAsync(CancellationToken cancellationToken);

    IAsyncEnumerable<HuntressOrganization> GetOrganizationsAsync(CancellationToken cancellationToken);

    /// <summary>The organizations whose key is exactly <paramref name="key"/> (<c>GET organizations?key=</c>), every page (M43).</summary>
    Task<IReadOnlyList<HuntressOrganization>> FindOrganizationsByKeyAsync(string key, CancellationToken cancellationToken);

    /// <summary>
    /// Creates an organization (<c>POST organizations</c>, M43): its name and the key its agents join it with. The organization Huntress
    /// answers with, or null when the answer has none.
    /// </summary>
    Task<HuntressOrganization?> CreateOrganizationAsync(string name, string key, CancellationToken cancellationToken);

    /// <summary>What Huntress counts for one organization's products; null when Huntress does not know the organization.</summary>
    Task<HuntressUsage?> GetUsageAsync(long organizationId, CancellationToken cancellationToken);

    /// <summary>
    /// Every agent, or every agent of one organization. The device mirror marks removed what a complete read no longer lists, so an
    /// agent that cannot be read fails the read instead of going missing.
    /// </summary>
    IAsyncEnumerable<HuntressAgent> GetAgentsAsync(long? organizationId, CancellationToken cancellationToken);

    /// <summary>One agent as Huntress has it now; null when Huntress no longer knows it (uninstalled).</summary>
    Task<HuntressAgent?> GetAgentAsync(long agentId, CancellationToken cancellationToken);

    /// <summary>The incident reports in one status (<c>sent</c>, <c>auto_remediating</c>, …), every page.</summary>
    IAsyncEnumerable<HuntressIncident> GetIncidentsAsync(string status, CancellationToken cancellationToken);

    /// <summary>One incident report, a draft (back at the SOC) included; null when Huntress does not know it.</summary>
    Task<HuntressIncident?> GetIncidentAsync(long incidentId, CancellationToken cancellationToken);

    /// <summary>Every remediation of an incident report.</summary>
    Task<IReadOnlyList<HuntressRemediation>> GetRemediationsAsync(long incidentId, CancellationToken cancellationToken);

    /// <summary>Every comment of an incident report, oldest first.</summary>
    Task<IReadOnlyList<HuntressComment>> GetCommentsAsync(long incidentId, CancellationToken cancellationToken);

    /// <summary>The escalations or platform actions in one status (<c>open</c>, <c>overdue</c>, <c>resolved</c>), every page.</summary>
    IAsyncEnumerable<HuntressNotice> GetNoticesAsync(HuntressNoticeKind kind, string status, CancellationToken cancellationToken);

    /// <summary>One escalation or platform action with the entities it is about; null when Huntress does not know it.</summary>
    Task<HuntressNotice?> GetNoticeAsync(HuntressNoticeKind kind, long id, CancellationToken cancellationToken);

    /// <summary>The monthly summary reports whose period starts on or after <paramref name="periodFrom"/>, every page.</summary>
    IAsyncEnumerable<HuntressReport> GetReportsAsync(DateOnly periodFrom, CancellationToken cancellationToken);

    /// <summary>Approves every unapproved remediation of a report: Huntress then runs the assisted ones.</summary>
    Task ApproveRemediationsAsync(long incidentId, CancellationToken cancellationToken);

    /// <summary>Rejects every unapproved remediation of a report: the report goes back to the SOC.</summary>
    Task RejectRemediationsAsync(long incidentId, HuntressRejection rejection, CancellationToken cancellationToken);

    /// <summary>Marks a manual remediation done, or not done again.</summary>
    Task SetRemediationCompletionAsync(long incidentId, long remediationId, bool completed, CancellationToken cancellationToken);

    /// <summary>Resolves a report whose remediations are all approved.</summary>
    Task ResolveIncidentAsync(long incidentId, CancellationToken cancellationToken);

    /// <summary>Adds a comment to a report; the comment Huntress answers with, when it does.</summary>
    Task<HuntressComment?> CreateCommentAsync(long incidentId, string body, CancellationToken cancellationToken);

    /// <summary>Resolves an escalation with the answer given.</summary>
    Task ResolveEscalationAsync(long escalationId, HuntressEscalationAnswer answer, CancellationToken cancellationToken);

    /// <summary>Schedules the isolation of a host; the agent Huntress answers with (<c>Pending Isolation</c>), when it does.</summary>
    Task<HuntressAgent?> IsolateAgentAsync(long agentId, string reason, CancellationToken cancellationToken);

    /// <summary>Schedules the release of an isolated host; the agent Huntress answers with (<c>Pending Release</c>), when it does.</summary>
    Task<HuntressAgent?> ReleaseAgentAsync(long agentId, CancellationToken cancellationToken);

    /// <summary>Schedules a remote uninstall: the agent leaves the account at once and the host removes it on its next callback.</summary>
    Task UninstallAgentAsync(long agentId, CancellationToken cancellationToken);
}

/// <summary>The Huntress client on the actions' budget (M41: 15 of the 60 requests a minute Huntress allows).</summary>
public interface IHuntressActionClient : IHuntressClient;
