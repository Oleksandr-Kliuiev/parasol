using Crm.Infrastructure.Health;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.Options;

namespace Crm.UnitTests;

/// <summary>Liveness of crm-worker follows the outbox loop, not the database (DEV-06-AC04).</summary>
public class ProcessingHealthTests
{
    private sealed class ManualTime(DateTimeOffset start) : TimeProvider
    {
        public DateTimeOffset Now { get; set; } = start;

        public override DateTimeOffset GetUtcNow() => Now;
    }

    [Fact]
    public async Task The_worker_is_alive_while_the_loop_finishes_rounds_and_not_after_it_stops()
    {
        var time = new ManualTime(new DateTimeOffset(2026, 10, 4, 8, 0, 0, TimeSpan.Zero));
        var monitor = new ProcessingLoopMonitor(time);
        var check = new ProcessingLoopHealthCheck(monitor, time, Options.Create(new ProcessingHealthOptions { LoopStaleAfter = TimeSpan.FromMinutes(10) }));
        var context = new HealthCheckContext();

        (await check.CheckHealthAsync(context, CancellationToken.None)).Status.ShouldBe(HealthStatus.Healthy, "a fresh start counts as progress");
        time.Now = time.Now.AddMinutes(9);
        monitor.RoundFinished();
        time.Now = time.Now.AddMinutes(9);
        (await check.CheckHealthAsync(context, CancellationToken.None)).Status.ShouldBe(HealthStatus.Healthy);

        // No round for longer than the limit: liveness fails, and the platform restarts the worker.
        time.Now = time.Now.AddMinutes(2);
        var stalled = await check.CheckHealthAsync(context, CancellationToken.None);
        stalled.Status.ShouldBe(HealthStatus.Unhealthy);
        stalled.Description!.ShouldContain("660 s");
    }

    [Fact]
    public void A_round_ends_early_only_when_the_database_cannot_be_reached()
    {
        // Retries exhausted or a timeout: the other contexts would wait just as long, so the round stops.
        Crm.Infrastructure.Outbox.OutboxProcessor.DatabaseUnavailable(new Microsoft.EntityFrameworkCore.Storage.RetryLimitExceededException("retries", new TimeoutException())).ShouldBeTrue();
        Crm.Infrastructure.Outbox.OutboxProcessor.DatabaseUnavailable(new InvalidOperationException("wrapped", new TimeoutException())).ShouldBeTrue();
        // A problem of one context's data or rights does not starve the other contexts.
        Crm.Infrastructure.Outbox.OutboxProcessor.DatabaseUnavailable(new InvalidOperationException("The DELETE permission was denied")).ShouldBeFalse();
    }

    [Fact]
    public void The_defaults_leave_room_for_a_legitimate_round_and_store_heartbeats_sparingly()
    {
        var defaults = new ProcessingHealthOptions();
        defaults.LoopStaleAfter.ShouldBeGreaterThan(TimeSpan.FromMinutes(2), "an outbox lease alone is two minutes");
        defaults.HeartbeatStaleAfter.ShouldBeLessThan(defaults.LoopStaleAfter);
        defaults.HeartbeatInterval.ShouldBeLessThan(defaults.HeartbeatStaleAfter);
    }
}
