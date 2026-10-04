using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.Options;

namespace Crm.Infrastructure.Health;

/// <summary>Health of the background processing in crm-worker (DEV-06, docs/07 §4.3).</summary>
public sealed class ProcessingHealthOptions
{
    public const string SectionName = "Worker:Health";

    /// <summary>Age after which monitoring calls a component's heartbeat stale.</summary>
    public TimeSpan HeartbeatStaleAfter { get; set; } = TimeSpan.FromMinutes(3);

    /// <summary>
    /// Time without a finished round of the outbox loop after which liveness fails and the platform restarts the worker.
    /// Longer than any legitimate round: an outbox lease alone is two minutes.
    /// </summary>
    public TimeSpan LoopStaleAfter { get; set; } = TimeSpan.FromMinutes(10);

    /// <summary>Least time between two stored heartbeats of a component.</summary>
    public TimeSpan HeartbeatInterval { get; set; } = TimeSpan.FromSeconds(30);
}

/// <summary>Stores a heartbeat of a background component where monitoring reads it (Integrations.Core implements it).</summary>
public interface IWorkerHeartbeat
{
    Task BeatAsync(string component, string? detail, CancellationToken cancellationToken);
}

/// <summary>
/// When the outbox loop last finished a round, in memory. Liveness of crm-worker is built on this and not on the database:
/// a database outage lets rounds finish (with errors) and restarts nothing, a wedged loop does not and gets restarted.
/// </summary>
public sealed class ProcessingLoopMonitor(TimeProvider time)
{
    private long _lastRound = time.GetUtcNow().UtcTicks;

    public DateTimeOffset LastRound => new(Interlocked.Read(ref _lastRound), TimeSpan.Zero);

    public void RoundFinished() => Interlocked.Exchange(ref _lastRound, time.GetUtcNow().UtcTicks);
}

public sealed class ProcessingLoopHealthCheck(ProcessingLoopMonitor monitor, TimeProvider time, IOptions<ProcessingHealthOptions> options) : IHealthCheck
{
    public Task<HealthCheckResult> CheckHealthAsync(HealthCheckContext context, CancellationToken cancellationToken)
    {
        var age = time.GetUtcNow() - monitor.LastRound;
        return Task.FromResult(age <= options.Value.LoopStaleAfter
            ? HealthCheckResult.Healthy()
            : HealthCheckResult.Unhealthy($"The outbox loop has not finished a round for {(int)age.TotalSeconds} s."));
    }
}
