using Crm.Integrations.Core.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crm.Integrations.Core.Webhooks;

/// <summary>
/// What Parasoll last heard from a vendor's webhooks (<c>integration.WebhookStates</c>, one row per system, M44): the last delivery
/// it accepted and its event, how many it has accepted, and the last one it refused with the reason. The connections page shows it;
/// nothing a delivery says is kept beyond the name of its event.
/// </summary>
public sealed class WebhookState
{
    public required string System { get; init; }
    public DateTimeOffset? LastReceivedAt { get; set; }
    public string? LastEventType { get; set; }
    public long Received { get; set; }
    public DateTimeOffset? LastRefusedAt { get; set; }
    public string? LastRefusal { get; set; }
}

/// <summary>
/// A job that webhooks asked to run before its schedule (<c>integration.EarlyReadRequests</c>, one row per system and job, M44). A
/// request is served once a run of the job has begun after it — the scheduled one or one the early-read loop starts — because
/// such a run reads what the vendor had already changed when it sent the webhook.
/// </summary>
public sealed class EarlyReadRequest
{
    public required string System { get; init; }
    public required string Job { get; init; }

    /// <summary>The latest request.</summary>
    public DateTimeOffset RequestedAt { get; set; }

    /// <summary>The first request that is not served yet; null when every request is.</summary>
    public DateTimeOffset? WaitingSince { get; set; }

    /// <summary>Requests up to this moment are served: a run began after them, or the loop started one for them.</summary>
    public DateTimeOffset? ServedUpTo { get; set; }

    /// <summary>When the loop last started the job.</summary>
    public DateTimeOffset? TriggeredAt { get; set; }

    /// <summary>Requests since the row began: what the connections page counts.</summary>
    public long Requests { get; set; }

    public bool IsWaiting => ServedUpTo is not { } served || RequestedAt > served;
}

/// <summary>
/// A record a webhook named for a job that can read one record by its id (<c>integration.EarlyReadTargets</c>): an Atera ticket whose
/// conversation the next run reads even when Atera's list of changed tickets does not name it. Removed once a run has read it.
/// </summary>
public sealed class EarlyReadTarget
{
    public required string System { get; init; }
    public required string Job { get; init; }
    public required string ExternalId { get; init; }
    public DateTimeOffset RequestedAt { get; set; }
}

/// <summary>
/// When this crm-web instance last noted a refused delivery of each system: a flood of forged deliveries reaches the database at most
/// once a minute per system and instance, and the row's own check holds that across instances (M44).
/// </summary>
public sealed class WebhookRefusalThrottle
{
    private readonly System.Collections.Concurrent.ConcurrentDictionary<string, long> lastNoted = new(StringComparer.Ordinal);

    /// <summary>True for the first refusal of a system in an interval, which is then noted; false for every other.</summary>
    public bool TryTake(string system, DateTimeOffset now)
    {
        while (true)
        {
            var known = lastNoted.TryGetValue(system, out var last);
            if (known && now.UtcTicks - last < WebhookInbox.RefusalWriteInterval.Ticks)
            {
                return false;
            }

            if (known ? lastNoted.TryUpdate(system, now.UtcTicks, last) : lastNoted.TryAdd(system, now.UtcTicks))
            {
                return true;
            }
        }
    }
}

/// <summary>Where crm-web files what a proven delivery asks for, and what it heard (M44).</summary>
public sealed class WebhookInbox(IntegrationDbContext db, WebhookRefusalThrottle refusals)
{
    /// <summary>A refusal is noted at most once a minute per system: a flood of forged deliveries is not a flood of writes.</summary>
    public static readonly TimeSpan RefusalWriteInterval = TimeSpan.FromMinutes(1);

    /// <summary>The longest id of a record a delivery may name; a longer one is not read early.</summary>
    public const int MaxTargetLength = 128;

    /// <summary>The state, the requests and the named records of one delivery, in one transaction.</summary>
    public Task AcceptAsync(string system, WebhookReading reading, DateTimeOffset now, CancellationToken ct) =>
        db.Database.CreateExecutionStrategy().ExecuteAsync(async cancellationToken =>
        {
            await using var transaction = await db.Database.BeginTransactionAsync(cancellationToken);
            var eventType = WebhookEvents.Name(reading.EventType);
            await db.Database.ExecuteSqlInterpolatedAsync($"""
                MERGE [integration].[WebhookStates] WITH (HOLDLOCK) AS t
                USING (SELECT {system} AS [System]) AS s ON t.[System] = s.[System]
                WHEN MATCHED THEN UPDATE SET [LastReceivedAt] = {now}, [LastEventType] = {eventType}, [Received] = t.[Received] + 1
                WHEN NOT MATCHED THEN INSERT ([System], [LastReceivedAt], [LastEventType], [Received]) VALUES (s.[System], {now}, {eventType}, 1);
                """, cancellationToken);
            foreach (var job in reading.Reads.Select(r => r.Job).Distinct(StringComparer.Ordinal))
            {
                // A request that arrives while nothing waits starts a new wait; the latest request never moves back.
                await db.Database.ExecuteSqlInterpolatedAsync($"""
                    MERGE [integration].[EarlyReadRequests] WITH (HOLDLOCK) AS t
                    USING (SELECT {system} AS [System], {job} AS [Job]) AS s ON t.[System] = s.[System] AND t.[Job] = s.[Job]
                    WHEN MATCHED THEN UPDATE SET
                        [WaitingSince] = CASE WHEN t.[ServedUpTo] IS NULL OR t.[RequestedAt] > t.[ServedUpTo] THEN COALESCE(t.[WaitingSince], {now}) ELSE {now} END,
                        [RequestedAt] = CASE WHEN t.[RequestedAt] > {now} THEN t.[RequestedAt] ELSE {now} END,
                        [Requests] = t.[Requests] + 1
                    WHEN NOT MATCHED THEN INSERT ([System], [Job], [RequestedAt], [WaitingSince], [Requests]) VALUES (s.[System], s.[Job], {now}, {now}, 1);
                    """, cancellationToken);
            }

            foreach (var (job, target) in reading.Reads.Where(r => r.Target is { Length: > 0 and <= MaxTargetLength })
                         .Select(r => (r.Job, r.Target!)).Distinct())
            {
                await db.Database.ExecuteSqlInterpolatedAsync($"""
                    MERGE [integration].[EarlyReadTargets] WITH (HOLDLOCK) AS t
                    USING (SELECT {system} AS [System], {job} AS [Job], {target} AS [ExternalId]) AS s
                        ON t.[System] = s.[System] AND t.[Job] = s.[Job] AND t.[ExternalId] = s.[ExternalId]
                    WHEN MATCHED THEN UPDATE SET [RequestedAt] = {now}
                    WHEN NOT MATCHED THEN INSERT ([System], [Job], [ExternalId], [RequestedAt]) VALUES (s.[System], s.[Job], s.[ExternalId], {now});
                    """, cancellationToken);
            }

            await transaction.CommitAsync(cancellationToken);
        }, ct);

    /// <summary>
    /// Notes a refused delivery: the time and the reason, unless one was noted less than a minute ago. An unsigned one is not noted:
    /// the vendor always signs (or calls the address with its key), anyone can post without, and the connections page would then call a
    /// working webhook broken until the vendor's next event.
    /// </summary>
    public async Task RefusedAsync(string system, WebhookRefusal refusal, DateTimeOffset now, CancellationToken ct)
    {
        if (refusal == WebhookRefusal.Unsigned || !refusals.TryTake(system, now))
        {
            return;
        }

        var reason = refusal.ToString();
        var quietUntil = now - RefusalWriteInterval;
        await db.Database.ExecuteSqlInterpolatedAsync($"""
            MERGE [integration].[WebhookStates] WITH (HOLDLOCK) AS t
            USING (SELECT {system} AS [System]) AS s ON t.[System] = s.[System]
            WHEN MATCHED AND (t.[LastRefusedAt] IS NULL OR t.[LastRefusedAt] < {quietUntil}) THEN UPDATE SET [LastRefusedAt] = {now}, [LastRefusal] = {reason}
            WHEN NOT MATCHED THEN INSERT ([System], [Received], [LastRefusedAt], [LastRefusal]) VALUES (s.[System], 0, {now}, {reason});
            """, ct);
    }
}

/// <summary>The records webhooks named for a job (M44): the job reads them with its next run and clears the ones it read.</summary>
public sealed class EarlyReadTargets(IntegrationDbContext db)
{
    /// <summary>The oldest first, at most <paramref name="max"/>: the rest wait for the next run.</summary>
    public async Task<IReadOnlyList<string>> ListAsync(string system, string job, int max, CancellationToken ct) =>
        await db.EarlyReadTargets.AsNoTracking()
            .Where(t => t.System == system && t.Job == job)
            .OrderBy(t => t.RequestedAt).ThenBy(t => t.ExternalId)
            .Select(t => t.ExternalId).Take(max).ToListAsync(ct);

    /// <summary>
    /// Removes the records a run has read. One named again after the run began stays: the run may have read it before the change the
    /// new webhook announces.
    /// </summary>
    public async Task<int> ClearAsync(string system, string job, IReadOnlyCollection<string> read, DateTimeOffset readStartedAt, CancellationToken ct) =>
        read.Count == 0 ? 0 : await db.EarlyReadTargets
            .Where(t => t.System == system && t.Job == job && read.Contains(t.ExternalId) && t.RequestedAt <= readStartedAt)
            .ExecuteDeleteAsync(ct);
}
