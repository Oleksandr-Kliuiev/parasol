namespace Crm.Integrations.PowerOffice;

public enum PowerOfficeEnvironment
{
    Demo,
    Production,
}

/// <summary>PowerOffice Go API v2 settings (docs/05-integrations.md §4). Keys come from Key Vault / user secrets, never appsettings.</summary>
public sealed class PowerOfficeOptions
{
    public const string SectionName = "Integrations:PowerOffice";

    public bool Enabled { get; set; }

    public PowerOfficeEnvironment Environment { get; set; } = PowerOfficeEnvironment.Demo;

    /// <summary>Application key of the CRM integration (developer portal).</summary>
    public string? ApplicationKey { get; set; }

    /// <summary>Client key generated when the integration is added to the company's Go client.</summary>
    public string? ClientKey { get; set; }

    /// <summary>Product subscription key sent as Ocp-Apim-Subscription-Key.</summary>
    public string? SubscriptionKey { get; set; }

    /// <summary>Overrides for tests; derived from <see cref="Environment"/> when empty.</summary>
    public Uri? BaseUrl { get; set; }

    public Uri? TokenUrl { get; set; }

    /// <summary>PowerOffice allows 10 requests per second per subscription key; keep headroom.</summary>
    public int RequestsPerSecond { get; set; } = 8;

    public int PageSize { get; set; } = 1000;

    /// <summary>Create and update customers in PowerOffice from the CRM. Off until the company has verified it in the demo client.</summary>
    public bool WriteEnabled { get; set; }

    /// <summary>Link unlinked PowerOffice customers to CRM organizations with the same org number during synchronization.</summary>
    public bool AutoLinkByOrgNumber { get; set; } = true;

    public string CustomerSyncCron { get; set; } = "*/15 * * * *";

    public string ContactPersonSyncCron { get; set; } = "5,35 * * * *";

    public string ProductSyncCron { get; set; } = "30 1 * * *";

    public string UserAgent { get; set; } = "VardaheiCRM/2.0 (it@vardahei.no)";

    public bool IsConfigured => Enabled && !string.IsNullOrWhiteSpace(ApplicationKey) && !string.IsNullOrWhiteSpace(ClientKey) && !string.IsNullOrWhiteSpace(SubscriptionKey);

    public Uri EffectiveBaseUrl => BaseUrl ?? new Uri(Environment == PowerOfficeEnvironment.Demo
        ? "https://goapi.poweroffice.net/Demo/v2/"
        : "https://goapi.poweroffice.net/v2/");

    public Uri EffectiveTokenUrl => TokenUrl ?? new Uri(Environment == PowerOfficeEnvironment.Demo
        ? "https://goapi.poweroffice.net/Demo/OAuth/Token"
        : "https://goapi.poweroffice.net/OAuth/Token");
}
