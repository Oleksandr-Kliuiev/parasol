using System.Net.Http.Headers;
using System.Text;

namespace Crm.Integrations.Huntress;

/// <summary>
/// Huntress API v1 settings (M41). The key and the secret are the account's (or, for actions, a user's): crm-worker's configuration
/// only; crm-web gets the switches. Every switch that writes is off by default.
/// </summary>
public sealed class HuntressOptions
{
    public const string SectionName = "Integrations:Huntress";

    public bool Enabled { get; set; }

    /// <summary>The API key, the user name of HTTP Basic authentication.</summary>
    public string? ApiKey { get; set; }

    /// <summary>The API secret key, its password.</summary>
    public string? ApiSecret { get; set; }

    public Uri BaseUrl { get; set; } = new("https://api.huntress.io/v1/");

    /// <summary>
    /// What the account may ask a minute: Huntress allows 60 on a sliding minute, and the two budgets below share it. Only a stand-in
    /// without a limit (the e2e suite) is given more; Huntress's own address never is.
    /// </summary>
    public int AccountRequestsPerMinute { get; set; } = 60;

    /// <summary>
    /// Requests per minute of the reads (organizations, agents, incidents, reports). Huntress allows 60 per account on a sliding
    /// minute; reads and actions share it, 45 to 15 (M38), and two budgets that add up to more would be refused with 429.
    /// </summary>
    public int ReadRequestsPerMinute { get; set; } = 45;

    /// <summary>Requests per minute of the actions people ask for: their reads before and after included.</summary>
    public int ActionRequestsPerMinute { get; set; } = 15;

    /// <summary>Pause before the first repeat of a throttled (429) request; later repeats back off from it (DEV-19).</summary>
    public TimeSpan RetryDelay { get; set; } = TimeSpan.FromSeconds(5);

    /// <summary>Items per page: Huntress allows up to 500.</summary>
    public int PageSize { get; set; } = 500;

    /// <summary>The organizations (for the mapping screen) and what Huntress counts for the linked ones.</summary>
    public string OrganizationSyncCron { get; set; } = "25 * * * *";

    /// <summary>The agents: machines, Defender and isolation, then the coverage checks of Huntress.</summary>
    public string AgentSyncCron { get; set; } = "35 * * * *";

    /// <summary>Incident reports, escalations and platform actions: the alerts of Huntress.</summary>
    public string AlertSyncCron { get; set; } = "*/5 * * * *";

    /// <summary>The monthly summary reports.</summary>
    public string ReportSyncCron { get; set; } = "45 4 * * *";

    /// <summary>How many months of summary reports a read covers.</summary>
    public int ReportMonths { get; set; } = 13;

    /// <summary>The PDFs of the monthly reports filed among the customer's documents (M43), a little after the reports are read.</summary>
    public string ReportFileSyncCron { get; set; } = "55 4 * * *";

    /// <summary>
    /// The hosts a report's PDF may be fetched from, each with its subdomains (M43). Huntress answers with a link on huntress.io that
    /// may redirect to the storage the file lives in; a hop to any other host is refused, so that host has to be added here once it
    /// is known. Empty: huntress.io only.
    /// </summary>
    public List<string> ReportFileHosts { get; set; } = [];

    /// <summary>The hosts a report's PDF may come from: <see cref="ReportFileHosts"/>, or huntress.io when none is set.</summary>
    public IReadOnlyList<string> AllowedReportFileHosts => ReportFileHosts.Count > 0 ? ReportFileHosts : ["huntress.io"];

    /// <summary>
    /// Writing to Huntress (M41): remediations, resolutions, comments, isolation, uninstall. Off by default: Huntress has no test
    /// account, so writes reach the live one, and the default account key is read-only anyway (a user's key is needed).
    /// </summary>
    public bool WriteEnabled { get; set; }

    /// <summary>
    /// Actions are simulated: the worker reads Huntress and says what it would send, and sends nothing. With writing off and DryRun on,
    /// the whole action path can be tried against the live account without a single write.
    /// </summary>
    public bool DryRun { get; set; }

    /// <summary>When not empty, actions are sent only for these Huntress organization ids (a test customer first).</summary>
    public List<string> WriteAllowedCustomerIds { get; set; } = [];

    /// <summary>
    /// The kinds of action people may ask of Huntress: <c>incident.approve</c>, <c>incident.reject</c>, <c>incident.step</c>,
    /// <c>incident.resolve</c>, <c>incident.comment</c>, <c>escalation.resolve</c>, <c>agent.isolate</c>, <c>agent.release</c>,
    /// <c>agent.uninstall</c>; M43 adds <c>organization.create</c>. Empty by default: a kind is off until it is listed.
    /// </summary>
    public List<string> EnabledActions { get; set; } = [];

    /// <summary>
    /// Huntress's portal (its sign-in page; an account may have its own address), which the "Connect services" wizard (M43) leads to for
    /// what the API cannot do — the account key of the install script. Empty: the wizard names the step without a link.
    /// </summary>
    public string? ConsoleUrl { get; set; } = "https://huntress.io/";

    /// <summary>
    /// Links to Huntress's pages, <c>{0}</c> being the id. Empty by default: the format of Huntress's direct links is not confirmed
    /// (M38 risks), and a guessed address would lead somewhere else, so records carry no link until these are set.
    /// </summary>
    public string? IncidentUrlTemplate { get; set; }

    public string? EscalationUrlTemplate { get; set; }

    public string? PlatformActionUrlTemplate { get; set; }

    public string? AgentUrlTemplate { get; set; }

    public bool IsConfigured => Enabled && !string.IsNullOrWhiteSpace(ApiKey) && !string.IsNullOrWhiteSpace(ApiSecret);
}

/// <summary>HTTP Basic authentication as Huntress asks: Base64 of <c>key:secret</c> on every request.</summary>
internal static class HuntressAuthentication
{
    public static void Apply(HttpRequestHeaders headers, HuntressOptions options)
    {
        if (string.IsNullOrWhiteSpace(options.ApiKey) || string.IsNullOrWhiteSpace(options.ApiSecret))
        {
            return;
        }

        var pair = Convert.ToBase64String(Encoding.UTF8.GetBytes($"{options.ApiKey.Trim()}:{options.ApiSecret.Trim()}"));
        headers.Authorization = new AuthenticationHeaderValue("Basic", pair);
    }
}
