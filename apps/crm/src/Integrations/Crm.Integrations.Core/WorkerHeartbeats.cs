using Crm.Infrastructure.Health;
using Crm.Integrations.Core.Persistence;
using Crm.SharedKernel.Operations;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Crm.Integrations.Core;

/// <summary>
/// The last sign of life of a background component of one worker instance (<c>integration.WorkerHeartbeats</c>, DEV-06):
/// the outbox loop after its rounds, the job server through a job that runs every minute. One row per component and
/// instance, rewritten in place; rows of instances gone for a week are removed.
/// </summary>
public sealed class WorkerHeartbeat
{
    public required string Component { get; init; }
    public required string Instance { get; init; }
    public DateTimeOffset BeatAt { get; set; }
    public string? Detail { get; set; }
}

public sealed record WorkerHeartbeatStatus(string Component, string Instance, DateTimeOffset BeatAt, int AgeSeconds, bool Stale, string? Detail);

internal sealed class WorkerHeartbeatStore(IntegrationDbContext db, TimeProvider time) : IWorkerHeartbeat
{
    public async Task BeatAsync(string component, string? detail, CancellationToken cancellationToken)
    {
        // Operational, not business data: monitoring keeps seeing a live worker during read-only maintenance (DEV-13).
        using var allowed = MaintenanceScope.AllowWrites("heartbeat");
        var instance = Environment.MachineName;
        var beat = await db.WorkerHeartbeats.SingleOrDefaultAsync(h => h.Component == component && h.Instance == instance, cancellationToken);
        if (beat is null)
        {
            beat = new WorkerHeartbeat { Component = component, Instance = instance };
            db.WorkerHeartbeats.Add(beat);
        }

        beat.BeatAt = time.GetUtcNow();
        beat.Detail = detail is { Length: > 256 } ? detail[..256] : detail;
        await db.SaveChangesAsync(cancellationToken);
    }
}

/// <summary>Reads the heartbeats for monitoring (<c>/health/details</c>); a heartbeat older than the limit is stale.</summary>
public sealed class WorkerHeartbeatReader(IntegrationDbContext db, TimeProvider time, IOptions<ProcessingHealthOptions> options)
{
    public async Task<IReadOnlyList<WorkerHeartbeatStatus>> ReadAsync(CancellationToken cancellationToken)
    {
        var now = time.GetUtcNow();
        var beats = await db.WorkerHeartbeats.AsNoTracking().OrderBy(h => h.Component).ThenBy(h => h.Instance).ToListAsync(cancellationToken);
        return beats.Select(h => new WorkerHeartbeatStatus(
                h.Component, h.Instance, h.BeatAt, (int)Math.Max(0, (now - h.BeatAt).TotalSeconds), now - h.BeatAt > options.Value.HeartbeatStaleAfter, h.Detail))
            .ToList();
    }
}

/// <summary>
/// Runs every minute in crm-worker (Hangfire): the job server picks up and executes jobs, or this heartbeat ages. Also removes
/// the rows of worker instances that have been gone for a week.
/// </summary>
public sealed class WorkerHeartbeatJob(IWorkerHeartbeat heartbeat, IntegrationDbContext db, TimeProvider time)
{
    public const string JobId = "worker-heartbeat";
    public const string Component = "jobs";

    public async Task RunAsync(CancellationToken cancellationToken)
    {
        await heartbeat.BeatAsync(Component, "recurring job executed", cancellationToken);
        var gone = time.GetUtcNow().AddDays(-7);
        await db.WorkerHeartbeats.Where(h => h.BeatAt < gone).ExecuteDeleteAsync(cancellationToken);
    }
}
