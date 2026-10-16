using Crm.Authorization;
using Crm.Billing.Contracts;
using Crm.Licensing.Contracts;
using Crm.Licensing.Persistence;
using Crm.SharedKernel.Operations;
using Microsoft.EntityFrameworkCore;

namespace Crm.Licensing.Features;

public sealed class LicensingOperationalSignals(LicensingDbContext db, IBillingApi billing, TimeProvider time) : IOperationalSignalSource
{
    public async Task<IReadOnlyList<OperationalSignal>> ReadAsync(CancellationToken cancellationToken)
    {
        var unmapped = db.CspSubscriptions.AsNoTracking().Where(s => s.Status == SubscriptionStatus.Active &&
            (s.OrganizationId == null || s.ProductId == null));
        var unmappedCount = await unmapped.CountAsync(cancellationToken);
        var unmappedSince = await unmapped.Select(s => (DateTimeOffset?)s.SyncedAt).MinAsync(cancellationToken);

        // Compare the preceding calendar month, matching the reconciliation report's customer-level definition.
        // Cost and revenue are used only in memory to decide a count and never leave this contributor.
        var today = DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(time.GetUtcNow(), TimeZoneInfo.FindSystemTimeZoneById("Europe/Oslo")).DateTime);
        var monthEnd = new DateOnly(today.Year, today.Month, 1).AddDays(-1);
        var monthStart = new DateOnly(monthEnd.Year, monthEnd.Month, 1);
        var costs = await db.MsBilledLines.AsNoTracking()
            .Where(l => l.PeriodStart <= monthEnd && l.PeriodEnd >= monthStart && l.Currency == "NOK" && l.OrganizationId != null)
            .GroupBy(l => l.OrganizationId!.Value)
            .Select(g => new { OrganizationId = g.Key, Cost = g.Sum(l => l.Total), Since = g.Min(l => l.ImportedAt) })
            .ToListAsync(cancellationToken);
        var revenue = costs.Count == 0 ? [] : await billing.GetBilledLicensesAsync(monthStart, monthEnd, cancellationToken);
        var revenueByCustomer = revenue.GroupBy(r => r.OrganizationId).ToDictionary(g => g.Key, g => g.Sum(r => r.Amount));
        var losses = costs.Where(c => c.Cost > revenueByCustomer.GetValueOrDefault(c.OrganizationId)).ToList();
        return
        [
            new("licensing:unmapped", "Integration", "licensing", "UnmappedSubscriptions", unmappedSince,
                unmappedCount, "MapSubscriptions", "docs/runbooks/15-monitoring.md#mapping"),
            new("licensing:discrepancy", "Financial", "licensing", "LicenseDiscrepancy", losses.Count == 0 ? null : losses.Min(c => c.Since),
                losses.Count, "ReviewPreviousMonthLicenseMargin", "docs/runbooks/15-monitoring.md#financial", Permissions.FinanceCostRead),
        ];
    }
}
