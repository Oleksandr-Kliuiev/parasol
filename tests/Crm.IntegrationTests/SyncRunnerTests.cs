using Crm.Integrations.Core;
using Crm.Integrations.Core.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

namespace Crm.IntegrationTests;

/// <summary>
/// The integration log keeps every failure and every change; a job that runs every two minutes (DEV-10 role sync) adds its
/// unchanged runs at most once an hour, so it does not drown the other systems' runs.
/// </summary>
public sealed class SyncRunnerTests(CrmWebFactory factory)
{
    private static readonly TimeSpan Hour = TimeSpan.FromHours(1);
    private readonly string _system = $"quiet-{Guid.NewGuid():N}"[..20];

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task A_quiet_job_records_failures_and_changes_always_and_unchanged_runs_once_an_hour()
    {
        var time = new ManualTimeProvider(DateTimeOffset.UtcNow.AddDays(-1));

        await RunAsync(time, changed: 0);
        (await RunsAsync()).ShouldBe([(SyncRunStatus.Succeeded, 0)], "the first run is a sign of life");

        time.Advance(TimeSpan.FromMinutes(2));
        await RunAsync(time, changed: 0);
        time.Advance(TimeSpan.FromMinutes(2));
        await RunAsync(time, changed: 3);
        time.Advance(TimeSpan.FromMinutes(2));
        await Should.ThrowAsync<InvalidOperationException>(() => RunAsync(time, changed: 0, fail: true));
        (await RunsAsync()).ShouldBe([(SyncRunStatus.Succeeded, 0), (SyncRunStatus.Succeeded, 3), (SyncRunStatus.Failed, 0)]);

        time.Advance(TimeSpan.FromMinutes(30));
        await RunAsync(time, changed: 0);
        (await RunsAsync()).Count.ShouldBe(3, "within the hour after the last recorded run");
        time.Advance(TimeSpan.FromMinutes(30));
        await RunAsync(time, changed: 0);
        (await RunsAsync()).Count.ShouldBe(4, "an hour after it: the next sign of life");
    }

    [Fact]
    public async Task A_paused_quiet_job_says_so_once_an_hour_and_an_ordinary_job_records_every_run()
    {
        var time = new ManualTimeProvider(DateTimeOffset.UtcNow.AddDays(-1));
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
            db.IntegrationSwitches.Add(new IntegrationSwitch { System = _system, IsPaused = true, Reason = "test" });
            await db.SaveChangesAsync(Ct);
        }

        await RunAsync(time, changed: 0);
        time.Advance(TimeSpan.FromMinutes(2));
        await RunAsync(time, changed: 0);
        time.Advance(Hour);
        await RunAsync(time, changed: 0);
        (await RunsAsync()).ShouldBe([(SyncRunStatus.Skipped, 0), (SyncRunStatus.Skipped, 0)]);

        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
            await db.IntegrationSwitches.Where(s => s.System == _system).ExecuteDeleteAsync(Ct);
        }

        await RunAsync(time, changed: 0, quiet: false);
        await RunAsync(time, changed: 0, quiet: false);
        (await RunsAsync()).Count.ShouldBe(4);
    }

    private async Task RunAsync(ManualTimeProvider time, int changed, bool fail = false, bool quiet = true)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var runner = new SyncRunner(scope.ServiceProvider.GetRequiredService<IntegrationDbContext>(), time, NullLogger<SyncRunner>.Instance);
        await runner.RunAsync(_system, "job", (progress, _) =>
        {
            progress.Changed = changed;
            return fail ? throw new InvalidOperationException("down") : Task.CompletedTask;
        }, Ct, quiet ? Hour : null);
    }

    private async Task<List<(SyncRunStatus Status, int Changed)>> RunsAsync()
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var runs = await scope.ServiceProvider.GetRequiredService<IntegrationDbContext>().SyncRuns.AsNoTracking()
            .Where(r => r.System == _system).OrderBy(r => r.StartedAt).ThenBy(r => r.Id).ToListAsync(Ct);
        return runs.Select(r => (r.Status, r.Changed)).ToList();
    }
}
