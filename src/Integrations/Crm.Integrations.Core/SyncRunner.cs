using Crm.Integrations.Core.Persistence;
using Crm.Privacy.Contracts;
using Crm.SharedKernel.Domain;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace Crm.Integrations.Core;

/// <summary>Counters a job reports while it runs.</summary>
public sealed class SyncProgress
{
    public int Read { get; set; }
    public int Changed { get; set; }
    public int Failed { get; set; }
    public string? Message { get; set; }
}

/// <summary>Records every synchronization run with its outcome, and stores incremental cursors.</summary>
public sealed class SyncRunner(IntegrationDbContext db, TimeProvider timeProvider, ILogger<SyncRunner> logger, IPrivacyReplayGate? privacy = null)
{
    /// <summary>
    /// Runs <paramref name="work"/> and records the run. <paramref name="quietFor"/> is for a job that runs every few minutes
    /// (DEV-10 role sync): a run that changed nothing, or was skipped, is recorded only when the job's last recorded run
    /// started at least that long ago — a sign of life in the log instead of a row per run that drowns the other systems'.
    /// Failures and changes are always recorded.
    /// </summary>
    public async Task<SyncRun> RunAsync(
        string system, string job, Func<SyncProgress, CancellationToken, Task> work, CancellationToken cancellationToken, TimeSpan? quietFor = null)
    {
        var recordQuiet = quietFor is not { } interval ||
                          await LastRecordedAsync(system, job, cancellationToken) is not { } last ||
                          timeProvider.GetUtcNow() - last >= interval;

        // A paused integration still records the run, so the log shows that the job fell due and was held (runbook 05). After a
        // database restore no synchronization runs until the erasures it lost are applied again (DEV-11-AC06).
        var held = privacy is not null && await privacy.IsReplayPendingAsync(cancellationToken)
            ? "erasures from before a database restore are being applied again (DEV-11)"
            : await IsPausedAsync(system, cancellationToken);
        if (held is { } pause)
        {
            var skipped = new SyncRun
            {
                Id = SequentialId.New(),
                System = system,
                Job = job,
                StartedAt = timeProvider.GetUtcNow(),
                FinishedAt = timeProvider.GetUtcNow(),
                Status = SyncRunStatus.Skipped,
                Message = Truncate($"Paused: {pause}"),
            };
            if (recordQuiet)
            {
                db.SyncRuns.Add(skipped);
                await db.SaveChangesAsync(cancellationToken);
            }

            logger.LogInformation("Synchronization {System}/{Job} skipped: {Reason}.", system, job, pause);
            return skipped;
        }

        var run = new SyncRun
        {
            Id = SequentialId.New(),
            System = system,
            Job = job,
            StartedAt = timeProvider.GetUtcNow(),
            Status = SyncRunStatus.Running,
        };
        if (quietFor is null)
        {
            // Shown while it runs; a quiet job is short and recorded when it ends, if at all.
            db.SyncRuns.Add(run);
            await db.SaveChangesAsync(cancellationToken);
        }

        var progress = new SyncProgress();
        try
        {
            await work(progress, cancellationToken);
            run.Status = SyncRunStatus.Succeeded;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogError(ex, "Synchronization {System}/{Job} failed", system, job);
            run.Status = SyncRunStatus.Failed;
            progress.Message = Truncate(ex.GetBaseException().Message);
            throw;
        }
        finally
        {
            run.Read = progress.Read;
            run.Changed = progress.Changed;
            run.Failed = progress.Failed;
            run.Message = Truncate(progress.Message);
            run.FinishedAt = timeProvider.GetUtcNow();
            if (run.Status == SyncRunStatus.Running)
            {
                run.Status = SyncRunStatus.Failed;
                run.Message ??= "Cancelled";
            }

            var quiet = run is { Status: SyncRunStatus.Succeeded, Changed: 0, Failed: 0 };
            if (quietFor is null || !quiet || recordQuiet)
            {
                if (quietFor is not null)
                {
                    db.SyncRuns.Add(run);
                }

                await db.SaveChangesAsync(CancellationToken.None);
            }
        }

        return run;
    }

    private async Task<DateTimeOffset?> LastRecordedAsync(string system, string job, CancellationToken cancellationToken) =>
        await db.SyncRuns.AsNoTracking()
            .Where(r => r.System == system && r.Job == job)
            .MaxAsync(r => (DateTimeOffset?)r.StartedAt, cancellationToken);

    public async Task<string?> GetCursorAsync(string system, string stream, CancellationToken cancellationToken) =>
        await db.SyncCursors.AsNoTracking()
            .Where(c => c.System == system && c.Stream == stream)
            .Select(c => c.Value)
            .SingleOrDefaultAsync(cancellationToken);

    public async Task SetCursorAsync(string system, string stream, string? value, CancellationToken cancellationToken)
    {
        var cursor = await db.SyncCursors.SingleOrDefaultAsync(c => c.System == system && c.Stream == stream, cancellationToken);
        if (cursor is null)
        {
            cursor = new SyncCursor { System = system, Stream = stream };
            db.SyncCursors.Add(cursor);
        }

        cursor.Value = value;
        cursor.UpdatedAt = timeProvider.GetUtcNow();
        await db.SaveChangesAsync(cancellationToken);
    }

    /// <summary>The reason the system is paused, or null when it runs.</summary>
    public async Task<string?> IsPausedAsync(string system, CancellationToken cancellationToken)
    {
        var paused = await db.IntegrationSwitches.AsNoTracking()
            .Where(s => s.System == system && s.IsPaused)
            .Select(s => s.Reason ?? "no reason given")
            .FirstOrDefaultAsync(cancellationToken);
        return paused;
    }

    private static string? Truncate(string? value) => value is { Length: > 4000 } ? value[..4000] : value;
}
