using System.Globalization;
using Crm.Sales.Domain;
using Crm.Sales.Persistence;
using Crm.SharedKernel.Documents;
using Crm.SharedKernel.Operations;
using Microsoft.EntityFrameworkCore;

namespace Crm.Sales.Features;

/// <summary>
/// Sales' part in a restore (DEV-13): quote documents against the document store — a document the copy calls ready must still
/// have its object — and quote e-mails the journal shows sent after the restore point, which the copy no longer records. A quote
/// is only ever sent by a person, so nothing is changed: the report tells the salesperson which customers already have which
/// quote before anyone sends it again.
/// </summary>
internal sealed class SalesRestoreParticipant(SalesDbContext db, IDocumentStore store) : IRestoreParticipant
{
    public string Area => "sales";

    public Task<int> InFlightAsync(CancellationToken cancellationToken) => Task.FromResult(0);

    public async Task<IReadOnlyList<RestoreLine>> CheckAsync(DateTimeOffset restorePoint, CancellationToken cancellationToken)
    {
        var stored = new Dictionary<string, DateTimeOffset>(StringComparer.Ordinal);
        await foreach (var item in store.ListAsync(QuoteDocumentJob.KeyPrefix, cancellationToken))
        {
            stored[item.Key] = item.LastModified;
        }

        var documents = await db.QuoteDocuments.AsNoTracking()
            .Where(d => d.Status == QuoteDocumentStatus.Ready && d.ErasedAt == null)
            .Select(d => new { d.Id, d.ObjectKey })
            .ToListAsync(cancellationToken);
        var known = documents.Select(d => d.ObjectKey).ToHashSet(StringComparer.Ordinal);
        var missing = documents.Where(d => !stored.ContainsKey(d.ObjectKey)).ToList();
        var newer = stored.Count(s => !known.Contains(s.Key) && s.Value >= restorePoint);
        var lines = new List<RestoreLine>
        {
            missing.Count == 0
                ? new RestoreLine(Area, "quote documents", string.Create(CultureInfo.InvariantCulture, $"All {documents.Count} ready documents have their stored object."), null, false)
                : new RestoreLine(Area, "quote documents", string.Create(CultureInfo.InvariantCulture,
                        $"{missing.Count} ready document(s) have no stored object (first: {missing[0].Id})."),
                    "Restore the documents container to match, or the downloads and e-mails of those quotes fail (runbook 10).", true),
        };
        if (newer > 0)
        {
            lines.Add(new RestoreLine(Area, "quote documents", string.Create(CultureInfo.InvariantCulture,
                    $"{newer} stored document(s) from after the restore point belong to no record of the copy."),
                "They are orphans now; the orphan cleanup (paused during maintenance) removes them seven days after it resumes.", false));
        }

        return lines;
    }

    public async Task<IReadOnlyList<RestoreLine>> ReconcileAsync(
        DateTimeOffset restorePoint, IReadOnlyList<ExternalEffectEntry> effects, bool apply, CancellationToken cancellationToken)
    {
        var lines = new List<RestoreLine>();
        foreach (var mail in effects.Where(e => e.Kind == QuoteService.MailEffect && e.EntityType == "Quote").GroupBy(e => e.EntityId))
        {
            if (!ExternalEffects.MayExist(mail))
            {
                continue;
            }

            var quote = await db.Quotes.AsNoTracking().Where(q => q.Id == mail.Key).Select(q => new { q.Number, q.VersionNo, q.SentAt }).SingleOrDefaultAsync(cancellationToken);
            var at = mail.Max(e => e.At).ToString("yyyy-MM-dd HH:mm 'UTC'", CultureInfo.InvariantCulture);
            if (quote is null)
            {
                lines.Add(new RestoreLine(Area, $"quote {mail.Key}", $"A quote e-mail went out at {at} for a quote the restored copy does not have.",
                    "The salesperson recreates the quote and tells the customer which one counts.", true));
            }
            else if (quote.SentAt is null || quote.SentAt < mail.Min(e => e.At).AddMinutes(-1))
            {
                lines.Add(new RestoreLine(Area, $"quote {quote.Number} v{quote.VersionNo}", $"The customer received this quote by e-mail at {at}; the restored copy does not record it.",
                    "Check the salesperson's sent items before sending it again.", true));
            }
        }

        return lines;
    }
}
