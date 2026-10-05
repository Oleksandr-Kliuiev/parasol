namespace Crm.Reports;

public enum ReportAccessKind
{
    /// <summary>A person with <c>reports.mart</c> read or downloaded a mart dataset (the cookie API).</summary>
    MartExport,

    /// <summary>A client application began reading a BI dataset (the Power BI refresh).</summary>
    BiRead,

    /// <summary>A client application began reading a stored month-end snapshot.</summary>
    BiSnapshotRead,
}

/// <summary>
/// The trail of who read financial datasets and when (docs/06 §7). Reporting owns no schema, so the record is written by the
/// host through the audit table; the entry holds the kind, the dataset, the period and the client or person — never rows.
/// </summary>
public interface IReportAccessAudit
{
    Task RecordAsync(
        ReportAccessKind kind, string dataset, string? client, DateOnly? from, DateOnly? to, string? detail, CancellationToken cancellationToken);
}
