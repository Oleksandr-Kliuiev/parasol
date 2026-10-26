using System.Globalization;
using Crm.Customers.Contracts;
using Crm.Customers.Domain;
using Crm.Customers.Persistence;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Documents;
using Crm.SharedKernel.Operations;
using Crm.SharedKernel.Results;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;

namespace Crm.Customers.Features.Organizations;

/// <summary>One document the CRM filed for the customer, as the Documents tab lists it; the bytes come with the download only.</summary>
public sealed record StoredDocumentItem(
    Guid Id, string Kind, string SourceKey, DateOnly PeriodStart, DateOnly PeriodEnd, string FileName, long Length,
    StoredDocumentProvenance Provenance, DateTimeOffset StoredAt);

public sealed record StoredDocumentDownload(byte[] Content, string FileName, string Sha256);

/// <summary>
/// Files the customer's monthly reports (M43, <see cref="ICustomerDocuments"/>): the bytes go to the document store create-only and
/// are read back and compared with what was offered before the row is saved, so a row never names bytes that are not there. The key
/// is the content's hash: an attempt that stored the object and failed before its row adopts the same object the next time.
/// </summary>
internal sealed class CustomerDocuments(CustomersDbContext db, IDocumentStore store, TimeProvider time) : ICustomerDocuments
{
    private const int FiledChunk = 500;

    public async Task<StoredDocumentFiled> FileAsync(StoredDocumentFiling filing, CancellationToken cancellationToken)
    {
        var document = StoredDocument.Create(filing, time.GetUtcNow());
        if (!await db.Organizations.AsNoTracking().AnyAsync(o => o.Id == filing.OrganizationId, cancellationToken))
        {
            throw new StoredDocumentOrganizationMissingException();
        }

        if (await FindAsync(document, cancellationToken) is { } earlier)
        {
            return new StoredDocumentFiled(earlier, false);
        }

        // A failed SQL save can leave this exact content-addressed object behind: it is adopted, never different bytes.
        var stored = await store.PutAsync(document.ObjectKey, filing.Content, StoredDocument.PdfMediaType, cancellationToken);
        var actual = await store.ReadAsync(document.ObjectKey, cancellationToken);
        if (stored.Key != document.ObjectKey || stored.Sha256 != document.ContentSha256 || stored.Length != document.Length ||
            actual is null || actual.LongLength != document.Length || DocumentHashes.Sha256(actual) != document.ContentSha256)
        {
            throw new InvalidDataException("The stored document failed integrity verification.");
        }

        db.StoredDocuments.Add(document);
        try
        {
            await db.SaveChangesAsync(cancellationToken);
        }
        catch (DbUpdateException ex) when (ex.InnerException is SqlException { Number: 2601 or 2627 })
        {
            // The same document was filed at the same moment by another run: its row is the one.
            db.ChangeTracker.Clear();
            return new StoredDocumentFiled(await FindAsync(document, cancellationToken) ?? throw new InvalidOperationException("The stored document vanished."), false);
        }

        return new StoredDocumentFiled(document.Id, true);
    }

    public async Task<IReadOnlyList<FiledSource>> FiledAsync(string kind, IReadOnlyCollection<string> sourceKeys, CancellationToken cancellationToken)
    {
        var filed = new List<FiledSource>();
        foreach (var chunk in sourceKeys.Distinct(StringComparer.Ordinal).Chunk(FiledChunk))
        {
            filed.AddRange(await db.StoredDocuments.AsNoTracking().Where(d => d.Kind == kind && chunk.Contains(d.SourceKey))
                .Select(d => new FiledSource(d.OrganizationId, d.SourceKey)).Distinct().ToListAsync(cancellationToken));
        }

        return filed;
    }

    private async Task<Guid?> FindAsync(StoredDocument document, CancellationToken ct) =>
        await db.StoredDocuments.AsNoTracking()
            .Where(d => d.OrganizationId == document.OrganizationId && d.SourceKey == document.SourceKey && d.ContentSha256 == document.ContentSha256)
            .Select(d => (Guid?)d.Id).SingleOrDefaultAsync(ct);
}

/// <summary>
/// The customer's stored documents for the Documents tab (M43): newest period first, a page at a time, with the documents of the
/// organizations merged into this one (their rows never change, so they stay under the merged organization and are shown here). A
/// download is served only when the stored bytes still have the length and hash they were filed with.
/// </summary>
internal sealed class StoredDocumentReader(CustomersDbContext db, IDocumentStore store)
{
    public const int DefaultLimit = 24;
    public const int MaxLimit = 100;

    public async Task<Result<PagedResult<StoredDocumentItem>>> ListAsync(Guid organizationId, string? cursor, int? limit, CancellationToken ct)
    {
        if (await OwnersAsync(organizationId, ct) is not { } owners)
        {
            return Error.NotFound("CUS_ORGANIZATION_NOT_FOUND", "The organization was not found.");
        }

        var after = KeysetCursor.Decode(cursor);
        DateOnly afterPeriod = default;
        if (cursor is not null && (after is null ||
            !DateOnly.TryParseExact(after.SortKey, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out afterPeriod)))
        {
            return Error.Validation("CUS_CURSOR_INVALID", "The cursor is not one this list gave.");
        }

        var query = db.StoredDocuments.AsNoTracking().Where(d => owners.Contains(d.OrganizationId));
        var total = await query.CountAsync(ct);
        if (after is not null)
        {
            var afterId = after.Id;
            query = query.Where(d => d.PeriodStart < afterPeriod || (d.PeriodStart == afterPeriod && d.Id.CompareTo(afterId) < 0));
        }

        var take = Math.Clamp(limit ?? DefaultLimit, 1, MaxLimit);
        var page = await query.OrderByDescending(d => d.PeriodStart).ThenByDescending(d => d.Id).Take(take + 1)
            .Select(d => new StoredDocumentItem(d.Id, d.Kind, d.SourceKey, d.PeriodStart, d.PeriodEnd, d.FileName, d.Length, d.Provenance, d.StoredAt))
            .ToListAsync(ct);
        var items = page.Take(take).ToList();
        var next = page.Count > take
            ? new KeysetCursor(items[^1].PeriodStart.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture), items[^1].Id).Encode()
            : null;
        return new PagedResult<StoredDocumentItem>(items, next, total);
    }

    public async Task<Result<StoredDocumentDownload>> DownloadAsync(Guid organizationId, Guid documentId, CancellationToken ct)
    {
        var owners = await OwnersAsync(organizationId, ct);
        var document = owners is null
            ? null
            : await db.StoredDocuments.AsNoTracking().SingleOrDefaultAsync(d => d.Id == documentId && owners.Contains(d.OrganizationId), ct);
        if (document is null)
        {
            return Error.NotFound("CUS_DOCUMENT_NOT_FOUND", "The document was not found.");
        }

        var content = await store.ReadAsync(document.ObjectKey, ct);
        if (content is null || content.LongLength != document.Length || DocumentHashes.Sha256(content) != document.ContentSha256)
        {
            return new Error("CUS_DOCUMENT_INTEGRITY", "The stored document failed integrity verification.", ErrorType.Failure);
        }

        return new StoredDocumentDownload(content, document.FileName, document.ContentSha256);
    }

    /// <summary>The organization and those merged into it, or null when the organization is not there (deleted or merged away itself).</summary>
    private async Task<List<Guid>?> OwnersAsync(Guid organizationId, CancellationToken ct)
    {
        if (!await db.Organizations.AsNoTracking().AnyAsync(o => o.Id == organizationId, ct))
        {
            return null;
        }

        var merged = await db.Organizations.IgnoreQueryFilters().AsNoTracking().Where(o => o.MergedIntoId == organizationId).Select(o => o.Id).ToListAsync(ct);
        return [organizationId, .. merged];
    }
}

/// <summary>Before a restored copy resumes work, every stored document's bytes are checked against their row (DEV-13, as M37's invoice PDFs).</summary>
internal sealed class StoredDocumentRestore(CustomersDbContext db, IDocumentStore store) : IRestoreParticipant
{
    public string Area => "customer-documents";

    public Task<int> InFlightAsync(CancellationToken cancellationToken) => Task.FromResult(0);

    public async Task<IReadOnlyList<RestoreLine>> CheckAsync(DateTimeOffset restorePoint, CancellationToken cancellationToken)
    {
        int checkedCount = 0, invalid = 0;
        await foreach (var document in db.StoredDocuments.AsNoTracking().AsAsyncEnumerable().WithCancellation(cancellationToken))
        {
            var content = await store.ReadAsync(document.ObjectKey, cancellationToken);
            checkedCount++;
            if (content is null || content.LongLength != document.Length || DocumentHashes.Sha256(content) != document.ContentSha256)
            {
                invalid++;
            }
        }

        return [new(Area, "stored document integrity", $"Checked {checkedCount} stored customer documents; {invalid} missing or corrupt.",
            invalid == 0 ? null : "Restore the matching document volume before resuming work.", invalid > 0)];
    }

    public Task<IReadOnlyList<RestoreLine>> ReconcileAsync(
        DateTimeOffset restorePoint, IReadOnlyList<ExternalEffectEntry> effects, bool apply, CancellationToken cancellationToken) =>
        CheckAsync(restorePoint, cancellationToken);
}
