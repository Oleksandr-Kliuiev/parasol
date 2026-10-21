using Crm.Integrations.Core.Persistence;
using Crm.Privacy.Contracts;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using System.Text.Json.Serialization;

namespace Crm.Integrations.Core;

/// <summary>Latest successful completion, including quiet runs; independent of log retention and later failures.</summary>
public sealed class SyncSuccess
{
    public required string System { get; init; }
    public required string Job { get; init; }
    public DateTimeOffset SucceededAt { get; set; }
}

public sealed class ExceptionTriage
{
    public Guid Id { get; init; }
    public required string Key { get; init; }
    public string Category { get; set; } = "Integration";
    public string Source { get; set; } = "";
    public string Kind { get; set; } = "";
    public string? RequiredPermission { get; set; }
    public Guid? OwnerId { get; set; }
    public string Status { get; set; } = "Open";
    public string? Comment { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
    public byte[] RowVersion { get; set; } = [];
}

public sealed record ExceptionTriageItem(Guid? OwnerId, string? OwnerName, string Status, string? Comment, string Etag)
{
    public static ExceptionTriageItem Empty { get; } = new(null, null, "Open", null, "\"new\"");
}

/// <param name="LastFailedAt">When the latest run that failed or could not read everything ended, whether or not a success followed.</param>
public sealed record IntegrationFreshnessItem(
    string System, string Job, bool Enabled, bool Paused, DateTimeOffset? LastRunAt, string? LastRunStatus,
    DateTimeOffset? LastSucceededAt, double? AgeMinutes, string Freshness, int ThresholdMinutes, int FailedOutbound, int Unmapped,
    DateTimeOffset? LastFailedAt = null);

public sealed record MonitoringExceptionItem(
    string Key, string Category, string Source, string Kind, DateTimeOffset? DetectedAt, DateTimeOffset? LastSucceededAt,
    double? AgeMinutes, int? ThresholdMinutes, int Count, string Impact, string Runbook, ExceptionTriageItem Triage,
    bool Active = true, [property: JsonIgnore] string? RequiredPermission = null);

public sealed record IntegrationMonitoringSnapshot(
    DateTimeOffset CheckedAt, IReadOnlyList<IntegrationFreshnessItem> Systems, IReadOnlyList<MonitoringExceptionItem> Exceptions,
    int RecoveredTotalCount = 0);

/// <summary>Only bounded dimension names and counts. Provider messages, amounts and mirrored records never enter this projection.</summary>
public sealed class IntegrationMonitoringReader(
    IntegrationDbContext db, IEnumerable<IIntegrationAdapter> adapters, IConfiguration configuration, TimeProvider time)
{
    public const string Runbook = "docs/runbooks/15-monitoring.md";

    public Task<IntegrationMonitoringSnapshot> ReadAsync(CancellationToken ct) => ReadAsync([], ct);

    /// <summary>
    /// The snapshot, with <paramref name="expected"/> streams reported even before their first run (the connections page lists
    /// every job this instance is configured to run).
    /// </summary>
    public async Task<IntegrationMonitoringSnapshot> ReadAsync(IEnumerable<(string System, string Job)> expected, CancellationToken ct)
    {
        var now = time.GetUtcNow();
        var latest = await db.SyncRuns.AsNoTracking().Where(r => r.Job != IntegrationConnectionTestHandler.Job)
            .GroupBy(r => new { r.System, r.Job }).Select(g => g.OrderByDescending(r => r.StartedAt).ThenByDescending(r => r.Id).First()).ToListAsync(ct);
        var failures = await db.SyncRuns.AsNoTracking().Where(r => r.Job != IntegrationConnectionTestHandler.Job &&
                (r.Status == SyncRunStatus.Failed || r.Failed > 0))
            .GroupBy(r => new { r.System, r.Job }).Select(g => g.OrderByDescending(r => r.FinishedAt).ThenByDescending(r => r.Id).First()).ToListAsync(ct);
        var successes = await db.SyncSuccesses.AsNoTracking().Where(s => s.Job != IntegrationConnectionTestHandler.Job).ToListAsync(ct);
        var pauses = await db.IntegrationSwitches.AsNoTracking().Where(s => s.IsPaused).ToDictionaryAsync(s => s.System, ct);
        var failed = await db.OutboundOperations.AsNoTracking()
            .Where(o => o.Status == OutboundStatus.Failed || o.Status == OutboundStatus.DeadLetter)
            .GroupBy(o => o.System).Select(g => new { System = g.Key, Count = g.Count(), At = g.Min(o => o.CreatedAt) }).ToDictionaryAsync(g => g.System, ct);
        var unmapped = await db.ExternalRecords.AsNoTracking().Where(r => !r.IsGone && !db.ExternalLinks.Any(l =>
                l.System == r.System && l.ExternalType == r.ExternalType && l.ExternalId == r.ExternalId))
            .GroupBy(r => r.System).Select(g => new { System = g.Key, Count = g.Count(), At = g.Min(r => r.FirstSeenAt) }).ToDictionaryAsync(g => g.System, ct);
        var enabled = adapters.ToDictionary(a => a.System, a => a.IsEnabled);
        var streams = latest.Select(r => (r.System, r.Job)).Concat(successes.Select(r => (r.System, r.Job))).ToHashSet();
        // These are specification limits, and must signal even before their first run. Other jobs are configurable.
        if (enabled.ContainsKey("atera"))
        {
            streams.Add(("atera", "atera-tickets"));
            streams.Add(("atera", "atera-tickets-recent"));
            streams.Add(("atera", "atera-work-hours"));
            streams.Add(("atera", "atera-agents"));
        }
        if (enabled.ContainsKey("partnercenter")) streams.Add(("partnercenter", "partnercenter-licenses"));
        if (enabled.ContainsKey("poweroffice")) streams.Add(("poweroffice", "poweroffice-invoices"));
        foreach (var stream in configuration.GetSection("Monitoring:Streams").GetChildren())
        {
            if (stream["System"] is { } system && stream["Job"] is { } job) streams.Add((system, job));
        }

        streams.UnionWith(expected);

        var systems = new List<IntegrationFreshnessItem>();
        var exceptions = new List<MonitoringExceptionItem>();
        foreach (var (system, job) in streams.OrderBy(s => s.System).ThenBy(s => s.Job))
        {
            var last = latest.SingleOrDefault(r => r.System == system && r.Job == job);
            var failure = failures.SingleOrDefault(r => r.System == system && r.Job == job);
            var succeeded = successes.SingleOrDefault(r => r.System == system && r.Job == job)?.SucceededAt;
            var threshold = Threshold(job);
            var age = succeeded is { } at ? Math.Max(0, (now - at).TotalMinutes) : (double?)null;
            var isEnabled = enabled.GetValueOrDefault(system, true);
            var paused = pauses.ContainsKey(system);
            var freshness = !isEnabled ? "Disabled" : paused ? "Paused" : age is null ? "Never" : age > threshold ? "Stale" : "Fresh";
            systems.Add(new(system, job, isEnabled, paused, last?.StartedAt, last?.Status.ToString(), succeeded, age, freshness, threshold,
                failed.GetValueOrDefault(system)?.Count ?? 0, unmapped.GetValueOrDefault(system)?.Count ?? 0, failure?.FinishedAt ?? failure?.StartedAt));
            if (!isEnabled || paused) continue;
            if (freshness is "Never" or "Stale")
                exceptions.Add(Item($"sync-stale:{system}:{job}", "Integration", system, "SyncStale", succeeded ?? last?.StartedAt, 1, succeeded, age, threshold));
            if (failure is not null && (succeeded is null || succeeded < (failure.FinishedAt ?? failure.StartedAt)))
                exceptions.Add(Item($"sync-failed:{system}:{job}", "Integration", system, "SyncFailed", failure.StartedAt, 1, succeeded, age, threshold));
        }

        foreach (var (system, pause) in pauses)
            exceptions.Add(Item($"paused:{system}", "Pause", system, "Paused", pause.PausedAt, 1));
        foreach (var (system, value) in failed)
            exceptions.Add(Item($"outbound:{system}", "Integration", system, "OutboundFailed", value.At, value.Count));
        foreach (var (system, value) in unmapped)
            exceptions.Add(Item($"unmapped:{system}", "Integration", system, "Unmapped", value.At, value.Count));
        return new(now, systems, exceptions);
    }

    private int Threshold(string job) => Math.Clamp(configuration.GetValue<int?>("Monitoring:Freshness:" + job) ?? job switch
    {
        "atera-tickets-recent" or "atera-tickets" => 15,
        "poweroffice-invoices" => 90,
        _ when CronJobs.TryGetValue(job, out var cron) =>
            CronCadence.FreshnessMinutes(configuration[cron.Key], cron.Default) ?? configuration.GetValue("Monitoring:FreshnessMinutes", 1440),
        _ => configuration.GetValue("Monitoring:FreshnessMinutes", 1440),
    }, 1, 525600);

    /// <summary>
    /// Jobs whose freshness follows their schedule (DEV-19): the limit is the longest gap between two runs of the configured
    /// cron plus half a gap and a quarter of an hour, so a daily job is not stale at 24 hours and a half-hourly one is stale
    /// after an hour. The defaults repeat those of the options classes, which this project cannot reference.
    /// </summary>
    private static readonly Dictionary<string, (string Key, string Default)> CronJobs = new(StringComparer.Ordinal)
    {
        ["atera-work-hours"] = ("Integrations:Atera:WorkHoursSyncCron", "*/30 * * * *"),
        ["atera-agents"] = ("Integrations:Atera:AgentSyncCron", "30 1 * * *"),
        ["partnercenter-licenses"] = ("Integrations:PartnerCenter:LicenseSyncCron", "50 2 * * *"),
    };

    public static MonitoringExceptionItem Item(string key, string category, string source, string kind, DateTimeOffset? at, int count,
        DateTimeOffset? succeeded = null, double? age = null, int? threshold = null) =>
        new(key, category, source, kind, at, succeeded, age, threshold, count, kind, Runbook, ExceptionTriageItem.Empty);
}

/// <summary>Only resolved case notes are eligible; the approved privacy retention policy supplies the cutoff.</summary>
internal sealed class ExceptionTriageRetention(IntegrationDbContext db) : IRetentionContributor
{
    public string DataClass => "integration.exception-triage";
    public Task<int> CountAsync(DateTimeOffset olderThan, CancellationToken cancellationToken) => Due(olderThan).CountAsync(cancellationToken);
    public async Task<int> ApplyAsync(DateTimeOffset olderThan, int batchSize, CancellationToken cancellationToken)
    {
        var ids = await Due(olderThan).OrderBy(t => t.UpdatedAt).Select(t => t.Id).Take(batchSize).ToListAsync(cancellationToken);
        return ids.Count == 0 ? 0 : await db.ExceptionTriages.Where(t => ids.Contains(t.Id)).ExecuteDeleteAsync(cancellationToken);
    }
    private IQueryable<ExceptionTriage> Due(DateTimeOffset olderThan) => db.ExceptionTriages.Where(t => t.Status == "Resolved" && t.UpdatedAt < olderThan);
}

/// <summary>Reads the spacing of runs out of a five-field cron expression, for the schedules this project uses (minute and hour lists, ranges and steps).</summary>
public static class CronCadence
{
    /// <summary>
    /// Minutes after which a job on <paramref name="cron"/> (or <paramref name="fallback"/> when empty) is overdue, or null when
    /// the expression restricts days or months, which this reading does not follow.
    /// </summary>
    public static int? FreshnessMinutes(string? cron, string fallback)
    {
        var gap = LongestGapMinutes(string.IsNullOrWhiteSpace(cron) ? fallback : cron);
        return gap is { } minutes ? minutes + minutes / 2 + 15 : null;
    }

    /// <summary>The longest time between two runs within a day, wrapping over midnight; null when days or months are restricted or the text is not understood.</summary>
    public static int? LongestGapMinutes(string cron)
    {
        var fields = cron.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (fields.Length != 5 || fields[2] != "*" || fields[3] != "*" || fields[4] != "*")
        {
            return null;
        }

        var minutes = Expand(fields[0], 0, 59);
        var hours = Expand(fields[1], 0, 23);
        if (minutes is null || hours is null)
        {
            return null;
        }

        var times = hours.SelectMany(h => minutes.Select(m => h * 60 + m)).Order().ToList();
        if (times.Count == 0)
        {
            return null;
        }

        var gap = 1440 - times[^1] + times[0];
        for (var i = 1; i < times.Count; i++)
        {
            gap = Math.Max(gap, times[i] - times[i - 1]);
        }

        return gap;
    }

    private static List<int>? Expand(string field, int min, int max)
    {
        var values = new SortedSet<int>();
        foreach (var part in field.Split(','))
        {
            var step = 1;
            var range = part;
            var slash = part.IndexOf('/', StringComparison.Ordinal);
            if (slash >= 0)
            {
                if (!int.TryParse(part[(slash + 1)..], System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out step) || step < 1)
                {
                    return null;
                }

                range = part[..slash];
            }

            int from, to;
            if (range == "*")
            {
                (from, to) = (min, max);
            }
            else if (range.Contains('-', StringComparison.Ordinal))
            {
                var bounds = range.Split('-');
                if (bounds.Length != 2 || !int.TryParse(bounds[0], System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out from) ||
                    !int.TryParse(bounds[1], System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out to))
                {
                    return null;
                }
            }
            else if (int.TryParse(range, System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out from))
            {
                to = slash >= 0 ? max : from;
            }
            else
            {
                return null;
            }

            if (from < min || to > max || from > to)
            {
                return null;
            }

            for (var v = from; v <= to; v += step)
            {
                values.Add(v);
            }
        }

        return values.ToList();
    }
}
