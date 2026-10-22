namespace Crm.Integrations.CloudAlly;

/// <summary>
/// CloudAlly settings (M42): the partner (reseller) API, read by crm-worker only. The application's client id and secret and the
/// partner portal user the CRM signs in as — a user of its own for the API, never a person's — live in the worker's private
/// configuration; crm-web gets the switches alone.
/// </summary>
public sealed class CloudAllyOptions
{
    public const string SectionName = "Integrations:CloudAlly";

    public bool Enabled { get; set; }

    /// <summary>The API host. CloudAlly's reference names one host for every data center: the region is the account's, not the host's.</summary>
    public Uri BaseUrl { get; set; } = new("https://api.cloudally.com/");

    /// <summary>The application's client id, sent as the <c>client-id</c> header when signing in.</summary>
    public string? ClientId { get; set; }

    public string? ClientSecret { get; set; }

    /// <summary>
    /// The partner portal user the CRM signs in as (its e-mail). CloudAlly binds every token to a portal user, so the "API user" is a
    /// partner user made for Parasoll, with a custom role that allows only what the CRM does — never a person's sign-in.
    /// </summary>
    public string? Email { get; set; }

    public string? Password { get; set; }

    /// <summary>Rows asked for per page; CloudAlly's default is 20 and its reference names no maximum, so paging follows its totals.</summary>
    public int PageSize { get; set; } = 100;

    /// <summary>CloudAlly publishes no request limit; two a second leaves room for its own portal.</summary>
    public int RequestsPerMinute { get; set; } = 120;

    /// <summary>Pause before the first repeat of a throttled (429) or, for reads, failed request; later repeats back off from it.</summary>
    public TimeSpan RetryDelay { get; set; } = TimeSpan.FromSeconds(2);

    /// <summary>The partner's customer accounts, for the mapping to customers (<c>cloudally-accounts</c>).</summary>
    public string AccountSyncCron { get; set; } = "15 * * * *";

    /// <summary>Backup tasks, their users and sites, and their statuses (<c>cloudally-backups</c>): every second hour.</summary>
    public string BackupSyncCron { get; set; } = "25 */2 * * *";

    /// <summary>What CloudAlly bills per account (<c>cloudally-bills</c>), once a night.</summary>
    public string BillSyncCron { get; set; } = "40 4 * * *";

    /// <summary>
    /// Link to an account in CloudAlly's partner portal, <c>{0}</c> being the account id. Empty by default: the portal's addresses are
    /// not documented, and a guessed one would lead somewhere else.
    /// </summary>
    public string? AccountUrlTemplate { get; set; }

    /// <summary>Send the actions people ask for (M39.1). Off by default: CloudAlly has no sandbox, so writes reach real backups.</summary>
    public bool WriteEnabled { get; set; }

    /// <summary>Actions are simulated: the worker reads CloudAlly and says what it would send, and sends nothing.</summary>
    public bool DryRun { get; set; }

    /// <summary>When not empty, actions are only sent for these CloudAlly account ids (a test customer first).</summary>
    public List<string> WriteAllowedCustomerIds { get; set; } = [];

    /// <summary>
    /// The kinds of action people may ask of CloudAlly (M42): <c>backup.run</c>, <c>backup.activate</c>, <c>backup.pause</c>,
    /// <c>backup.resume</c>, <c>account.deactivate</c>, <c>restore.export</c>, <c>restore.other</c>, <c>restore.in-place</c>. Empty by
    /// default: a kind is off until it is listed.
    /// </summary>
    public List<string> EnabledActions { get; set; } = [];

    public bool IsConfigured => Enabled && !string.IsNullOrWhiteSpace(ClientId) && !string.IsNullOrWhiteSpace(ClientSecret)
        && !string.IsNullOrWhiteSpace(Email) && !string.IsNullOrWhiteSpace(Password);
}
