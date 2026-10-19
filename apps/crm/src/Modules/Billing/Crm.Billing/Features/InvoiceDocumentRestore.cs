using Crm.Billing.Persistence;
using Crm.SharedKernel.Documents;
using Crm.SharedKernel.Operations;
using Microsoft.EntityFrameworkCore;

namespace Crm.Billing.Features;

/// <summary>Verify bytes as well as metadata before the restored copy resumes normal work.</summary>
internal sealed class InvoiceDocumentRestore(BillingDbContext db, IDocumentStore store) : IRestoreParticipant
{
    public string Area => "billing-documents";
    public Task<int> InFlightAsync(CancellationToken cancellationToken) => Task.FromResult(0);

    public async Task<IReadOnlyList<RestoreLine>> CheckAsync(DateTimeOffset restorePoint, CancellationToken cancellationToken)
    {
        int checkedCount = 0, invalid = 0;
        await foreach (var document in db.InvoiceDocuments.AsNoTracking().AsAsyncEnumerable().WithCancellation(cancellationToken))
        {
            var content = await store.ReadAsync(document.ObjectKey, cancellationToken);
            checkedCount++;
            if (content is null || content.LongLength != document.Length || DocumentHashes.Sha256(content) != document.ContentSha256) invalid++;
        }
        return [new(Area, "invoice PDF integrity", $"Checked {checkedCount} imported PDFs; {invalid} missing or corrupt.",
            invalid == 0 ? null : "Restore the matching document volume before resuming work.", invalid > 0)];
    }

    public Task<IReadOnlyList<RestoreLine>> ReconcileAsync(DateTimeOffset restorePoint, IReadOnlyList<ExternalEffectEntry> effects, bool apply, CancellationToken cancellationToken) =>
        CheckAsync(restorePoint, cancellationToken);
}
