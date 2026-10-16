namespace Crm.Licensing;

public sealed class LicensingOptions
{
    public const string SectionName = "Licensing";

    /// <summary>NCE cancellation window: 7 days (BR-LIC-02).</summary>
    public int CancellationWindowHours { get; set; } = 168;

    /// <summary>How far ahead the renewal warning looks.</summary>
    public int RenewalNoticeDays { get; set; } = 60;
}
