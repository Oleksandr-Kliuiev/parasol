using Crm.Sales.Domain;
using Crm.Sales.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace Crm.Sales.Features;

/// <summary>
/// Marks quotes whose validity date has passed (BR-SAL-04): they stay in the list as history, but they can no longer be
/// accepted without a new version. Runs every morning before the notification scan.
/// </summary>
public sealed class QuoteExpiryJob(SalesDbContext db, TimeProvider time, ILogger<QuoteExpiryJob> logger)
{
    public const string JobId = "quote-expiry";

    private static readonly TimeZoneInfo Oslo = TimeZoneInfo.FindSystemTimeZoneById("Europe/Oslo");

    public async Task<int> RunAsync(CancellationToken cancellationToken)
    {
        var today = DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(time.GetUtcNow(), Oslo).DateTime);
        var due = await db.Quotes.Where(q => q.Status == QuoteStatus.Sent && q.ValidUntil < today).ToListAsync(cancellationToken);
        var expired = due.Count(quote => quote.Expire(today));
        if (expired > 0)
        {
            await db.SaveChangesAsync(cancellationToken);
            logger.LogInformation("Quote expiry marked {Count} quotes as expired.", expired);
        }

        return expired;
    }
}
