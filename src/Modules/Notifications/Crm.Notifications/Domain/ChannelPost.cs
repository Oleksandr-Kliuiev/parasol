using System.Text.Json;
using Crm.Notifications.Contracts;
using Crm.SharedKernel.Domain;

namespace Crm.Notifications.Domain;

public enum ChannelPostStatus
{
    Pending,
    Sent,

    /// <summary>Gave up after <see cref="ChannelPost.MaxAttempts"/> attempts, or the channel is no longer configured.</summary>
    Failed,
}

/// <summary>
/// A card waiting to be posted to a team channel (FR-ACT-04). An event handler only queues it — in its transaction, with its
/// receipt — so a repeated delivery of the event queues nothing twice (DEV-07); <c>ChannelPostJob</c> sends it.
/// </summary>
public sealed class ChannelPost
{
    public const int MaxAttempts = 8;

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    private ChannelPost() { }

    public Guid Id { get; private set; }
    public TeamsChannel Channel { get; private set; }
    public string CardJson { get; private set; } = "{}";
    public DateTimeOffset CreatedAt { get; private set; }
    public ChannelPostStatus Status { get; private set; }
    public int Attempts { get; private set; }
    public DateTimeOffset NextAttemptAt { get; private set; }
    public DateTimeOffset? LockedUntil { get; private set; }

    /// <summary>The token of the job run sending the card; only that run records the outcome.</summary>
    public Guid? LeaseOwner { get; private set; }

    public DateTimeOffset? SentAt { get; private set; }
    public string? LastError { get; private set; }

    public TeamsCard Card => JsonSerializer.Deserialize<TeamsCard>(CardJson, JsonOptions)!;

    public static ChannelPost For(TeamsChannel channel, TeamsCard card, DateTimeOffset now) => new()
    {
        Id = SequentialId.New(now),
        Channel = channel,
        CardJson = JsonSerializer.Serialize(card, JsonOptions),
        CreatedAt = now,
        Status = ChannelPostStatus.Pending,
        NextAttemptAt = now,
    };
}
