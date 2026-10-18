using Crm.Billing.Persistence;
using Crm.SharedKernel.Documents;
using Crm.SharedKernel.Results;
using Microsoft.EntityFrameworkCore;

namespace Crm.Billing.Features;

public sealed record InvoiceDocumentItem(Guid Id, string SourceName, string ContentSha256, long Length, DateTimeOffset ImportedAt);
public sealed record InvoiceDocumentsView(Guid InvoiceId, bool? SourceHasPdf, DateTimeOffset? CheckedAt, IReadOnlyList<InvoiceDocumentItem> Documents);
public sealed record InvoiceDocumentDownload(byte[] Content, string FileName);

internal sealed class InvoiceDocumentReader(BillingDbContext db, IDocumentStore store)
{
    public async Task<InvoiceDocumentsView?> ListAsync(Guid invoiceId, CancellationToken ct, Guid? expectedOrganizationId = null)
    {
        if (!await db.Invoices.AnyAsync(i => i.Id == invoiceId && (expectedOrganizationId == null || i.OrganizationId == expectedOrganizationId), ct)) return null;
        var check = await db.InvoiceDocumentChecks.AsNoTracking().SingleOrDefaultAsync(d => d.InvoiceId == invoiceId, ct);
        var documents = await db.InvoiceDocuments.AsNoTracking().Where(d => d.InvoiceId == invoiceId)
            .OrderBy(d => d.ImportedAt).ThenBy(d => d.Id)
            .Select(d => new InvoiceDocumentItem(d.Id, d.SourceName, d.ContentSha256, d.Length, d.ImportedAt)).ToListAsync(ct);
        return new(invoiceId, check?.HasPdf, check?.CheckedAt, documents);
    }

    public async Task<Result<InvoiceDocumentDownload>> DownloadAsync(Guid invoiceId, Guid documentId, CancellationToken ct, Guid? expectedOrganizationId = null)
    {
        var document = await db.InvoiceDocuments.AsNoTracking().Where(d => d.InvoiceId == invoiceId && d.Id == documentId &&
            db.Invoices.Any(i => i.Id == d.InvoiceId && (expectedOrganizationId == null || i.OrganizationId == expectedOrganizationId))).SingleOrDefaultAsync(ct);
        if (document is null) return Error.NotFound("BIL_DOCUMENT_NOT_FOUND", "Invoice document not found.");
        var content = await store.ReadAsync(document.ObjectKey, ct);
        if (content is null || content.LongLength != document.Length || DocumentHashes.Sha256(content) != document.ContentSha256)
            return new Error("BIL_DOCUMENT_INTEGRITY", "The stored invoice document failed integrity verification.", ErrorType.Failure);
        return new InvoiceDocumentDownload(content, $"invoice-{document.Id:N}.pdf");
    }
}
