using Crm.SharedKernel.Documents;
using Crm.SharedKernel.Domain;

namespace Crm.Billing.Domain;

/// <summary>Append-only original source bytes. A source replacement adds a new row and never mutates the old one.</summary>
public sealed class InvoiceDocument : Entity
{
    private InvoiceDocument() { }
    public Guid InvoiceId { get; private set; }
    public string SourceName { get; private set; } = "";
    public string ContentSha256 { get; private set; } = "";
    public string ObjectKey { get; private set; } = "";
    public long Length { get; private set; }
    public DateTimeOffset ImportedAt { get; private set; }

    public static InvoiceDocument Create(Guid invoiceId, string sourceName, byte[] content, DateTimeOffset at)
    {
        if (invoiceId == Guid.Empty) throw new InvalidOperationException("Missing invoice identity.");
        PdfContent.ValidateSourceName(sourceName);
        PdfContent.Validate(content);
        var hash = DocumentHashes.Sha256(content);
        return new InvoiceDocument { InvoiceId = invoiceId, SourceName = sourceName, ContentSha256 = hash,
            ObjectKey = $"billing/invoice-pdfs/{invoiceId:N}/{hash}.pdf", Length = content.Length, ImportedAt = at };
    }
}

/// <summary>Latest successful availability check. NoPdf never deletes earlier captured documents.</summary>
public sealed class InvoiceDocumentCheck
{
    private InvoiceDocumentCheck() { }
    public Guid InvoiceId { get; private set; }
    public bool? HasPdf { get; private set; }
    public DateTimeOffset CheckedAt { get; private set; }
    public static InvoiceDocumentCheck Create(Guid invoiceId) => new() { InvoiceId = invoiceId };
    public void Record(bool? hasPdf, DateTimeOffset at) { HasPdf = hasPdf; CheckedAt = at; }
}
