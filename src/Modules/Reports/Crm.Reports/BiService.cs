using System.Globalization;
using System.Text;
using Crm.Billing.Contracts;
using Crm.Contracts.Contracts;
using Crm.Customers.Contracts;
using Crm.Licensing.Contracts;
using Crm.SharedKernel.Results;
using Crm.TimeTracking.Contracts;
using Microsoft.Extensions.Options;

namespace Crm.Reports;

/// <summary>A column of a BI dataset: a stable name and one of <c>guid, string, int, decimal, date, bool</c>.</summary>
public sealed record BiColumn(string Name, string Type);

/// <summary>
/// One dataset of the BI read API (DEV-14). <paramref name="KeyColumns"/> leading columns identify a row and give the order
/// pages are read in. <paramref name="Snapshot"/> datasets are also kept per closed month (<see cref="BiSnapshotService"/>).
/// </summary>
public sealed record BiDataset(string Name, string Definition, bool RequiresCost, bool Snapshot, int KeyColumns, IReadOnlyList<BiColumn> Columns);

/// <summary>A dataset as read at <see cref="AsOf"/>: the whole table of the period, rows ordered by their key.</summary>
public sealed record BiTable(
    string SchemaVersion, string Dataset, DateTimeOffset AsOf, DateOnly From, DateOnly To,
    IReadOnlyList<BiColumn> Columns, IReadOnlyList<IReadOnlyList<object?>> Rows);

/// <summary>One page of a dataset. <see cref="Watermark"/> is set on the last page only: the <c>asOf</c> the refresh began at.</summary>
public sealed record BiPage(
    string SchemaVersion, string Dataset, DateTimeOffset AsOf, DateOnly From, DateOnly To, IReadOnlyList<BiColumn> Columns,
    IReadOnlyList<IReadOnlyList<object?>> Rows, string? NextCursor, DateTimeOffset? Watermark,
    string? Provenance = null, int? Revision = null, string? Sha256 = null);

/// <summary>
/// The BI read API's data (DEV-14, ADR-022): every dataset is composed from the owning modules' contracts, typed, ordered by a
/// key and stamped with <c>asOf</c>. The definitions in <see cref="Glossary"/> say what each number is; in particular the CRM
/// knows what was billed and what the accounting system says is still unpaid, never what was paid.
/// </summary>
internal sealed class BiService(
    ICustomersApi customers,
    IBillingApi billing,
    ILicensingApi licensing,
    ITimeTrackingApi timeTracking,
    IContractsApi contracts,
    MarginService margins,
    TimeProvider time,
    IOptions<ReportsOptions> options)
{
    public const string SchemaVersion = "1";

    private static BiColumn C(string name, string type) => new(name, type);

    public static readonly IReadOnlyList<BiDataset> Datasets =
    [
        new("organizations", "Every organization of the CRM (status as of asOf). Not a period dataset.", false, false, 1,
            [C("organizationId", "guid"), C("name", "string"), C("orgNumber", "string"), C("status", "string")]),
        new("revenue-by-month",
            "Billing per month of the billed period, NOK ex VAT. approvedExVat: content of approved bases (frozen at approval, whatever became of the export). " +
            "pendingExVat: what collected bases not yet approved would bill. Cancelled bases and information lines count nowhere. Not an accounting figure.",
            false, true, 2, [C("year", "int"), C("month", "int"), C("approvedExVat", "decimal"), C("pendingExVat", "decimal")]),
        new("revenue-by-customer",
            "Approved billing per customer in the period, NOK ex VAT, split by line group; draft (not yet approved) bases are left out.",
            false, true, 1,
            [C("organizationId", "guid"), C("name", "string"), C("total", "decimal"), C("licenses", "decimal"), C("subscriptions", "decimal"),
             C("hours", "decimal"), C("oneOff", "decimal")]),
        new("hours-by-customer", "Approved hours per customer in the period; billedHours of them were invoiced; amount is NOK ex VAT.", false, true, 1,
            [C("organizationId", "guid"), C("name", "string"), C("hours", "decimal"), C("billedHours", "decimal"), C("amount", "decimal")]),
        new("microsoft-costs", "What Microsoft charged the partner per customer and currency in the period (Microsoft's own billing lines). Cost data.", true, true, 2,
            [C("organizationId", "guid"), C("currency", "string"), C("name", "string"), C("cost", "decimal"), C("lines", "int")]),
        new("subscriptions", "Licence quantities per customer and offer on the last day of the period.", false, true, 3,
            [C("organizationId", "guid"), C("productId", "guid"), C("offerId", "string"), C("name", "string"), C("offerName", "string"), C("quantity", "int")]),
        new("margins",
            "Approved billing against cost per customer in the period, NOK. licenseCost is Microsoft's cost; hourCost is approved hours times hourlyCostUsed " +
            "(the company's internal hourly cost setting, repeated in every row so the number can be reproduced). costIncomplete: licences were billed but " +
            "Microsoft's cost is missing. Cost of goods is not tracked.",
            true, true, 1,
            [C("organizationId", "guid"), C("name", "string"), C("revenue", "decimal"), C("licenseCost", "decimal"), C("hourCost", "decimal"),
             C("margin", "decimal"), C("marginPct", "decimal"), C("hours", "decimal"), C("costIncomplete", "bool"), C("hourlyCostUsed", "decimal")]),
        new("renewals", "Contracts ending in the period with their notice deadline.", false, false, 1,
            [C("contractId", "guid"), C("number", "string"), C("organizationId", "guid"), C("name", "string"), C("endDate", "date"), C("autoRenew", "bool"),
             C("noticeDeadline", "date")]),
        new("recurring-revenue",
            "Recurring value of live contracts on the last day of the period, NOK ex VAT: mrr = monthly amounts with quarterly and yearly lines divided down, " +
            "arr = mrr × 12. One row per contract type and one 'All' row (the only one with a contract count).",
            false, true, 2, [C("date", "date"), C("contractType", "string"), C("mrr", "decimal"), C("arr", "decimal"), C("contracts", "int")]),
        new("invoices",
            "Invoices dated in the period as the accounting system reports them. totalIncVat is invoiced; outstanding is what the accounting system still shows " +
            "unpaid at asOf. A fall in outstanding can be a payment or a credit note: the CRM does not tell them apart, so there is no 'paid' column.",
            false, true, 2,
            [C("system", "string"), C("invoiceNo", "string"), C("organizationId", "guid"), C("invoiceDate", "date"), C("dueDate", "date"),
             C("totalIncVat", "decimal"), C("outstanding", "decimal"), C("status", "string")]),
    ];

    /// <summary>The meaning of the words the numbers use, served with the catalog and kept in docs/runbooks/14.</summary>
    public static readonly IReadOnlyDictionary<string, string> Glossary = new Dictionary<string, string>
    {
        ["MRR"] = "Monthly recurring revenue: the monthly value of live contract lines on a date, NOK ex VAT; quarterly and yearly lines divided to months. Not revenue billed.",
        ["ARR"] = "Annual recurring revenue: MRR × 12 on the same date.",
        ["billed (approved)"] = "The content of billing bases that were approved. It is frozen at approval; it says what the CRM asked the accounting system to invoice.",
        ["pending"] = "What collected billing bases not yet approved would bill; it can still change or disappear.",
        ["invoiced"] = "totalIncVat of an invoice in the accounting system.",
        ["outstanding"] = "What the accounting system shows as still unpaid on an invoice at asOf. It is not 'receivable minus payments': a credit note lowers it too.",
        ["margin"] = "Approved billing minus Microsoft cost minus hours at the internal hourly cost. Cost of goods is not tracked; costIncomplete marks a missing Microsoft cost.",
        ["asOf"] = "The moment the answer was read. Snapshots carry the moment they were taken and a provenance: Captured (taken in time) or Reconstructed (built later from current data).",
    };

    public static BiDataset? Find(string? name) => Datasets.FirstOrDefault(d => string.Equals(d.Name, name, StringComparison.OrdinalIgnoreCase));

    public async Task<Result<BiTable>> BuildAsync(BiDataset dataset, DateOnly from, DateOnly to, DateTimeOffset asOf, CancellationToken ct)
    {
        if (to < from || from.Year < 2020 || to.Year > 2100)
        {
            return Error.Validation("RPT_MART_PERIOD", "Give a period inside 2020–2100 that does not end before it starts.");
        }

        List<object?[]> rows;
        switch (dataset.Name)
        {
            case "organizations":
                rows = (await customers.GetAllOrganizationsAsync(ct)).Select(o => new object?[] { o.Id, o.Name, o.OrgNumber, o.Status.ToString() }).ToList();
                break;
            case "revenue-by-month":
                rows = (await billing.GetRevenueSplitAsync(from, to, ct)).Select(r => new object?[] { r.Year, r.Month, r.ApprovedExVat, r.PendingExVat }).ToList();
                break;
            case "revenue-by-customer":
            {
                var revenue = await billing.GetRevenueByOrganizationAsync(from, to, ct, approvedOnly: true);
                var names = await customers.GetOrganizationNamesAsync(revenue.Select(r => r.OrganizationId).ToList(), ct);
                rows = revenue.Select(r => new object?[] { r.OrganizationId, Name(names, r.OrganizationId), r.Total, r.Licenses, r.Subscriptions, r.Hours, r.OneOff }).ToList();
                break;
            }

            case "hours-by-customer":
            {
                var hours = await timeTracking.GetHoursByOrganizationAsync(from, to, ct);
                var names = await customers.GetOrganizationNamesAsync(hours.Select(r => r.OrganizationId).ToList(), ct);
                rows = hours.Select(r => new object?[] { r.OrganizationId, Name(names, r.OrganizationId), r.Hours, r.BilledHours, r.Amount }).ToList();
                break;
            }

            case "microsoft-costs":
            {
                var costs = await licensing.GetMsCostsAsync(from, to, ct);
                var names = await customers.GetOrganizationNamesAsync(costs.Select(r => r.OrganizationId).ToList(), ct);
                rows = costs.Select(r => new object?[] { r.OrganizationId, r.Currency, Name(names, r.OrganizationId), r.Cost, r.Lines }).ToList();
                break;
            }

            case "subscriptions":
            {
                var quantities = await licensing.GetSubscriptionQuantitiesAsync(to, ct);
                var names = await customers.GetOrganizationNamesAsync(quantities.Select(r => r.OrganizationId).Distinct().ToList(), ct);
                rows = quantities.Select(r => new object?[] { r.OrganizationId, r.ProductId, r.OfferId, Name(names, r.OrganizationId), r.OfferName, r.Quantity }).ToList();
                break;
            }

            case "margins":
            {
                var months = ((to.Year - from.Year) * 12) + to.Month - from.Month + 1;
                var report = await margins.GetAsync(to.Year, to.Month, Math.Clamp(months, 1, 12), ct, approvedOnly: true);
                if (!report.IsSuccess)
                {
                    return report.Error!;
                }

                rows = report.Value.Rows.Select(r => new object?[]
                {
                    r.OrganizationId, r.OrganizationName, r.Revenue, r.LicenseCost, r.HourCost, r.Margin, r.MarginPct, r.Hours, r.CostIncomplete, report.Value.HourlyCost,
                }).ToList();
                break;
            }

            case "renewals":
            {
                var days = Math.Clamp(to.DayNumber - from.DayNumber + 1, 1, 730);
                var due = await contracts.GetRenewalsAsync(from, days, ct);
                var names = await customers.GetOrganizationNamesAsync(due.Select(r => r.OrganizationId).Distinct().ToList(), ct);
                rows = due.Select(r => new object?[] { r.ContractId, r.Number, r.OrganizationId, Name(names, r.OrganizationId), r.EndDate, r.AutoRenew, r.NoticeDeadline }).ToList();
                break;
            }

            case "recurring-revenue":
            {
                var recurring = await contracts.GetRecurringRevenueAsync(to, ct);
                rows = [new object?[] { to, "All", recurring.MonthlyTotal, decimal.Round(recurring.MonthlyTotal * 12m, 2), recurring.Contracts }];
                rows.AddRange(recurring.ByType.Select(t => new object?[] { to, t.Key.ToString(), t.Value, decimal.Round(t.Value * 12m, 2), null }));
                break;
            }

            case "invoices":
                rows = (await billing.GetInvoiceRowsAsync(from, to, ct)).Select(i => new object?[]
                {
                    i.System, i.InvoiceNo, i.OrganizationId, i.InvoiceDate, i.DueDate, i.TotalIncVat, i.Outstanding, i.Status.ToString(),
                }).ToList();
                break;
            default:
                return Error.NotFound("RPT_MART_UNKNOWN", $"There is no dataset '{dataset.Name}'.");
        }

        var ordered = rows.OrderBy(r => KeyOf(dataset, r), StringComparer.Ordinal).ThenBy(r => string.Join('\u0001', r.Select(Cell)), StringComparer.Ordinal).ToList();
        return new BiTable(SchemaVersion, dataset.Name, asOf, from, to, dataset.Columns, ordered.ConvertAll(r => (IReadOnlyList<object?>)r));
    }

    public DateTimeOffset Now => time.GetUtcNow();

    /// <summary>The page after <paramref name="after"/> (the key of the last row of the previous page; null for the first).</summary>
    public BiPage PageOf(BiTable table, string? after, int pageSize, DateTimeOffset watermarkAsOf)
    {
        var dataset = Find(table.Dataset)!;
        var size = Math.Clamp(pageSize <= 0 ? options.Value.MartPageSize : pageSize, 1, 5000);
        var remaining = table.Rows.Where(r => after is null || string.CompareOrdinal(KeyOf(dataset, r), after) > 0).ToList();
        var page = remaining.Take(size).ToList();
        var more = remaining.Count > page.Count;
        return new BiPage(
            table.SchemaVersion, table.Dataset, table.AsOf, table.From, table.To, table.Columns, page,
            more ? BiCursor.Encode(watermarkAsOf, table.From, table.To, KeyOf(dataset, page[^1])) : null,
            more ? null : watermarkAsOf);
    }

    /// <summary>The ordering key of a row: its key columns, formatted so that ordinal comparison follows the natural order.</summary>
    public static string KeyOf(BiDataset dataset, IReadOnlyList<object?> row) =>
        string.Join('\u0001', row.Take(dataset.KeyColumns).Select(KeyCell));

    private static string KeyCell(object? value) => value switch
    {
        int number => number.ToString("D10", CultureInfo.InvariantCulture),
        _ => Cell(value),
    };

    private static string Name(IReadOnlyDictionary<Guid, string> names, Guid id) => names.GetValueOrDefault(id, "—");

    internal static string Cell(object? value) => value switch
    {
        null => string.Empty,
        bool flag => flag ? "true" : "false",
        decimal number => number.ToString("0.####", CultureInfo.InvariantCulture),
        DateOnly date => date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
        _ => Convert.ToString(value, CultureInfo.InvariantCulture) ?? string.Empty,
    };
}

/// <summary>The continuation of a refresh: the moment it began, its period and the key of the last row read.</summary>
internal static class BiCursor
{
    public static string Encode(DateTimeOffset asOf, DateOnly from, DateOnly to, string lastKey) =>
        Convert.ToBase64String(Encoding.UTF8.GetBytes(string.Join('|', asOf.UtcTicks.ToString(CultureInfo.InvariantCulture), from.ToString("O", CultureInfo.InvariantCulture),
            to.ToString("O", CultureInfo.InvariantCulture), Convert.ToBase64String(Encoding.UTF8.GetBytes(lastKey)))))
            .Replace('+', '-').Replace('/', '_').TrimEnd('=');

    public static (DateTimeOffset AsOf, DateOnly From, DateOnly To, string LastKey)? Decode(string? cursor)
    {
        if (string.IsNullOrEmpty(cursor))
        {
            return null;
        }

        try
        {
            var padded = cursor.Replace('-', '+').Replace('_', '/');
            padded = padded.PadRight(padded.Length + ((4 - (padded.Length % 4)) % 4), '=');
            var parts = Encoding.UTF8.GetString(Convert.FromBase64String(padded)).Split('|');
            return parts.Length == 4
                ? (new DateTimeOffset(long.Parse(parts[0], CultureInfo.InvariantCulture), TimeSpan.Zero), DateOnly.Parse(parts[1], CultureInfo.InvariantCulture),
                    DateOnly.Parse(parts[2], CultureInfo.InvariantCulture), Encoding.UTF8.GetString(Convert.FromBase64String(parts[3])))
                : null;
        }
        catch (Exception ex) when (ex is FormatException or OverflowException or ArgumentException)
        {
            return null;
        }
    }
}
