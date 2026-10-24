using Crm.Authorization;
using Crm.Privacy.Contracts;
using Crm.Service.Contracts;
using Crm.Service.Domain;
using Crm.Service.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crm.IntegrationTests;

/// <summary>
/// M40 on SQL Server: the retention class of resolved alerts counts and removes, as the application's own database identity, only
/// the alerts resolved longer ago than the period, together with their status in Parasoll and its history. Open alerts and alerts
/// resolved within the period stay. The test's alerts live under a system of its own.
/// </summary>
public sealed class AlertRetentionTests(CrmWebFactory factory)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Alerts_resolved_before_the_period_go_with_their_hold_and_history_and_nothing_else_does()
    {
        var system = $"m40r-{Guid.NewGuid():N}"[..16];
        var organizationId = await factory.ClientAs(CrmRoles.Admin).CreateOrganizationAsync(new { name = $"{system} Oppbevaring AS", status = "Customer" });
        var now = DateTimeOffset.UtcNow;
        var sources = new[] { "old", "recent", "open" }
            .Select(id => new ExternalAlert(id, organizationId, AlertSeverity.Warning, $"{system} {id}", null, now.AddDays(-500))).ToList();
        Guid oldId;
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            await scope.ServiceProvider.GetRequiredService<IServiceApi>().ApplyAlertSnapshotAsync(
                new AlertSnapshot(system, AlertKind.Monitoring, sources, sources.Select(a => a.ExternalId).ToList(), IsComplete: true), Ct);
            var db = scope.ServiceProvider.GetRequiredService<ServiceDbContext>();
            var alerts = await db.Alerts.Include(a => a.Hold).Where(a => a.System == system).ToListAsync(Ct);
            var old = alerts.Single(a => a.ExternalId == "old");
            oldId = old.Id;
            old.Hide(now.AddDays(3), "Waiting for a part", null, now);
            db.AlertTransitions.Add(AlertTransition.Hidden(old.Id, now.AddDays(3), "Waiting for a part"));
            old.Resolve(now.AddDays(-400));
            alerts.Single(a => a.ExternalId == "recent").Resolve(now.AddDays(-10));
            await db.SaveChangesAsync(Ct);
        }

        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var retention = scope.ServiceProvider.GetServices<IRetentionContributor>().Single(c => c.DataClass == "service.resolved-alerts");
            var olderThan = now.AddDays(-365);
            (await retention.CountAsync(olderThan, Ct)).ShouldBeGreaterThanOrEqualTo(1);
            (await retention.ApplyAsync(olderThan, 500, Ct)).ShouldBeGreaterThanOrEqualTo(1);

            var db = scope.ServiceProvider.GetRequiredService<ServiceDbContext>();
            (await db.Alerts.AsNoTracking().Where(a => a.System == system).Select(a => a.ExternalId).ToListAsync(Ct))
                .ShouldBe(["recent", "open"], ignoreOrder: true);
            (await db.AlertHolds.AsNoTracking().CountAsync(h => h.Id == oldId, Ct)).ShouldBe(0);
            (await db.AlertTransitions.AsNoTracking().CountAsync(t => t.AlertId == oldId, Ct)).ShouldBe(0);
            (await retention.CountAsync(olderThan, Ct)).ShouldBe(0, "nothing older is left");
        }
    }
}
