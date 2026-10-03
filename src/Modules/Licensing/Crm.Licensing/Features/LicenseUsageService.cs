using System.Globalization;
using Crm.Catalog.Contracts;
using Crm.Customers.Contracts;
using Crm.Billing.Contracts;
using Crm.Licensing.Contracts;
using Crm.Licensing.Domain;
using Crm.Licensing.Persistence;
using Crm.SharedKernel.Results;
using Microsoft.EntityFrameworkCore;

namespace Crm.Licensing.Features;

/// <summary>A customer's licence usage today: what they pay for and what is actually handed out (FR-LIC-03).</summary>
public sealed record LicenseUsageRow(
    Guid OrganizationId,
    string OrganizationName,
    string SkuPartNumber,
    string SkuId,
    int Purchased,
    int Assigned,
    int Unused,
    DateOnly SnapshotDate,
    /// <summary>Unused licences every day of the window; that is what turns a number into a recommendation (BR-LIC-04).</summary>
    bool UnusedForWholeWindow,
    int WindowDays);

/// <summary>What Microsoft charged against what the customer was charged, for one period (FR-LIC-04).</summary>
public sealed record ReconciliationRow(
    Guid? OrganizationId,
    string OrganizationName,
    decimal MicrosoftCost,
    decimal BilledRevenue,
    decimal Margin,
    decimal MarginPct,
    int MicrosoftLines,
    bool NotBilled,
    IReadOnlyList<string> OffersWithoutRevenue);

public sealed record ReconciliationReport(
    DateOnly PeriodStart,
    DateOnly PeriodEnd,
    decimal MicrosoftCost,
    decimal BilledRevenue,
    decimal Margin,
    string Currency,
    int Lines,
    IReadOnlyList<ReconciliationRow> Rows);

/// <summary>
/// Licence usage and the Microsoft reconciliation (S11). Both live in Licensing because they are about subscriptions, and
/// both are read-only mirrors: the CRM never writes to the customer's tenant or to Microsoft's invoice.
/// </summary>
internal sealed class LicenseUsageService(
    LicensingDbContext db,
    ICustomersApi customers,
    ICatalogApi catalog,
    IBillingApi billing,
    TimeProvider time)
{
    private static readonly TimeZoneInfo Oslo = TimeZoneInfo.FindSystemTimeZoneById("Europe/Oslo");

    /// <summary>Licences are called "unused" only when every reading in this window says so.</summary>
    public const int UnusedWindowDays = 30;

    private DateOnly Today => DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(time.GetUtcNow(), Oslo).DateTime);

    public async Task<IReadOnlyList<LicenseUsageRow>> GetUsageAsync(Guid? organizationId, bool unusedOnly, CancellationToken ct)
    {
        var today = Today;
        var windowStart = today.AddDays(-UnusedWindowDays);
        var snapshots = await db.LicenseSnapshots.AsNoTracking()
            .Where(s => s.SnapshotDate >= windowStart && (organizationId == null || s.OrganizationId == organizationId))
            .ToListAsync(ct);
        if (snapshots.Count == 0)
        {
            return [];
        }

        var names = await customers.GetOrganizationNamesAsync(snapshots.Select(s => s.OrganizationId).Distinct().ToList(), ct);
        var rows = new List<LicenseUsageRow>();
        foreach (var group in snapshots.GroupBy(s => new { s.OrganizationId, s.SkuId }))
        {
            var ordered = group.OrderByDescending(s => s.SnapshotDate).ToList();
            var latest = ordered[0];
            // "Unused all window" needs readings that cover it; a tenant read for the first time yesterday says nothing yet.
            var covered = ordered.Count >= 2 && ordered[^1].SnapshotDate <= today.AddDays(-UnusedWindowDays + 1);
            var alwaysUnused = covered && ordered.TrueForAll(s => s.Unused > 0);
            if (unusedOnly && !alwaysUnused)
            {
                continue;
            }

            rows.Add(new LicenseUsageRow(
                latest.OrganizationId,
                names.GetValueOrDefault(latest.OrganizationId, "—"),
                latest.SkuPartNumber,
                latest.SkuId,
                latest.Purchased,
                latest.Assigned,
                latest.Unused,
                latest.SnapshotDate,
                alwaysUnused,
                UnusedWindowDays));
        }

        return rows
            .OrderByDescending(r => r.UnusedForWholeWindow)
            .ThenByDescending(r => r.Unused)
            .ThenBy(r => r.OrganizationName, StringComparer.CurrentCultureIgnoreCase)
            .ToList();
    }

    /// <summary>FR-LIC-04: Microsoft's cost against the CRM's revenue for the same month, per customer.</summary>
    public async Task<Result<ReconciliationReport>> GetReconciliationAsync(int year, int month, CancellationToken ct)
    {
        if (year is < 2020 or > 2100 || month is < 1 or > 12)
        {
            return Error.Validation("LIC_PERIOD", "Choose a month between 2020 and 2100.");
        }

        var periodStart = new DateOnly(year, month, 1);
        var periodEnd = periodStart.AddMonths(1).AddDays(-1);
        var costLines = await db.MsBilledLines.AsNoTracking()
            .Where(l => l.PeriodStart <= periodEnd && l.PeriodEnd >= periodStart)
            .ToListAsync(ct);
        var revenue = await billing.GetBilledLicensesAsync(periodStart, periodEnd, ct);

        var organizationIds = costLines.Where(l => l.OrganizationId != null).Select(l => l.OrganizationId!.Value)
            .Concat(revenue.Select(r => r.OrganizationId))
            .Distinct()
            .ToList();
        var names = await customers.GetOrganizationNamesAsync(organizationIds, ct);
        var revenueByOrganization = revenue.GroupBy(r => r.OrganizationId).ToDictionary(g => g.Key, g => g.Sum(r => r.Amount));

        var rows = new List<ReconciliationRow>();
        foreach (var group in costLines.GroupBy(l => l.OrganizationId))
        {
            var cost = group.Sum(l => l.Total);
            var billed = group.Key is { } id ? revenueByOrganization.GetValueOrDefault(id) : 0m;
            var offersWithoutRevenue = billed > 0
                ? []
                : group.Select(l => l.OfferName ?? l.OfferId).Distinct(StringComparer.OrdinalIgnoreCase).Take(5).ToList();
            rows.Add(new ReconciliationRow(
                group.Key,
                group.Key is { } organizationId
                    ? names.GetValueOrDefault(organizationId, "—")
                    : group.Select(l => l.CspCustomerName).FirstOrDefault(n => n is { Length: > 0 }) ?? "—",
                decimal.Round(cost, 2),
                decimal.Round(billed, 2),
                decimal.Round(billed - cost, 2),
                billed == 0 ? 0 : decimal.Round((billed - cost) / billed * 100m, 1),
                group.Count(),
                billed == 0 && cost > 0,
                offersWithoutRevenue));
        }

        // Customers billed for licences without a Microsoft cost line are listed too; that is the other half of a mismatch.
        foreach (var (organizationId, amount) in revenueByOrganization.Select(pair => (pair.Key, pair.Value)))
        {
            if (rows.Exists(r => r.OrganizationId == organizationId))
            {
                continue;
            }

            rows.Add(new ReconciliationRow(
                organizationId, names.GetValueOrDefault(organizationId, "—"), 0m, decimal.Round(amount, 2),
                decimal.Round(amount, 2), 100m, 0, false, []));
        }

        var currency = costLines.Select(l => l.Currency).FirstOrDefault() ?? "NOK";
        return new ReconciliationReport(
            periodStart,
            periodEnd,
            decimal.Round(costLines.Sum(l => l.Total), 2),
            decimal.Round(revenue.Sum(r => r.Amount), 2),
            decimal.Round(revenue.Sum(r => r.Amount) - costLines.Sum(l => l.Total), 2),
            currency,
            costLines.Count,
            rows.OrderBy(r => r.NotBilled ? 0 : 1).ThenByDescending(r => r.MicrosoftCost).ToList());
    }

    /// <summary>The periods that have Microsoft cost lines, newest first — what the report's month picker offers.</summary>
    public async Task<IReadOnlyList<string>> GetReconciliationPeriodsAsync(CancellationToken ct)
    {
        var periods = await db.MsBilledLines.AsNoTracking().Select(l => l.PeriodStart).Distinct().ToListAsync(ct);
        return periods
            .OrderByDescending(p => p)
            .Select(p => p.ToString("yyyy-MM", CultureInfo.InvariantCulture))
            .Distinct(StringComparer.Ordinal)
            .Take(24)
            .ToList();
    }

    /// <summary>Products behind the SKUs, so usage can be shown next to what the customer is billed for.</summary>
    public Task<IReadOnlyDictionary<string, ProductRef>> ProductsBySkuAsync(IReadOnlyCollection<string> skus, CancellationToken ct) =>
        catalog.FindProductsByOfferIdAsync(skus, ct);
}
