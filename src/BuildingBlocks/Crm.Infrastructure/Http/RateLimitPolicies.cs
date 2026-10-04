namespace Crm.Infrastructure.Http;

/// <summary>Named rate limiter policies configured by crm-web (docs/06-security.md §4).</summary>
public static class RateLimitPolicies
{
    /// <summary>Bulk data exports: 10 per user per hour.</summary>
    public const string Export = "export";

    /// <summary>The BI read API (DEV-14): requests per minute per client application, not per person.</summary>
    public const string BiRefresh = "bi-refresh";
}
