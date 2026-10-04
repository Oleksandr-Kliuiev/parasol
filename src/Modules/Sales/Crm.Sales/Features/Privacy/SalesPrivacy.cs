using System.Globalization;
using Crm.Privacy.Contracts;
using Crm.Sales.Contracts;
using Crm.Sales.Domain;
using Crm.Sales.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crm.Sales.Features.Privacy;

internal static class SalesPrivacy
{
    public const string Module = SalesDbContext.SchemaName;
    public const string LeadClass = "sales.lead";
    public const string RecipientClass = "sales.quote-recipient";
    public const string DocumentClass = "sales.quote-document";
    public const string AcceptedQuoteClass = "sales.accepted-quote";

    public static RecordRef LeadRecord(Guid id) => new(Module, nameof(Lead), id);

    public static RecordRef QuoteRecord(Guid id) => new(Module, nameof(Quote), id);

    public static RecordRef DocumentRecord(Guid id) => new(Module, nameof(QuoteDocument), id);

    /// <summary>
    /// Bokføringsloven §13: documentation is kept five years after the end of its financial year — for an accepted quote, the
    /// year it was accepted (the year it was issued when the decision date is missing).
    /// </summary>
    public static DateOnly BookkeepingUntil(Quote quote) => new((quote.DecidedOn ?? quote.IssuedOn).Year + 5, 12, 31);

    public static string Format(DateTimeOffset value) => value.ToString("O", CultureInfo.InvariantCulture);
}

/// <summary>Who a lead is, for a privacy case (DEV-11): the prospect's address and number as the lead holds them.</summary>
internal sealed class LeadSubjectResolver(SalesDbContext db) : IDataSubjectResolver
{
    public DataSubjectKind Kind => DataSubjectKind.Lead;

    public async Task<DataSubject?> ResolveAsync(Guid id, CancellationToken cancellationToken)
    {
        if (await db.Leads.IgnoreQueryFilters().AsNoTracking().SingleOrDefaultAsync(l => l.Id == id, cancellationToken) is not { } lead)
        {
            return null;
        }

        return new DataSubject(
            DataSubjectKind.Lead, lead.Id, SalesPrivacy.LeadRecord(lead.Id),
            lead.Email is { } email ? [email] : [], lead.Phone is { } phone ? [phone] : [], [], []);
    }
}

/// <summary>
/// The sales module's part in subject requests (DEV-11). A lead is erased outright. For a contact: a quote that was not
/// accepted forgets who it went to, and its stored documents — which print the person's name and address — are hidden at
/// once and cleared by the privacy operator's procedure; an accepted quote and its documents are bookkeeping documentation
/// and are kept until five years after their financial year. Deals only point at the contact, whose row is pseudonymized.
/// </summary>
internal sealed class SalesPersonalData(SalesDbContext db) : IPersonalDataContributor
{
    public string Module => SalesPrivacy.Module;

    public async Task<PersonalDataSection> ExportAsync(DataSubject subject, CancellationToken cancellationToken)
    {
        if (subject.Kind == DataSubjectKind.Lead)
        {
            var lead = await db.Leads.IgnoreQueryFilters().AsNoTracking().SingleOrDefaultAsync(l => l.Id == subject.Id, cancellationToken);
            return new PersonalDataSection(Module, lead is null ? [] :
            [
                new PersonalDataItem("lead", lead.Id, new Dictionary<string, string?>
                {
                    ["company"] = lead.CompanyName,
                    ["contactName"] = lead.ContactName,
                    ["email"] = lead.Email,
                    ["phone"] = lead.Phone,
                    ["source"] = lead.Source,
                    ["notes"] = lead.Notes,
                    ["status"] = lead.Status.ToString(),
                    ["disqualifyReason"] = lead.DisqualifyReason,
                    ["createdAt"] = SalesPrivacy.Format(lead.CreatedAt),
                    ["closedAt"] = lead.ClosedAt is { } closed ? SalesPrivacy.Format(closed) : null,
                }),
            ], []);
        }

        var deals = await db.Opportunities.IgnoreQueryFilters().AsNoTracking().Where(o => o.ContactId == subject.Id).OrderBy(o => o.CreatedAt).ToListAsync(cancellationToken);
        var quotes = await db.Quotes.IgnoreQueryFilters().AsNoTracking().Where(q => q.ContactId == subject.Id)
            .OrderBy(q => q.Number).ThenBy(q => q.VersionNo).ToListAsync(cancellationToken);
        var quoteIds = quotes.Select(q => q.Id).ToList();
        var documents = await db.QuoteDocuments.AsNoTracking().Where(d => quoteIds.Contains(d.QuoteId))
            .GroupBy(d => d.QuoteId).Select(g => new { QuoteId = g.Key, Count = g.Count() }).ToDictionaryAsync(g => g.QuoteId, g => g.Count, cancellationToken);
        var items = deals.Select(o => new PersonalDataItem("deal", o.Id, new Dictionary<string, string?>
        {
            ["name"] = o.Name,
            ["status"] = o.Status.ToString(),
            ["createdAt"] = SalesPrivacy.Format(o.CreatedAt),
        })).ToList();
        items.AddRange(quotes.Select(q => new PersonalDataItem("quote", q.Id, new Dictionary<string, string?>
        {
            ["number"] = q.Number,
            ["version"] = q.VersionNo.ToString(CultureInfo.InvariantCulture),
            ["title"] = q.Title,
            ["status"] = q.Status.ToString(),
            ["issuedOn"] = q.IssuedOn.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
            ["sentAt"] = q.SentAt is { } sent ? SalesPrivacy.Format(sent) : null,
            ["sentTo"] = q.SentTo,
            ["customerReference"] = q.CustomerReference,
            ["storedDocuments"] = documents.GetValueOrDefault(q.Id).ToString(CultureInfo.InvariantCulture),
        })));
        return new PersonalDataSection(Module, items,
        [
            "The PDF of each quote sent to the person can be handed over on request; the export lists the stored documents.",
            "Free text in deals and quotes (names, intro and terms wording) is not searched for the person.",
        ]);
    }

    public async Task<IReadOnlyList<PlannedErasure>> PlanAsync(DataSubject subject, CancellationToken cancellationToken)
    {
        if (subject.Kind == DataSubjectKind.Lead)
        {
            return await db.Leads.IgnoreQueryFilters().AnyAsync(l => l.Id == subject.Id, cancellationToken)
                ? [new PlannedErasure(SalesPrivacy.LeadRecord(subject.Id), ErasureAction.Pseudonymize, SalesPrivacy.LeadClass)]
                : [];
        }

        var plan = new List<PlannedErasure>();
        var quotes = await db.Quotes.IgnoreQueryFilters().AsNoTracking().Where(q => q.ContactId == subject.Id).ToListAsync(cancellationToken);
        var quoteIds = quotes.Select(q => q.Id).ToList();
        var documents = await db.QuoteDocuments.AsNoTracking().Where(d => quoteIds.Contains(d.QuoteId) && d.ErasedAt == null)
            .Select(d => new { d.Id, d.QuoteId }).ToListAsync(cancellationToken);
        foreach (var quote in quotes)
        {
            if (quote.Status == QuoteStatus.Accepted)
            {
                var until = SalesPrivacy.BookkeepingUntil(quote);
                plan.Add(new PlannedErasure(SalesPrivacy.QuoteRecord(quote.Id), ErasureAction.Retain, SalesPrivacy.AcceptedQuoteClass, RetentionBasis.Bookkeeping, until));
                plan.AddRange(documents.Where(d => d.QuoteId == quote.Id).Select(d =>
                    new PlannedErasure(SalesPrivacy.DocumentRecord(d.Id), ErasureAction.Retain, SalesPrivacy.DocumentClass, RetentionBasis.Bookkeeping, until)));
                continue;
            }

            if (quote.SentTo is not null || quote.CustomerReference is not null)
            {
                plan.Add(new PlannedErasure(SalesPrivacy.QuoteRecord(quote.Id), ErasureAction.Pseudonymize, SalesPrivacy.RecipientClass));
            }

            plan.AddRange(documents.Where(d => d.QuoteId == quote.Id).Select(d =>
                new PlannedErasure(SalesPrivacy.DocumentRecord(d.Id), ErasureAction.OperatorErasure, SalesPrivacy.DocumentClass)));
        }

        return plan;
    }

    public async Task<IReadOnlyList<ErasedRecord>> EraseAsync(
        DataSubject subject, IReadOnlyList<PlannedErasure> plan, string reference, CancellationToken cancellationToken)
    {
        var erased = new List<ErasedRecord>();
        foreach (var item in plan.Where(p => p.Action != ErasureAction.Retain))
        {
            await ApplyAsync(item.Record, reference, cancellationToken);
            erased.Add(new ErasedRecord(item.Record, item.Action, item.DataClass));
        }

        await db.SaveChangesAsync(cancellationToken);
        return erased;
    }

    public async Task<int> ReapplyAsync(IReadOnlyList<ErasedRecord> records, string reference, CancellationToken cancellationToken)
    {
        var applied = 0;
        foreach (var record in records.Where(r => r.Action != ErasureAction.Retain))
        {
            applied += await ApplyAsync(record.Record, reference, cancellationToken) ? 1 : 0;
        }

        await db.SaveChangesAsync(cancellationToken);
        return applied;
    }

    private async Task<bool> ApplyAsync(RecordRef record, string reference, CancellationToken ct) => record.EntityType switch
    {
        nameof(Lead) => await db.Leads.IgnoreQueryFilters().SingleOrDefaultAsync(l => l.Id == record.EntityId, ct) is { } lead && lead.Pseudonymize(reference),
        nameof(Quote) => await db.Quotes.IgnoreQueryFilters().SingleOrDefaultAsync(q => q.Id == record.EntityId, ct) is { } quote && quote.ForgetRecipient(reference),
        // A stored document is cleared by the privacy operator's procedure; being on the manifest already hides it.
        _ => false,
    };
}

/// <summary>Leads never converted (docs/04 §8): erased once untouched for the approved period, like a privacy case does.</summary>
internal sealed class UnconvertedLeadsRetention(SalesDbContext db) : IRetentionContributor
{
    public const string Class = "sales.unconverted-leads";

    public string DataClass => Class;

    public Task<int> CountAsync(DateTimeOffset olderThan, CancellationToken cancellationToken) => Due(olderThan).CountAsync(cancellationToken);

    public async Task<int> ApplyAsync(DateTimeOffset olderThan, int batchSize, CancellationToken cancellationToken)
    {
        var leads = await Due(olderThan).OrderBy(l => l.Id).Take(batchSize).ToListAsync(cancellationToken);
        foreach (var lead in leads)
        {
            lead.Pseudonymize($"retention:{Class}");
        }

        await db.SaveChangesAsync(cancellationToken);
        return leads.Count;
    }

    private IQueryable<Lead> Due(DateTimeOffset olderThan) =>
        db.Leads.Where(l => l.Status != LeadStatus.Converted && (l.ModifiedAt ?? l.CreatedAt) < olderThan);
}
