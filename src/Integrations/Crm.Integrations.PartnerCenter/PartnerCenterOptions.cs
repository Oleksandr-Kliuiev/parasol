namespace Crm.Integrations.PartnerCenter;

/// <summary>
/// Partner Center (CSP) settings, Secure Application Model (docs/05-integrations.md §2.2): a service account consents once and the
/// resulting refresh token lives in Key Vault; the worker exchanges it for access tokens.
/// </summary>
public sealed class PartnerCenterOptions
{
    public const string SectionName = "Integrations:PartnerCenter";

    public bool Enabled { get; set; }

    /// <summary>Partner tenant id of the multi-tenant application.</summary>
    public string? TenantId { get; set; }

    public string? ClientId { get; set; }

    public string? ClientSecret { get; set; }

    /// <summary>Refresh token of the partner service account; rotated on every use.</summary>
    public string? RefreshToken { get; set; }

    public Uri BaseUrl { get; set; } = new("https://api.partnercenter.microsoft.com/");

    public Uri? TokenUrl { get; set; }

    /// <summary>Partner Center throttles hard; four parallel requests is the documented ceiling (docs/05 §2.5).</summary>
    public int RequestsPerSecond { get; set; } = 4;

    public int PageSize { get; set; } = 200;

    public string CustomerSyncCron { get; set; } = "40 2 * * *";

    /// <summary>Subscriptions every four hours (docs/05 §0).</summary>
    public string SubscriptionSyncCron { get; set; } = "15 */4 * * *";

    /// <summary>Licences in the customers' tenants, read through GDAP once a day (FR-LIC-03).</summary>
    public string LicenseSyncCron { get; set; } = "50 2 * * *";

    /// <summary>Partner billing reconciliation through Microsoft Graph (FR-LIC-04); off until the export is confirmed on the partner tenant.</summary>
    public bool BillingReconciliationEnabled { get; set; }

    /// <summary>Graph endpoint of the partner billing export (docs/05 §2.4).</summary>
    public Uri GraphBaseUrl { get; set; } = new("https://graph.microsoft.com/v1.0/");

    public string BillingSyncCron { get; set; } = "20 4 * * *";

    public Uri EffectiveTokenUrl => TokenUrl ?? new Uri($"https://login.microsoftonline.com/{TenantId}/oauth2/token");

    public bool IsConfigured => Enabled && !string.IsNullOrWhiteSpace(ClientId) && !string.IsNullOrWhiteSpace(RefreshToken) && !string.IsNullOrWhiteSpace(TenantId);
}
