using Crm.Integrations.Core.Persistence;
using Crm.SharedKernel.Domain;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Crm.Integrations.Core;

public sealed record OutboundResult(string? Message)
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
        var pending = await db.OutboundOperations.SingleOrDefaultAsync(o =>
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

/// <summary>Runs due outbound operations with exponential backoff; after <see cref="OutboundOperation.MaxAttempts"/> they become dead letters.</summary>
public sealed class OutboundProcessorJob(
    IServiceScopeFactory scopeFactory,
    TimeProvider timeProvider,
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
            var lease = timeProvider.GetUtcNow().Add(Lease);
            var claimed = await db.OutboundOperations
                .Where(o => o.Id == id && o.Status == OutboundStatus.Pending && (o.LockedUntil == null || o.LockedUntil < now))
                .ExecuteUpdateAsync(s => s.SetProperty(o => o.LockedUntil, lease), cancellationToken);
            if (claimed == 0)
            {
                continue;
            }

            await ExecuteOneAsync(id, cancellationToken);
            processed++;
        }

        return processed;
    }

    public async Task ExecuteOneAsync(Guid operationId, CancellationToken cancellationToken)
    {
        await using var scope = scopeFactory.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
        var operation = await db.OutboundOperations.SingleAsync(o => o.Id == operationId, cancellationToken);
        var handler = scope.ServiceProvider.GetServices<IOutboundHandler>()
            .SingleOrDefault(h => h.System == operation.System && h.Operation == operation.Operation);

        operation.Attempts++;
        try
        {
            if (handler is null)
            {
                throw new PermanentOutboundException($"No handler for {operation.System}/{operation.Operation}.");
            }

            var result = await handler.ExecuteAsync(operation, cancellationToken);
            operation.Status = OutboundStatus.Succeeded;
            operation.Result = result.Message;
            operation.LastError = null;
            operation.CompletedAt = timeProvider.GetUtcNow();
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            var permanent = ex is PermanentOutboundException;
            logger.LogWarning(ex, "Outbound {System}/{Operation} for {EntityId} failed (attempt {Attempt})",
                operation.System, operation.Operation, operation.EntityId, operation.Attempts);
            operation.LastError = Truncate(ex.GetBaseException().Message);
            if (permanent)
            {
                operation.Status = OutboundStatus.Failed;
                operation.CompletedAt = timeProvider.GetUtcNow();
            }
            else if (operation.Attempts >= OutboundOperation.MaxAttempts)
            {
                operation.Status = OutboundStatus.DeadLetter;
                operation.CompletedAt = timeProvider.GetUtcNow();
            }
            else
            {
                var delay = TimeSpan.FromMinutes(Math.Min(60, Math.Pow(2, operation.Attempts - 1)));
                operation.NextAttemptAt = timeProvider.GetUtcNow().Add(delay);
            }
        }
        finally
        {
            operation.LockedUntil = null;
            await db.SaveChangesAsync(CancellationToken.None);
        }
    }

    private static string Truncate(string value) => value.Length > 4000 ? value[..4000] : value;
}
