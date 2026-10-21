using System.Net.Http.Headers;

namespace Crm.Integrations.Atera;

/// <summary>How crm-worker signs its calls to Atera (M39.0).</summary>
public enum AteraAuthenticationScheme
{
    /// <summary>The account's v3 API key in the <c>X-API-KEY</c> header.</summary>
    ApiKey,

    /// <summary>A token Atera issued (a JWT) in <c>Authorization: Bearer</c>, for an account Atera has moved to tokens.</summary>
    Bearer,
}

/// <summary>Atera API v3 settings (docs/05-integrations.md §3). The API key is account-wide: Key Vault / user secrets only.</summary>
public sealed class AteraOptions
{
    public const string SectionName = "Integrations:Atera";

    public bool Enabled { get; set; }

    /// <summary>The secret crm-worker signs with: the API key, or with <see cref="Authentication"/> <c>Bearer</c> the token itself.</summary>
    public string? ApiKey { get; set; }

    /// <summary>
    /// Whether <see cref="ApiKey"/> travels as <c>X-API-KEY</c> (default) or as <c>Authorization: Bearer</c>. The date Atera moves
    /// accounts to tokens is not confirmed (M38 risks), so both stay possible and the switch is configuration only.
    /// </summary>
    public AteraAuthenticationScheme Authentication { get; set; } = AteraAuthenticationScheme.ApiKey;

    public Uri BaseUrl { get; set; } = new("https://app.atera.com/api/v3/");

    /// <summary>Atera allows 700 requests per minute per account; leave room for other Atera integrations.</summary>
    public int RequestsPerMinute { get; set; } = 600;

    /// <summary>Pause before the first repeat of a throttled (429) request; later repeats back off from it (DEV-19).</summary>
    public TimeSpan RetryDelay { get; set; } = TimeSpan.FromSeconds(2);

    /// <summary>
    /// The recent-ticket pass reads newest first but a ticket's activity can be recent while its id is old, so it stops only
    /// after this many consecutive pages in which no ticket is inside the window (DEV-19).
    /// </summary>
    public int RecentStopPages { get; set; } = 3;

    /// <summary>Atera caps page size at 50.</summary>
    public int ItemsInPage { get; set; } = 50;

    /// <summary>
    /// Create and update customers in Atera. Off by default: Atera has no sandbox, so writes go to the live account.
    /// Enable after verifying on a test customer (docs/08-roadmap.md, PoC).
    /// </summary>
    public bool WriteEnabled { get; set; }

    /// <summary>When not empty, updates are only sent for these Atera customer ids (safety net for the test environment).</summary>
    public List<string> WriteAllowedCustomerIds { get; set; } = [];

    /// <summary>
    /// Name of the Atera customer custom field that receives the SLA level of the customer's active contract (e.g. "SLA").
    /// Empty disables the push. The field must exist in Atera (Admin → Custom fields → Customer).
    /// </summary>
    public string? SlaCustomFieldName { get; set; }

    public bool AutoLinkByOrgNumber { get; set; } = true;

    public string CustomerSyncCron { get; set; } = "10,40 * * * *";

    /// <summary>Open tickets (BR-SRV-01).</summary>
    public string TicketSyncCron { get; set; } = "*/10 * * * *";

    /// <summary>Full pass over recent tickets, so closed ones and late changes are picked up.</summary>
    public string RecentTicketSyncCron { get; set; } = "5-59/10 * * * *";

    public string WorkHoursSyncCron { get; set; } = "*/30 * * * *";

    public string AgentSyncCron { get; set; } = "30 1 * * *";

    public string AlertSyncCron { get; set; } = "5,35 * * * *";

    /// <summary>How far back the recent pass and the work-hours pass look.</summary>
    public int RecentTicketDays { get; set; } = 60;

    /// <summary>Ticket statuses treated as open in the frequent pass.</summary>
    public List<string> OpenTicketStatuses { get; set; } = ["Open", "Pending"];

    public string TicketUrlTemplate { get; set; } = "https://app.atera.com/new/ticket/{0}";

    public string DeviceUrlTemplate { get; set; } = "https://app.atera.com/new/device/{0}";

    /// <summary>
    /// Link to an alert in Atera, <c>{0}</c> being the alert id. Empty by default: the address of an alert page is not confirmed,
    /// and a guessed one would send people somewhere else, so alerts carry no link until it is set (M38).
    /// </summary>
    public string? AlertUrlTemplate { get; set; }

    public string ContactSyncCron { get; set; } = "20 * * * *";

    public bool IsConfigured => Enabled && !string.IsNullOrWhiteSpace(ApiKey);
}

/// <summary>Puts the secret on the client's default headers in the configured scheme; one header, never both.</summary>
internal static class AteraAuthentication
{
    public const string ApiKeyHeader = "X-API-KEY";

    public static void Apply(HttpRequestHeaders headers, AteraOptions options)
    {
        if (string.IsNullOrWhiteSpace(options.ApiKey))
        {
            return;
        }

        var secret = options.ApiKey.Trim();
        if (options.Authentication == AteraAuthenticationScheme.Bearer)
        {
            headers.Authorization = new AuthenticationHeaderValue("Bearer", secret);
        }
        else
        {
            headers.Add(ApiKeyHeader, secret);
        }
    }
}
