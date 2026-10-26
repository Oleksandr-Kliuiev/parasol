using Crm.Integrations.Core;
using Crm.Integrations.Core.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crm.IntegrationTests;

public class SyncExclusiveTests(CrmWebFactory factory)
{
    [Fact]
    public async Task Same_system_cannot_overlap_streams_and_failure_releases_the_session()
    {
        var system = $"synthetic-{Guid.NewGuid():N}";
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var first = factory.Services.CreateAsyncScope();
        var running = first.ServiceProvider.GetRequiredService<SyncRunner>().RunExclusiveAsync(system, "customers", async (_, ct) =>
        {
            entered.SetResult();
            await release.Task.WaitAsync(ct);
            throw new InvalidOperationException("Synthetic stop.");
        }, CancellationToken.None);
        try
        {
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(15));
            await using var second = factory.Services.CreateAsyncScope();
            var calls = 0;
            var error = await Should.ThrowAsync<SyncFailedException>(() => second.ServiceProvider.GetRequiredService<SyncRunner>()
                .RunExclusiveAsync(system, "contacts", (_, _) => { calls++; return Task.CompletedTask; }, CancellationToken.None, 0));
            error.ErrorType.ShouldBe("SyncBusy");
            calls.ShouldBe(0);
            // The key is per integration, not a database-wide gate.
            await second.ServiceProvider.GetRequiredService<SyncRunner>()
                .RunExclusiveAsync(system + "-other", "customers", (_, _) => Task.CompletedTask, CancellationToken.None, 0);
        }
        finally
        {
            release.TrySetResult();
            await Should.ThrowAsync<SyncFailedException>(() => running);
        }
        await AssertAvailable(system);
    }

    [Fact]
    public async Task Cancellation_releases_the_session_and_does_not_publish_success()
    {
        var system = $"synthetic-{Guid.NewGuid():N}";
        using var cancellation = new CancellationTokenSource();
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var scope = factory.Services.CreateAsyncScope();
        var running = scope.ServiceProvider.GetRequiredService<SyncRunner>().RunExclusiveAsync(system, "customers", async (_, ct) =>
        {
            entered.SetResult();
            await Task.Delay(Timeout.InfiniteTimeSpan, ct);
        }, cancellation.Token);
        try
        {
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(15));
        }
        finally
        {
            await cancellation.CancelAsync();
            await Should.ThrowAsync<OperationCanceledException>(() => running);
        }
        var db = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
        (await db.SyncRuns.AsNoTracking().Where(r => r.System == system).ToListAsync()).ShouldHaveSingleItem().Status.ShouldBe(SyncRunStatus.Failed);
        (await db.SyncSuccesses.AnyAsync(r => r.System == system)).ShouldBeFalse();
        await AssertAvailable(system);
    }

    [Fact]
    public async Task Lost_sql_session_cannot_reconnect_and_advance_the_cursor_without_its_lock()
    {
        var system = $"synthetic-{Guid.NewGuid():N}";
        var entered = new TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously);
        var killed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var scope = factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
        var runner = scope.ServiceProvider.GetRequiredService<SyncRunner>();
        var calls = 0;
        var running = runner.RunExclusiveAsync(system, "customers", async (_, ct) =>
        {
            calls++;
            entered.SetResult(await db.Database.SqlQueryRaw<int>("SELECT CAST(@@SPID AS int) AS [Value]").SingleAsync(ct));
            await killed.Task.WaitAsync(ct);
            await runner.SetCursorAsync(system, "customers", "must-not-commit", ct);
        }, CancellationToken.None);
        try
        {
            var session = await entered.Task.WaitAsync(TimeSpan.FromSeconds(15));
            await factory.AdminSqlAsync($"KILL {session};");
        }
        finally
        {
            killed.TrySetResult();
            await Should.ThrowAsync<SyncFailedException>(() => running);
        }
        calls.ShouldBe(1);
        await using var check = factory.Services.CreateAsyncScope();
        (await check.ServiceProvider.GetRequiredService<SyncRunner>().GetCursorAsync(system, "customers", CancellationToken.None)).ShouldBeNull();
        await AssertAvailable(system);
    }

    [Fact]
    public async Task Reopening_a_connection_cannot_publish_a_cursor_on_an_unlocked_session()
    {
        var system = $"synthetic-{Guid.NewGuid():N}";
        await using var scope = factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
        var runner = scope.ServiceProvider.GetRequiredService<SyncRunner>();
        await Should.ThrowAsync<SyncFailedException>(() => runner.RunExclusiveAsync(system, "customers", async (_, ct) =>
        {
            await db.Database.CloseConnectionAsync();
            await db.Database.OpenConnectionAsync(ct);
            await runner.SetCursorAsync(system, "customers", "must-not-commit", ct);
        }, CancellationToken.None));
        await using var check = factory.Services.CreateAsyncScope();
        (await check.ServiceProvider.GetRequiredService<SyncRunner>().GetCursorAsync(system, "customers", CancellationToken.None)).ShouldBeNull();
        await AssertAvailable(system);
    }

    private async Task AssertAvailable(string system)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var result = await scope.ServiceProvider.GetRequiredService<SyncRunner>()
            .RunExclusiveAsync(system, "retry", (_, _) => Task.CompletedTask, CancellationToken.None, 0);
        result.Status.ShouldBe(SyncRunStatus.Succeeded);
    }
}
