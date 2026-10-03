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
}
