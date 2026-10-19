using System.Globalization;
using System.Text.Json;
using Crm.Billing.Contracts;

namespace Crm.Integrations.PowerOffice;

internal static class PowerOfficeInvoiceMapping
{
    public static ExternalInvoice Map(PoOutgoingInvoice source, IReadOnlyList<PoOutgoingInvoiceLine> received)
    {
        if (source.Id == Guid.Empty || source.InvoiceNo is not > 0 || source.VoucherDate is null || source.LastChangedDateTimeOffset is null ||
            source.TotalAmount is null || source.NetAmount is null || source.TotalPostedAmount is null || source.NetPostedAmount is null ||
            source.IsReversed is null || source.Balance is null || source.CurrencyCode is not { Length: 3 } || source.CustomerId is <= 0 || source.CurrencyCode.Any(c => !char.IsAsciiLetter(c)))
            throw new InvalidOperationException("PowerOffice invoice header is incomplete.");
        var kind = source.VoucherType switch
        {
            "OutgoingInvoice" => InvoiceDocumentKind.Invoice,
            "OutgoingCreditNote" => InvoiceDocumentKind.CreditNote,
            _ => throw new InvalidOperationException("PowerOffice invoice voucher type is unknown."),
        };
        var lines = new Dictionary<long, ExternalInvoiceLine>();
        foreach (var line in received)
        {
            if (line.Id <= 0 || line.SortOrder < 0) throw new InvalidOperationException("Invalid PowerOffice invoice line identity.");
            var mapped = new ExternalInvoiceLine(line.Id, line.SortOrder, line.LineType ?? "Unknown", line.Description,
                line.ProductId, line.ProductCode, line.UnitOfMeasureCode, line.Quantity, line.ProductUnitPrice, line.Allowance,
                line.VatRate, line.NetAmount, line.VatAmount, line.TotalAmount, line.NetPostedAmount, line.TotalPostedAmount,
                JsonSerializer.Serialize(line, PoJson.Options));
            if (lines.TryGetValue(line.Id, out var previous) && previous != mapped)
                throw new InvalidOperationException("Conflicting duplicate PowerOffice invoice line.");
            lines[line.Id] = mapped;
        }
        var ordered = lines.Values.OrderBy(l => l.SortOrder).ThenBy(l => l.Id).ToList();
        var amounts = ordered.Where(l => l.LineType is "Normal" or "InvoiceFee").ToList();
        var coverage = ordered.Count == 0 ? InvoiceLineCoverage.EmptyUnverified : InvoiceLineCoverage.RetrievedUnverified;
        if (amounts.Count > 0 && ordered.All(l => l.LineType is "Normal" or "InvoiceFee" or "Text" or "Summary" or "TotalHours") &&
            amounts.All(l => l.NetAmount is not null && l.VatAmount is not null && l.TotalAmount is not null && l.NetPostedAmount is not null && l.TotalPostedAmount is not null) &&
            Near(amounts.Sum(l => l.NetAmount!.Value), source.NetAmount.Value) &&
            Near(amounts.Sum(l => l.TotalAmount!.Value), source.TotalAmount.Value) &&
            Near(amounts.Sum(l => l.VatAmount!.Value), source.TotalAmount.Value - source.NetAmount.Value) &&
            Near(amounts.Sum(l => l.NetPostedAmount!.Value), source.NetPostedAmount.Value) &&
            Near(amounts.Sum(l => l.TotalPostedAmount!.Value), source.TotalPostedAmount.Value))
            coverage = InvoiceLineCoverage.Reconciled;
        var history = new ExternalInvoiceHistory(source.Id, source.CustomerId?.ToString(CultureInfo.InvariantCulture), kind,
            source.CurrencyCode.ToUpperInvariant(), source.NetAmount.Value, source.TotalAmount.Value, source.NetPostedAmount.Value,
            source.TotalPostedAmount.Value, source.Balance.Value, source.RelatedInvoiceNo?.ToString(CultureInfo.InvariantCulture), source.IsReversed.Value,
            source.LastChangedDateTimeOffset.Value, source.BalanceLastChangedDateTimeOffset, coverage, ordered,
            JsonSerializer.Serialize(source, PoJson.Options));
        // Balance is in client currency, not necessarily the currency printed on the invoice. Never mix it with TotalAmount.
        var total = source.TotalPostedAmount.Value;
        var outstanding = source.Balance.Value;
        var status = source.IsReversed.Value ? InvoiceStatus.Credited : outstanding == 0 ? InvoiceStatus.Paid
            : Math.Abs(outstanding) < Math.Abs(total) ? InvoiceStatus.PartiallyPaid : InvoiceStatus.Sent;
        return new ExternalInvoice(PowerOfficeTypes.System, source.InvoiceNo.Value.ToString(CultureInfo.InvariantCulture),
            source.OrderNo?.ToString(CultureInfo.InvariantCulture), source.ExternalImportReference, null, source.VoucherDate.Value,
            source.DueDate, total, outstanding, status, null) { History = history };
    }

    private static bool Near(decimal left, decimal right) => Math.Abs(left - right) <= 0.01m;
}
