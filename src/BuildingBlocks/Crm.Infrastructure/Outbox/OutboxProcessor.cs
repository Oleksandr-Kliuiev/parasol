using System.Collections.Concurrent;
using System.Reflection;
using System.Text.Json;
using Crm.Infrastructure.DependencyInjection;
using Crm.Infrastructure.Persistence;
using Crm.SharedKernel.Domain;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

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
    ILogger<OutboxProcessor> logger) : BackgroundService
{
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
            foreach (var contextType in registry.Contexts)
            {
                try
                {
                    await ProcessContextAsync(contextType, stoppingToken);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    logger.LogError(ex, "Outbox processing failed for {Context}", contextType.Name);
                }
            }
        }
        while (await timer.WaitForNextTickAsync(stoppingToken));
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
