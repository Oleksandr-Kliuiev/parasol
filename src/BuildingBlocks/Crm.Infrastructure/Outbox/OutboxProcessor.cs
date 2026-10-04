using System.Collections.Concurrent;
using System.Diagnostics.Metrics;
using System.Text.Json;
using Crm.Infrastructure.DependencyInjection;
using Crm.Infrastructure.Health;
using Crm.Infrastructure.Persistence;
using Crm.SharedKernel.Domain;
using Crm.SharedKernel.Operations;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Query;
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

/// <summary>Timing of the outbox (DEV-07). Tests shorten it; production keeps the defaults.</summary>
public sealed class OutboxOptions
{
    public const string SectionName = "Outbox";

    /// <summary>The first retry waits this long, every further one twice as long (capped), with ±20 % jitter.</summary>
    public TimeSpan RetryBaseDelay { get; set; } = TimeSpan.FromSeconds(10);

    public TimeSpan MaxRetryDelay { get; set; } = TimeSpan.FromHours(1);

    /// <summary>How long a claimed message belongs to its worker; renewed every third of it while the handlers run.</summary>
    public TimeSpan Lease { get; set; } = TimeSpan.FromMinutes(2);
}

/// <summary>
/// Polls every module outbox and delivers each message to its <see cref="IDomainEventHandler{TEvent}"/> handlers (DEV-07).
/// A worker claims a message with a lease and a token of its own and renews the lease while the handlers run; only the
/// holder of the token can note progress, finish or release the message. Each handler runs in a scope and a transaction of
/// its own, committed together with the handler's receipt: the handlers done with a message are noted on it, so a retry
/// runs only the others, and a handler delivered twice — after a crash before the acknowledgement, or by a second worker
/// after an expired lease — finds its receipt and changes nothing. A failing message is retried with growing delays and
/// becomes a dead letter after <see cref="OutboxMessage.MaxAttempts"/> attempts; one that cannot be read is quarantined at
/// once. Both wait for a person to replay them (<see cref="OutboxReplayRequest"/>).
/// </summary>
public sealed class OutboxProcessor(
    IServiceScopeFactory scopeFactory,
    ModuleDbContextRegistry registry,
    OutboxEventTypeResolver typeResolver,
    TimeProvider timeProvider,
    ProcessingLoopMonitor monitor,
    IOptions<ProcessingHealthOptions> healthOptions,
    IOptions<OutboxOptions> options,
    IMaintenanceGate maintenance,
    ILogger<OutboxProcessor> logger) : BackgroundService
{
    public const string HeartbeatComponent = "outbox";
    public const string MeterName = "Crm.Outbox";
    private const int BatchSize = 50;
    private static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(5);
    private static readonly TimeSpan BacklogInterval = TimeSpan.FromMinutes(1);

    // The interceptor writes enums as names, so reading has to accept them: an event that carries an enum would otherwise
    // never be dispatched.
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        Converters = { new System.Text.Json.Serialization.JsonStringEnumConverter() },
    };

    // Metrics for DEV-17: deliveries, failed attempts, parked messages and the backlog of every module outbox.
    private static readonly Meter Meter = new(MeterName);
    private static readonly Counter<long> DeliveredCount = Meter.CreateCounter<long>("crm.outbox.delivered", description: "Messages every handler is done with");
    private static readonly Counter<long> FailedCount = Meter.CreateCounter<long>("crm.outbox.failed_attempts", description: "Attempts that left a handler failed");
    private static readonly Counter<long> DeadLetteredCount = Meter.CreateCounter<long>("crm.outbox.dead_lettered", description: "Messages that used up their attempts");
    private static readonly Counter<long> QuarantinedCount = Meter.CreateCounter<long>("crm.outbox.quarantined", description: "Messages that cannot be delivered as stored");
    private static readonly Counter<long> ReplayedCount = Meter.CreateCounter<long>("crm.outbox.replayed", description: "Messages a person sent back to pending");
    private static readonly ConcurrentDictionary<(string Module, OutboxStatus Status), int> Backlog = new();
    private static readonly ObservableGauge<int> BacklogGauge = Meter.CreateObservableGauge(
        "crm.outbox.backlog",
        () => Backlog.Select(b => new Measurement<int>(b.Value, new("module", b.Key.Module), new("status", b.Key.Status.ToString()))),
        description: "Undelivered messages per module and state");

    private readonly ConcurrentDictionary<Type, DateTimeOffset> _backlogCounted = new();
    private readonly ConcurrentDictionary<Type, IReadOnlyList<Type>> _handlers = new();
    private readonly ConcurrentDictionary<Type, Type?> _moduleContexts = new();
    private DateTimeOffset _lastHeartbeat = DateTimeOffset.MinValue;
    private Task? _pendingBeat;

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

    /// <summary>Applies the module's waiting replay requests, then delivers its due messages. Returns how many were delivered.</summary>
    public async Task<int> ProcessContextAsync(Type contextType, CancellationToken cancellationToken)
    {
        // DEV-13: during read-only maintenance nothing is delivered — handlers write and enqueue sends, and a refused attempt
        // would count towards the dead letter. The messages wait; the round still finishes (liveness).
        if ((await maintenance.CurrentAsync(cancellationToken)).IsReadOnly)
        {
            return 0;
        }

        await using var scope = scopeFactory.CreateAsyncScope();
        var context = (ModuleDbContext)scope.ServiceProvider.GetRequiredService(contextType);
        await ApplyReplayRequestsAsync(context, cancellationToken);
        await CountBacklogAsync(contextType, context, cancellationToken);

        var now = timeProvider.GetUtcNow();
        var candidates = await Due(context.OutboxMessages, now)
            .OrderBy(m => m.OccurredAt)
            .Select(m => m.Id)
            .Take(BatchSize)
            .ToListAsync(cancellationToken);

        var delivered = 0;
        foreach (var id in candidates)
        {
            if ((await maintenance.CurrentAsync(cancellationToken)).IsReadOnly)
            {
                break;
            }

            if (await TryClaimAsync(context, id, cancellationToken) is { } token && await DeliverAsync(contextType, id, token, cancellationToken))
            {
                delivered++;
            }
        }

        return delivered;
    }

    /// <summary>
    /// Messages a worker may take: pending and due, or processing under a lease that ran out. An older image leases without a
    /// state and finishes by setting the processed time, so a running lease and a processed time count whatever the state.
    /// </summary>
    private static IQueryable<OutboxMessage> Due(IQueryable<OutboxMessage> messages, DateTimeOffset now) => messages.Where(m =>
        m.ProcessedAt == null &&
        (m.LockedUntil == null || m.LockedUntil < now) &&
        ((m.Status == OutboxStatus.Pending && (m.NextAttemptAt == null || m.NextAttemptAt <= now)) || m.Status == OutboxStatus.Processing));

    /// <summary>Takes a due message with a fresh lease and a token of its own; null when another worker was quicker.</summary>
    public async Task<Guid?> TryClaimAsync(ModuleDbContext context, Guid id, CancellationToken cancellationToken)
    {
        var now = timeProvider.GetUtcNow();
        var token = Guid.NewGuid();
        var lease = now + options.Value.Lease;
        var claimed = await Due(context.OutboxMessages.Where(m => m.Id == id), now)
            .ExecuteUpdateAsync(s => s
                .SetProperty(m => m.Status, OutboxStatus.Processing)
                .SetProperty(m => m.LockedUntil, lease)
                .SetProperty(m => m.LeaseOwner, token), cancellationToken);
        return claimed == 1 ? token : null;
    }

    /// <summary>
    /// Delivers a claimed message to the handlers not yet done with it and settles it, as long as <paramref name="token"/>
    /// still holds the lease: a worker whose lease was taken over can neither finish nor release the message
    /// (DEV-07-AC05). Returns whether every handler is done.
    /// </summary>
    public async Task<bool> DeliverAsync(Type contextType, Guid id, Guid token, CancellationToken cancellationToken)
    {
        await using var scope = scopeFactory.CreateAsyncScope();
        var context = (ModuleDbContext)scope.ServiceProvider.GetRequiredService(contextType);
        var module = context.Schema;
        var message = await context.OutboxMessages.AsNoTracking().SingleAsync(m => m.Id == id, cancellationToken);

        var eventType = typeResolver.Resolve(message.Type);
        if (eventType is null)
        {
            // Perhaps an image that knows the type takes over soon: retried like a failure, quarantined once exhausted.
            logger.LogWarning("Outbox message {MessageId} in {Module} has an event type this image does not know", id, module);
            await SettleFailureAsync(context, message, token, "This image does not know the event type.", OutboxStatus.Quarantined);
            return false;
        }

        IDomainEvent domainEvent;
        try
        {
            domainEvent = (IDomainEvent)(JsonSerializer.Deserialize(message.Payload, eventType, JsonOptions)
                                         ?? throw new JsonException("The payload is empty."));
        }
        catch (Exception ex) when (ex is JsonException or NotSupportedException)
        {
            // A retry cannot help an unreadable payload. Logged by position only: the exception text may quote the payload,
            // and a payload may carry personal data (DEV-07-AC07).
            var path = (ex as JsonException)?.Path ?? "$";
            logger.LogError("Outbox message {MessageId} ({EventType}) in {Module} quarantined: the payload cannot be read at {Path}", id, eventType.Name, module, path);
            if (await SettleAsync(context, id, token, s => s
                    .SetProperty(m => m.Status, OutboxStatus.Quarantined)
                    .SetProperty(m => m.Attempts, m => m.Attempts + 1)
                    .SetProperty(m => m.DeadLetteredAt, timeProvider.GetUtcNow())
                    .SetProperty(m => m.LastError, $"The payload is not a readable {eventType.Name} (at {path}).")))
            {
                QuarantinedCount.Add(1, new KeyValuePair<string, object?>("module", module));
            }

            return false;
        }

        var done = (message.DeliveredHandlers ?? string.Empty).Split('\n', StringSplitOptions.RemoveEmptyEntries).ToHashSet(StringComparer.Ordinal);
        var errors = new List<string>();
        await using (var lease = new LeaseRenewal(options.Value.Lease, timeProvider, ct => RenewAsync(contextType, id, token, ct), logger, cancellationToken))
        {
            foreach (var handler in Handlers(eventType).Where(h => !done.Contains(h.FullName!)))
            {
                try
                {
                    await RunHandlerAsync(contextType, eventType, handler, id, domainEvent, lease.Token);
                }
                catch (Exception ex) when (AlreadyHandled(ex))
                {
                    // Its change is already saved, by an earlier attempt or another worker: done, nothing repeated.
                    logger.LogInformation("Outbox message {MessageId}: {Handler} had already handled it", id, handler.Name);
                }
                catch (OperationCanceledException) when (lease.Lost)
                {
                    logger.LogWarning("Outbox message {MessageId}: the lease was taken over while {Handler} ran; left to the new holder", id, handler.Name);
                    return false;
                }
                catch (Exception ex) when (cancellationToken.IsCancellationRequested || Unreachable(ex, timeouts: false))
                {
                    // Stopping, or the database went away: what the handler did was rolled back, and the message goes back
                    // to pending without an attempt — an outage must not use up attempts and turn messages into dead letters.
                    await TryReleaseAsync(context, id, token);
                    throw;
                }
                catch (Exception ex) when (ex is MaintenanceReadOnlyException or MaintenanceStateUnavailableException)
                {
                    // DEV-13: maintenance began while the message was being delivered (or a send could not learn the state).
                    // The handler's transaction was rolled back; the message goes back to pending without an attempt and is
                    // delivered once the CRM is writable again.
                    logger.LogInformation("Outbox message {MessageId}: {Handler} waits for the end of maintenance", id, handler.Name);
                    await TryReleaseAsync(context, id, token);
                    return false;
                }
                catch (Exception ex)
                {
                    // The text goes to the operators' list; the logged exception keeps the detail for diagnosis.
                    logger.LogWarning(ex, "Outbox message {MessageId} ({EventType}): handler {Handler} failed", id, eventType.Name, handler.Name);
                    errors.Add($"{handler.Name}: {ex.GetBaseException().Message}");
                    continue;
                }

                done.Add(handler.FullName!);
                if (!await SettleAsync(context, id, token, s => s.SetProperty(m => m.DeliveredHandlers, string.Join('\n', done)), release: false))
                {
                    return false;
                }
            }
        }

        if (errors.Count > 0)
        {
            FailedCount.Add(1, new KeyValuePair<string, object?>("module", module));
            await SettleFailureAsync(context, message, token, string.Join(" | ", errors), OutboxStatus.DeadLetter);
            return false;
        }

        if (!await SettleAsync(context, id, token, s => s
                .SetProperty(m => m.Status, OutboxStatus.Processed)
                .SetProperty(m => m.ProcessedAt, timeProvider.GetUtcNow())
                .SetProperty(m => m.Attempts, m => m.Attempts + 1)
                .SetProperty(m => m.NextAttemptAt, (DateTimeOffset?)null)
                .SetProperty(m => m.LastError, (string?)null)))
        {
            return false;
        }

        DeliveredCount.Add(1, new KeyValuePair<string, object?>("module", module));
        return true;
    }

    /// <summary>
    /// The delay before the attempt after <paramref name="attempts"/> failed ones: base · 2^(attempts−1), capped, ±20 %. The
    /// jitter keeps the messages of one outage from all coming back in the same second.
    /// </summary>
    public static TimeSpan RetryDelay(OutboxOptions options, int attempts)
    {
        var raw = options.RetryBaseDelay.TotalMilliseconds * Math.Pow(2, Math.Clamp(attempts - 1, 0, 30));
        var capped = Math.Min(raw, options.MaxRetryDelay.TotalMilliseconds);
        return TimeSpan.FromMilliseconds(capped * (0.8 + (0.4 * Random.Shared.NextDouble())));
    }

    /// <summary>A failed attempt: pending again after a growing delay, or parked once the attempts are used up.</summary>
    private async Task SettleFailureAsync(ModuleDbContext context, OutboxMessage message, Guid token, string error, OutboxStatus whenExhausted)
    {
        var attempts = message.Attempts + 1;
        var now = timeProvider.GetUtcNow();
        var lastError = error.Length > 2000 ? error[..2000] : error;
        if (attempts < OutboxMessage.MaxAttempts)
        {
            var next = now + RetryDelay(options.Value, attempts);
            await SettleAsync(context, message.Id, token, s => s
                .SetProperty(m => m.Status, OutboxStatus.Pending)
                .SetProperty(m => m.Attempts, attempts)
                .SetProperty(m => m.NextAttemptAt, next)
                .SetProperty(m => m.LastError, lastError));
            return;
        }

        if (await SettleAsync(context, message.Id, token, s => s
                .SetProperty(m => m.Status, whenExhausted)
                .SetProperty(m => m.Attempts, attempts)
                .SetProperty(m => m.NextAttemptAt, (DateTimeOffset?)null)
                .SetProperty(m => m.DeadLetteredAt, now)
                .SetProperty(m => m.LastError, lastError)))
        {
            (whenExhausted == OutboxStatus.Quarantined ? QuarantinedCount : DeadLetteredCount).Add(1, new KeyValuePair<string, object?>("module", context.Schema));
            logger.LogError("Outbox message {MessageId} in {Module} is {Status} after {Attempts} attempts", message.Id, context.Schema, whenExhausted, attempts);
        }
    }

    /// <summary>
    /// Compare-and-set on the lease: applies <paramref name="change"/> only while <paramref name="token"/> holds the message.
    /// A settlement (<paramref name="release"/>) also ends the lease in the same statement; noting progress keeps it. False
    /// when the lease is gone. Not cancellable: the outcome of work that is done must be recorded even while the worker stops.
    /// </summary>
    private async Task<bool> SettleAsync(
        ModuleDbContext context, Guid id, Guid token, Action<UpdateSettersBuilder<OutboxMessage>> change, bool release = true)
    {
        // The bookkeeping of a delivery that is under way stays possible during maintenance (DEV-13): it records work that is done.
        using var bookkeeping = MaintenanceScope.AllowWrites("outbox-bookkeeping");
        var updated = await context.OutboxMessages
            .Where(m => m.Id == id && m.LeaseOwner == token && m.Status == OutboxStatus.Processing)
            .ExecuteUpdateAsync(s =>
            {
                change(s);
                if (release)
                {
                    s.SetProperty(m => m.LockedUntil, (DateTimeOffset?)null);
                    s.SetProperty(m => m.LeaseOwner, (Guid?)null);
                }
            });
        if (updated == 0)
        {
            logger.LogWarning("Outbox message {MessageId}: the lease was taken over; this worker leaves the message alone", id);
        }

        return updated == 1;
    }

    /// <summary>Gives a claimed message back without counting an attempt; without a database the lease simply runs out.</summary>
    private async Task TryReleaseAsync(ModuleDbContext context, Guid id, Guid token)
    {
        using var bookkeeping = MaintenanceScope.AllowWrites("outbox-bookkeeping");
        try
        {
            await context.OutboxMessages
                .Where(m => m.Id == id && m.LeaseOwner == token && m.Status == OutboxStatus.Processing)
                .ExecuteUpdateAsync(s => s
                    .SetProperty(m => m.Status, OutboxStatus.Pending)
                    .SetProperty(m => m.LockedUntil, (DateTimeOffset?)null)
                    .SetProperty(m => m.LeaseOwner, (Guid?)null));
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogWarning(ex, "Outbox message {MessageId} could not be released; its lease will run out", id);
        }
    }

    /// <summary>Extends the lease while the handlers run; false once the token no longer holds the message.</summary>
    private async Task<bool> RenewAsync(Type contextType, Guid id, Guid token, CancellationToken cancellationToken)
    {
        using var bookkeeping = MaintenanceScope.AllowWrites("outbox-bookkeeping");
        await using var scope = scopeFactory.CreateAsyncScope();
        var context = (ModuleDbContext)scope.ServiceProvider.GetRequiredService(contextType);
        var lease = timeProvider.GetUtcNow() + options.Value.Lease;
        return await context.OutboxMessages
            .Where(m => m.Id == id && m.LeaseOwner == token && m.Status == OutboxStatus.Processing)
            .ExecuteUpdateAsync(s => s.SetProperty(m => m.LockedUntil, lease), cancellationToken) == 1;
    }

    /// <summary>The handler classes of an event type; their full name is what progress notes and receipts record.</summary>
    private IReadOnlyList<Type> Handlers(Type eventType) => _handlers.GetOrAdd(eventType, type =>
    {
        using var scope = scopeFactory.CreateScope();
        return scope.ServiceProvider.GetServices(typeof(IDomainEventHandler<>).MakeGenericType(type))
            .Select(h => h!.GetType())
            .Distinct()
            .ToList();
    });

    /// <summary>
    /// One handler in a scope and a transaction of its own (see <see cref="MessageHandlingContext"/>): a handler that belongs
    /// to a module starts with its receipt in that module; one of an integration adapter gets it at its first save. The SQL
    /// Server retry strategy runs the whole handler again after a transient error; its transaction was rolled back by then.
    /// </summary>
    private async Task RunHandlerAsync(
        Type contextType, Type eventType, Type handlerType, Guid messageId, IDomainEvent domainEvent, CancellationToken cancellationToken)
    {
        await using var outer = scopeFactory.CreateAsyncScope();
        var strategy = ((DbContext)outer.ServiceProvider.GetRequiredService(contextType)).Database.CreateExecutionStrategy();
        await strategy.ExecuteAsync(async ct =>
        {
            await using var scope = scopeFactory.CreateAsyncScope();
            var handling = scope.ServiceProvider.GetRequiredService<MessageHandlingContext>();
            handling.Begin(messageId, handlerType.FullName!);
            if (ModuleContextOf(handlerType) is { } moduleContext)
            {
                await handling.ClaimAsync((ModuleDbContext)scope.ServiceProvider.GetRequiredService(moduleContext), timeProvider.GetUtcNow(), ct);
            }

            var serviceType = typeof(IDomainEventHandler<>).MakeGenericType(eventType);
            var handler = scope.ServiceProvider.GetServices(serviceType).First(h => h!.GetType() == handlerType)!;
            // DoNotWrapExceptions: a handler that throws before its first await fails like one that throws after it.
            await (Task)serviceType.GetMethod(nameof(IDomainEventHandler<IDomainEvent>.HandleAsync))!
                .Invoke(handler, System.Reflection.BindingFlags.DoNotWrapExceptions, null, [domainEvent, ct], null)!;
            await handling.CommitAsync(ct);
        }, cancellationToken);
    }

    /// <summary>The context of the module a handler belongs to: the only one declared in the handler's assembly, if any.</summary>
    private Type? ModuleContextOf(Type handlerType) => _moduleContexts.GetOrAdd(handlerType, type =>
    {
        var declared = registry.Contexts.Where(c => c.Assembly == type.Assembly).Take(2).ToList();
        return declared.Count == 1 ? declared[0] : null;
    });

    /// <summary>The receipt says the handler is done: found before the save, or (two workers at once) hit on its key.</summary>
    private static bool AlreadyHandled(Exception exception)
    {
        for (var ex = exception; ex is not null; ex = ex.InnerException)
        {
            if (ex is MessageAlreadyHandledException ||
                (ex is DbUpdateException update && update.IsUniqueViolation() && update.InnerException!.Message.Contains("PK_InboxReceipts", StringComparison.Ordinal)))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Applies the replay requests a person confirmed in crm-web: those messages, if still dead or quarantined, go back to
    /// pending exactly as stored, with a fresh count of attempts (DEV-07-AC01, AC06). The web host only writes the request.
    /// Taking the request and moving its messages is one transaction, so two workers never both apply it and a crash in
    /// between leaves it waiting for the next round.
    /// </summary>
    private async Task ApplyReplayRequestsAsync(ModuleDbContext context, CancellationToken cancellationToken)
    {
        var requests = await context.OutboxReplayRequests.AsNoTracking()
            .Where(r => r.AppliedAt == null)
            .OrderBy(r => r.RequestedAt)
            .Select(r => new { r.Id, r.MessageIds, r.Expected })
            .Take(10)
            .ToListAsync(cancellationToken);
        foreach (var request in requests)
        {
            var ids = request.MessageIds.Split(',', StringSplitOptions.RemoveEmptyEntries)
                .Select(value => Guid.TryParse(value, out var id) ? id : Guid.Empty)
                .Where(id => id != Guid.Empty)
                .Take(OutboxReplayRequest.MaxMessages)
                .ToList();
            var applied = await context.Database.CreateExecutionStrategy().ExecuteAsync(async ct =>
            {
                await using var transaction = await context.Database.BeginTransactionAsync(ct);
                var now = timeProvider.GetUtcNow();
                if (await context.OutboxReplayRequests.Where(r => r.Id == request.Id && r.AppliedAt == null)
                        .ExecuteUpdateAsync(s => s.SetProperty(r => r.AppliedAt, now), ct) == 0)
                {
                    return (int?)null;
                }

                var moved = await context.OutboxMessages
                    .Where(m => ids.Contains(m.Id) && (m.Status == OutboxStatus.DeadLetter || m.Status == OutboxStatus.Quarantined))
                    .ExecuteUpdateAsync(s => s
                        .SetProperty(m => m.Status, OutboxStatus.Pending)
                        .SetProperty(m => m.Attempts, 0)
                        .SetProperty(m => m.NextAttemptAt, (DateTimeOffset?)null)
                        .SetProperty(m => m.DeadLetteredAt, (DateTimeOffset?)null)
                        .SetProperty(m => m.LockedUntil, (DateTimeOffset?)null)
                        .SetProperty(m => m.LeaseOwner, (Guid?)null)
                        .SetProperty(m => m.Replays, m => m.Replays + 1), ct);
                await context.OutboxReplayRequests.Where(r => r.Id == request.Id).ExecuteUpdateAsync(s => s.SetProperty(r => r.Applied, moved), ct);
                await transaction.CommitAsync(ct);
                return moved;
            }, cancellationToken);
            if (applied is not { } count)
            {
                continue;
            }

            ReplayedCount.Add(count, new KeyValuePair<string, object?>("module", context.Schema));
            logger.LogInformation("Replay request {RequestId} in {Module}: {Applied} of {Expected} messages back to pending", request.Id, context.Schema, count, request.Expected);
        }
    }

    private async Task CountBacklogAsync(Type contextType, ModuleDbContext context, CancellationToken cancellationToken)
    {
        var now = timeProvider.GetUtcNow();
        if (_backlogCounted.TryGetValue(contextType, out var last) && now - last < BacklogInterval)
        {
            return;
        }

        _backlogCounted[contextType] = now;
        var counts = await context.OutboxMessages.AsNoTracking()
            .Where(m => m.ProcessedAt == null)
            .GroupBy(m => m.Status)
            .Select(g => new { Status = g.Key, Count = g.Count() })
            .ToListAsync(cancellationToken);
        foreach (var status in new[] { OutboxStatus.Pending, OutboxStatus.Processing, OutboxStatus.DeadLetter, OutboxStatus.Quarantined })
        {
            Backlog[(context.Schema, status)] = counts.SingleOrDefault(c => c.Status == status)?.Count ?? 0;
        }
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
                // The heartbeat is operational, not business data: it keeps telling monitoring the worker lives during maintenance.
                using var allowed = MaintenanceScope.AllowWrites("heartbeat");
                var detail = maintenance.Last.IsReadOnly ? "paused: read-only maintenance" : $"{processed} processed in the last round";
                await heartbeat.BeatAsync(HeartbeatComponent, detail, cancellationToken);
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
    public static bool DatabaseUnavailable(Exception exception) => Unreachable(exception, timeouts: true);

    /// <summary>
    /// Inside a handler a timeout is the handler's own failure: an external call that times out (HttpClient reports a
    /// <see cref="TimeoutException"/>) or a slow query must use up attempts like any other error, or such a message would
    /// be retried for ever. There only the exhausted SQL retry strategy and connection errors mean the database is gone.
    /// </summary>
    private static bool Unreachable(Exception exception, bool timeouts)
    {
        for (var ex = exception; ex is not null; ex = ex.InnerException)
        {
            switch (ex)
            {
                case RetryLimitExceededException:
                case TimeoutException when timeouts:
                case SqlException { Number: -2 } when timeouts:
                case SqlException { Number: -1 or 2 or 53 or 121 or 258 or 4060 or 10053 or 10054 or 10060 or 10061 or 11001
                    or 40197 or 40501 or 40613 or 49918 or 49919 or 49920 }:
                    return true;
            }
        }

        return false;
    }
}
