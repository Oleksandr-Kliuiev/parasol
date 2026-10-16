using Crm.Integrations.Core;
using Crm.Integrations.Core.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

namespace Crm.IntegrationTests;

/// <summary>Freshness of the Atera work-hour and agent jobs and the Partner Center licence job follows their schedule (DEV-19).</summary>
public class CronAwareFreshnessTests(CrmWebFactory factory)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Theory]
    [InlineData("atera-work-hours", 60, 59, 61)]
    [InlineData("atera-agents", 2175, 2174, 2176)]
    [InlineData("partnercenter-licenses", 2175, 2174, 2176)]
    public async Task A_scheduled_job_is_fresh_until_one_and_a_half_gaps_and_a_quarter_hour_have_passed(string job, int threshold, int freshAfter, int staleAfter)
    {
        var system = $"monitor-{Guid.NewGuid():N}";
        var time = new ManualTimeProvider(DateTimeOffset.UtcNow.AddDays(-5));
        await using var scope = factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
        var reader = new IntegrationMonitoringReader(db, [], new ConfigurationBuilder().Build(), time);
        await new SyncRunner(db, time, NullLogger<SyncRunner>.Instance).RunAsync(system, job, (_, _) => Task.CompletedTask, Ct);
        try
        {
            time.Advance(TimeSpan.FromMinutes(freshAfter));
            var fresh = (await reader.ReadAsync(Ct)).Systems.Single(s => s.System == system);
            fresh.ThresholdMinutes.ShouldBe(threshold);
            fresh.Freshness.ShouldBe("Fresh");

            time.Advance(TimeSpan.FromMinutes(staleAfter - freshAfter));
            (await reader.ReadAsync(Ct)).Systems.Single(s => s.System == system).Freshness.ShouldBe("Stale");
        }
        finally
        {
            await db.SyncRuns.Where(r => r.System == system).ExecuteDeleteAsync(Ct);
            await db.SyncSuccesses.Where(r => r.System == system).ExecuteDeleteAsync(Ct);
        }
    }

    [Fact]
    public async Task A_configured_schedule_changes_the_limit_and_an_explicit_override_wins()
    {
        var system = $"monitor-{Guid.NewGuid():N}";
        var time = new ManualTimeProvider(DateTimeOffset.UtcNow);
        await using var scope = factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
        await new SyncRunner(db, time, NullLogger<SyncRunner>.Instance).RunAsync(system, "atera-work-hours", (_, _) => Task.CompletedTask, Ct);
        try
        {
            var hourly = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["Integrations:Atera:WorkHoursSyncCron"] = "0 * * * *" }).Build();
            (await new IntegrationMonitoringReader(db, [], hourly, time).ReadAsync(Ct)).Systems.Single(s => s.System == system).ThresholdMinutes.ShouldBe(105);

            var overridden = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Integrations:Atera:WorkHoursSyncCron"] = "0 * * * *", ["Monitoring:Freshness:atera-work-hours"] = "10",
            }).Build();
            (await new IntegrationMonitoringReader(db, [], overridden, time).ReadAsync(Ct)).Systems.Single(s => s.System == system).ThresholdMinutes.ShouldBe(10);
        }
        finally
        {
            await db.SyncRuns.Where(r => r.System == system).ExecuteDeleteAsync(Ct);
            await db.SyncSuccesses.Where(r => r.System == system).ExecuteDeleteAsync(Ct);
        }
    }
}
