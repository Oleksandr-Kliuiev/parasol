using System.Text;
using Crm.Customers.Contracts;
using Crm.Identity.Contracts;
using Crm.Infrastructure.Persistence;
using Crm.Privacy.Contracts;
using Crm.Sales.Contracts;
using Crm.Sales.Domain;
using Crm.Sales.Persistence;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Documents;
using Crm.SharedKernel.Results;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Crm.Sales.Features;

/// <summary>A stored document ready to be downloaded or attached: the very bytes the record names.</summary>
internal sealed record QuoteDelivery(QuoteDocument Document, byte[] Content);

/// <summary>
/// The documents of released quote versions (DEV-08). Releasing a version freezes every field of its document in the same
/// transaction as the release (Preparing); the PDF is then drawn from that snapshot, stored under a key that is never reused
/// and recorded with its hash (Ready). Storage and database are not one transaction: a document whose PDF could not be
/// stored stays Preparing — nothing downloads or sends it — until a later attempt stores it; an attempt that finds the PDF
/// already stored adopts it. Downloads and e-mail attachments are both read from storage and checked against the hash.
/// </summary>
internal sealed class QuoteDocuments(
    SalesDbContext db,
    ICustomersApi customers,
    IUserDirectory users,
    IDocumentStore store,
    IOptions<SalesOptions> options,
    ICurrentUser currentUser,
    TimeProvider time,
    IErasedRecords erasedRecords,
    ILogger<QuoteDocuments> logger)
{
    private static readonly TimeZoneInfo Oslo = TimeZoneInfo.FindSystemTimeZoneById("Europe/Oslo");

    public static readonly Error Erased = Error.NotFound(
        "SAL_DOCUMENT_ERASED", "This quote document was erased at the request of the person on it (privacy case); it is no longer shown or sent.");

    public static readonly Error Preparing = Error.Conflict(
        "SAL_DOCUMENT_PREPARING", "The quote document is being stored; it can be downloaded or sent in a moment.");

    /// <summary>
    /// Freezes the document of a version that is being released: a Preparing document joins the context and is saved with the
    /// release. <paramref name="origin"/> Reconstructed is for versions released before documents were stored.
    /// </summary>
    public async Task<QuoteDocument> PrepareAsync(Quote quote, QuoteDocumentOrigin origin, CancellationToken cancellationToken, int? revision = null)
    {
        var now = time.GetUtcNow();
        var snapshot = await SnapshotAsync(quote, origin == QuoteDocumentOrigin.Reconstructed ? OsloDate(now) : null, cancellationToken);
        var json = snapshot.ToJson();
        revision ??= (await db.QuoteDocuments.Where(d => d.QuoteId == quote.Id).MaxAsync(d => (int?)d.Revision, cancellationToken) ?? 0) + 1;
        var document = QuoteDocument.Prepare(quote, revision.Value, origin, json, DocumentHashes.Sha256(Encoding.UTF8.GetBytes(json)), now, currentUser.UserId);
        db.QuoteDocuments.Add(document);
        return document;
    }

    /// <summary>
    /// Stores the PDF of a Preparing document and marks it Ready; a Ready one is returned as it is. Repeating it is safe: a PDF
    /// stored by an earlier attempt that could not record it is adopted as it is.
    /// </summary>
    public async Task<QuoteDocument> CompleteAsync(Guid documentId, CancellationToken cancellationToken)
    {
        var document = await db.QuoteDocuments.AsNoTracking().SingleAsync(d => d.Id == documentId, cancellationToken);
        if (document.Status == QuoteDocumentStatus.Ready || await IsErasedAsync(document, cancellationToken))
        {
            // DEV-11: a document a privacy case covered is never drawn from its snapshot again, even if it was still Preparing.
            return document;
        }

        var content = QuotePdf.Render(QuoteSnapshot.FromJson(document.SnapshotJson));
        var stored = await store.PutAsync(document.ObjectKey, content, document.MediaType, cancellationToken);
        if (!stored.Created)
        {
            // The first object of a key is the document. It differs from this rendering only if the renderer changed between
            // the attempts (a deployment in between) — or if someone wrote the key: worth a look either way.
            var differs = stored.Sha256 != DocumentHashes.Sha256(content);
            logger.Log(
                differs ? LogLevel.Warning : LogLevel.Information,
                "Quote document {DocumentId}: the PDF stored by an earlier attempt is adopted ({Sha256}); it {Comparison} this rendering",
                documentId,
                stored.Sha256,
                differs ? "differs from" : "matches");
        }

        var now = time.GetUtcNow();
        await db.QuoteDocuments
            .Where(d => d.Id == documentId && d.Status == QuoteDocumentStatus.Preparing)
            .ExecuteUpdateAsync(s => s
                .SetProperty(d => d.Status, QuoteDocumentStatus.Ready)
                .SetProperty(d => d.ContentSha256, stored.Sha256)
                .SetProperty(d => d.Length, stored.Length)
                .SetProperty(d => d.RendererVersion, QuotePdf.RendererVersion)
                .SetProperty(d => d.ReadyAt, now), cancellationToken);
        return await db.QuoteDocuments.AsNoTracking().SingleAsync(d => d.Id == documentId, cancellationToken);
    }

    /// <summary>Like <see cref="CompleteAsync"/>, but a storage or database failure leaves the document Preparing for the next attempt.</summary>
    public async Task<QuoteDocument?> TryCompleteAsync(Guid documentId, CancellationToken cancellationToken)
    {
        try
        {
            return await CompleteAsync(documentId, cancellationToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            logger.LogWarning("Quote document {DocumentId} could not be stored yet ({ErrorType}); it stays Preparing", documentId, ex.GetType().Name);
            return null;
        }
    }

    /// <summary>Erased by the privacy operator's procedure, or covered by an executed privacy case that still waits for it.</summary>
    private async Task<bool> IsErasedAsync(QuoteDocument document, CancellationToken cancellationToken) =>
        document.IsErased || (await erasedRecords.ErasedAsync(SalesDbContext.SchemaName, nameof(QuoteDocument), [document.Id], cancellationToken)).Count > 0;

    public Task<QuoteDocument?> CurrentAsync(Guid quoteId, CancellationToken cancellationToken) =>
        db.QuoteDocuments.AsNoTracking().Where(d => d.QuoteId == quoteId).OrderByDescending(d => d.Revision).FirstOrDefaultAsync(cancellationToken);

    public async Task<IReadOnlyList<QuoteDocument>> ListAsync(Guid quoteId, CancellationToken cancellationToken) =>
        await db.QuoteDocuments.AsNoTracking().Where(d => d.QuoteId == quoteId).OrderBy(d => d.Revision).ToListAsync(cancellationToken);

    /// <summary>
    /// The document to download or attach, read from storage and checked against its hash. The current one is completed now
    /// if it is still Preparing. A version released before documents were stored gets one now: issued if it was never sent,
    /// otherwise reconstructed — and labelled so on the paper. <paramref name="revision"/> picks an earlier one.
    /// </summary>
    public async Task<Result<QuoteDelivery>> ForDeliveryAsync(Quote quote, int? revision, CancellationToken cancellationToken)
    {
        var document = revision is { } wanted
            ? await db.QuoteDocuments.AsNoTracking().SingleOrDefaultAsync(d => d.QuoteId == quote.Id && d.Revision == wanted, cancellationToken)
            : await CurrentAsync(quote.Id, cancellationToken);
        if (document is null && revision is not null)
        {
            return Error.NotFound("SAL_DOCUMENT_NOT_FOUND", $"Quote {quote.Number} has no document revision {revision}.");
        }

        document ??= await PrepareLegacyAsync(quote, cancellationToken);
        // DEV-11: a document erased at a person's request is never shown or sent again — from the moment the case was carried
        // out, before the privacy operator's procedure clears it for good.
        if (await IsErasedAsync(document, cancellationToken))
        {
            return Erased;
        }

        if (document.Status == QuoteDocumentStatus.Preparing)
        {
            if (await TryCompleteAsync(document.Id, cancellationToken) is not { Status: QuoteDocumentStatus.Ready } completed)
            {
                return Preparing;
            }

            document = completed;
        }

        var content = await store.ReadAsync(document.ObjectKey, cancellationToken);
        if (content is null || DocumentHashes.Sha256(content) != document.ContentSha256)
        {
            // Never send or show a file that is not the recorded document (DEV-08); the operators investigate.
            logger.LogError("Quote document {DocumentId} ({Key}) is missing from storage or does not match its recorded hash", document.Id, document.ObjectKey);
            return new Error("SAL_DOCUMENT_UNAVAILABLE", "The stored quote document cannot be read; nothing was sent.", ErrorType.Failure);
        }

        return new QuoteDelivery(document, content);
    }

    private async Task<QuoteDocument> PrepareLegacyAsync(Quote quote, CancellationToken cancellationToken)
    {
        // Released before DEV-08: nothing was frozen. A version still waiting to be sent is issued now; one that may have left
        // the house already can only be reconstructed from today's data, and says so.
        // Always revision 1: two requests that both find no document collide on (quote, revision) and the loser adopts the winner's.
        var origin = quote.Status == QuoteStatus.Ready && quote.SentAt is null ? QuoteDocumentOrigin.Issued : QuoteDocumentOrigin.Reconstructed;
        var document = await PrepareAsync(quote, origin, cancellationToken, revision: 1);
        try
        {
            await db.SaveChangesAsync(cancellationToken);
            return document;
        }
        catch (DbUpdateException ex) when (ex.IsUniqueViolation())
        {
            // Another request made it first; that one is the document. Only the losing insert is let go: the caller's quote
            // stays tracked, so a send that lost the race still records that it was sent. A document is a plain entity —
            // the failed save staged no audit row or event alongside it.
            db.Entry(document).State = EntityState.Detached;
            return await CurrentAsync(quote.Id, cancellationToken) ?? throw new InvalidOperationException("The concurrent quote document vanished.", ex);
        }
    }

    /// <summary>Every field the paper shows, as it is now; frozen in the document's snapshot.</summary>
    private async Task<QuoteSnapshot> SnapshotAsync(Quote quote, DateOnly? reconstructedOn, CancellationToken cancellationToken)
    {
        var organization = await customers.GetOrganizationForSyncAsync(quote.OrganizationId, cancellationToken);
        var contact = quote.ContactId is { } contactId ? await customers.GetContactForSyncAsync(contactId, cancellationToken) : null;
        var owner = quote.OwnerId is { } ownerId ? await users.GetProfileAsync(ownerId, cancellationToken) : null;
        var template = await db.QuoteTemplates.AsNoTracking()
            .FirstOrDefaultAsync(t => t.Language == quote.Language && t.IsDefault && t.IsActive, cancellationToken);
        var address = organization?.Billing.Address ?? organization?.PostalAddress;

        return new QuoteSnapshot(
            quote.Number,
            quote.VersionNo,
            quote.Title,
            quote.Language,
            quote.IssuedOn,
            quote.ValidUntil,
            quote.TermMonths,
            quote.IntroText,
            quote.TermsText,
            template?.FooterText,
            quote.CustomerReference,
            owner?.DisplayName,
            owner?.Email,
            new QuoteSnapshotCustomer(
                organization?.Name ?? "—",
                organization?.OrgNumber,
                address?.Street,
                address?.PostalCode,
                address?.City,
                contact is null ? null : $"{contact.FirstName} {contact.LastName}".Trim(),
                contact?.Email),
            quote.Lines.OrderBy(l => l.Sort).Select(l => new QuoteSnapshotLine(
                l.Name, l.Description, l.Sku, l.Quantity, l.UnitPrice, l.DiscountPct, l.NetAmount, l.Recurrence == QuoteLineRecurrence.Monthly)).ToList(),
            quote.OneTimeExVat,
            quote.OneTimeVat,
            quote.MonthlyExVat,
            quote.MonthlyVat,
            QuoteSnapshotCompany.From(options.Value.Company),
            template?.Id,
            template?.Name,
            reconstructedOn);
    }

    private static DateOnly OsloDate(DateTimeOffset now) => DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(now, Oslo).DateTime);
}

/// <summary>
/// Background care of quote documents (DEV-08): documents still Preparing are stored (storage was away when the version was
/// released), and stored objects that no document references are removed after a grace period — never one that is referenced.
/// </summary>
public sealed class QuoteDocumentJob
{
    public const string JobId = "quote-documents";
    public const string OrphanJobId = "quote-document-orphans";
    public const string KeyPrefix = "quotes/";

    /// <summary>Long enough for any release in flight and for a person to notice a database restore first (runbook 03).</summary>
    public static readonly TimeSpan OrphanGrace = TimeSpan.FromDays(7);

    private readonly SalesDbContext _db;
    private readonly QuoteDocuments _documents;
    private readonly IDocumentStore _store;
    private readonly TimeProvider _time;
    private readonly ILogger<QuoteDocumentJob> _logger;

    internal QuoteDocumentJob(SalesDbContext db, QuoteDocuments documents, IDocumentStore store, TimeProvider time, ILogger<QuoteDocumentJob> logger)
    {
        _db = db;
        _documents = documents;
        _store = store;
        _time = time;
        _logger = logger;
    }

    public async Task<int> RunAsync(CancellationToken cancellationToken)
    {
        var waiting = await _db.QuoteDocuments.AsNoTracking()
            .Where(d => d.Status == QuoteDocumentStatus.Preparing && d.ErasedAt == null)
            .OrderBy(d => d.CreatedAt)
            .Select(d => d.Id)
            .Take(50)
            .ToListAsync(cancellationToken);
        var completed = 0;
        foreach (var id in waiting)
        {
            if (await _documents.TryCompleteAsync(id, cancellationToken) is { Status: QuoteDocumentStatus.Ready })
            {
                completed++;
            }
        }

        return completed;
    }

    public async Task<QuoteDocumentOrphans> CleanOrphansAsync(CancellationToken cancellationToken)
    {
        var cutoff = _time.GetUtcNow() - OrphanGrace;
        var referenced = (await _db.QuoteDocuments.AsNoTracking().Select(d => d.ObjectKey).ToListAsync(cancellationToken)).ToHashSet(StringComparer.Ordinal);
        int kept = 0, removed = 0;
        await foreach (var item in _store.ListAsync(KeyPrefix, cancellationToken))
        {
            if (referenced.Contains(item.Key) || item.LastModified > cutoff)
            {
                kept++;
                continue;
            }

            await _store.DeleteAsync(item.Key, cancellationToken);
            removed++;
            _logger.LogWarning("Removed stored object {Key} ({Length} bytes, written {LastModified}): no quote document references it", item.Key, item.Length, item.LastModified);
        }

        return new QuoteDocumentOrphans(kept, removed);
    }
}

public sealed record QuoteDocumentOrphans(int Kept, int Removed);
