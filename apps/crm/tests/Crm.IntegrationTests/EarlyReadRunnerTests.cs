using System.Collections.Concurrent;
using Crm.Integrations.Core.Persistence;
using Crm.Integrations.Core.Webhooks;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

namespace Crm.IntegrationTests;

/// <summary>
/// M44: a round of early reads against SQL Server. Each test files requests for jobs of a system of its own; a round serves a request
/// with a run that began after it, waits while a run is under way, and starts a job once, however many rounds follow before its run
/// begins. The class runs in the Atera collection with the webhook tests, whose requests a round also handles.
/// </summary>
[Collection(AteraCollection.Name)]
public sealed class EarlyReadRunnerTests(CrmWebFactory factory) : IAsyncLifetime
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;
    private readonly string system = "early-" + Guid.NewGuid().ToString("N")[..12];

    public ValueTask InitializeAsync() => ValueTask.CompletedTask;

    public async ValueTask DisposeAsync()
    {
        await using var scope = factory.Services.CreateAsyncScope(); var db = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
        await db.EarlyReadRequests.Where(r => r.System == system).ExecuteDeleteAsync(Ct);
        await db.SyncRuns.Where(r => r.System == system).ExecuteDeleteAsync(Ct);
        await db.WebhookStates.Where(s => s.System == system).ExecuteDeleteAsync(Ct);
    }

    private sealed class RecordingTrigger : IJobTrigger
    {
        public ConcurrentQueue<string> Started { get; } = new();

        public void Trigger(string jobId) => Started.Enqueue(jobId);
    }

    private EarlyReadRunner Runner(IJobTrigger trigger) => new(
        factory.Services.GetRequiredService<IServiceScopeFactory>(), trigger, TimeProvider.System,
        Options.Create(new EarlyReadOptions { Quiet = TimeSpan.Zero, MaxWait = TimeSpan.Zero }), NullLogger<EarlyReadRunner>.Instance);

    private async Task RequestAsync(params string[] jobs)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        await scope.ServiceProvider.GetRequiredService<WebhookInbox>()
            .AcceptAsync(system, new WebhookReading("synthetic.event", jobs.Select(job => new EarlyRead(job)).ToList()), DateTimeOffset.UtcNow, Ct);
    }

    private async Task RunAsync(string job, DateTimeOffset startedAt, SyncRunStatus status)
    {
        await using var scope = factory.Services.CreateAsyncScope(); var db = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
        db.SyncRuns.Add(new SyncRun
        {
            Id = Guid.NewGuid(), System = system, Job = job, StartedAt = startedAt, Status = status,
            FinishedAt = status == SyncRunStatus.Running ? null : startedAt.AddSeconds(1),
        });
        await db.SaveChangesAsync(Ct);
    }

    private async Task<EarlyReadRequest> RequestOfAsync(string job)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<IntegrationDbContext>().EarlyReadRequests.AsNoTracking()
            .SingleAsync(r => r.System == system && r.Job == job, Ct);
    }

    [Fact]
    public async Task A_round_starts_a_waiting_job_once_serves_one_a_later_run_read_and_waits_for_a_run_under_way()
    {
        await RunAsync("served", DateTimeOffset.UtcNow.AddMinutes(-10), SyncRunStatus.Succeeded);
        await RunAsync("busy", DateTimeOffset.UtcNow.AddMinutes(-2), SyncRunStatus.Running);
        await RequestAsync("start", "served", "busy");
        // The scheduled read of "served" begins after the webhook: it reads what the vendor announced.
        await RunAsync("served", DateTimeOffset.UtcNow.AddSeconds(1), SyncRunStatus.Running);
        var trigger = new RecordingTrigger();

        await Runner(trigger).RunDueAsync(Ct);

        trigger.Started.Where(job => job is "start" or "served" or "busy").ShouldBe(["start"]);
        (await RequestOfAsync("start")).IsWaiting.ShouldBeFalse();
        (await RequestOfAsync("start")).TriggeredAt.ShouldNotBeNull();
        (await RequestOfAsync("served")).IsWaiting.ShouldBeFalse();
        (await RequestOfAsync("served")).TriggeredAt.ShouldBeNull();
        (await RequestOfAsync("busy")).IsWaiting.ShouldBeTrue();

        // Rounds before the started run begins start nothing again, even for a new webhook: the run will read it.
        await RequestAsync("start");
        await Runner(trigger).RunDueAsync(Ct);
        await Runner(trigger).RunDueAsync(Ct);
        trigger.Started.Count(job => job == "start").ShouldBe(1);
        (await RequestOfAsync("start")).IsWaiting.ShouldBeTrue();

        // The run begins: the request is served without another start.
        await RunAsync("start", DateTimeOffset.UtcNow.AddSeconds(1), SyncRunStatus.Running);
        await Runner(trigger).RunDueAsync(Ct);
        trigger.Started.Count(job => job == "start").ShouldBe(1);
        (await RequestOfAsync("start")).IsWaiting.ShouldBeFalse();
        (await RequestOfAsync("start")).Requests.ShouldBe(2);
    }

    [Fact]
    public async Task Rounds_of_two_worker_instances_at_once_start_a_job_once()
    {
        for (var attempt = 0; attempt < 5; attempt++)
        {
            var job = $"twice-{attempt}";
            await RequestAsync(job);
            var first = new RecordingTrigger(); var second = new RecordingTrigger();

            await Task.WhenAll(Runner(first).RunDueAsync(Ct), Runner(second).RunDueAsync(Ct));

            first.Started.Concat(second.Started).Count(started => started == job).ShouldBe(1, $"attempt {attempt}");
        }
    }

    /// <summary>The job server refuses to queue one job (storage down); every other start is recorded.</summary>
    private sealed class RefusingTrigger(string refused) : IJobTrigger
    {
        public ConcurrentQueue<string> Started { get; } = new();

        public void Trigger(string jobId)
        {
            if (jobId == refused)
            {
                throw new InvalidOperationException("Synthetic: the job storage did not answer.");
            }

            Started.Enqueue(jobId);
        }
    }

    [Fact]
    public async Task A_start_the_job_server_refuses_leaves_the_request_waiting_and_shows_no_start()
    {
        await RequestAsync("refused");
        var before = await RequestOfAsync("refused");

        await Should.ThrowAsync<InvalidOperationException>(() => Runner(new RefusingTrigger("refused")).RunDueAsync(Ct));

        var after = await RequestOfAsync("refused");
        after.IsWaiting.ShouldBeTrue();
        (after.TriggeredAt, after.ServedUpTo, after.WaitingSince).ShouldBe((before.TriggeredAt, before.ServedUpTo, before.WaitingSince));
        // The next round, with the job server back, starts it.
        var trigger = new RecordingTrigger();
        await Runner(trigger).RunDueAsync(Ct);
        trigger.Started.ShouldContain("refused");
    }

    [Fact]
    public async Task Requests_of_one_burst_keep_the_first_wait_and_the_latest_time()
    {
        await RequestAsync("burst");
        var first = await RequestOfAsync("burst");
        await RequestAsync("burst", "burst");

        var request = await RequestOfAsync("burst");
        request.Requests.ShouldBe(2, "one delivery naming a job twice is one request");
        request.WaitingSince.ShouldBe(first.WaitingSince);
        request.RequestedAt.ShouldBeGreaterThanOrEqualTo(first.RequestedAt);
        request.IsWaiting.ShouldBeTrue();
    }
}
