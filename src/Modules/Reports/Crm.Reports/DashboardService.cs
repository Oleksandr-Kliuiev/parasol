using Crm.Authorization;
using Crm.Billing.Contracts;
using Crm.Catalog.Contracts;
using Crm.Contracts.Contracts;
using Crm.Customers.Contracts;
using Crm.Licensing.Contracts;
using Crm.Sales.Contracts;
using Crm.Service.Contracts;
using Crm.TimeTracking.Contracts;

namespace Crm.Reports;

public sealed record MoneyByLabel(string Label, [property: SensitiveData(Permissions.FinanceRead)] decimal? Amount);

public sealed record RevenueMonth(
    int Year,
    int Month,
    [property: SensitiveData(Permissions.FinanceRead)] decimal? TotalExVat,
    IReadOnlyList<MoneyByLabel> ByBusinessLine);

public sealed record RecurringPanel(
    [property: SensitiveData(Permissions.FinanceRead)] decimal? Mrr,
    [property: SensitiveData(Permissions.FinanceRead)] decimal? Arr,
    int Contracts,
    IReadOnlyList<MoneyByLabel> ByType);

public sealed record PipelinePanel(
    int Open,
    int Stale,
    [property: SensitiveData(Permissions.FinanceRead)] decimal? WeightedForecast,
    [property: SensitiveData(Permissions.FinanceRead)] decimal? OpenValue,
    int WonLast90Days,
    [property: SensitiveData(Permissions.FinanceRead)] decimal? WonAmountLast90Days,
    int LostLast90Days);

public sealed record InvoicePanel(
    int Open,
    [property: SensitiveData(Permissions.FinanceRead)] decimal? Outstanding,
    [property: SensitiveData(Permissions.FinanceRead)] decimal? Overdue,
    int OverdueCount);

public sealed record RenewalItem(
    Guid ContractId, string Number, string Title, string Organization, DateOnly EndDate, int DaysLeft, bool AutoRenew, DateOnly? NoticeDeadline);

public sealed record UtilizationItem(
    string Technician, decimal BilledHours, decimal CoveredHours, decimal HourBankHours, decimal NonBillableHours, decimal TotalHours, decimal BillablePct);

public sealed record LicensePanel(int Subscriptions, int Licenses, int CancellationWindowOpen, int RenewingSoon, int NotBilled, int WithoutOrganization);

public sealed record ServicePanel(int OpenTickets, int UnassignedTickets, int CriticalAlerts, int WarningAlerts, int Devices, int DevicesOffline);

public sealed record DashboardResponse(
    DateOnly AsOf,
    RecurringPanel Recurring,
    IReadOnlyList<RevenueMonth> Revenue,
    InvoicePanel Invoices,
    PipelinePanel Pipeline,
    IReadOnlyList<RenewalItem> Renewals,
    IReadOnlyList<UtilizationItem> Utilization,
    LicensePanel Licenses,
    ServicePanel Service,
    int RenewalsTotal,
    int TechniciansTotal);

/// <summary>
/// The dashboard (FR-RPT-01) is composed from what each module already knows through its contracts: nothing is copied into a
/// reporting schema, so the numbers cannot drift from the modules that own them.
/// </summary>
internal sealed class DashboardService(
    IContractsApi contracts,
    IBillingApi billing,
    ICatalogApi catalog,
    ICustomersApi customers,
    ISalesApi sales,
    ILicensingApi licensing,
    IServiceApi service,
    ITimeTrackingApi timeTracking,
    TimeProvider time)
{
    /// <summary>The panels show the soonest renewals and the busiest technicians; the totals say how many there are (DEV-12).</summary>
    public const int RenewalsShown = 20;

    public const int TechniciansShown = 15;

    private static readonly TimeZoneInfo Oslo = TimeZoneInfo.FindSystemTimeZoneById("Europe/Oslo");

    public async Task<DashboardResponse> GetAsync(int months, CancellationToken ct)
    {
        var now = time.GetUtcNow();
        var today = DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(now, Oslo).DateTime);
        var window = Math.Clamp(months, 1, 24);
        var firstPeriod = new DateOnly(today.Year, today.Month, 1).AddMonths(-(window - 1));

        var recurring = await contracts.GetRecurringRevenueAsync(today, ct);
        var revenue = await billing.GetRevenueAsync(firstPeriod, today, ct);
        var invoices = await billing.GetInvoiceTotalsAsync(today, ct);
        var pipeline = await sales.GetPipelineSummaryAsync(now, ct);
        var renewals = await contracts.GetRenewalsAsync(today, 90, ct);
        var utilization = await timeTracking.GetUtilizationAsync(today.Year, today.Month, ct);
        var licenses = await licensing.GetSummaryAsync(today, ct);
        var load = await service.GetLoadAsync(ct);

        var productIds = revenue.SelectMany(r => r.ByProduct.Keys).Distinct().ToList();
        var products = await catalog.GetProductsAsync(productIds, ct);
        // The total covers every renewal, but only the visible panel needs customer names (DEV-16).
        var organizations = await customers.GetOrganizationNamesAsync(renewals.Take(RenewalsShown).Select(r => r.OrganizationId).Distinct().ToList(), ct);

        return new DashboardResponse(
            today,
            new RecurringPanel(
                recurring.MonthlyTotal,
                decimal.Round(recurring.MonthlyTotal * 12, 2),
                recurring.Contracts,
                recurring.ByType.OrderByDescending(x => x.Value).Select(x => new MoneyByLabel(x.Key.ToString(), x.Value)).ToList()),
            MonthlyRevenue(firstPeriod, window, revenue, products),
            new InvoicePanel(invoices.Open, invoices.Outstanding, invoices.Overdue, invoices.OverdueCount),
            new PipelinePanel(
                pipeline.Open, pipeline.Stale, pipeline.WeightedForecast, pipeline.OpenValue,
                pipeline.WonLast90Days, pipeline.WonAmountLast90Days, pipeline.LostLast90Days),
            renewals
                .Select(r => new RenewalItem(
                    r.ContractId, r.Number, r.Title, organizations.GetValueOrDefault(r.OrganizationId, "—"), r.EndDate, r.DaysLeft, r.AutoRenew, r.NoticeDeadline))
                .Take(RenewalsShown)
                .ToList(),
            utilization
                .Take(TechniciansShown)
                .Select(u => new UtilizationItem(
                    u.TechnicianName, u.BilledHours, u.CoveredHours, u.HourBankHours, u.NonBillableHours, u.TotalHours,
                    u.TotalHours == 0 ? 0 : decimal.Round(u.BilledHours / u.TotalHours * 100m, 1)))
                .ToList(),
            new LicensePanel(
                licenses.Subscriptions, licenses.Licenses, licenses.CancellationWindowOpen, licenses.RenewingSoon,
                licenses.NotBilled, licenses.WithoutOrganization),
            new ServicePanel(load.OpenTickets, load.UnassignedTickets, load.CriticalAlerts, load.WarningAlerts, load.Devices, load.DevicesOffline),
            renewals.Count,
            utilization.Count);
    }

    /// <summary>Every month of the window is present, so a chart shows the gaps instead of skipping them.</summary>
    private static List<RevenueMonth> MonthlyRevenue(
        DateOnly firstPeriod, int window, IReadOnlyList<RevenueByMonth> revenue, IReadOnlyDictionary<Guid, ProductRef> products)
    {
        var months = new List<RevenueMonth>(window);
        for (var index = 0; index < window; index++)
        {
            var period = firstPeriod.AddMonths(index);
            var month = revenue.FirstOrDefault(r => r.Year == period.Year && r.Month == period.Month);
            var byLine = month is null
                ? []
                : month.ByProduct
                    .GroupBy(p => products.TryGetValue(p.Key, out var product) ? BusinessLineOf(product) : "Other")
                    .Select(g => new MoneyByLabel(g.Key, decimal.Round(g.Sum(x => x.Value), 2)))
                    .OrderByDescending(x => x.Amount)
                    .ToList();
            months.Add(new RevenueMonth(period.Year, period.Month, month?.TotalExVat ?? 0m, byLine));
        }

        return months;
    }

    // The product's business line is how revenue is split by what the company sells (docs/02 §4.12).
    private static string BusinessLineOf(ProductRef product) => product.Type switch
    {
        ProductType.MicrosoftLicense => nameof(Catalog.Contracts.BusinessLine.Microsoft),
        ProductType.PowerOfficeService => nameof(Catalog.Contracts.BusinessLine.PowerOffice),
        ProductType.ManagedService => nameof(Catalog.Contracts.BusinessLine.Atera),
        ProductType.HourlyService or ProductType.HourBank => nameof(Catalog.Contracts.BusinessLine.Consulting),
        ProductType.Hardware => nameof(Catalog.Contracts.BusinessLine.Hardware),
        _ => nameof(Catalog.Contracts.BusinessLine.Other),
    };
}
