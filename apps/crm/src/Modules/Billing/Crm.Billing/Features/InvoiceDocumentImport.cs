using Crm.Billing.Contracts;
using Crm.Billing.Domain;
using Crm.SharedKernel.Documents;
using Microsoft.EntityFrameworkCore;

namespace Crm.Billing.Features;

internal sealed partial class BillingApi
{
    public async Task<IReadOnlyList<InvoiceDocumentSource>> GetInvoiceDocumentSourcesAsync(string system, int offset, int limit, CancellationToken cancellationToken)
    {
        if (offset < 0 || limit is < 1 or > 200) throw new ArgumentOutOfRangeException(nameof(limit));
        return await db.Invoices.AsNoTracking().Where(i => i.System == system && i.ExternalId != null && i.DocumentKind != null)
            .OrderBy(i => i.Id).Skip(offset).Take(limit)
            .Select(i => new InvoiceDocumentSource(i.Id, i.ExternalId!.Value, i.DocumentKind!.Value)).ToListAsync(cancellationToken);
    }

    public async Task<InvoiceDocumentImportResult> ImportInvoiceDocumentsAsync(string system, InvoiceDocumentSource source, bool? hasPdf,
        IReadOnlyList<ExternalInvoicePdf> files, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(system) || system.Length > 32 || source.VoucherId == Guid.Empty ||
            files.Count > 20 || (hasPdf == true) != (files.Count > 0) || files.Sum(f => (long)f.Content.Length) > 100L * 1024 * 1024 ||
            files.Select(f => f.SourceName).Distinct(StringComparer.Ordinal).Count() != files.Count)
            throw new InvalidOperationException("Invalid invoice PDF batch.");
        var incoming = files.Select(f => (Document: InvoiceDocument.Create(source.InvoiceId, f.SourceName, f.Content, time.GetUtcNow()), f.Content)).ToList();
        if (db.ChangeTracker.HasChanges()) throw new InvalidOperationException("PDF import requires a clean context.");
        return await db.Database.CreateExecutionStrategy().ExecuteAsync(async () =>
        {
            db.ChangeTracker.Clear();
            await using var transaction = await db.Database.BeginTransactionAsync(cancellationToken);
            await AcquireInvoiceLockAsync(system, cancellationToken);
            if (!await db.Invoices.AnyAsync(i => i.Id == source.InvoiceId && i.System == system && i.ExternalId == source.VoucherId &&
                    i.DocumentKind == source.Kind, cancellationToken))
                throw new InvalidOperationException("Invoice PDF identity does not match the historical invoice.");
            var previous = await db.InvoiceDocuments.Where(d => d.InvoiceId == source.InvoiceId).ToListAsync(cancellationToken);
            int created = 0;
            foreach (var (document, content) in incoming)
            {
                // A failed SQL commit can leave this exact content-addressed file. Never adopt different bytes.
                var stored = await documentStore.PutAsync(document.ObjectKey, content, "application/pdf", cancellationToken);
                var actual = await documentStore.ReadAsync(document.ObjectKey, cancellationToken);
                if (stored.Key != document.ObjectKey || stored.Sha256 != document.ContentSha256 || stored.Length != document.Length ||
                    actual is null || actual.LongLength != document.Length || DocumentHashes.Sha256(actual) != document.ContentSha256)
                    throw new InvalidDataException("Stored invoice PDF failed integrity verification.");
                if (previous.Any(d => d.SourceName == document.SourceName && d.ContentSha256 == document.ContentSha256)) continue;
                // Fresh entity on every execution-strategy attempt; a failed commit may have changed EF tracking state.
                db.InvoiceDocuments.Add(InvoiceDocument.Create(source.InvoiceId, document.SourceName, content, document.ImportedAt));
                created++;
            }
            var check = await db.InvoiceDocumentChecks.SingleOrDefaultAsync(d => d.InvoiceId == source.InvoiceId, cancellationToken);
            if (check is null) db.InvoiceDocumentChecks.Add(check = InvoiceDocumentCheck.Create(source.InvoiceId));
            check.Record(hasPdf, time.GetUtcNow());
            await db.SaveChangesAsync(cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            return new InvoiceDocumentImportResult(created, incoming.Count - created);
        });
    }
}
