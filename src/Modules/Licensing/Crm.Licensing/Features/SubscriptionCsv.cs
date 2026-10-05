using System.Globalization;
using Crm.Licensing.Contracts;
using Crm.SharedKernel.Text;

namespace Crm.Licensing.Features;

public sealed record CsvParseResult(IReadOnlyList<ExternalSubscription> Subscriptions, IReadOnlyList<string> Errors, IReadOnlyList<string> UnknownColumns);

/// <summary>
/// Reads a distributor subscription export (BR-LIC-05). Both semicolon and comma files are accepted, header names are matched loosely
/// (case, spaces and the Norwegian equivalents), and unknown columns are reported rather than rejected.
/// </summary>
public static class SubscriptionCsv
{
    private static readonly Dictionary<string, string> Aliases = new(StringComparer.OrdinalIgnoreCase)
    {
        ["customerid"] = "customerid",
        ["cspcustomerid"] = "customerid",
        ["kundeid"] = "customerid",
        ["customername"] = "customername",
        ["kundenavn"] = "customername",
        ["customer"] = "customername",
        ["kunde"] = "customername",
        ["organizationnumber"] = "orgnumber",
        ["orgnumber"] = "orgnumber",
        ["organisasjonsnummer"] = "orgnumber",
        ["orgnr"] = "orgnumber",
        ["tenantid"] = "tenantid",
        ["subscriptionid"] = "subscriptionid",
        ["abonnementsid"] = "subscriptionid",
        ["offerid"] = "offerid",
        ["productid"] = "offerid",
        ["produktid"] = "offerid",
        ["offername"] = "offername",
        ["productname"] = "offername",
        ["produktnavn"] = "offername",
        ["sku"] = "sku",
        ["skuid"] = "sku",
        ["quantity"] = "quantity",
        ["antall"] = "quantity",
        ["licenses"] = "quantity",
        ["status"] = "status",
        ["term"] = "term",
        ["termduration"] = "term",
        ["bindingstid"] = "term",
        ["billingcycle"] = "billingcycle",
        ["faktureringsperiode"] = "billingcycle",
        ["startdate"] = "startdate",
        ["startdato"] = "startdate",
        ["enddate"] = "enddate",
        ["commitmentenddate"] = "enddate",
        ["sluttdato"] = "enddate",
        ["renewaldate"] = "renewaldate",
        ["fornyelsesdato"] = "renewaldate",
        ["autorenew"] = "autorenew",
        ["autofornyelse"] = "autorenew",
        ["purchasedate"] = "purchasedate",
        ["purchasedat"] = "purchasedate",
        ["kjøpsdato"] = "purchasedate",
        ["partnerprice"] = "partnerprice",
        ["partnerunitprice"] = "partnerprice",
        ["partnerpris"] = "partnerprice",
        ["unitprice"] = "partnerprice",
    };

    public static CsvParseResult Parse(string content)
    {
        var table = CsvTable.Parse(content, Aliases);
        if (table is null)
        {
            return new CsvParseResult([], ["The file has no data rows."], []);
        }

        var errors = new List<string>();
        foreach (var required in new[] { "customerid", "subscriptionid", "offerid", "quantity" })
        {
            if (!table.Has(required))
            {
                errors.Add($"The column '{required}' is missing.");
            }
        }

        if (errors.Count > 0)
        {
            return new CsvParseResult([], errors, table.UnknownColumns);
        }

        var subscriptions = new List<ExternalSubscription>();
        for (var row = 0; row < table.RowCount; row++)
        {
            string? Value(string column) => table.Value(row, column);

            var subscriptionId = Value("subscriptionid");
            var customerId = Value("customerid");
            var offerId = Value("offerid");
            if (subscriptionId is null || customerId is null || offerId is null)
            {
                errors.Add($"Row {table.Line(row)}: customer, subscription or offer is missing.");
                continue;
            }

            if (!int.TryParse(Value("quantity"), CultureInfo.InvariantCulture, out var quantity) || quantity < 0)
            {
                errors.Add($"Row {table.Line(row)}: quantity '{Value("quantity")}' is not a whole number.");
                continue;
            }

            subscriptions.Add(new ExternalSubscription(
                SubscriptionSource.Distributor,
                customerId,
                Value("customername"),
                Value("tenantid"),
                Digits(Value("orgnumber")),
                subscriptionId,
                offerId,
                Value("offername"),
                Value("sku"),
                quantity,
                ParseStatus(Value("status")),
                ParseTerm(Value("term")),
                ParseCycle(Value("billingcycle")),
                CsvTable.Date(Value("startdate")),
                CsvTable.Date(Value("enddate")),
                CsvTable.Date(Value("renewaldate")),
                ParseBool(Value("autorenew")),
                CsvTable.Date(Value("purchasedate")) is { } purchased ? new DateTimeOffset(purchased.ToDateTime(TimeOnly.MinValue), TimeSpan.Zero) : null,
                CsvTable.Decimal(Value("partnerprice"))));
        }

        return new CsvParseResult(subscriptions, errors, table.UnknownColumns);
    }

    private static string? Digits(string? value)
    {
        var digits = new string((value ?? string.Empty).Where(char.IsAsciiDigit).ToArray());
        return digits.Length == 9 ? digits : null;
    }

    private static SubscriptionStatus ParseStatus(string? value) => value?.ToLowerInvariant() switch
    {
        "suspended" or "suspendert" => SubscriptionStatus.Suspended,
        "deleted" or "cancelled" or "canceled" or "slettet" => SubscriptionStatus.Deleted,
        "pending" or "venter" => SubscriptionStatus.Pending,
        _ => SubscriptionStatus.Active,
    };

    private static SubscriptionTerm ParseTerm(string? value) => value?.ToUpperInvariant().Replace(" ", string.Empty, StringComparison.Ordinal) switch
    {
        "P1M" or "MONTHLY" or "1MONTH" or "MÅNED" => SubscriptionTerm.P1M,
        "P1Y" or "ANNUAL" or "YEARLY" or "1YEAR" or "ÅR" => SubscriptionTerm.P1Y,
        "P3Y" or "3YEARS" or "TRIENNIAL" => SubscriptionTerm.P3Y,
        _ => SubscriptionTerm.Unknown,
    };

    private static SubscriptionBillingCycle ParseCycle(string? value) => value?.ToLowerInvariant() switch
    {
        "monthly" or "month" or "månedlig" => SubscriptionBillingCycle.Monthly,
        "annual" or "yearly" or "year" or "årlig" => SubscriptionBillingCycle.Annual,
        _ => SubscriptionBillingCycle.Unknown,
    };

    private static bool ParseBool(string? value) =>
        value?.ToLowerInvariant() is "true" or "yes" or "ja" or "1" or "y";
}
