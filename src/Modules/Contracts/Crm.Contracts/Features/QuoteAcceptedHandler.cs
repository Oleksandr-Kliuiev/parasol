using System.Globalization;
using Crm.Contracts.Contracts;
using Crm.Contracts.Domain;
using Crm.Contracts.Persistence;
using Crm.Sales.Contracts;
using Crm.SharedKernel.Domain;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace Crm.Contracts.Features;

/// <summary>
/// BR-SAL-07: an accepted quote becomes a draft contract with its monthly lines, at the prices the customer accepted. It
/// stays a draft on purpose — somebody reads it, fills in what a quote does not say (notice period, SLA) and activates it.
/// The handler is keyed by the quote, so a repeated event adds nothing.
/// </summary>
internal sealed class QuoteAcceptedHandler(
    ContractsDbContext db, ILogger<QuoteAcceptedHandler> logger) : IDomainEventHandler<QuoteAccepted>
{
    /// <summary>Notice period of the draft; the default of the standard agreement, changed by hand when it differs.</summary>
    private const int DefaultNoticeDays = 90;

    public async Task HandleAsync(QuoteAccepted domainEvent, CancellationToken cancellationToken)
    {
        var recurring = domainEvent.Lines.Where(l => l.Recurrence == QuoteLineRecurrence.Monthly).ToList();
        if (recurring.Count == 0)
        {
            return;
        }

        if (await db.Contracts.AnyAsync(c => c.SourceQuoteId == domainEvent.QuoteId, cancellationToken))
        {
            return;
        }

        var start = domainEvent.AcceptedOn;
        var withoutProduct = recurring.Count(l => l.ProductId is null);
        var notes = string.Create(CultureInfo.InvariantCulture, $"Drafted from quote {domainEvent.Number} v{domainEvent.VersionNo}.")
                    + (withoutProduct > 0
                        ? string.Create(CultureInfo.InvariantCulture, $" {withoutProduct} quote line(s) without a catalog product were not transferred.")
                        : string.Empty);

        var terms = new ContractTerms(
            domainEvent.Title,
            ContractType.Mixed,
            start,
            domainEvent.TermMonths > 0 ? start.AddMonths(domainEvent.TermMonths).AddDays(-1) : null,
            AutoRenew: true,
            RenewalTermMonths: domainEvent.TermMonths > 0 ? domainEvent.TermMonths : 12,
            NoticePeriodDays: DefaultNoticeDays,
            SlaPolicyId: null,
            InvoiceFrequency.Monthly,
            InvoiceTiming.InAdvance,
            PriceCategory: null,
            Indexation: false,
            NextIndexationDate: null,
            CustomerReference: null,
            domainEvent.OwnerId,
            notes);

        var created = Contract.Create(await db.NextContractNumberAsync(start.Year, cancellationToken), domainEvent.OrganizationId, terms);
        if (!created.IsSuccess)
        {
            logger.LogWarning("Quote {Number} could not be drafted as a contract: {Code}", domainEvent.Number, created.Error!.Code);
            return;
        }

        var contract = created.Value;
        contract.LinkToQuote(domainEvent.QuoteId);
        foreach (var line in recurring.Where(l => l.ProductId is not null))
        {
            contract.AddLine(new LineTerms(
                line.ProductId!.Value,
                string.IsNullOrWhiteSpace(line.Description) ? line.Name : line.Description,
                QuantityModel.Fixed,
                DeviceFilter.All,
                line.Quantity,
                line.UnitPrice,
                line.DiscountPct,
                start,
                null));
        }

        db.Contracts.Add(contract);
        await db.SaveChangesAsync(cancellationToken);
        logger.LogInformation("Quote {Number} accepted: draft contract {Contract} with {Lines} lines.", domainEvent.Number, contract.Number, contract.Lines.Count);
    }
}
