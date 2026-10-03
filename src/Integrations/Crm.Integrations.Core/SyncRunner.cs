using Crm.Integrations.Core.Persistence;
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
public sealed class SyncRunner(IntegrationDbContext db, TimeProvider timeProvider, ILogger<SyncRunner> logger)
{
    public async Task<SyncRun> RunAsync(string system, string job, Func<SyncProgress, CancellationToken, Task> work, CancellationToken cancellationToken)
    {
        // A paused integration still records the run, so the log shows that the job fell due and was held (runbook 05).
        if (await IsPausedAsync(system, cancellationToken) is { } pause)
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
            db.SyncRuns.Add(skipped);
            await db.SaveChangesAsync(cancellationToken);
            logger.LogInformation("Synchronization {System}/{Job} skipped: the integration is paused.", system, job);
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
        db.SyncRuns.Add(run);
        await db.SaveChangesAsync(cancellationToken);

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

            await db.SaveChangesAsync(CancellationToken.None);
        }

        return run;
    }

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
