using System.Globalization;
using Crm.Integrations.Core.Persistence;
using Crm.SharedKernel.Operations;
using Microsoft.EntityFrameworkCore;

namespace Crm.Integrations.Core;

/// <summary>
/// The outbound queue's part in a restore (DEV-13, ADR-021). An operation the journal shows attempted after the restore point
/// may already have reached PowerOffice or Atera although the restored copy still has it waiting: applied, the reconciliation
/// fails it with the evidence, so nothing sends it again until a person checked the external system and retried or cancelled it.
/// </summary>
internal sealed class IntegrationRestoreParticipant(IntegrationDbContext db, TimeProvider time) : IRestoreParticipant
{
    public string Area => "integrations";

    public Task<int> InFlightAsync(CancellationToken cancellationToken)
    {
        var now = time.GetUtcNow();
        return db.OutboundOperations.AsNoTracking().CountAsync(o => o.Status == OutboundStatus.Pending && o.LockedUntil > now, cancellationToken);
    }

    public async Task<IReadOnlyList<RestoreLine>> CheckAsync(DateTimeOffset restorePoint, CancellationToken cancellationToken)
    {
        var lines = new List<RestoreLine>();
        var waiting = await db.OutboundOperations.AsNoTracking()
            .Where(o => o.Status == OutboundStatus.Pending)
            .GroupBy(o => o.System)
            .Select(g => new { System = g.Key, Count = g.Count() })
            .ToListAsync(cancellationToken);
        foreach (var system in waiting.OrderBy(w => w.System, StringComparer.Ordinal))
        {
            lines.Add(new RestoreLine(Area, $"outbound {system.System}",
                $"{system.Count} operation(s) wait to be sent when the maintenance ends.", null, false));
        }

        foreach (var paused in await db.IntegrationSwitches.AsNoTracking().Where(s => s.IsPaused).Select(s => s.System).ToListAsync(cancellationToken))
        {
            lines.Add(new RestoreLine(Area, paused, "The integration is paused in the restored copy.", "Resume it on the integrations page when it should run again.", true));
        }

        foreach (var cursor in await db.SyncCursors.AsNoTracking().OrderBy(c => c.System).ThenBy(c => c.Stream).ToListAsync(cancellationToken))
        {
            lines.Add(new RestoreLine(Area, $"cursor {cursor.System}/{cursor.Stream}",
                string.Create(CultureInfo.InvariantCulture, $"Last moved {cursor.UpdatedAt:yyyy-MM-dd HH:mm} UTC; the next sync reads again from there."),
                null, false));
        }

        return lines;
    }

    public async Task<IReadOnlyList<RestoreLine>> ReconcileAsync(
        DateTimeOffset restorePoint, IReadOnlyList<ExternalEffectEntry> effects, bool apply, CancellationToken cancellationToken)
    {
        var attempts = effects.Where(e => e.OperationId is not null).GroupBy(e => e.OperationId!.Value).ToList();
        if (attempts.Count == 0)
        {
            return [];
        }

        var ids = attempts.Select(a => a.Key).ToList();
        var operations = await db.OutboundOperations.Where(o => ids.Contains(o.Id)).ToDictionaryAsync(o => o.Id, cancellationToken);
        var lines = new List<RestoreLine>();
        foreach (var attempt in attempts)
        {
            if (!operations.TryGetValue(attempt.Key, out var operation))
            {
                // Queued after the restore point: the copy never had it, the external system may have its effect.
                if (ExternalEffects.MayExist(attempt))
                {
                    var first = attempt.OrderBy(e => e.At).First();
                    lines.Add(new RestoreLine(Area, $"{first.System}/{first.Kind} {first.EntityType} {first.EntityId}",
                        Describe(attempt, "an operation the restored copy does not have"),
                        $"Check {first.System}: the CRM may queue this change again and finds an existing record by its reference.", true));
                }

                continue;
            }

            var own = attempt.Where(e => e.Kind == operation.Operation).ToList();
            if (!ExternalEffects.MayExist(own) || operation.Status != OutboundStatus.Pending)
            {
                continue;
            }

            var finding = Describe(own, $"operation {operation.Id}");
            if (apply)
            {
                operation.Status = OutboundStatus.Failed;
                operation.LastError = $"Held after a database restore: {finding} Check {operation.System}, then retry or cancel.";
                operation.LockedUntil = null;
                operation.LeaseOwner = null;
                operation.CompletedAt = time.GetUtcNow();
                await HoldActionAsync(operation, cancellationToken);
            }

            lines.Add(new RestoreLine(Area, $"{operation.System}/{operation.Operation} {operation.EntityType} {operation.EntityId}",
                finding, apply ? "Held (failed) until a person retries or cancels it on the integrations page." : "Would be held.", true));
        }

        if (apply)
        {
            await db.SaveChangesAsync(cancellationToken);
        }

        return lines;
    }

    /// <summary>
    /// A vendor action whose operation is held may have reached the vendor (M39.1): it becomes uncertain, so a person checks there and
    /// settles it instead of anything sending it again; the person who asked hears of it once the outbox runs after the maintenance.
    /// </summary>
    private async Task HoldActionAsync(OutboundOperation operation, CancellationToken cancellationToken)
    {
        if (operation.EntityType != Actions.VendorAction.EntityType ||
            await db.VendorActions.SingleOrDefaultAsync(a => a.Id == operation.EntityId, cancellationToken) is not { IsFinished: false } action)
        {
            return;
        }

        action.Status = Actions.VendorActionStatus.Uncertain;
        action.MayHaveSent = true;
        action.OutcomeCode = "VND_HELD_AFTER_RESTORE";
        action.Outcome = "Held after a database restore: it may have reached the vendor; check there and settle it.";
        action.CompletedAt = time.GetUtcNow();
        db.OutboxMessages.Add(Actions.VendorActionNotices.Message(action.Id, time.GetUtcNow()));
    }

    private static string Describe(IEnumerable<ExternalEffectEntry> entries, string what)
    {
        var list = entries.OrderBy(e => e.At).ToList();
        var reference = ExternalEffects.LatestReference(list);
        var sent = list.Any(e => e.Phase == EffectPhase.Sent);
        return string.Create(CultureInfo.InvariantCulture,
            $"The journal shows {what} {(sent ? "sent" : "being sent without an answer")} at {list[^1].At:yyyy-MM-dd HH:mm} UTC{(reference is null ? "" : $" (reference {reference})")}.");
    }
}
