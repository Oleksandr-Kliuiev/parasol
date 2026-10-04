using System.Globalization;
using Crm.SharedKernel.Domain;

namespace Crm.Sales.Domain;

public enum QuoteDocumentStatus
{
    /// <summary>The fields are frozen; the PDF is not stored yet. Nothing is downloaded or sent until it is.</summary>
    Preparing,

    /// <summary>The PDF is stored and its hash recorded; this is the document, for good.</summary>
    Ready,
}

public enum QuoteDocumentOrigin
{
    /// <summary>Frozen when the version was released (DEV-08).</summary>
    Issued,

    /// <summary>
    /// A version released before documents were stored: drawn later from the data of that later day and labelled so on the
    /// paper — never presented as the document that was sent.
    /// </summary>
    Reconstructed,
}

/// <summary>
/// The document of a released quote version (DEV-08). Everything the paper shows — seller, customer, contact, owner,
/// language, wording, footer, lines, prices and periods — is frozen in <see cref="SnapshotJson"/> when the version is
/// released; the PDF is stored once under <see cref="ObjectKey"/> with <see cref="ContentSha256"/>. A later change of the
/// customer, the contact, the company settings, the template or the renderer changes nothing about it. A version released
/// again after an edit gets a new revision; a Ready document never changes and none is ever deleted (database trigger).
/// </summary>
public sealed class QuoteDocument : Entity
{
    public const string PdfMediaType = "application/pdf";

    private QuoteDocument() { }

    public Guid QuoteId { get; private set; }
    public Guid RootId { get; private set; }
    public int VersionNo { get; private set; }

    /// <summary>1 for the first release of the version, 2 after it was edited and released again, …</summary>
    public int Revision { get; private set; }

    public QuoteDocumentOrigin Origin { get; private set; }
    public QuoteDocumentStatus Status { get; private set; }

    /// <summary>Where the PDF is stored; unique, never reused, never overwritten.</summary>
    public string ObjectKey { get; private set; } = string.Empty;

    public string FileName { get; private set; } = string.Empty;
    public string MediaType { get; private set; } = PdfMediaType;

    /// <summary>All fields of the document as they were when it was frozen (JSON).</summary>
    public string SnapshotJson { get; private set; } = "{}";

    public string SnapshotSha256 { get; private set; } = string.Empty;
    public string? ContentSha256 { get; private set; }
    public long? Length { get; private set; }

    /// <summary>The renderer that drew the stored bytes; a later renderer never redraws them.</summary>
    public string? RendererVersion { get; private set; }

    public DateTimeOffset CreatedAt { get; private set; }
    public Guid? CreatedBy { get; private set; }
    public DateTimeOffset? ReadyAt { get; private set; }

    public static QuoteDocument Prepare(
        Quote quote, int revision, QuoteDocumentOrigin origin, string snapshotJson, string snapshotSha256, DateTimeOffset now, Guid? userId)
    {
        var document = new QuoteDocument
        {
            QuoteId = quote.Id,
            RootId = quote.RootId,
            VersionNo = quote.VersionNo,
            Revision = revision,
            Origin = origin,
            Status = QuoteDocumentStatus.Preparing,
            SnapshotJson = snapshotJson,
            SnapshotSha256 = snapshotSha256,
            CreatedAt = now,
            CreatedBy = userId,
        };
        document.ObjectKey = string.Create(CultureInfo.InvariantCulture, $"quotes/{quote.RootId:N}/{quote.Id:N}/{document.Id:N}.pdf");
        var name = quote.VersionNo > 1 ? string.Create(CultureInfo.InvariantCulture, $"{quote.Number}-v{quote.VersionNo}") : quote.Number;
        document.FileName = origin == QuoteDocumentOrigin.Reconstructed
            ? $"{name}-{(quote.Language == "en" ? "reconstructed" : "gjenskapt")}.pdf"
            : $"{name}.pdf";
        return document;
    }
}
