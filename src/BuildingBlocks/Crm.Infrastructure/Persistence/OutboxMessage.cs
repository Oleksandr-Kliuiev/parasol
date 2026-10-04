using System.Text.Json;
using System.Text.Json.Serialization;
using Crm.SharedKernel.Domain;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;

namespace Crm.Infrastructure.Persistence;

/// <summary>Where an outbox message stands (DEV-07). Stored as text; older images only read <see cref="OutboxMessage.ProcessedAt"/>.</summary>
public enum OutboxStatus
{
    /// <summary>Waiting for its first or next attempt (<see cref="OutboxMessage.NextAttemptAt"/>).</summary>
    Pending,

    /// <summary>Leased by one worker (<see cref="OutboxMessage.LeaseOwner"/> until <see cref="OutboxMessage.LockedUntil"/>).</summary>
    Processing,

    /// <summary>Every handler is done.</summary>
    Processed,

    /// <summary>Failed <see cref="OutboxMessage.MaxAttempts"/> times; waits for a person to fix the cause and replay it.</summary>
    DeadLetter,

    /// <summary>Cannot be delivered as it is (unreadable payload, a type no image knows); replayable once fixed.</summary>
    Quarantined,
}

/// <summary>Domain event stored in the module schema within the business transaction (transactional outbox).</summary>
public sealed class OutboxMessage
{
    public const int MaxAttempts = 10;

    // Domain events may carry enums; they are written as names, and OutboxProcessor reads them back the same way.
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        Converters = { new JsonStringEnumConverter() },
    };

    public Guid Id { get; init; }
    public required string Type { get; init; }
    public required string Payload { get; init; }
    public DateTimeOffset OccurredAt { get; init; }
    public string? CorrelationId { get; init; }
    public OutboxStatus Status { get; set; } = OutboxStatus.Pending;
    public DateTimeOffset? ProcessedAt { get; set; }
    public DateTimeOffset? NextAttemptAt { get; set; }
    public DateTimeOffset? LockedUntil { get; set; }

    /// <summary>The token of the worker holding the lease; only that worker may finish or release the message.</summary>
    public Guid? LeaseOwner { get; set; }

    public int Attempts { get; set; }
    public string? LastError { get; set; }
    public DateTimeOffset? DeadLetteredAt { get; set; }

    /// <summary>Handlers that are done with this message, one type name per line: a retry runs only the others.</summary>
    public string? DeliveredHandlers { get; set; }

    /// <summary>How often a person replayed the message.</summary>
    public int Replays { get; set; }

    /// <summary>
    /// The outbox row of a domain event. The interceptor writes those an entity raised; a request that has no aggregate to
    /// raise it (a connection test asked of the worker) adds the row itself, in the transaction of its own change.
    /// </summary>
    public static OutboxMessage For(IDomainEvent domainEvent, DateTimeOffset now, string? correlationId)
    {
        var type = domainEvent.GetType();
        return new OutboxMessage
        {
            Id = SequentialId.New(now),
            Type = $"{type.FullName}, {type.Assembly.GetName().Name}",
            Payload = JsonSerializer.Serialize(domainEvent, type, JsonOptions),
            OccurredAt = domainEvent.OccurredAt,
            CorrelationId = correlationId,
        };
    }
}

/// <summary>
/// A handler's receipt for a message, in the handler's own module schema and in the same transaction as the handler's
/// change (DEV-07): a second delivery of the message to that handler — after a crash before the acknowledgement, or by a
/// second worker after an expired lease — fails on the key and leaves no second effect.
/// </summary>
public sealed class InboxReceipt
{
    public Guid MessageId { get; init; }
    public required string Handler { get; init; }
    public DateTimeOffset ProcessedAt { get; init; }
}

/// <summary>
/// A person's request to deliver dead or quarantined messages again, exactly as they were stored (DEV-07). crm-web writes
/// it with the audit entry; crm-worker applies it, as the web host never changes outbox rows (DEV-04).
/// </summary>
public sealed class OutboxReplayRequest
{
    public const int MaxMessages = 100;

    public Guid Id { get; init; }

    /// <summary>The messages, comma separated: what the person confirmed, never a query evaluated later.</summary>
    public required string MessageIds { get; init; }

    public int Expected { get; init; }
    public required string Reason { get; init; }
    public Guid? RequestedBy { get; init; }
    public string? RequestedByName { get; init; }
    public DateTimeOffset RequestedAt { get; init; }
    public DateTimeOffset? AppliedAt { get; set; }
    public int? Applied { get; set; }
}

/// <summary>
/// The message and handler being delivered, set by the outbox processor in each handler's scope (DEV-07). The handler's
/// module gets a transaction that starts with the handler's <see cref="InboxReceipt"/> (<see cref="ClaimAsync"/>); a handler
/// outside a module (an integration adapter) gets it at its first save, through the auditing interceptor. The processor
/// commits once the handler returns, so whatever the handler changed lands together with its receipt or not at all, and a
/// second delivery to the same handler changes nothing.
/// </summary>
public sealed class MessageHandlingContext
{
    private readonly List<(ModuleDbContext Context, IDbContextTransaction? Owned)> _enlisted = [];

    public Guid? MessageId { get; private set; }
    public string? Handler { get; private set; }

    public void Begin(Guid messageId, string handler)
    {
        MessageId = messageId;
        Handler = handler;
    }

    internal bool Handles(ModuleDbContext context) => MessageId is not null && !_enlisted.Exists(e => e.Context == context);

    /// <summary>
    /// Opens the handler's transaction in its module and writes the receipt first. The receipt's key is the claim: another
    /// worker delivering the same message to the same handler waits for this transaction and then finds the key taken.
    /// </summary>
    public async Task ClaimAsync(ModuleDbContext context, DateTimeOffset now, CancellationToken cancellationToken)
    {
        Guard(context);
        // The usual case of a repeated delivery is answered by a read; the key settles only a true race of two workers.
        if (await context.InboxReceipts.AnyAsync(r => r.MessageId == MessageId && r.Handler == Handler, cancellationToken))
        {
            throw new MessageAlreadyHandledException(MessageId!.Value, Handler!);
        }

        var owned = await context.Database.BeginTransactionAsync(cancellationToken);
        Add(context, owned, now);
        await context.SaveChangesAsync(cancellationToken);
    }

    internal async Task EnlistAsync(ModuleDbContext context, DateTimeOffset now, CancellationToken cancellationToken)
    {
        Guard(context);
        if (await context.InboxReceipts.AnyAsync(r => r.MessageId == MessageId && r.Handler == Handler, cancellationToken))
        {
            throw new MessageAlreadyHandledException(MessageId!.Value, Handler!);
        }

        var owned = context.Database.CurrentTransaction is null ? await context.Database.BeginTransactionAsync(cancellationToken) : null;
        Add(context, owned, now);
    }

    internal void Enlist(ModuleDbContext context, DateTimeOffset now)
    {
        Guard(context);
        if (context.InboxReceipts.Any(r => r.MessageId == MessageId && r.Handler == Handler))
        {
            throw new MessageAlreadyHandledException(MessageId!.Value, Handler!);
        }

        var owned = context.Database.CurrentTransaction is null ? context.Database.BeginTransaction() : null;
        Add(context, owned, now);
    }

    /// <summary>Commits what the handler saved, with its receipt. A transaction the handler opened itself is the handler's to commit.</summary>
    public async Task CommitAsync(CancellationToken cancellationToken)
    {
        foreach (var (_, owned) in _enlisted)
        {
            if (owned is not null)
            {
                await owned.CommitAsync(cancellationToken);
            }
        }
    }

    private void Guard(ModuleDbContext context)
    {
        // Atomicity ends at the module (DEV-07): a handler that also wrote another module could be half done after a crash,
        // and the receipt of the half that landed would hide the half that did not. Another module reacts to an event instead.
        if (_enlisted.Count > 0)
        {
            throw new InvalidOperationException(
                $"The handler {Handler} saved in '{_enlisted[0].Context.Schema}' and now in '{context.Schema}'; a handler changes one module only (DEV-07).");
        }
    }

    private void Add(ModuleDbContext context, IDbContextTransaction? owned, DateTimeOffset now)
    {
        context.InboxReceipts.Add(new InboxReceipt { MessageId = MessageId!.Value, Handler = Handler!, ProcessedAt = now });
        _enlisted.Add((context, owned));
    }
}

/// <summary>The handler's receipt for the message already exists: an earlier attempt or another worker did the work.</summary>
public sealed class MessageAlreadyHandledException(Guid messageId, string handler)
    : Exception($"Message {messageId} was already handled by {handler}.");
