using System.Text.Json;
using Crm.Infrastructure.Health;
using Crm.Infrastructure.Outbox;
using Crm.Integrations.Core.Persistence;
using Crm.SharedKernel.Operations;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Crm.Integrations.Core.Actions;

/// <summary>
/// Sends due vendor actions in crm-worker (M39.1). It claims an action's outbound operation with a lease (like the outbound job,
/// which leaves <c>action:*</c> operations to it), marks the action <see cref="VendorActionStatus.Sending"/> — a unique index lets
/// one action per target be there — reads the vendor's switches again, journals the attempt and lets the kind's handler read the
/// live state and send. The outcome is saved on the action and its operation in one transaction, by the lease holder only.
/// </summary>
public sealed class VendorActionRunner(
    IServiceScopeFactory scopes,
    TimeProvider time,
    IMaintenanceGate maintenance,
    IExternalEffectJournal journal,
    ILogger<VendorActionRunner> logger)
{
    private static readonly TimeSpan Lease = TimeSpan.FromMinutes(2);

    /// <summary>How long an action waits when another action on its target is being sent.</summary>
    private static readonly TimeSpan TargetBusyPause = TimeSpan.FromSeconds(5);

    private const int Batch = 20;

    public async Task<int> RunDueAsync(CancellationToken cancellationToken)
    {
        if (!await MaySendAsync(cancellationToken))
        {
            return 0;
        }

        List<Guid> due;
        await using (var scope = scopes.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
            var now = time.GetUtcNow();
            // A paused vendor keeps its actions waiting, like its other outbound operations (runbook 05).
            var paused = await db.IntegrationSwitches.AsNoTracking().Where(s => s.IsPaused).Select(s => s.System).ToListAsync(cancellationToken);
            due = await db.OutboundOperations.AsNoTracking()
                .Where(o => o.Status == OutboundStatus.Pending && o.Operation.StartsWith(VendorAction.OperationPrefix) && o.NextAttemptAt <= now &&
                            (o.LockedUntil == null || o.LockedUntil < now) && !paused.Contains(o.System))
                .OrderBy(o => o.NextAttemptAt).ThenBy(o => o.CreatedAt)
                .Select(o => o.Id).Take(Batch).ToListAsync(cancellationToken);
        }

        var processed = 0;
        foreach (var id in due)
        {
            // DEV-13: asked before every action, never from a cache.
            if (!await MaySendAsync(cancellationToken))
            {
                break;
            }

            processed += await RunOneAsync(id, cancellationToken) ? 1 : 0;
        }

        return processed;
    }

    /// <summary>
    /// Runs one due action; false when another run holds it, it is not due, its vendor is paused, or another action on its target is
    /// being sent.
    /// </summary>
    public async Task<bool> RunOneAsync(Guid operationId, CancellationToken cancellationToken)
    {
        await using var scope = scopes.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
        var now = time.GetUtcNow();
        var token = Guid.NewGuid();
        var claimed = await db.OutboundOperations
            .Where(o => o.Id == operationId && o.Status == OutboundStatus.Pending && o.Operation.StartsWith(VendorAction.OperationPrefix) &&
                        o.NextAttemptAt <= now && (o.LockedUntil == null || o.LockedUntil < now) &&
                        !db.IntegrationSwitches.Any(s => s.System == o.System && s.IsPaused))
            .ExecuteUpdateAsync(s => s.SetProperty(o => o.LockedUntil, now + Lease).SetProperty(o => o.LeaseOwner, token), cancellationToken);
        if (claimed == 0)
        {
            return false;
        }

        // Claimed after a fresh look at the maintenance switch: what the attempt writes is recorded even should maintenance begin.
        using var inFlight = MaintenanceScope.AllowWrites("vendor-action-in-flight");
        var operation = await db.OutboundOperations.AsNoTracking().SingleAsync(o => o.Id == operationId, cancellationToken);
        var action = await db.VendorActions.SingleOrDefaultAsync(a => a.Id == operation.EntityId, cancellationToken);
        if (action is null || action.IsFinished)
        {
            // Settled some other way (a restore reconciliation, a person): the operation follows the action and nothing is sent.
            await SettleAsync(db, operationId, token, null, action is { Status: VendorActionStatus.Succeeded or VendorActionStatus.Skipped or VendorActionStatus.Simulated }
                ? OutboundStatus.Succeeded : OutboundStatus.Cancelled, "The action was already settled.", cancellationToken);
            return true;
        }

        action.Status = VendorActionStatus.Sending;
        action.StartedAt ??= now;
        action.Attempts++;
        try
        {
            await db.SaveChangesAsync(cancellationToken);
        }
        catch (DbUpdateException ex) when (ex.InnerException is SqlException { Number: 2601 or 2627 })
        {
            // Another action on the same target is being sent: this one waits a moment, uncounted.
            db.ChangeTracker.Clear();
            await db.OutboundOperations.Where(o => o.Id == operationId && o.LeaseOwner == token).ExecuteUpdateAsync(s => s
                .SetProperty(o => o.LockedUntil, (DateTimeOffset?)null).SetProperty(o => o.LeaseOwner, (Guid?)null)
                .SetProperty(o => o.NextAttemptAt, time.GetUtcNow() + TargetBusyPause), cancellationToken);
            return false;
        }

        var handler = scope.ServiceProvider.GetServices<IVendorActionHandler>()
            .SingleOrDefault(h => h.System == action.System && h.Kind == action.Kind && h.TargetType == action.TargetType);
        var switches = scope.ServiceProvider.GetServices<IVendorActionGate>().SingleOrDefault(g => g.System == action.System)?.Read();
        if (await AttemptAsync(action, operation, handler, switches, token, cancellationToken) is { } result)
        {
            await SettleAsync(db, operationId, token, (action, handler, result), null, null, cancellationToken);
        }

        return true;
    }

    /// <summary>One attempt; null when the lease was lost and another run decides.</summary>
    private async Task<VendorActionResult?> AttemptAsync(
        VendorAction action, OutboundOperation operation, IVendorActionHandler? handler, VendorActionSwitches? switches, Guid token, CancellationToken ct)
    {
        if (handler is null)
        {
            return VendorActionResult.Failed("VND_KIND_UNKNOWN", "This kind of action is no longer known to the CRM; nothing was sent.");
        }

        if (VendorActionRules.CheckSwitches(switches, action.Kind, action.ExternalCustomerId, credentials: true) is { } block)
        {
            return VendorActionResult.Rejected(block.Code, block.Message);
        }

        var simulate = switches!.DryRun;
        // An attempt that may have reached the vendor without its outcome being saved (no answer, a worker that stopped): a kind
        // whose repeat would double its effect is handed to a person instead of being sent again.
        var earlier = (await journal.ForEntityAsync(VendorAction.EntityType, action.Id, ct)).Where(e => e.System == action.System).ToList();
        if (!simulate && !handler.IsRepeatable && ExternalEffects.MayExist(earlier))
        {
            return VendorActionResult.Uncertain("VND_EARLIER_ATTEMPT", "An earlier attempt may have reached the vendor without an answer; check there before asking again.");
        }

        ExternalEffectEntry? effect = null;
        if (!simulate)
        {
            try
            {
                effect = await journal.BeginAsync(new ExternalEffect(action.System, operation.Operation, VendorAction.EntityType, action.Id, operation.Id), ct);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                // Maintenance began, or the journal cannot be written: nothing may be sent, so the action waits.
                logger.LogInformation("Vendor action {ActionId} waits: its attempt cannot be journaled ({ErrorType})", action.Id, ex.GetType().Name);
                return VendorActionResult.Later("VND_WAITING", "The CRM could not record the attempt (maintenance or storage); it is tried again.");
            }
        }

        VendorActionResult result;
        await using (var lease = new LeaseRenewal(Lease, time, c => RenewAsync(operation.Id, token, c), logger, ct))
        {
            try
            {
                using var parameters = JsonDocument.Parse(action.Parameters);
                result = await handler.ExecuteAsync(new VendorActionContext(action, parameters.RootElement, simulate), lease.Token);
            }
            catch (OperationCanceledException) when (lease.Lost)
            {
                logger.LogWarning("Vendor action {ActionId}: another run took it over; its outcome counts", action.Id);
                return null;
            }
            catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
            {
                // A timeout or a dropped connection after the request may have left: the outcome is unknown.
                logger.LogWarning("Vendor action {ActionId} ({System}/{Kind}) got no clear answer ({ErrorType})", action.Id, action.System, action.Kind, ex.GetType().Name);
                action.MayHaveSent |= !simulate;
                result = handler.IsRepeatable || simulate
                    ? VendorActionResult.Later("VND_NO_ANSWER", "The vendor gave no clear answer; the live state is read again before the next attempt.")
                    : VendorActionResult.Uncertain("VND_NO_ANSWER", "The vendor gave no clear answer; check there whether it happened.");
            }
        }

        if (effect is not null && Phase(result, action.MayHaveSent) is { } phase)
        {
            await journal.CompleteAsync(effect, phase, result.Reference, ct);
        }

        return result;
    }

    /// <summary>The journal's outcome; null leaves the attempt open, because the effect may exist.</summary>
    private static EffectPhase? Phase(VendorActionResult result, bool mayHaveSent) => result switch
    {
        { Retry: true } => mayHaveSent ? null : EffectPhase.Failed,
        { Status: VendorActionStatus.Succeeded } => EffectPhase.Sent,
        { Status: VendorActionStatus.Skipped } => EffectPhase.Skipped,
        { Status: VendorActionStatus.Uncertain } => null,
        _ => EffectPhase.Failed,
    };

    /// <summary>
    /// Saves the outcome on the action and its operation together, while the lease holds. An attempt that should be repeated puts
    /// the action back in the queue with a pause, until <see cref="VendorActionRules.MaxAttempts"/>.
    /// </summary>
    private async Task SettleAsync(
        IntegrationDbContext db, Guid operationId, Guid token, (VendorAction Action, IVendorActionHandler? Handler, VendorActionResult Result)? attempt,
        OutboundStatus? orphanStatus, string? orphanMessage, CancellationToken ct)
    {
        var now = time.GetUtcNow();
        OutboundStatus? final = orphanStatus;
        DateTimeOffset? next = null;
        string? message = orphanMessage;
        var attempts = 0;
        if (attempt is { } done)
        {
            var (action, _, result) = done;
            var outcome = result.Retry && action.Attempts >= VendorActionRules.MaxAttempts
                ? action.MayHaveSent
                    ? VendorActionResult.Uncertain("VND_NO_ANSWER", "The vendor gave no clear answer after several attempts; check there whether it happened.")
                    : VendorActionResult.Failed("VND_VENDOR_UNAVAILABLE", "The vendor could not be reached after several attempts; nothing was sent.")
                : result;
            action.OutcomeCode = outcome.Code;
            action.Outcome = outcome.Message.Length > 500 ? outcome.Message[..500] : outcome.Message;
            action.Reference = outcome.Reference ?? action.Reference;
            attempts = action.Attempts;
            message = action.Outcome;
            if (outcome.Retry)
            {
                action.Status = VendorActionStatus.Queued;
                next = now + VendorActionRules.Backoff(action.Attempts);
            }
            else
            {
                action.Status = outcome.Status;
                action.CompletedAt = now;
                final = outcome.Status switch
                {
                    VendorActionStatus.Succeeded or VendorActionStatus.Simulated or VendorActionStatus.Skipped => OutboundStatus.Succeeded,
                    VendorActionStatus.Rejected => OutboundStatus.Cancelled,
                    _ => OutboundStatus.Failed,
                };
            }
        }

        await db.Database.CreateExecutionStrategy().ExecuteAsync(async () =>
        {
            await using var transaction = await db.Database.BeginTransactionAsync(ct);
            var updated = await db.OutboundOperations.Where(o => o.Id == operationId && o.LeaseOwner == token).ExecuteUpdateAsync(s =>
            {
                s.SetProperty(o => o.LockedUntil, (DateTimeOffset?)null).SetProperty(o => o.LeaseOwner, (Guid?)null);
                if (attempt is not null)
                {
                    s.SetProperty(o => o.Attempts, attempts);
                }

                if (final is { } status)
                {
                    var failed = status == OutboundStatus.Failed;
                    s.SetProperty(o => o.Status, status).SetProperty(o => o.CompletedAt, now)
                        .SetProperty(o => o.Result, failed ? null : message).SetProperty(o => o.LastError, failed ? message : null);
                }
                else if (next is { } at)
                {
                    s.SetProperty(o => o.NextAttemptAt, at).SetProperty(o => o.LastError, message);
                }
            }, ct);
            if (updated == 0)
            {
                logger.LogWarning("Vendor action operation {OperationId}: another run took it over; this run leaves its outcome alone", operationId);
                return;
            }

            await db.SaveChangesAsync(ct);
            await transaction.CommitAsync(ct);
        });
    }

    private async Task<bool> RenewAsync(Guid id, Guid token, CancellationToken cancellationToken)
    {
        using var inFlight = MaintenanceScope.AllowWrites("vendor-action-in-flight");
        await using var scope = scopes.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
        var lease = time.GetUtcNow() + Lease;
        return await db.OutboundOperations
            .Where(o => o.Id == id && o.LeaseOwner == token && o.Status == OutboundStatus.Pending)
            .ExecuteUpdateAsync(s => s.SetProperty(o => o.LockedUntil, lease), cancellationToken) == 1;
    }

    /// <summary>Normal operation, read from the store now; an unreadable state sends nothing (DEV-13: fail closed for effects).</summary>
    private async Task<bool> MaySendAsync(CancellationToken cancellationToken)
    {
        try
        {
            return !(await maintenance.FreshAsync(cancellationToken)).IsReadOnly;
        }
        catch (MaintenanceStateUnavailableException ex)
        {
            logger.LogWarning("Vendor actions wait: the maintenance state cannot be read ({Error})", ex.InnerException?.GetType().Name);
            return false;
        }
    }
}

/// <summary>The loop of crm-worker that sends vendor actions every five seconds (M39.1), with its own heartbeat.</summary>
public sealed class VendorActionLoop(VendorActionRunner runner, IServiceScopeFactory scopes, TimeProvider time, ILogger<VendorActionLoop> logger) : BackgroundService
{
    public const string HeartbeatComponent = "actions";
    public static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(5);
    private static readonly TimeSpan BeatInterval = TimeSpan.FromSeconds(30);
    private DateTimeOffset _lastBeat = DateTimeOffset.MinValue;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(PollInterval, time);
        do
        {
            var sent = 0;
            try
            {
                sent = await runner.RunDueAsync(stoppingToken);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                // The round ends; the next one starts on time, so an outage does not stop the loop.
                logger.LogError("A round of vendor actions failed ({ErrorType})", ex.GetType().Name);
            }

            await BeatAsync(sent, stoppingToken);
        }
        while (await timer.WaitForNextTickAsync(stoppingToken));
    }

    private async Task BeatAsync(int sent, CancellationToken cancellationToken)
    {
        var now = time.GetUtcNow();
        if (now - _lastBeat < BeatInterval && sent == 0)
        {
            return;
        }

        try
        {
            await using var scope = scopes.CreateAsyncScope();
            await scope.ServiceProvider.GetRequiredService<IWorkerHeartbeat>().BeatAsync(HeartbeatComponent, $"round finished, {sent} sent", cancellationToken);
            _lastBeat = now;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogWarning("The vendor action loop could not store its heartbeat ({ErrorType})", ex.GetType().Name);
        }
    }
}
