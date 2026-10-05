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
        return
        [
            Signal("unbilled", "Unbilled", pendingCount, pendingSince, "ReviewOverdueCharges"),
            Signal("reconciliation", "ReconciliationRequired", uncertainCount, uncertainSince, "VerifyExternalEffect"),
            Signal("legacy", "LegacyUnresolved", legacyCount, legacySince, "ReviewLegacyCharges"),
            Signal("conflicts", "BillingConflict", conflictCount, conflictSince, "ResolveBillingConflicts"),
        ];
    }

    private static OperationalSignal Signal(string key, string kind, int count, DateTimeOffset? since, string impact) =>
        new($"billing:{key}", "Financial", "billing", kind, since, count, impact,
            "docs/runbooks/15-monitoring.md#financial", Permissions.FinanceRead);
}
