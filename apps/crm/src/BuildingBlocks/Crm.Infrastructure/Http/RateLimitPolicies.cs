namespace Crm.Infrastructure.Http;

/// <summary>Named rate limiter policies configured by crm-web (docs/06-security.md §4).</summary>
public static class RateLimitPolicies
{
    /// <summary>Bulk data exports: 10 per user per hour.</summary>
    public const string Export = "export";

    /// <summary>
    /// The migration import (DEV-20): a preview, the import, its resumes and repeats are several calls of one job, so it has a
    /// budget of its own (60 per user per hour) instead of the export budget.
    /// </summary>
    public const string Migration = "migration";

    /// <summary>The BI read API (DEV-14): requests per minute per client application, not per person.</summary>
    public const string BiRefresh = "bi-refresh";
}
