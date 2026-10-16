namespace Crm.Reports;

public sealed class ReportsOptions
{
    public const string SectionName = "Reports";

    /// <summary>
    /// What an hour of a technician's time costs the company, used by the margin report (FR-RPT-02). It is a setting and
    /// not a per-person salary: the CRM has no payroll data, and the report says which rate it used.
    /// </summary>
    public decimal InternalHourlyCost { get; set; } = 650m;

    /// <summary>Rows per page of the Power BI mart (FR-RPT-03).</summary>
    public int MartPageSize { get; set; } = 1000;

    /// <summary>A month's snapshot made later than this many days after the month ended is labelled Reconstructed (DEV-14).</summary>
    public int SnapshotTimelyDays { get; set; } = 5;
}

/// <summary>
/// The BI read API (DEV-14, ADR-022): Entra-issued bearer tokens for Power BI Service's scheduled refresh, accepted on
/// <c>/api/v1/bi</c> only. Off unless configured; enabled it must name the tenant, the audience and the client applications
/// that may read — an empty list admits nobody.
/// </summary>
public sealed class BiOptions
{
    public const string SectionName = "Bi";

    public bool Enabled { get; set; }

    public string? TenantId { get; set; }

    /// <summary>The audience the tokens are issued for, as the CRM's app registration names it (<c>aud</c> claim).</summary>
    public string? Audience { get; set; }

    /// <summary>Application (client) ids of the BI service identities allowed to read (<c>azp</c> or <c>appid</c> claim).</summary>
    public List<string> AllowedClients { get; set; } = [];

    /// <summary>Requests per minute per client application.</summary>
    public int RequestsPerMinute { get; set; } = 120;
}
