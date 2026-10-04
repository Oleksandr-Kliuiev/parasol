using System.Collections.Concurrent;
using System.Reflection;
using System.Text.Json;
using Crm.Infrastructure.DependencyInjection;
using Crm.Infrastructure.Health;
using Crm.Infrastructure.Persistence;
using Crm.SharedKernel.Domain;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Crm.Infrastructure.Outbox;

public sealed class OutboxEventTypeResolver
{
    private readonly ConcurrentDictionary<string, Type?> _cache = new(StringComparer.Ordinal);

    public Type? Resolve(string typeName) => _cache.GetOrAdd(typeName, static name => Type.GetType(name, throwOnError: false));
}

/// <summary>
/// Polls every module outbox and dispatches events to <see cref="IDomainEventHandler{TEvent}"/> implementations.
/// Delivery is at-least-once: a message is claimed with a short lease, so parallel workers do not process it twice
/// under normal operation, but handlers must still be idempotent.
/// </summary>
public sealed class OutboxProcessor(
    IServiceScopeFactory scopeFactory,
    ModuleDbContextRegistry registry,
    OutboxEventTypeResolver typeResolver,
    TimeProvider timeProvider,
    ProcessingLoopMonitor monitor,
    IOptions<ProcessingHealthOptions> healthOptions,
    ILogger<OutboxProcessor> logger) : BackgroundService
{
    public const string HeartbeatComponent = "outbox";
    private DateTimeOffset _lastHeartbeat = DateTimeOffset.MinValue;
    private Task? _pendingBeat;

    private const int BatchSize = 50;
    private const int MaxAttempts = 10;
    private static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(5);
    private static readonly TimeSpan Lease = TimeSpan.FromMinutes(2);
    // The interceptor writes enums as names, so reading has to accept them: an event that carries an enum would otherwise
    // never be dispatched.
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        Converters = { new System.Text.Json.Serialization.JsonStringEnumConverter() },
    };
    private static readonly MethodInfo DispatchMethod =
        typeof(OutboxProcessor).GetMethod(nameof(DispatchAsync), BindingFlags.NonPublic | BindingFlags.Static)!;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(PollInterval, timeProvider);
        do
        {
            var processed = 0;
            foreach (var contextType in registry.Contexts)
            {
                try
                {
                    processed += await ProcessContextAsync(contextType, stoppingToken);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    logger.LogError(ex, "Outbox processing failed for {Context}", contextType.Name);
                    // Without the database every other context would wait for its own timeouts too: the round ends here, so
                    // rounds keep finishing and liveness does not turn into a restart loop during an outage (DEV-06).
                    if (DatabaseUnavailable(ex))
                    {
                        break;
                    }
                }
            }

            // DEV-06: a finished round is the worker's liveness; the stored heartbeat lets monitoring see a stalled worker.
            monitor.RoundFinished();
            await BeatAsync(processed, stoppingToken);
        }
        while (await timer.WaitForNextTickAsync(stoppingToken));
    }

    private async Task BeatAsync(int processed, CancellationToken cancellationToken)
    {
        var now = timeProvider.GetUtcNow();
        if (now - _lastHeartbeat < healthOptions.Value.HeartbeatInterval || _pendingBeat is { IsCompleted: false })
        {
            return;
        }

        // At most ten seconds of the loop's time; a beat that hangs on an absent database finishes (or fails) on its own and
        // the next one waits for it, so beats never pile up.
        _pendingBeat = StoreBeatAsync(processed, now, cancellationToken);
        await Task.WhenAny(_pendingBeat, Task.Delay(TimeSpan.FromSeconds(10), timeProvider, cancellationToken));
    }

    private async Task StoreBeatAsync(int processed, DateTimeOffset now, CancellationToken cancellationToken)
    {
        try
        {
            await using var scope = scopeFactory.CreateAsyncScope();
            if (scope.ServiceProvider.GetService<IWorkerHeartbeat>() is { } heartbeat)
            {
                await heartbeat.BeatAsync(HeartbeatComponent, $"{processed} processed in the last round", cancellationToken);
                _lastHeartbeat = now;
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            // The database may be away; the loop goes on and the heartbeat simply ages.
            logger.LogWarning(ex, "The outbox heartbeat could not be stored");
        }
    }

    /// <summary>An error that says the database cannot be reached, as opposed to a problem of one context's data.</summary>
    public static bool DatabaseUnavailable(Exception exception)
    {
        for (var ex = exception; ex is not null; ex = ex.InnerException)
        {
            switch (ex)
            {
                case RetryLimitExceededException or TimeoutException:
                    return true;
                case SqlException sql when sql.Number is -2 or -1 or 2 or 53 or 121 or 258 or 4060 or 10053 or 10054 or 10060 or 10061 or 11001
                    or 40197 or 40501 or 40613 or 49918 or 49919 or 49920:
                    return true;
            }
        }

        return false;
    }

    public async Task<int> ProcessContextAsync(Type contextType, CancellationToken cancellationToken)
    {
        await using var scope = scopeFactory.CreateAsyncScope();
        var context = (ModuleDbContext)scope.ServiceProvider.GetRequiredService(contextType);
        var now = timeProvider.GetUtcNow();

        var candidates = await context.OutboxMessages
            .Where(m => m.ProcessedAt == null && m.Attempts < MaxAttempts && (m.LockedUntil == null || m.LockedUntil < now))
            .OrderBy(m => m.OccurredAt)
            .Select(m => m.Id)
            .Take(BatchSize)
            .ToListAsync(cancellationToken);

        int processed = 0;
        foreach (var id in candidates)
        {
            var leaseUntil = timeProvider.GetUtcNow().Add(Lease);
            int claimed = await context.OutboxMessages
                .Where(m => m.Id == id && m.ProcessedAt == null && (m.LockedUntil == null || m.LockedUntil < now))
                .ExecuteUpdateAsync(s => s.SetProperty(m => m.LockedUntil, leaseUntil), cancellationToken);
            if (claimed == 0)
            {
                continue;
            }

            var message = await context.OutboxMessages.AsNoTracking().SingleAsync(m => m.Id == id, cancellationToken);
            string? error = null;
            try
            {
                var eventType = typeResolver.Resolve(message.Type)
                                ?? throw new InvalidOperationException($"Unknown event type '{message.Type}'.");
                var domainEvent = (IDomainEvent)JsonSerializer.Deserialize(message.Payload, eventType, JsonOptions)!;
                await using var handlerScope = scopeFactory.CreateAsyncScope();
                await (Task)DispatchMethod.MakeGenericMethod(eventType)
                    .Invoke(null, [handlerScope.ServiceProvider, domainEvent, cancellationToken])!;
                processed++;
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                error = ex.GetBaseException().Message;
                logger.LogWarning(ex, "Outbox message {MessageId} of type {Type} failed", message.Id, message.Type);
            }

            var finishedAt = timeProvider.GetUtcNow();
            await context.OutboxMessages
                .Where(m => m.Id == id)
                .ExecuteUpdateAsync(s => s
                    .SetProperty(m => m.ProcessedAt, error == null ? finishedAt : null)
                    .SetProperty(m => m.LockedUntil, (DateTimeOffset?)null)
                    .SetProperty(m => m.Attempts, m => m.Attempts + 1)
                    .SetProperty(m => m.LastError, error), cancellationToken);
        }

        return processed;
    }

    private static async Task DispatchAsync<TEvent>(IServiceProvider services, TEvent domainEvent, CancellationToken cancellationToken)
        where TEvent : IDomainEvent
    {
        foreach (var handler in services.GetServices<IDomainEventHandler<TEvent>>())
        {
            await handler.HandleAsync(domainEvent, cancellationToken);
        }
    }
}
