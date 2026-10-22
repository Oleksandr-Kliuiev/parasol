using Crm.Authorization;
using Crm.Billing.Contracts;
using Crm.Billing.Domain;
using Crm.Billing.Persistence;
using Crm.SharedKernel.Operations;
using Microsoft.EntityFrameworkCore;

namespace Crm.Billing.Features;

/// <summary>Aggregate finance warnings, without amounts, customer names or descriptions.</summary>
public sealed class BillingOperationalSignals(BillingDbContext db, TimeProvider time) : IOperationalSignalSource
{
    /// <summary>
    /// The anomaly codes of a basis built from a stale reading, no daily device count, an incomplete hours import, or (M43) no count of
    /// Huntress agents or CloudAlly seats. Matched as text in the stored anomalies, so no code may contain another.
    /// </summary>
    private static readonly string[] EstimatedCodes =
        ["BIL_STALE_QUANTITY", "BIL_NO_DEVICE_SNAPSHOT", "BIL_INCOMPLETE_HOURS", "BIL_NO_AGENT_READING", "BIL_NO_SEAT_READING"];

    public async Task<IReadOnlyList<OperationalSignal>> ReadAsync(CancellationToken cancellationToken)
    {
        var today = DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(time.GetUtcNow(), TimeZoneInfo.FindSystemTimeZoneById("Europe/Oslo")).DateTime);
        var monthStart = new DateOnly(today.Year, today.Month, 1);
        // Pending items from a previous calendar month deserve review; this is a warning, never an automatic invoice.
        var pending = db.PendingCharges.AsNoTracking().Where(c => c.InvoicedBasisId == null && c.ChargeableFrom < monthStart);
        var pendingCount = await pending.CountAsync(cancellationToken);
        var pendingSince = await pending.Select(c => (DateTimeOffset?)c.CreatedAt).MinAsync(cancellationToken);
        var uncertain = db.BillingBases.AsNoTracking().Where(b => b.Status == BillingBasisStatus.ReconciliationRequired);
        var uncertainCount = await uncertain.CountAsync(cancellationToken);
        var uncertainSince = await uncertain.Select(b => (DateTimeOffset?)b.CreatedAt).MinAsync(cancellationToken);
        var legacy = db.Charges.AsNoTracking().Where(c => c.Status == ChargeStatus.LegacyUnresolved);
        var legacyCount = await legacy.CountAsync(cancellationToken);
        var legacySince = await legacy.Select(c => (DateTimeOffset?)c.CreatedAt).MinAsync(cancellationToken);
        var conflicts = db.BillingLines.AsNoTracking().Where(l => l.Conflict != BillingLineConflict.None &&
            db.BillingBases.Any(b => b.Id == l.BasisId && b.Status != BillingBasisStatus.Cancelled && b.Status != BillingBasisStatus.Exported));
        var conflictCount = await conflicts.CountAsync(cancellationToken);
        var conflictSince = await conflicts.Select(l => (DateTimeOffset?)l.CreatedAt).MinAsync(cancellationToken);
        // Open bases that are to be billed from a quantity or hours that may be stale or incomplete (DEV-19). A count only: Finance
        // decides whether such a basis may be billed, the signal just makes sure nobody overlooks it. It clears when the basis is
        // exported or cancelled, or a re-collect finds fresh readings.
        var (stale, noSnapshot, hours, noAgents, noSeats) = (EstimatedCodes[0], EstimatedCodes[1], EstimatedCodes[2], EstimatedCodes[3], EstimatedCodes[4]);
        var estimated = db.BillingBases.AsNoTracking().Where(b =>
            b.Status != BillingBasisStatus.Exported && b.Status != BillingBasisStatus.Cancelled && b.AnomaliesJson != null &&
            (b.AnomaliesJson.Contains(stale) || b.AnomaliesJson.Contains(noSnapshot) || b.AnomaliesJson.Contains(hours) ||
             b.AnomaliesJson.Contains(noAgents) || b.AnomaliesJson.Contains(noSeats)));
        var estimatedCount = await estimated.CountAsync(cancellationToken);
        var estimatedSince = await estimated.Select(b => (DateTimeOffset?)b.CreatedAt).MinAsync(cancellationToken);
        return
        [
            Signal("unbilled", "Unbilled", pendingCount, pendingSince, "ReviewOverdueCharges"),
            Signal("reconciliation", "ReconciliationRequired", uncertainCount, uncertainSince, "VerifyExternalEffect"),
            Signal("legacy", "LegacyUnresolved", legacyCount, legacySince, "ReviewLegacyCharges"),
            Signal("conflicts", "BillingConflict", conflictCount, conflictSince, "ResolveBillingConflicts"),
            Signal("estimated", "EstimatedQuantity", estimatedCount, estimatedSince, "ReviewEstimatedQuantities"),
        ];
    }

    private static OperationalSignal Signal(string key, string kind, int count, DateTimeOffset? since, string impact) =>
        new($"billing:{key}", "Financial", "billing", kind, since, count, impact,
            "docs/runbooks/15-monitoring.md#financial", Permissions.FinanceRead);
}
