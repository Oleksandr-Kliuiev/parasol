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

    /// <summary>
    /// Not posted: when its turn came, what the notice announces was no longer so (M43: the alert was resolved, hidden or no longer
    /// critical), or its kind was switched off. Nothing reached the channel.
    /// </summary>
    Skipped,
}

/// <summary>What a notice announces (M43); a post without a kind carries the finished card its handler made.</summary>
public enum ChannelPostKind
{
    /// <summary>An alert that became urgent; its parameters name the alert, its words are made when it is sent.</summary>
    UrgentAlert,
}

/// <summary>
/// A card waiting to be posted to a team channel (FR-ACT-04). An event handler only queues it — in its transaction, with its
/// receipt — so a repeated delivery of the event queues nothing twice (DEV-07); <c>ChannelPostJob</c> sends it. A notice (M43)
/// stores its kind and parameters, never a finished sentence: its card is made in the channel's language when it is sent, from what
/// the CRM knows then, and its dedupe key keeps a second notice about the same thing out of the queue.
/// </summary>
public sealed class ChannelPost
{
    public const int MaxAttempts = 8;
    public const int ParametersLength = 1024;
    public const int DedupeKeyLength = 200;

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    private ChannelPost() { }

    public Guid Id { get; private set; }
    public TeamsChannel Channel { get; private set; }

    /// <summary>The finished card; a notice keeps <c>{}</c> here (the column predates notices and stays required).</summary>
    public string CardJson { get; private set; } = "{}";

    /// <summary>What a notice announces; null for a post with a finished card.</summary>
    public ChannelPostKind? Kind { get; private set; }

    /// <summary>A notice's parameters as one JSON object of plain values: ids and codes only.</summary>
    public string? ParametersJson { get; private set; }

    /// <summary>A notice's subject and day (<c>urgent-alert:{alert}:{date}</c>); unique, so the same notice is queued once.</summary>
    public string? DedupeKey { get; private set; }

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

    public IReadOnlyDictionary<string, string> Parameters => ParametersJson is null
        ? new Dictionary<string, string>()
        : JsonSerializer.Deserialize<Dictionary<string, string>>(ParametersJson, JsonOptions) ?? [];

    public static ChannelPost For(TeamsChannel channel, TeamsCard card, DateTimeOffset now) => new()
    {
        Id = SequentialId.New(now),
        Channel = channel,
        CardJson = JsonSerializer.Serialize(card, JsonOptions),
        CreatedAt = now,
        Status = ChannelPostStatus.Pending,
        NextAttemptAt = now,
    };

    public static ChannelPost Notice(
        TeamsChannel channel, ChannelPostKind kind, IReadOnlyDictionary<string, string> parameters, string dedupeKey, DateTimeOffset now) => new()
    {
        Id = SequentialId.New(now),
        Channel = channel,
        Kind = kind,
        ParametersJson = JsonSerializer.Serialize(new SortedDictionary<string, string>(parameters.ToDictionary(), StringComparer.Ordinal), JsonOptions),
        DedupeKey = dedupeKey,
        CreatedAt = now,
        Status = ChannelPostStatus.Pending,
        NextAttemptAt = now,
    };
}
