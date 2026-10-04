using System.Globalization;
using Crm.Billing.Contracts;
using Crm.Billing.Domain;
using Crm.Billing.Persistence;
using Crm.SharedKernel.Operations;
using Microsoft.EntityFrameworkCore;

namespace Crm.Billing.Features;

/// <summary>
/// Billing's part in a restore (DEV-13, ADR-021). A sales order the journal shows sent — or sent without an answer — after the
/// restore point is unknown to the restored copy, whose basis may still wait to be sent: applied, the reconciliation holds that
/// basis for Finance with the order number PowerOffice reported, so the worker never sends it a second time (ADR-013). The
/// order handler checks the same journal before every send, so a basis approved again later is held too.
/// </summary>
internal sealed class BillingRestoreParticipant(BillingDbContext db, IBillingApi billing) : IRestoreParticipant
{
    private const string BasisType = "BillingBasis";
    private const string SalesOrderEffect = "sales-order";

    public string Area => "billing";

    public Task<int> InFlightAsync(CancellationToken cancellationToken) => Task.FromResult(0);

    public async Task<IReadOnlyList<RestoreLine>> CheckAsync(DateTimeOffset restorePoint, CancellationToken cancellationToken)
    {
        var lines = new List<RestoreLine>();
        var bases = await db.BillingBases.AsNoTracking()
            .Where(b => b.Status == BillingBasisStatus.Approved || b.Status == BillingBasisStatus.ReconciliationRequired)
            .GroupBy(b => b.Status)
            .Select(g => new { Status = g.Key, Count = g.Count() })
            .ToListAsync(cancellationToken);
        foreach (var group in bases)
        {
            lines.Add(group.Status == BillingBasisStatus.Approved
                ? new RestoreLine(Area, "bases waiting to be sent", $"{group.Count} approved basis(es) will be sent to PowerOffice when the maintenance ends.",
                    "Finance compares them with the orders PowerOffice received after the restore point (runbook 03).", true)
                : new RestoreLine(Area, "bases held for reconciliation", $"{group.Count} basis(es) wait for Finance to reconcile them with PowerOffice.",
                    "Reconcile them on the billing run page before closing the run.", true));
        }

        var charges = await db.Charges.AsNoTracking().GroupBy(c => c.Status).Select(g => new { Status = g.Key, Count = g.Count() }).ToListAsync(cancellationToken);
        lines.Add(new RestoreLine(Area, "charges",
            string.Join(", ", charges.OrderBy(c => c.Status).Select(c => string.Create(CultureInfo.InvariantCulture, $"{c.Status} {c.Count}"))) is { Length: > 0 } text
                ? $"Charges by state: {text}."
                : "No charges.",
            null, false));
        return lines;
    }

    public async Task<IReadOnlyList<RestoreLine>> ReconcileAsync(
        DateTimeOffset restorePoint, IReadOnlyList<ExternalEffectEntry> effects, bool apply, CancellationToken cancellationToken)
    {
        var orders = effects.Where(e => e.EntityType == BasisType && e.Kind == SalesOrderEffect).GroupBy(e => e.EntityId).ToList();
        var lines = new List<RestoreLine>();
        foreach (var group in orders)
        {
            // What Finance reconciled in the restored copy is settled; only the attempts after that decision count.
            var checkedAt = await db.ExportAttempts.AsNoTracking()
                .Where(a => a.BasisId == group.Key && a.Result == BillingExportAttempt.Reconciled)
                .MaxAsync(a => (DateTimeOffset?)a.At, cancellationToken);
            var order = group.Where(e => checkedAt is null || e.At > checkedAt).ToList();
            if (!ExternalEffects.MayExist(order))
            {
                continue;
            }

            var reference = ExternalEffects.LatestReference(order);
            var at = order.Max(e => e.At).ToString("yyyy-MM-dd HH:mm 'UTC'", CultureInfo.InvariantCulture);
            var basis = await db.BillingBases.AsNoTracking().SingleOrDefaultAsync(b => b.Id == group.Key, cancellationToken);
            var subject = $"basis {group.Key}";
            var what = reference is null
                ? $"An order request for this basis was sent at {at} without an answer"
                : $"PowerOffice created order {reference} for this basis at {at}";
            switch (basis?.Status)
            {
                case BillingBasisStatus.Approved:
                    if (apply)
                    {
                        await billing.MarkReconciliationRequiredAsync(group.Key, "poweroffice",
                            $"{what} (external effect journal), after the point the database was restored to. Check PowerOffice and reconcile the basis.",
                            "restore", cancellationToken);
                    }

                    lines.Add(new RestoreLine(Area, subject, $"{what}; the restored copy still has it waiting to be sent.",
                        apply ? "Held for reconciliation: Finance confirms the order in PowerOffice." : "Would be held for reconciliation.", true));
                    break;
                case BillingBasisStatus.Exported when basis.OrderNo == reference || reference is null:
                    break;
                case BillingBasisStatus.Exported:
                    lines.Add(new RestoreLine(Area, subject,
                        $"{what}, while the restored copy has order {basis.OrderNo}.", "Finance checks both orders in PowerOffice.", true));
                    break;
                case BillingBasisStatus.ReconciliationRequired:
                    lines.Add(new RestoreLine(Area, subject, $"{what}; the basis already waits for reconciliation.", "Use this order when reconciling.", true));
                    break;
                default:
                    lines.Add(new RestoreLine(Area, subject,
                        basis is null ? $"{what}; the restored copy does not have the basis." : $"{what}; the restored copy has the basis as {basis.Status}.",
                        "Finance decides: if the basis is approved again, the order handler holds it by the journal instead of sending.", true));
                    break;
            }
        }

        return lines;
    }
}
