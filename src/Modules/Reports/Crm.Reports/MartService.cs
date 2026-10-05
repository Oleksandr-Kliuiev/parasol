using System.Globalization;
using System.Text;
using Crm.Billing.Contracts;
using Crm.Contracts.Contracts;
using Crm.Customers.Contracts;
using Crm.Licensing.Contracts;
using Crm.SharedKernel.Results;
using Crm.TimeTracking.Contracts;

namespace Crm.Reports;

/// <summary>One table of the mart: named columns and rows of plain values, ready for Power BI (FR-RPT-03).</summary>
public sealed record MartTable(string Dataset, DateOnly From, DateOnly To, IReadOnlyList<string> Columns, IReadOnlyList<IReadOnlyList<object?>> Rows);

/// <summary>
/// Read-only data mart (FR-RPT-03). Power BI connects with the Web connector and an account that has `reports.mart`;
/// there is no direct SQL access, so the same permission checks and the same module contracts apply as everywhere else.
/// The mart owns nothing: every dataset is composed from the modules' own queries.
/// </summary>
internal sealed class MartService(
    ICustomersApi customers,
    IBillingApi billing,
    ILicensingApi licensing,
    ITimeTrackingApi timeTracking,
    IContractsApi contracts,
    MarginService margins)
{
    public static readonly string[] Datasets =
        ["organizations", "revenue-by-month", "revenue-by-customer", "hours-by-customer", "microsoft-costs", "subscriptions", "margins", "renewals"];

    public async Task<Result<MartTable>> GetAsync(string dataset, DateOnly from, DateOnly to, CancellationToken ct)
    {
        if (to < from || from.Year < 2020 || to.Year > 2100)
        {
            return Error.Validation("RPT_MART_PERIOD", "Give a period inside 2020–2100 that does not end before it starts.");
        }

        return dataset?.ToLowerInvariant() switch
        {
            "organizations" => await OrganizationsAsync(from, to, ct),
            "revenue-by-month" => await RevenueByMonthAsync(from, to, ct),
            "revenue-by-customer" => await RevenueByCustomerAsync(from, to, ct),
            "hours-by-customer" => await HoursAsync(from, to, ct),
            "microsoft-costs" => await MicrosoftCostsAsync(from, to, ct),
            "subscriptions" => await SubscriptionsAsync(from, to, ct),
            "margins" => await MarginsAsync(from, to, ct),
            "renewals" => await RenewalsAsync(from, to, ct),
            _ => Error.NotFound("RPT_MART_UNKNOWN", $"There is no dataset '{dataset}'. Available: {string.Join(", ", Datasets)}."),
        };
    }

    private async Task<MartTable> OrganizationsAsync(DateOnly from, DateOnly to, CancellationToken ct)
    {
        var rows = await customers.GetAllOrganizationsAsync(ct);
        return Table("organizations", from, to,
            ["organizationId", "name", "orgNumber", "status"],
            rows.Select(o => new object?[] { o.Id, o.Name, o.OrgNumber, o.Status.ToString() }).ToList());
    }

    private async Task<MartTable> RevenueByMonthAsync(DateOnly from, DateOnly to, CancellationToken ct)
    {
        var rows = await billing.GetRevenueAsync(from, to, ct);
        return Table("revenue-by-month", from, to,
            ["year", "month", "totalExVat"],
            rows.Select(r => new object?[] { r.Year, r.Month, r.TotalExVat }).ToList());
    }

    private async Task<MartTable> RevenueByCustomerAsync(DateOnly from, DateOnly to, CancellationToken ct)
    {
        var rows = await billing.GetRevenueByOrganizationAsync(from, to, ct);
        var names = await customers.GetOrganizationNamesAsync(rows.Select(r => r.OrganizationId).ToList(), ct);
        return Table("revenue-by-customer", from, to,
            ["organizationId", "name", "total", "licenses", "subscriptions", "hours", "oneOff"],
            rows.Select(r => new object?[]
            {
                r.OrganizationId, names.GetValueOrDefault(r.OrganizationId, "—"), r.Total, r.Licenses, r.Subscriptions, r.Hours, r.OneOff,
            }).ToList());
    }

    private async Task<MartTable> HoursAsync(DateOnly from, DateOnly to, CancellationToken ct)
    {
        var rows = await timeTracking.GetHoursByOrganizationAsync(from, to, ct);
        var names = await customers.GetOrganizationNamesAsync(rows.Select(r => r.OrganizationId).ToList(), ct);
        return Table("hours-by-customer", from, to,
            ["organizationId", "name", "hours", "billedHours", "amount"],
            rows.Select(r => new object?[] { r.OrganizationId, names.GetValueOrDefault(r.OrganizationId, "—"), r.Hours, r.BilledHours, r.Amount }).ToList());
    }

    private async Task<MartTable> MicrosoftCostsAsync(DateOnly from, DateOnly to, CancellationToken ct)
    {
        var rows = await licensing.GetMsCostsAsync(from, to, ct);
        var names = await customers.GetOrganizationNamesAsync(rows.Select(r => r.OrganizationId).ToList(), ct);
        return Table("microsoft-costs", from, to,
            ["organizationId", "name", "cost", "currency", "lines"],
            rows.Select(r => new object?[] { r.OrganizationId, names.GetValueOrDefault(r.OrganizationId, "—"), r.Cost, r.Currency, r.Lines }).ToList());
    }

    private async Task<MartTable> SubscriptionsAsync(DateOnly from, DateOnly to, CancellationToken ct)
    {
        var rows = await licensing.GetSubscriptionQuantitiesAsync(to, ct);
        var names = await customers.GetOrganizationNamesAsync(rows.Select(r => r.OrganizationId).Distinct().ToList(), ct);
        return Table("subscriptions", from, to,
            ["organizationId", "name", "productId", "offerId", "offerName", "quantity"],
            rows.Select(r => new object?[]
            {
                r.OrganizationId, names.GetValueOrDefault(r.OrganizationId, "—"), r.ProductId, r.OfferId, r.OfferName, r.Quantity,
            }).ToList());
    }

    private async Task<Result<MartTable>> MarginsAsync(DateOnly from, DateOnly to, CancellationToken ct)
    {
        var months = ((to.Year - from.Year) * 12) + to.Month - from.Month + 1;
        var report = await margins.GetAsync(to.Year, to.Month, Math.Clamp(months, 1, 12), ct);
        if (!report.IsSuccess)
        {
            return report.Error!;
        }

        return Table("margins", from, to,
            ["organizationId", "name", "revenue", "licenseCost", "hourCost", "margin", "marginPct", "hours", "costIncomplete"],
            report.Value.Rows.Select(r => new object?[]
            {
                r.OrganizationId, r.OrganizationName, r.Revenue, r.LicenseCost, r.HourCost, r.Margin, r.MarginPct, r.Hours, r.CostIncomplete,
            }).ToList());
    }

    private async Task<MartTable> RenewalsAsync(DateOnly from, DateOnly to, CancellationToken ct)
    {
        var days = Math.Clamp(to.DayNumber - from.DayNumber + 1, 1, 730);
        var rows = await contracts.GetRenewalsAsync(from, days, ct);
        var names = await customers.GetOrganizationNamesAsync(rows.Select(r => r.OrganizationId).Distinct().ToList(), ct);
        return Table("renewals", from, to,
            ["contractId", "number", "organizationId", "name", "endDate", "autoRenew", "noticeDeadline"],
            rows.Select(r => new object?[]
            {
                r.ContractId, r.Number, r.OrganizationId, names.GetValueOrDefault(r.OrganizationId, "—"), r.EndDate, r.AutoRenew, r.NoticeDeadline,
            }).ToList());
    }

    private static MartTable Table(string dataset, DateOnly from, DateOnly to, string[] columns, List<object?[]> rows) =>
        new(dataset, from, to, columns, rows);

    /// <summary>The same table as CSV, because Power BI's Web connector reads a file more happily than paged JSON.</summary>
    public static string ToCsv(MartTable table)
    {
        var text = new StringBuilder();
        text.AppendLine(string.Join(';', table.Columns));
        foreach (var row in table.Rows)
        {
            text.AppendLine(string.Join(';', row.Select(Cell)));
        }

        return text.ToString();
    }

    private static string Cell(object? value) => value switch
    {
        null => string.Empty,
        bool flag => flag ? "true" : "false",
        decimal number => number.ToString("0.##", CultureInfo.InvariantCulture),
        DateOnly date => date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
        DateTimeOffset moment => moment.ToString("O", CultureInfo.InvariantCulture),
        string s when s.Contains(';', StringComparison.Ordinal) || s.Contains('"', StringComparison.Ordinal) =>
            $"\"{s.Replace("\"", "\"\"", StringComparison.Ordinal)}\"",
        _ => Convert.ToString(value, CultureInfo.InvariantCulture) ?? string.Empty,
    };
}
