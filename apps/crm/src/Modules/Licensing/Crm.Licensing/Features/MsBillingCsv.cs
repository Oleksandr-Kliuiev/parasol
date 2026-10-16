using Crm.Licensing.Contracts;
using Crm.SharedKernel.Text;

namespace Crm.Licensing.Features;

public sealed record MsBillingParseResult(
    IReadOnlyList<ExternalBilledLine> Lines, IReadOnlyList<string> Errors, IReadOnlyList<string> UnknownColumns);

/// <summary>
/// Reads what Microsoft or the distributor charged the partner (FR-LIC-04). The indirect model gets an invoice file from
/// the distributor, the direct model the reconciliation export — both end up as the same lines.
/// </summary>
public static class MsBillingCsv
{
    private static readonly Dictionary<string, string> Aliases = new(StringComparer.OrdinalIgnoreCase)
    {
        ["customerid"] = "customerid",
        ["cspcustomerid"] = "customerid",
        ["kundeid"] = "customerid",
        ["customername"] = "customername",
        ["kundenavn"] = "customername",
        ["kunde"] = "customername",
        ["subscriptionid"] = "subscriptionid",
        ["entitlementid"] = "subscriptionid",
        ["abonnementsid"] = "subscriptionid",
        ["offerid"] = "offerid",
        ["productid"] = "offerid",
        ["produktid"] = "offerid",
        ["skuid"] = "offerid",
        ["offername"] = "offername",
        ["productname"] = "offername",
        ["skuname"] = "offername",
        ["produktnavn"] = "offername",
        ["quantity"] = "quantity",
        ["unitcount"] = "quantity",
        ["antall"] = "quantity",
        ["unitprice"] = "unitprice",
        ["effectiveunitprice"] = "unitprice",
        ["enhetspris"] = "unitprice",
        ["total"] = "total",
        ["totalforcustomer"] = "total",
        ["subtotal"] = "total",
        ["beløp"] = "total",
        ["belop"] = "total",
        ["sum"] = "total",
        ["currency"] = "currency",
        ["billingcurrency"] = "currency",
        ["valuta"] = "currency",
        ["invoiceid"] = "invoiceid",
        ["invoicenumber"] = "invoiceid",
        ["fakturanummer"] = "invoiceid",
        ["chargestartdate"] = "periodstart",
        ["billingperiodstartdate"] = "periodstart",
        ["periodstart"] = "periodstart",
        ["fraogmed"] = "periodstart",
        ["chargeenddate"] = "periodend",
        ["billingperiodenddate"] = "periodend",
        ["periodend"] = "periodend",
        ["tilogmed"] = "periodend",
    };

    public static MsBillingParseResult Parse(string content, DateOnly fallbackPeriodStart)
    {
        var table = CsvTable.Parse(content, Aliases);
        if (table is null)
        {
            return new MsBillingParseResult([], ["The file has no header row and no lines."], []);
        }

        if (table.RowCount > CsvTable.MaxImportRows)
        {
            return new MsBillingParseResult([], [$"The file has more than {CsvTable.MaxImportRows} rows; split it."], table.UnknownColumns);
        }

        var errors = new List<string>();
        foreach (var required in new[] { "customerid", "offerid", "total" })
        {
            if (!table.Has(required))
            {
                errors.Add($"The column '{required}' is missing.");
            }
        }

        if (errors.Count > 0)
        {
            return new MsBillingParseResult([], errors, table.UnknownColumns);
        }

        var lines = new List<ExternalBilledLine>();
        for (var row = 0; row < table.RowCount; row++)
        {
            var customerId = table.Value(row, "customerid");
            var offerId = table.Value(row, "offerid");
            if (customerId is null || offerId is null)
            {
                errors.Add($"Row {table.Line(row)}: customer or offer is missing.");
                continue;
            }

            if (CsvTable.Decimal(table.Value(row, "total")) is not { } total)
            {
                errors.Add($"Row {table.Line(row)}: the amount '{table.Value(row, "total")}' is not a number.");
                continue;
            }

            var periodStart = CsvTable.Date(table.Value(row, "periodstart")) ?? fallbackPeriodStart;
            var periodEnd = CsvTable.Date(table.Value(row, "periodend")) ?? periodStart.AddMonths(1).AddDays(-1);
            var quantity = CsvTable.Decimal(table.Value(row, "quantity")) ?? 0m;
            var unitPrice = CsvTable.Decimal(table.Value(row, "unitprice")) ?? (quantity == 0 ? 0m : decimal.Round(total / quantity, 4));
            lines.Add(new ExternalBilledLine(
                MsBillingSource.Csv,
                periodStart,
                periodEnd,
                table.Value(row, "invoiceid"),
                customerId,
                table.Value(row, "customername"),
                table.Value(row, "subscriptionid"),
                offerId,
                table.Value(row, "offername"),
                quantity,
                unitPrice,
                total,
                table.Value(row, "currency") ?? "NOK"));
        }

        return new MsBillingParseResult(lines, errors, table.UnknownColumns);
    }
}
