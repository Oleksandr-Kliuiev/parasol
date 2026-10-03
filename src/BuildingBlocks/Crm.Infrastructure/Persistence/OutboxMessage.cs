namespace Crm.Infrastructure.Persistence;

/// <summary>Domain event stored in the module schema within the business transaction (transactional outbox).</summary>
public sealed class OutboxMessage
{
    public Guid Id { get; init; }
    public required string Type { get; init; }
    public required string Payload { get; init; }
    public DateTimeOffset OccurredAt { get; init; }
    public string? CorrelationId { get; init; }
    public DateTimeOffset? ProcessedAt { get; set; }
    public DateTimeOffset? LockedUntil { get; set; }
    public int Attempts { get; set; }
    public string? LastError { get; set; }
}
