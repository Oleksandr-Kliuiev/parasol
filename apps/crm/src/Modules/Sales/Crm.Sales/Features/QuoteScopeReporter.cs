using Crm.Authorization;
using Crm.Sales.Persistence;
using Crm.SharedKernel.Application;
using Microsoft.EntityFrameworkCore;

namespace Crm.Sales.Features;

/// <summary>Quotes per owner of their current version — the rule <c>QuoteService</c> applies (DEV-09).</summary>
internal sealed class QuoteScopeReporter(SalesDbContext db) : IRecordScopeReporter
{
    public string Kind => "quotes";

    public string ReadPermission => Permissions.SalesRead;

    public string EveryRecordPermission => Permissions.QuotesAll;

    public async Task<RecordScopeCounts> CountAsync(CancellationToken cancellationToken)
    {
        var owners = await db.Quotes.AsNoTracking()
            .Where(q => !db.Quotes.Any(v => v.RootId == q.RootId && v.VersionNo > q.VersionNo))
            .GroupBy(q => q.OwnerId)
            .Select(g => new { Owner = g.Key, Quotes = g.Count() })
            .ToListAsync(cancellationToken);
        return new RecordScopeCounts(
            owners.Sum(o => o.Quotes),
            owners.Where(o => o.Owner is null).Sum(o => o.Quotes),
            owners.Where(o => o.Owner is not null).ToDictionary(o => o.Owner!.Value, o => o.Quotes));
    }
}
