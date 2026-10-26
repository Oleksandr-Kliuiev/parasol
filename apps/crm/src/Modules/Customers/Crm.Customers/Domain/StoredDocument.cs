using Crm.Customers.Contracts;
using Crm.SharedKernel.Documents;
using Crm.SharedKernel.Domain;

namespace Crm.Customers.Domain;

/// <summary>
/// A document the CRM filed for a customer (M43): a monthly report, as bytes in the document store under a content-addressed key that
/// is never reused, with the hash and length the bytes had when they were filed. Insert-only: the application never changes or
/// deletes a row (DENY in <see cref="Persistence.CustomersDatabasePermissions"/>), and a download is served only when the stored bytes
/// still match.
/// </summary>
public sealed class StoredDocument : Entity
{
    public const int KindLength = 32;
    public const int SourceKeyLength = 128;
    public const int FileNameLength = 240;
    public const string PdfMediaType = "application/pdf";

    private StoredDocument() { }

    public Guid OrganizationId { get; private set; }

    /// <summary>One of <see cref="StoredDocumentKinds"/>.</summary>
    public string Kind { get; private set; } = string.Empty;

    /// <summary>Where the document comes from, such as <c>huntress:report:4490</c> or <c>parasoll:summary:2026-10</c>.</summary>
    public string SourceKey { get; private set; } = string.Empty;

    public DateOnly PeriodStart { get; private set; }
    public DateOnly PeriodEnd { get; private set; }
    public string FileName { get; private set; } = string.Empty;
    public string MediaType { get; private set; } = PdfMediaType;
    public string ObjectKey { get; private set; } = string.Empty;
    public string ContentSha256 { get; private set; } = string.Empty;
    public long Length { get; private set; }
    public StoredDocumentProvenance Provenance { get; private set; }

    /// <summary>The renderer of a document the CRM made (its output is kept as it was, a later renderer makes new documents only).</summary>
    public string? RendererVersion { get; private set; }

    public DateTimeOffset StoredAt { get; private set; }

    /// <summary>The key of the bytes: one object per customer and content, so the same bytes filed twice are one object.</summary>
    public static string KeyOf(Guid organizationId, string sha256) => $"customers/documents/{organizationId:N}/{sha256}.pdf";

    public static StoredDocument Create(StoredDocumentFiling filing, DateTimeOffset at)
    {
        if (filing.OrganizationId == Guid.Empty)
        {
            throw new InvalidOperationException("A stored document needs its organization.");
        }

        if (!StoredDocumentKinds.All.Contains(filing.Kind, StringComparer.Ordinal))
        {
            throw new InvalidOperationException("Unknown kind of stored document.");
        }

        if (string.IsNullOrWhiteSpace(filing.SourceKey) || filing.SourceKey.Length > SourceKeyLength || filing.SourceKey.Any(char.IsControl))
        {
            throw new InvalidOperationException("Invalid source key of a stored document.");
        }

        if (filing.PeriodEnd < filing.PeriodStart || filing.RendererVersion is { Length: > 64 })
        {
            throw new InvalidOperationException("Invalid period or renderer of a stored document.");
        }

        PdfContent.ValidateSourceName(filing.FileName);
        PdfContent.Validate(filing.Content);
        var hash = DocumentHashes.Sha256(filing.Content);
        return new StoredDocument
        {
            OrganizationId = filing.OrganizationId,
            Kind = filing.Kind,
            SourceKey = filing.SourceKey,
            PeriodStart = filing.PeriodStart,
            PeriodEnd = filing.PeriodEnd,
            FileName = filing.FileName,
            ObjectKey = KeyOf(filing.OrganizationId, hash),
            ContentSha256 = hash,
            Length = filing.Content.Length,
            Provenance = filing.Provenance,
            RendererVersion = filing.RendererVersion,
            StoredAt = at,
        };
    }
}
