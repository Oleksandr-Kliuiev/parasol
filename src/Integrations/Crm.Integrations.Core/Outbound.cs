using Crm.Infrastructure.Outbox;
using Crm.Integrations.Core.Persistence;
using Crm.SharedKernel.Domain;
using Crm.SharedKernel.Operations;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Crm.Integrations.Core;

/// <summary>
/// What a handler did. <paramref name="Reference"/> is the external system's identifier of what exists now (an order number),
/// kept in the external effect journal (DEV-13).
/// </summary>
public sealed record OutboundResult(string? Message, string? Reference = null)
{
    public static readonly OutboundResult NothingToDo = new("No changes to push.");
}

/// <summary>Executes one kind of outbound operation, e.g. <c>poweroffice</c> / <c>update-customer</c>. Must be idempotent.</summary>
public interface IOutboundHandler
{
    string System { get; }

    string Operation { get; }

    Task<OutboundResult> ExecuteAsync(OutboundOperation operation, CancellationToken cancellationToken);
}

/// <summary>An error that will not go away on retry (validation, missing data): the operation fails immediately.</summary>
public sealed class PermanentOutboundException(string message) : Exception(message);

public sealed class OutboundQueue(IntegrationDbContext db, TimeProvider timeProvider)
{
    /// <summary>
    /// Queues an operation unless one for the same system, operation and entity is still pending: handlers read the latest
    /// CRM state when they run, so a pending operation already covers later changes.
    /// </summary>
    public async Task<OutboundOperation> EnqueueAsync(
        string system, string operation, string entityType, Guid entityId, Guid? requestedBy, CancellationToken cancellationToken)
    {
        // First, not single: two events of one entity handled at the same moment can each queue one, and both are harmless.
        var pending = await db.OutboundOperations.OrderBy(o => o.CreatedAt).FirstOrDefaultAsync(o =>
            o.System == system && o.Operation == operation && o.EntityId == entityId && o.Status == OutboundStatus.Pending, cancellationToken);
        if (pending is not null)
        {
            return pending;
        }

        var now = timeProvider.GetUtcNow();
        var item = new OutboundOperation
        {
            Id = SequentialId.New(now),
            System = system,
            Operation = operation,
            EntityType = entityType,
            EntityId = entityId,
            IdempotencyKey = $"{system}:{operation}:{entityId}:{now.ToUnixTimeMilliseconds()}",
            Status = OutboundStatus.Pending,
            CreatedAt = now,
            RequestedBy = requestedBy,
            NextAttemptAt = now,
        };
        db.OutboundOperations.Add(item);
        await db.SaveChangesAsync(cancellationToken);
        return item;
    }
}

/// <summary>
/// Runs due outbound operations with exponential backoff; after <see cref="OutboundOperation.MaxAttempts"/> they become dead
/// letters. A run claims an operation with a lease and a token of its own and renews the lease while the handler works; only
/// the holder of the token records the outcome, so a run whose lease was taken over cannot overwrite what the new holder
/// decided (DEV-07). Repeating an external effect is still possible after an uncertain answer: handlers check the live
/// external record or hand the case to reconciliation instead of trusting a local flag.
/// </summary>
public sealed class OutboundProcessorJob(
    IServiceScopeFactory scopeFactory,
    TimeProvider timeProvider,
    IMaintenanceGate maintenance,
    IExternalEffectJournal journal,
    ILogger<OutboundProcessorJob> logger)
{
    public const string JobId = "outbound-operations";
    private static readonly TimeSpan Lease = TimeSpan.FromMinutes(5);

    public async Task<int> RunAsync(CancellationToken cancellationToken)
    {
        await using var scope = scopeFactory.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
        var now = timeProvider.GetUtcNow();
        // A paused system keeps its queue: the operations wait instead of failing against a system we are holding (runbook 05).
        var paused = await db.IntegrationSwitches.AsNoTracking().Where(s => s.IsPaused).Select(s => s.System).ToListAsync(cancellationToken);
        var due = await db.OutboundOperations.AsNoTracking()
            .Where(o => o.Status == OutboundStatus.Pending && o.NextAttemptAt <= now && (o.LockedUntil == null || o.LockedUntil < now) &&
                        !paused.Contains(o.System))
            .OrderBy(o => o.CreatedAt)
            .Select(o => o.Id)
            .Take(100)
            .ToListAsync(cancellationToken);

        int processed = 0;
        foreach (var id in due)
        {
            // DEV-13: asked before every operation, never from a cache — maintenance that began a moment ago stops this run here.
            if (!await MaySendAsync(cancellationToken))
            {
                break;
            }

            if (await ClaimAsync(db, id, cancellationToken) is not { } token)
            {
                continue;
            }

            await ExecuteClaimedAsync(id, token, cancellationToken);
            processed++;
        }

        return processed;
    }

    /// <summary>Runs one pending operation now, whatever its next attempt time; false when another run holds it.</summary>
    public async Task<bool> ExecuteOneAsync(Guid operationId, CancellationToken cancellationToken)
    {
        if (!await MaySendAsync(cancellationToken))
        {
            return false;
        }

        await using var scope = scopeFactory.CreateAsyncScope();
        if (await ClaimAsync(scope.ServiceProvider.GetRequiredService<IntegrationDbContext>(), operationId, cancellationToken) is not { } token)
        {
            return false;
        }

        await ExecuteClaimedAsync(operationId, token, cancellationToken);
        return true;
    }

    private async Task<Guid?> ClaimAsync(IntegrationDbContext db, Guid id, CancellationToken cancellationToken)
    {
        var now = timeProvider.GetUtcNow();
        var token = Guid.NewGuid();
        var lease = now.Add(Lease);
        var claimed = await db.OutboundOperations
            .Where(o => o.Id == id && o.Status == OutboundStatus.Pending && (o.LockedUntil == null || o.LockedUntil < now))
            .ExecuteUpdateAsync(s => s.SetProperty(o => o.LockedUntil, lease).SetProperty(o => o.LeaseOwner, token), cancellationToken);
        return claimed == 1 ? token : null;
    }

    private async Task ExecuteClaimedAsync(Guid operationId, Guid token, CancellationToken cancellationToken)
    {
        // DEV-13: claimed after a fresh look at the switch, the operation is under way. Should maintenance begin meanwhile, what
        // the handler writes and the outcome are still recorded — an order that left must not be forgotten and sent again — while
        // a send that has not started yet is stopped by the journal, which reads the switch again.
        using var inFlight = MaintenanceScope.AllowWrites("outbound-in-flight");
        await using var scope = scopeFactory.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
        var operation = await db.OutboundOperations.AsNoTracking().SingleAsync(o => o.Id == operationId, cancellationToken);
        var handler = scope.ServiceProvider.GetServices<IOutboundHandler>()
            .SingleOrDefault(h => h.System == operation.System && h.Operation == operation.Operation);
        var attempts = operation.Attempts + 1;

        // DEV-13: the attempt is journaled outside the database before the handler may reach the external system, so a restore
        // to an earlier point still knows it happened. Without that entry nothing is sent: the lease is given back uncounted.
        ExternalEffectEntry? attempt = null;
        if (handler is not null)
        {
            try
            {
                attempt = await journal.BeginAsync(
                    new ExternalEffect(operation.System, operation.Operation, operation.EntityType, operation.EntityId, operation.Id), cancellationToken);
            }
            catch (Exception ex) when (ex is MaintenanceReadOnlyException or MaintenanceStateUnavailableException)
            {
                logger.LogInformation("Outbound {System}/{Operation} {OperationId} waits: maintenance began, or its state cannot be read",
                    operation.System, operation.Operation, operationId);
                await SettleAsync(db, operationId, token, _ => { });
                return;
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.LogWarning("Outbound {System}/{Operation} {OperationId} waits: the external effect journal is unavailable ({Error})",
                    operation.System, operation.Operation, operationId, ex.GetType().Name);
                await SettleAsync(db, operationId, token, _ => { });
                return;
            }
        }

        await using var lease = new LeaseRenewal(Lease, timeProvider, ct => RenewAsync(operationId, token, ct), logger, cancellationToken);
        try
        {
            if (handler is null)
            {
                throw new PermanentOutboundException($"No handler for {operation.System}/{operation.Operation}.");
            }

            var result = await handler.ExecuteAsync(operation, lease.Token);
            await journal.CompleteAsync(
                attempt!, ReferenceEquals(result, OutboundResult.NothingToDo) ? EffectPhase.Skipped : EffectPhase.Sent, result.Reference, cancellationToken);
            await SettleAsync(db, operationId, token, s => s
                .SetProperty(o => o.Status, OutboundStatus.Succeeded)
                .SetProperty(o => o.Attempts, attempts)
                .SetProperty(o => o.Result, result.Message)
                .SetProperty(o => o.LastError, (string?)null)
                .SetProperty(o => o.CompletedAt, timeProvider.GetUtcNow()));
        }
        catch (OperationCanceledException) when (lease.Lost)
        {
            logger.LogWarning("Outbound {System}/{Operation} {OperationId}: another run took the operation over; its outcome counts",
                operation.System, operation.Operation, operationId);
        }
        catch (Exception ex) when (ex is MaintenanceReadOnlyException or MaintenanceStateUnavailableException)
        {
            // A handler that journals its own effect asks the switch before sending it (the PowerOffice sales order), and
            // maintenance began in between: the operation waits, uncounted. Its attempt stays open in the journal — a restore
            // reconciliation then asks a person rather than assume nothing left.
            logger.LogInformation("Outbound {System}/{Operation} {OperationId} waits: maintenance began while it was being prepared",
                operation.System, operation.Operation, operationId);
            await SettleAsync(db, operationId, token, _ => { });
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            // An HttpClient timeout arrives as a cancellation that nobody asked for: a failed attempt like any other.
            logger.LogWarning(ex, "Outbound {System}/{Operation} for {EntityId} failed (attempt {Attempt})",
                operation.System, operation.Operation, operation.EntityId, attempts);
            var error = Truncate(ex.GetBaseException().Message);
            var now = timeProvider.GetUtcNow();
            if (ex is PermanentOutboundException && attempt is not null)
            {
                // A refusal the handler is sure of: nothing was created. Anything else stays "sending" in the journal — the
                // effect may exist, and a restore reconciliation holds the operation for a person.
                await journal.CompleteAsync(attempt, EffectPhase.Failed, null, cancellationToken);
            }

            if (ex is PermanentOutboundException || attempts >= OutboundOperation.MaxAttempts)
            {
                var status = ex is PermanentOutboundException ? OutboundStatus.Failed : OutboundStatus.DeadLetter;
                await SettleAsync(db, operationId, token, s => s
                    .SetProperty(o => o.Status, status)
                    .SetProperty(o => o.Attempts, attempts)
                    .SetProperty(o => o.LastError, error)
                    .SetProperty(o => o.CompletedAt, now));
            }
            else
            {
                var next = now.Add(TimeSpan.FromMinutes(Math.Min(60, Math.Pow(2, attempts - 1))));
                await SettleAsync(db, operationId, token, s => s
                    .SetProperty(o => o.Attempts, attempts)
                    .SetProperty(o => o.LastError, error)
                    .SetProperty(o => o.NextAttemptAt, next));
            }
        }
    }

    /// <summary>Records the outcome only while the token holds the operation, and ends the lease in the same statement.</summary>
    private async Task SettleAsync(
        IntegrationDbContext db, Guid id, Guid token, Action<Microsoft.EntityFrameworkCore.Query.UpdateSettersBuilder<OutboundOperation>> change)
    {
        var updated = await db.OutboundOperations
            .Where(o => o.Id == id && o.LeaseOwner == token)
            .ExecuteUpdateAsync(s =>
            {
                change(s);
                s.SetProperty(o => o.LockedUntil, (DateTimeOffset?)null);
                s.SetProperty(o => o.LeaseOwner, (Guid?)null);
            });
        if (updated == 0)
        {
            logger.LogWarning("Outbound operation {OperationId}: another run took it over; this run leaves its outcome alone", id);
        }
    }

    private async Task<bool> RenewAsync(Guid id, Guid token, CancellationToken cancellationToken)
    {
        using var inFlight = MaintenanceScope.AllowWrites("outbound-in-flight");
        await using var scope = scopeFactory.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
        var lease = timeProvider.GetUtcNow().Add(Lease);
        return await db.OutboundOperations
            .Where(o => o.Id == id && o.LeaseOwner == token && o.Status == OutboundStatus.Pending)
            .ExecuteUpdateAsync(s => s.SetProperty(o => o.LockedUntil, lease), cancellationToken) == 1;
    }

    private static string Truncate(string value) => value.Length > 4000 ? value[..4000] : value;

    /// <summary>Normal operation, read from the store now; an unreadable state sends nothing (DEV-13: fail closed for effects).</summary>
    private async Task<bool> MaySendAsync(CancellationToken cancellationToken)
    {
        try
        {
            if (!(await maintenance.FreshAsync(cancellationToken)).IsReadOnly)
            {
                return true;
            }

            logger.LogInformation("Outbound operations wait: the CRM is read-only for maintenance");
            return false;
        }
        catch (MaintenanceStateUnavailableException ex)
        {
            logger.LogWarning("Outbound operations wait: the maintenance state cannot be read ({Error})", ex.InnerException?.GetType().Name);
            return false;
        }
    }
}
