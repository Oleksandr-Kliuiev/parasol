using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crm.Authorization;
using Crm.Service.Contracts;
using Crm.Service.Domain;
using Crm.Service.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crm.IntegrationTests;

/// <summary>
/// M40 on SQL Server: a person hides an alert in Parasoll until a day with a reason; it leaves every open list and count until then,
/// is listed under hidden, keeps its source's state, and comes back by itself or when shown again. Each change needs the ETag of the
/// status the person saw, which a read of the source passing by leaves alone, and is kept as an audited transition. Each test reads
/// its alerts under a system of its own.
/// </summary>
public sealed class AlertHidingTests(CrmWebFactory factory)
{
    private const string Alerts = "/api/v1/service/alerts";
    private static readonly TimeZoneInfo Oslo = TimeZoneInfo.FindSystemTimeZoneById("Europe/Oslo");

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task A_hidden_alert_leaves_the_open_lists_and_counts_until_it_is_shown_again()
    {
        var (system, organizationId, marker) = await ScenarioAsync();
        var admin = factory.ClientAs(CrmRoles.Admin);
        await SnapshotAsync(system, organizationId, marker, "hide", "keep");
        var hide = await RowAsync(system, "hide");
        var card = await CardAsync(admin, hide.Id);
        var until = Tomorrow().AddDays(6);

        var hidden = await admin.PostWithETagAsync($"{Alerts}/{hide.Id}/hide", new { until, reason = "Waiting for a new disk from the supplier" }, Etag(card));
        hidden.StatusCode.ShouldBe(HttpStatusCode.OK, await hidden.Content.ReadAsStringAsync(Ct));
        var answer = await hidden.ReadJsonAsync();
        var hold = answer.GetProperty("hidden");
        hold.GetProperty("reason").GetString().ShouldBe("Waiting for a new disk from the supplier");
        hold.GetProperty("byName").GetString().ShouldNotBeNullOrWhiteSpace();
        hold.GetProperty("until").GetDateTimeOffset().ShouldBe(StartInOslo(until));
        answer.GetProperty("state").GetString().ShouldBe("Open", "the source's state is mirrored, never written");

        (await TitlesAsync(admin, $"{Alerts}?organizationId={organizationId}")).ShouldBe([$"{marker} keep"]);
        (await TitlesAsync(admin, $"{Alerts}?organizationId={organizationId}&hidden=true")).ShouldBe([$"{marker} hide"]);
        var summary = await (await admin.GetAsync($"/api/v1/service/organizations/{organizationId}/summary", Ct)).ReadJsonAsync();
        summary.GetProperty("criticalAlerts").GetInt32().ShouldBe(1, "a hidden alert alarms nobody until its day");
        (await TransitionsAsync(hide.Id)).ShouldBe([("Hidden", true)]);

        var shown = await admin.PostWithETagAsync($"{Alerts}/{hide.Id}/show", new { }, Etag(answer));
        shown.StatusCode.ShouldBe(HttpStatusCode.OK);
        (await shown.ReadJsonAsync()).GetProperty("hidden").ValueKind.ShouldBe(JsonValueKind.Null);
        (await TitlesAsync(admin, $"{Alerts}?organizationId={organizationId}")).ShouldBe([$"{marker} hide", $"{marker} keep"], ignoreOrder: true);
        (await TransitionsAsync(hide.Id)).ShouldBe([("Hidden", true), ("Shown", true)]);
    }

    [Fact]
    public async Task A_hidden_alert_comes_back_by_itself_on_its_day()
    {
        var (system, organizationId, marker) = await ScenarioAsync();
        var admin = factory.ClientAs(CrmRoles.Admin);
        await SnapshotAsync(system, organizationId, marker, "back");
        var alert = await RowAsync(system, "back");
        (await admin.PostWithETagAsync($"{Alerts}/{alert.Id}/hide", new { until = Tomorrow(), reason = "Machine is in for repair" }, Etag(await CardAsync(admin, alert.Id))))
            .StatusCode.ShouldBe(HttpStatusCode.OK);
        (await TitlesAsync(admin, $"{Alerts}?organizationId={organizationId}")).ShouldBeEmpty();

        // The day has come: nothing has to run for the alert to be open again.
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<ServiceDbContext>();
            await db.AlertHolds.Where(h => h.Id == alert.Id).ExecuteUpdateAsync(u => u.SetProperty(h => h.Until, DateTimeOffset.UtcNow.AddMinutes(-1)), Ct);
        }

        (await TitlesAsync(admin, $"{Alerts}?organizationId={organizationId}")).ShouldBe([$"{marker} back"]);
        (await TitlesAsync(admin, $"{Alerts}?organizationId={organizationId}&hidden=true")).ShouldBeEmpty();
    }

    [Fact]
    public async Task Hiding_needs_the_status_the_person_saw_a_day_ahead_and_a_reason()
    {
        var (system, organizationId, marker) = await ScenarioAsync();
        var admin = factory.ClientAs(CrmRoles.Admin);
        await SnapshotAsync(system, organizationId, marker, "one");
        var alert = await RowAsync(system, "one");
        var card = await CardAsync(admin, alert.Id);
        var url = $"{Alerts}/{alert.Id}/hide";

        (await admin.PostAsJsonAsync(url, new { until = Tomorrow(), reason = "Later" }, Ct)).StatusCode.ShouldBe(HttpStatusCode.PreconditionRequired);
        await ShouldRefuseAsync(admin.PostWithETagAsync(url, new { until = Tomorrow().AddDays(-1), reason = "Later" }, Etag(card)), "SRV_ALERT_HIDE_DATE");
        await ShouldRefuseAsync(admin.PostWithETagAsync(url, new { until = Tomorrow().AddDays(400), reason = "Later" }, Etag(card)), "SRV_ALERT_HIDE_DATE");
        (await admin.PostWithETagAsync(url, new { until = Tomorrow(), reason = "   " }, Etag(card))).StatusCode.ShouldBe(HttpStatusCode.BadRequest);

        (await admin.PostWithETagAsync($"{Alerts}/{alert.Id}/show", new { }, Etag(card))).StatusCode
            .ShouldBe(HttpStatusCode.BadRequest, "an alert that is not hidden is not shown again");

        // A read passing by moves the alert's last-seen time, not its status in Parasoll: what the person saw still holds.
        await SnapshotAsync(system, organizationId, marker, "one");
        (await RowAsync(system, "one")).LastSeenAt.ShouldNotBe(alert.LastSeenAt);
        var hidden = await admin.PostWithETagAsync(url, new { until = Tomorrow(), reason = "Later" }, Etag(card));
        hidden.StatusCode.ShouldBe(HttpStatusCode.OK, await hidden.Content.ReadAsStringAsync(Ct));

        // Someone else decided in between: the person decides again on what is there now.
        (await admin.PostWithETagAsync(url, new { until = Tomorrow().AddDays(1), reason = "Even later" }, Etag(card))).StatusCode
            .ShouldBe(HttpStatusCode.PreconditionFailed);
        (await admin.PostWithETagAsync($"{Alerts}/{alert.Id}/show", new { }, Etag(card))).StatusCode.ShouldBe(HttpStatusCode.PreconditionFailed);
        (await admin.PostWithETagAsync($"{Alerts}/{alert.Id}/show", new { }, Etag(await hidden.ReadJsonAsync()))).StatusCode.ShouldBe(HttpStatusCode.OK);
    }

    [Fact]
    public async Task An_alert_an_earlier_release_stored_without_its_hold_is_listed_hidden_and_read_as_usual()
    {
        var (system, organizationId, marker) = await ScenarioAsync();
        var admin = factory.ClientAs(CrmRoles.Admin);
        await SnapshotAsync(system, organizationId, marker, "old", "read");
        var old = await RowAsync(system, "old");
        var read = await RowAsync(system, "read");
        // A rollback in between: the earlier release stored these alerts on this schema, without their holds.
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            await scope.ServiceProvider.GetRequiredService<ServiceDbContext>().AlertHolds
                .Where(h => h.Id == old.Id || h.Id == read.Id).ExecuteDeleteAsync(Ct);
        }

        (await TitlesAsync(admin, $"{Alerts}?organizationId={organizationId}")).ShouldBe([$"{marker} old", $"{marker} read"], ignoreOrder: true);
        var hidden = await admin.PostWithETagAsync($"{Alerts}/{old.Id}/hide", new { until = Tomorrow(), reason = "Later" }, Etag(await CardAsync(admin, old.Id)));
        hidden.StatusCode.ShouldBe(HttpStatusCode.OK, await hidden.Content.ReadAsStringAsync(Ct));
        (await TitlesAsync(admin, $"{Alerts}?organizationId={organizationId}&hidden=true")).ShouldBe([$"{marker} old"]);

        // The next read that lists an alert adds its hold; the one the person hid keeps its own.
        await SnapshotAsync(system, organizationId, marker, "old", "read");
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            (await scope.ServiceProvider.GetRequiredService<ServiceDbContext>().AlertHolds.AsNoTracking()
                    .Where(h => h.Id == old.Id || h.Id == read.Id).Select(h => h.Reason).ToListAsync(Ct))
                .ShouldBe(["Later", null], ignoreOrder: true);
        }
    }

    private static DateOnly Tomorrow() => DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, Oslo).DateTime).AddDays(1);

    private static DateTimeOffset StartInOslo(DateOnly day)
    {
        var start = day.ToDateTime(TimeOnly.MinValue);
        return new DateTimeOffset(start, Oslo.GetUtcOffset(start));
    }

    private static async Task ShouldRefuseAsync(Task<HttpResponseMessage> call, string code)
    {
        var response = await call;
        response.StatusCode.ShouldBe(HttpStatusCode.BadRequest);
        (await response.Content.ReadAsStringAsync(Ct)).ShouldContain(code);
    }

    private async Task<(string System, Guid OrganizationId, string Marker)> ScenarioAsync()
    {
        var marker = $"M40{Guid.NewGuid():N}"[..11];
        var organizationId = await factory.ClientAs(CrmRoles.Admin).CreateOrganizationAsync(new { name = $"{marker} Skjul AS", status = "Customer" });
        return ($"m40h-{marker}", organizationId, marker);
    }

    /// <summary>A complete read of the test's own system that lists these alerts open (each read moves their last-seen time).</summary>
    private async Task SnapshotAsync(string system, Guid organizationId, string marker, params string[] ids)
    {
        var alerts = ids.Select(id => new ExternalAlert(id, organizationId, AlertSeverity.Critical, $"{marker} {id}", null, DateTimeOffset.UtcNow.AddHours(-2))).ToList();
        await using var scope = factory.Services.CreateAsyncScope();
        await scope.ServiceProvider.GetRequiredService<IServiceApi>().ApplyAlertSnapshotAsync(
            new AlertSnapshot(system, AlertKind.Monitoring, alerts, alerts.Select(a => a.ExternalId).ToList(), IsComplete: true), Ct);
    }

    private async Task<Alert> RowAsync(string system, string externalId)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<ServiceDbContext>().Alerts.AsNoTracking().SingleAsync(a => a.System == system && a.ExternalId == externalId, Ct);
    }

    private static async Task<JsonElement> CardAsync(HttpClient client, Guid alertId) =>
        await (await client.GetAsync($"{Alerts}/{alertId}", Ct)).ReadJsonAsync();

    private static string Etag(JsonElement card) => card.GetProperty("etag").GetString()!;

    private static async Task<List<string>> TitlesAsync(HttpClient client, string url) =>
        (await (await client.GetAsync(url, Ct)).ReadJsonAsync()).GetProperty("items").EnumerateArray().Select(a => a.GetProperty("title").GetString()!).ToList();

    private async Task<List<(string Kind, bool Audited)>> TransitionsAsync(Guid alertId)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        return (await scope.ServiceProvider.GetRequiredService<ServiceDbContext>().AlertTransitions.AsNoTracking()
                .Where(t => t.AlertId == alertId).OrderBy(t => t.CreatedAt).ToListAsync(Ct))
            .Select(t => (t.Kind.ToString(), t.CreatedBy is not null)).ToList();
    }
}
