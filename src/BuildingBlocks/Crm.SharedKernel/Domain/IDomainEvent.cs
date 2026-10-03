namespace Crm.SharedKernel.Domain;

/// <summary>
/// Something that happened in a module. Persisted to the module's outbox in the same transaction
/// and dispatched asynchronously, so handlers must be idempotent.
/// </summary>
public interface IDomainEvent
{
    DateTimeOffset OccurredAt { get; }
}

public abstract record DomainEvent : IDomainEvent
{
    public DateTimeOffset OccurredAt { get; init; } = DateTimeOffset.UtcNow;
}

public interface IDomainEventHandler<in TEvent>
    where TEvent : IDomainEvent
{
    Task HandleAsync(TEvent domainEvent, CancellationToken cancellationToken);
}
