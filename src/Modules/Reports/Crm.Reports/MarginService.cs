using Crm.Authorization;
using Crm.Billing.Contracts;
using Crm.Customers.Contracts;
using Crm.Licensing.Contracts;
using Crm.SharedKernel.Results;
using Crm.TimeTracking.Contracts;
using Microsoft.Extensions.Options;

namespace Crm.Reports;

/// <summary>Margin of one customer for a period (FR-RPT-02). Every number carries the permission of the money it shows.</summary>
public sealed record CustomerMarginRow(
    Guid OrganizationId,
    string OrganizationName,
    [property: SensitiveData(Permissions.FinanceRead)] decimal Revenue,
    [property: SensitiveData(Permissions.FinanceRead)] decimal LicenseRevenue,
    [property: SensitiveData(Permissions.FinanceRead)] decimal HourRevenue,
    [property: SensitiveData(Permissions.FinanceCostRead)] decimal LicenseCost,
    [property: SensitiveData(Permissions.FinanceCostRead)] decimal HourCost,
    [property: SensitiveData(Permissions.FinanceCostRead)] decimal Margin,
    [property: SensitiveData(Permissions.FinanceCostRead)] decimal MarginPct,
    decimal Hours,
    bool CostIncomplete);

public sealed record MarginReport(
    DateOnly PeriodStart,
    DateOnly PeriodEnd,
    [property: SensitiveData(Permissions.FinanceRead)] decimal Revenue,
    [property: SensitiveData(Permissions.FinanceCostRead)] decimal Cost,
    [property: SensitiveData(Permissions.FinanceCostRead)] decimal Margin,
    [property: SensitiveData(Permissions.FinanceCostRead)] decimal MarginPct,
    decimal HourlyCost,
    int Customers,
    int WithoutLicenseCost,
    IReadOnlyList<CustomerMarginRow> Rows);

/// <summary>
/// Customer margin (FR-RPT-02): what was billed against what it cost us. Licence cost comes from Microsoft's own billing
/// lines (FR-LIC-04) — a customer whose costs were never imported is marked, not guessed — and hours cost is the internal
/// hourly cost from the settings times the approved hours. Cost of goods for hardware is not tracked in the CRM.
/// </summary>
internal sealed class MarginService(
    IBillingApi billing,
    ILicensingApi licensing,
    ITimeTrackingApi timeTracking,
    ICustomersApi customers,
    IOptions<ReportsOptions> options)
{
    public async Task<Result<MarginReport>> GetAsync(int year, int month, int months, CancellationToken ct)
    {
        if (year is < 2020 or > 2100 || month is < 1 or > 12 || months is < 1 or > 12)
        {
            return Error.Validation("RPT_PERIOD", "Choose a month between 2020 and 2100 and a window of 1–12 months.");
        }

        var periodStart = new DateOnly(year, month, 1).AddMonths(1 - months);
        var periodEnd = new DateOnly(year, month, 1).AddMonths(1).AddDays(-1);

        var revenue = await billing.GetRevenueByOrganizationAsync(periodStart, periodEnd, ct);
        var licenseCosts = (await licensing.GetMsCostsAsync(periodStart, periodEnd, ct)).ToDictionary(c => c.OrganizationId);
        var hours = (await timeTracking.GetHoursByOrganizationAsync(periodStart, periodEnd, ct)).ToDictionary(h => h.OrganizationId);
        var hourlyCost = Math.Max(0m, options.Value.InternalHourlyCost);

        var organizationIds = revenue.Select(r => r.OrganizationId).Concat(hours.Keys).Concat(licenseCosts.Keys).Distinct().ToList();
        var names = await customers.GetOrganizationNamesAsync(organizationIds, ct);

        var rows = new List<CustomerMarginRow>();
        foreach (var organizationId in organizationIds)
        {
            var billed = revenue.FirstOrDefault(r => r.OrganizationId == organizationId);
            var worked = hours.GetValueOrDefault(organizationId);
            var licenseCost = licenseCosts.GetValueOrDefault(organizationId)?.Cost ?? 0m;
            var hourCost = decimal.Round((worked?.Hours ?? 0m) * hourlyCost, 2);
            var total = billed?.Total ?? 0m;
            var margin = decimal.Round(total - licenseCost - hourCost, 2);

            rows.Add(new CustomerMarginRow(
                organizationId,
                names.GetValueOrDefault(organizationId, "—"),
                total,
                billed?.Licenses ?? 0m,
                billed?.Hours ?? 0m,
                licenseCost,
                hourCost,
                margin,
                total == 0 ? 0m : decimal.Round(margin / total * 100m, 1),
                worked?.Hours ?? 0m,
                // Licences were billed but Microsoft's cost for them is missing, so the margin reads better than it is.
                (billed?.Licenses ?? 0m) > 0 && licenseCost == 0));
        }

        var revenueTotal = decimal.Round(rows.Sum(r => r.Revenue), 2);
        var costTotal = decimal.Round(rows.Sum(r => r.LicenseCost + r.HourCost), 2);

        return new MarginReport(
            periodStart,
            periodEnd,
            revenueTotal,
            costTotal,
            decimal.Round(revenueTotal - costTotal, 2),
            revenueTotal == 0 ? 0m : decimal.Round((revenueTotal - costTotal) / revenueTotal * 100m, 1),
            hourlyCost,
            rows.Count,
            rows.Count(r => r.CostIncomplete),
            rows.OrderByDescending(r => r.Margin).ToList());
    }
}
