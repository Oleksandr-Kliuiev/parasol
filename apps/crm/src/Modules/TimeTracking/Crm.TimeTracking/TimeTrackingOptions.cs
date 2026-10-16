namespace Crm.TimeTracking;

public sealed class TimeTrackingOptions
{
    public const string SectionName = "TimeTracking";

    /// <summary>Hours billed by the rate are rounded up to this many minutes (BR-TIM-04).</summary>
    public int RateRoundingMinutes { get; set; } = 15;

    /// <summary>Shortest on-site visit that is billed (BR-TIM-04).</summary>
    public decimal MinimumOnsiteHours { get; set; } = 1m;

    /// <summary>Used when the contract has no SLA multiplier for work outside support hours (BR-TIM-06).</summary>
    public decimal DefaultAfterHoursMultiplier { get; set; } = 1.5m;

    /// <summary>Hourly product used when no product matches the work type, e.g. "TIME-SUPPORT".</summary>
    public string? DefaultHourlyProductSku { get; set; }

    /// <summary>Work types offered in the CRM in addition to those from the catalog.</summary>
    public List<string> WorkTypes { get; set; } = ["Remote", "Onsite", "Project", "Travel"];
}
