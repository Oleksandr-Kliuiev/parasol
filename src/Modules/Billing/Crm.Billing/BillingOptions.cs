namespace Crm.Billing;

/// <summary>Billing settings (docs/02 §4.9). Thresholds are configuration, not code.</summary>
public sealed class BillingOptions
{
    public const string SectionName = "Billing";

    /// <summary>A basis above this amount (excluding VAT) needs a second approval by Management (BR-BIL-04).</summary>
    public decimal SecondApprovalThreshold { get; set; } = 200_000m;

    /// <summary>A customer total that differs from the previous period by more than this share is flagged (BR-BIL-03).</summary>
    public decimal TotalChangeAnomalyPct { get; set; } = 20m;

    /// <summary>Add date, ticket and technician to hourly lines (BR-BIL-07).</summary>
    public bool DetailedHourLines { get; set; } = true;

    /// <summary>Show hours already covered by a contract or an hour bank as zero-priced information lines.</summary>
    public bool IncludeInfoLines { get; set; } = true;

    /// <summary>SKU of the hourly product used when a work type has no product of its own.</summary>
    public string? FallbackHourlySku { get; set; }

    /// <summary>
    /// A licence or device reading older than this many days, counted back from the end of the period (or from today when the
    /// period ends later), is flagged on the basis (DEV-19). It only informs Finance; it never blocks a basis.
    /// </summary>
    public int StaleQuantityDays { get; set; } = 3;

    /// <summary>The synchronization job that brings in approved work hours; when its latest run is not a complete success the bases say hours may be missing.</summary>
    public string HoursSyncSystem { get; set; } = "atera";

    public string HoursSyncJob { get; set; } = "atera-work-hours";

    public string InvoiceSyncCron { get; set; } = "20 * * * *";
}
