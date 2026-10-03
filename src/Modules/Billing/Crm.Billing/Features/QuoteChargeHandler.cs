using System.Globalization;
using Crm.Billing.Domain;
using Crm.Billing.Persistence;
using Crm.Sales.Contracts;
using Crm.SharedKernel.Domain;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace Crm.Billing.Features;

/// <summary>
/// BR-SAL-07: the one-time lines of an accepted quote (implementation, hardware, an hour package) wait for the next
/// billing run. Keyed by the quote line, so a repeated event queues nothing twice.
/// </summary>
internal sealed class QuoteAcceptedChargeHandler(
    BillingDbContext db, ILogger<QuoteAcceptedChargeHandler> logger) : IDomainEventHandler<QuoteAccepted>
{
    public const string SourceType = "quote";

    public async Task HandleAsync(QuoteAccepted domainEvent, CancellationToken cancellationToken)
    {
        var oneTime = domainEvent.Lines.Where(l => l.Recurrence == QuoteLineRecurrence.OneTime).ToList();
        if (oneTime.Count == 0)
        {
            return;
        }

        var existing = await db.PendingCharges
            .Where(c => c.SourceType == SourceType && c.SourceId == domainEvent.QuoteId)
            .Select(c => c.SourceLineId)
            .ToListAsync(cancellationToken);

        var added = 0;
        foreach (var line in oneTime.Where(l => !existing.Contains(l.LineId)))
        {
            db.PendingCharges.Add(PendingCharge.Create(
                domainEvent.OrganizationId,
                line.ProductId,
                string.Create(CultureInfo.InvariantCulture, $"{line.Name} ({domainEvent.Number})"),
                line.Quantity,
                line.UnitPrice,
                line.DiscountPct,
                line.VatRate,
                SourceType,
                domainEvent.QuoteId,
                line.LineId,
                domainEvent.AcceptedOn));
            added++;
        }

        if (added == 0)
        {
            return;
        }

        await db.SaveChangesAsync(cancellationToken);
        logger.LogInformation("Quote {Number} accepted: {Count} one-time items queued for the next billing run.", domainEvent.Number, added);
    }
}
