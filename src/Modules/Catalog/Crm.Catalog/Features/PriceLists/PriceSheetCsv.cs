using Crm.Catalog.Contracts;
using Crm.SharedKernel.Text;

namespace Crm.Catalog.Features.PriceLists;

/// <summary>One priced SKU as Microsoft's NCE price list writes it (FR-CAT-03).</summary>
public sealed record PriceSheetRow(string OfferId, string? OfferName, decimal PartnerPrice, string Currency, CommitmentTerm Term, string? BillingPlan);

public sealed record PriceSheetParseResult(IReadOnlyList<PriceSheetRow> Rows, IReadOnlyList<string> Errors, IReadOnlyList<string> UnknownColumns);

/// <summary>
/// Reads the Microsoft NCE price list (or a distributor's version of it). The sheet has one row per SKU and term, and the
/// offer is identified as <c>ProductId:SkuId</c> — which is what a product's Microsoft offer id holds in the CRM.
/// </summary>
public static class PriceSheetCsv
{
    private static readonly Dictionary<string, string> Aliases = new(StringComparer.OrdinalIgnoreCase)
    {
        ["productid"] = "productid",
        ["produktid"] = "productid",
        ["skuid"] = "skuid",
        ["offerid"] = "offerid",
        ["producttitle"] = "producttitle",
        ["skutitle"] = "skutitle",
        ["offername"] = "skutitle",
        ["productname"] = "producttitle",
        ["unitprice"] = "unitprice",
        ["erpprice"] = "unitprice",
        ["partnerprice"] = "unitprice",
        ["pris"] = "unitprice",
        ["currency"] = "currency",
        ["currencycode"] = "currency",
        ["valuta"] = "currency",
        ["termduration"] = "term",
        ["term"] = "term",
        ["billingplan"] = "billingplan",
        ["segment"] = "segment",
        ["market"] = "market",
        ["unitofmeasure"] = "uom",
        ["uom"] = "uom",
        ["effectivestartdate"] = "validfrom",
        ["effectiveenddate"] = "validto",
        ["tagsandattributes"] = "tags",
        ["pricingtierrangemin"] = "tiermin",
        ["pricingtierrangemax"] = "tiermax",
    };

    public static PriceSheetParseResult Parse(string content)
    {
        var table = CsvTable.Parse(content, Aliases);
        if (table is null)
        {
            return new PriceSheetParseResult([], ["The file has no header row and no lines."], []);
        }

        if (!table.Has("unitprice") || (!table.Has("offerid") && !table.Has("productid")))
        {
            return new PriceSheetParseResult(
                [], ["The price sheet needs a price column and either an offer id or a product id."], table.UnknownColumns);
        }

        var errors = new List<string>();
        var rows = new List<PriceSheetRow>();
        for (var row = 0; row < table.RowCount; row++)
        {
            var offerId = table.Value(row, "offerid") ?? Compose(table.Value(row, "productid"), table.Value(row, "skuid"));
            if (offerId is null)
            {
                continue;
            }

            if (CsvTable.Decimal(table.Value(row, "unitprice")) is not { } price)
            {
                if (errors.Count < 20)
                {
                    errors.Add($"Row {table.Line(row)}: the price '{table.Value(row, "unitprice")}' is not a number.");
                }

                continue;
            }

            var names = new[] { table.Value(row, "producttitle"), table.Value(row, "skutitle") }.Where(n => n is not null).ToList();
            rows.Add(new PriceSheetRow(
                offerId,
                names.Count > 0 ? string.Join(" — ", names) : null,
                price,
                table.Value(row, "currency") ?? "NOK",
                Term(table.Value(row, "term")),
                table.Value(row, "billingplan")));
        }

        return new PriceSheetParseResult(rows, errors, table.UnknownColumns);
    }

    private static string? Compose(string? productId, string? skuId) => productId is null
        ? null
        : skuId is null ? productId : $"{productId}:{skuId}";

    private static CommitmentTerm Term(string? value) => value?.Trim().ToUpperInvariant() switch
    {
        "P1M" or "1 MONTH" or "MONTHLY" => CommitmentTerm.P1M,
        "P1Y" or "1 YEAR" or "ANNUAL" or "YEARLY" => CommitmentTerm.P1Y,
        "P3Y" or "3 YEARS" => CommitmentTerm.P3Y,
        _ => CommitmentTerm.None,
    };
}
