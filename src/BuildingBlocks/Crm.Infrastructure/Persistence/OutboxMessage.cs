using System.Text.Json;
using System.Text.Json.Serialization;
using Crm.SharedKernel.Domain;

namespace Crm.Infrastructure.Persistence;

/// <summary>Domain event stored in the module schema within the business transaction (transactional outbox).</summary>
public sealed class OutboxMessage
{
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
    public DateTimeOffset? ProcessedAt { get; set; }
    public DateTimeOffset? LockedUntil { get; set; }
    public int Attempts { get; set; }
    public string? LastError { get; set; }

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
