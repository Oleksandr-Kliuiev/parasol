namespace Crm.Customers.Contracts;

/// <summary>The kinds of document the CRM files for a customer itself (M43), next to the SharePoint folder of FR-DOC-01.</summary>
public static class StoredDocumentKinds
{
    /// <summary>A security source's monthly summary report as the source made it (Huntress's PDF).</summary>
    public const string HuntressMonthly = "huntress-monthly";

    /// <summary>Parasoll's own monthly summary of the customer, rendered by the CRM from what its modules held at month end.</summary>
    public const string ParasollMonthly = "parasoll-monthly";

    public static readonly string[] All = [HuntressMonthly, ParasollMonthly];

    /// <summary>The source key of a Huntress report: one per report, whatever its bytes.</summary>
    public static string HuntressReport(long reportId) => FormattableString.Invariant($"huntress:report:{reportId}");

    /// <summary>The source key of Parasoll's summary of a month (<paramref name="monthStart"/> is the first day).</summary>
    public static string ParasollSummary(DateOnly monthStart) => FormattableString.Invariant($"parasoll:summary:{monthStart:yyyy-MM}");
}

/// <summary>
/// Where a stored document comes from: a source's own file (Huntress made it), or a summary the CRM rendered — Captured when it was
/// taken while the month's state was still at hand (ADR-022: within <c>Reports:SnapshotTimelyDays</c> of the month's end), else
/// Reconstructed, which the document says on every page.
/// </summary>
public enum StoredDocumentProvenance
{
    Source,
    Captured,
    Reconstructed,
}

/// <summary>
/// A document to file for a customer: the period it covers, the source it comes from (one source key per report or month) and its
/// bytes, a PDF. <paramref name="RendererVersion"/> names the renderer of a document the CRM made.
/// </summary>
public sealed record StoredDocumentFiling(
    Guid OrganizationId,
    string Kind,
    string SourceKey,
    DateOnly PeriodStart,
    DateOnly PeriodEnd,
    string FileName,
    byte[] Content,
    StoredDocumentProvenance Provenance,
    string? RendererVersion = null);

/// <summary>What filing did: the document's id, and whether it was new (false: these bytes of this source were filed before).</summary>
public sealed record StoredDocumentFiled(Guid DocumentId, bool Created);

/// <summary>A source already filed for a customer, whatever its bytes.</summary>
public sealed record FiledSource(Guid OrganizationId, string SourceKey);

/// <summary>
/// The customer's documents the CRM keeps itself (M43): generated monthly reports, filed once and never changed or deleted by the
/// application — like invoice and quote PDFs, unlike the customer's own files, which stay in SharePoint (FR-DOC-01). The bytes go to
/// the document store create-only and are read back and checked before the row is saved; a download checks the hash again.
/// </summary>
public interface ICustomerDocuments
{
    /// <summary>
    /// Files a document. Idempotent per organization, source key and content: filing the same bytes again returns the stored row. The
    /// content must be a whole PDF; an organization the CRM does not have is refused.
    /// </summary>
    Task<StoredDocumentFiled> FileAsync(StoredDocumentFiling filing, CancellationToken cancellationToken);

    /// <summary>The customers and sources among <paramref name="sourceKeys"/> that already have a document of <paramref name="kind"/>.</summary>
    Task<IReadOnlyList<FiledSource>> FiledAsync(string kind, IReadOnlyCollection<string> sourceKeys, CancellationToken cancellationToken);
}
