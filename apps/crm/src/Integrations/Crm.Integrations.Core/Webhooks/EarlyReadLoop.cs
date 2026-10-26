using Crm.Infrastructure.Health;
using Crm.Integrations.Core.Persistence;
using Crm.SharedKernel.Operations;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Crm.Integrations.Core.Webhooks;

/// <summary>Starts a recurring job now, outside its schedule: crm-worker's job server (Hangfire), which the job's filters still guard.</summary>
public interface IJobTrigger
{
    void Trigger(string jobId);
}

/// <summary>
/// How eagerly webhooks start reads (<c>Integrations:EarlyReads</c>, M44). The defaults keep a vendor's limit safe: a job runs early at
/// most once a <see cref="MinimumGap"/> since its last run began, scheduled or not, and a burst of deliveries becomes one read.
/// </summary>
public sealed class EarlyReadOptions
{
    public const string SectionName = "Integrations:EarlyReads";

    /// <summary>How long no new request must arrive before a read starts, so the deliveries of one change become one read.</summary>
    public TimeSpan Quiet { get; set; } = TimeSpan.FromSeconds(3);

    /// <summary>The longest a request waits for that quiet while deliveries keep coming.</summary>
    public TimeSpan MaxWait { get; set; } = TimeSpan.FromSeconds(15);

    /// <summary>The least time between the beginnings of two runs of a job, however many webhooks arrive.</summary>
    public TimeSpan MinimumGap { get; set; } = TimeSpan.FromSeconds(60);

    /// <summary>How long a started job may take to begin before a new request may start it again.</summary>
    public TimeSpan StartWait { get; set; } = TimeSpan.FromMinutes(2);

    /// <summary>A run recorded as running for longer than this is taken as stopped (a worker that died mid-run).</summary>
    public TimeSpan RunningLimit { get; set; } = TimeSpan.FromMinutes(15);
}

/// <summary>The latest run of a job: when it began and whether it is still running.</summary>
internal sealed record LatestRun(DateTimeOffset StartedAt, bool Running);

internal enum EarlyReadStep
{
    /// <summary>Nothing waits.</summary>
    None,

    /// <summary>Not yet: a burst is still arriving, a run is under way or about to begin, or the job ran a moment ago.</summary>
    Wait,

    /// <summary>A run began after the latest request: it reads what the webhooks announced, so nothing has to start.</summary>
    Served,

    /// <summary>Start the job now.</summary>
    Start,
}

/// <summary>The rules of one request, apart from the database so they can be read and tested on their own.</summary>
internal static class EarlyReadRules
{
    public static EarlyReadStep Decide(EarlyReadRequest request, LatestRun? latest, DateTimeOffset now, EarlyReadOptions options)
    {
        if (!request.IsWaiting)
            return EarlyReadStep.None;
        if (latest is { } run && run.StartedAt >= request.RequestedAt)
            return EarlyReadStep.Served;
        // A run that began before the request may have read the vendor before the change: the next one starts after it ends.
        if (latest is { Running: true })
            return EarlyReadStep.Wait;
        // The loop started the job and the run has not begun yet: it will begin after every request so far.
        if (request.TriggeredAt is { } triggered && (latest is null || latest.StartedAt < triggered) && now - triggered < options.StartWait)
            return EarlyReadStep.Wait;
        if (now - request.RequestedAt < options.Quiet && now - (request.WaitingSince ?? request.RequestedAt) < options.MaxWait)
            return EarlyReadStep.Wait;
        if (latest is { } last && now - last.StartedAt < options.MinimumGap)
            return EarlyReadStep.Wait;
        return EarlyReadStep.Start;
    }
}

/// <summary>
/// One round of early reads (M44): every request still waiting is served by a run that began after it, waits, or starts its job.
/// A request is marked before its job is started, so a round that fails after the start never starts it twice; one that fails
/// before leaves the request waiting for the next round. Nothing here calls a vendor: the job does, as on its schedule.
/// </summary>
public sealed class EarlyReadRunner(
    IServiceScopeFactory scopes, IJobTrigger trigger, TimeProvider time, IOptions<EarlyReadOptions> options, ILogger<EarlyReadRunner> logger)
{
    /// <summary>Returns how many jobs it started.</summary>
    public async Task<int> RunDueAsync(CancellationToken ct)
    {
        await using var scope = scopes.CreateAsyncScope();
        // While the CRM is read-only the worker runs no reads, and the web host refuses webhooks: the requests wait for the end.
        if ((await scope.ServiceProvider.GetRequiredService<IMaintenanceGate>().CurrentAsync(ct)).IsReadOnly)
        {
            return 0;
        }

        var db = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
        var waiting = await db.EarlyReadRequests.AsNoTracking()
            .Where(r => r.ServedUpTo == null || r.RequestedAt > r.ServedUpTo)
            .OrderBy(r => r.RequestedAt)
            .ToListAsync(ct);
        var started = 0;
        foreach (var request in waiting)
        {
            var now = time.GetUtcNow();
            var latest = await db.SyncRuns.AsNoTracking()
                .Where(r => r.System == request.System && r.Job == request.Job)
                .OrderByDescending(r => r.StartedAt)
                .Select(r => new { r.StartedAt, r.Status })
                .FirstOrDefaultAsync(ct);
            var run = latest is null ? null
                : new LatestRun(latest.StartedAt, latest.Status == SyncRunStatus.Running && now - latest.StartedAt < options.Value.RunningLimit);
            switch (EarlyReadRules.Decide(request, run, now, options.Value))
            {
                case EarlyReadStep.Served:
                    await MarkAsync(db, request, served: run!.StartedAt, triggered: null, ct);
                    break;
                case EarlyReadStep.Start:
                    // The requests read so far are served by the run about to begin; one that arrived meanwhile keeps waiting. The mark is
                    // taken only if no other worker instance started the job since this round read the request: one start, not two.
                    if (await MarkAsync(db, request, served: request.RequestedAt, triggered: now, ct) == 0)
                    {
                        break;
                    }

                    try
                    {
                        trigger.Trigger(request.Job);
                    }
                    catch (Exception ex) when (ex is not OperationCanceledException)
                    {
                        // Nothing was queued: the requests wait again for the next round, and no start is shown that never was.
                        await UnmarkAsync(db, request, now);
                        throw;
                    }

                    started++;
                    logger.LogInformation("Early read of {System}/{Job} started after {Requests} webhook request(s)", request.System, request.Job, request.Requests);
                    break;
            }
        }

        return started;
    }

    /// <summary>Puts back what the round read, while no other round has marked the request since.</summary>
    private static Task<int> UnmarkAsync(IntegrationDbContext db, EarlyReadRequest request, DateTimeOffset triggered) =>
        db.EarlyReadRequests
            .Where(r => r.System == request.System && r.Job == request.Job && r.TriggeredAt == triggered)
            .ExecuteUpdateAsync(set => set
                .SetProperty(r => r.ServedUpTo, request.ServedUpTo)
                .SetProperty(r => r.WaitingSince, request.WaitingSince ?? request.RequestedAt)
                .SetProperty(r => r.TriggeredAt, request.TriggeredAt), CancellationToken.None);

    private static Task<int> MarkAsync(IntegrationDbContext db, EarlyReadRequest request, DateTimeOffset served, DateTimeOffset? triggered, CancellationToken ct) =>
        db.EarlyReadRequests
            .Where(r => r.System == request.System && r.Job == request.Job && (triggered == null || r.TriggeredAt == request.TriggeredAt))
            .ExecuteUpdateAsync(set => set
                .SetProperty(r => r.ServedUpTo, r => r.ServedUpTo == null || r.ServedUpTo < served ? served : r.ServedUpTo)
                .SetProperty(r => r.WaitingSince, r => r.RequestedAt > served ? r.WaitingSince : null)
                .SetProperty(r => r.TriggeredAt, r => triggered ?? r.TriggeredAt), ct);
}

/// <summary>The five-second loop of early reads in crm-worker, with a heartbeat of its own on the connections page (M44).</summary>
public sealed class EarlyReadLoop(EarlyReadRunner runner, IServiceScopeFactory scopes, TimeProvider time, ILogger<EarlyReadLoop> logger) : BackgroundService
{
    public const string HeartbeatComponent = "early-reads";
    public static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(5);
    private static readonly TimeSpan BeatInterval = TimeSpan.FromSeconds(30);
    private DateTimeOffset _lastBeat = DateTimeOffset.MinValue;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(PollInterval, time);
        do
        {
            var started = 0;
            try
            {
                started = await runner.RunDueAsync(stoppingToken);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                // The round ends; the next one starts on time, so an outage does not stop the loop.
                logger.LogError("A round of early reads failed ({ErrorType})", ex.GetType().Name);
            }

            await BeatAsync(started, stoppingToken);
        }
        while (await timer.WaitForNextTickAsync(stoppingToken));
    }

    private async Task BeatAsync(int started, CancellationToken cancellationToken)
    {
        var now = time.GetUtcNow();
        if (now - _lastBeat < BeatInterval && started == 0)
        {
            return;
        }

        try
        {
            await using var scope = scopes.CreateAsyncScope();
            await scope.ServiceProvider.GetRequiredService<IWorkerHeartbeat>().BeatAsync(HeartbeatComponent, $"round finished, {started} started", cancellationToken);
            _lastBeat = now;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogWarning("The early-read loop could not store its heartbeat ({ErrorType})", ex.GetType().Name);
        }
    }
}
