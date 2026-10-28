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
/// M45 on SQL Server: the alert queue narrows by source and age with counts of the whole filter; "all that match" is selected in the
/// queue's order up to 500, with the ETag of each alert's status; and many alerts are hidden until one day with one reason, or shown
/// again, each checked against the status its dialog read and answered with what happened to it. Each test reads its alerts under a
/// system of its own.
/// </summary>
public sealed class AlertBulkTests(CrmWebFactory factory)
{
    private const string Alerts = "/api/v1/service/alerts";
    private static readonly TimeZoneInfo Oslo = TimeZoneInfo.FindSystemTimeZoneById("Europe/Oslo");

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task The_queue_narrows_by_source_and_age_and_counts_the_whole_filter()
    {
        var (system, organizationId, marker) = await ScenarioAsync();
        var other = $"{system}-x";
        var admin = factory.ClientAs(CrmRoles.Admin);
        await SnapshotAsync(system, organizationId, marker, ("year", 400, AlertSeverity.Warning), ("quarter", 100, AlertSeverity.Critical),
            ("week", 7, AlertSeverity.Critical), ("today", 0, AlertSeverity.Warning));
        await SnapshotAsync(other, organizationId, marker, ("elsewhere", 200, AlertSeverity.Critical));

        var bySource = await PageAsync(admin, $"{Alerts}?organizationId={organizationId}&system={system}");
        Titles(bySource).ShouldBe([$"{marker} week", $"{marker} quarter", $"{marker} today", $"{marker} year"], "critical first, then the newest");
        (bySource.GetProperty("totalCount").GetInt32(), bySource.GetProperty("critical").GetInt32(), bySource.GetProperty("warning").GetInt32())
            .ShouldBe((4, 2, 2));

        // Older than 90 days, across sources: the age counts from when the source raised the alert.
        Titles(await PageAsync(admin, $"{Alerts}?organizationId={organizationId}&olderThanDays=90"))
            .ShouldBe([$"{marker} quarter", $"{marker} elsewhere", $"{marker} year"]);

        // What is new: raised within the last 30 days, counted like any filter.
        var recent = await PageAsync(admin, $"{Alerts}?organizationId={organizationId}&newerThanDays=30");
        Titles(recent).ShouldBe([$"{marker} week", $"{marker} today"]);
        (recent.GetProperty("totalCount").GetInt32(), recent.GetProperty("critical").GetInt32(), recent.GetProperty("warning").GetInt32()).ShouldBe((2, 1, 1));
        Titles(await PageAsync(admin, $"{Alerts}?organizationId={organizationId}&newerThanDays=1")).ShouldBe([$"{marker} today"]);

        // Both together, a page at a time: the counts are of the whole filter, not of the page.
        var first = await PageAsync(admin, $"{Alerts}?organizationId={organizationId}&system={system}&olderThanDays=30&limit=1");
        Titles(first).ShouldBe([$"{marker} quarter"]);
        (first.GetProperty("totalCount").GetInt32(), first.GetProperty("critical").GetInt32(), first.GetProperty("warning").GetInt32()).ShouldBe((2, 1, 1));
        var cursor = Uri.EscapeDataString(first.GetProperty("nextCursor").GetString()!);
        Titles(await PageAsync(admin, $"{Alerts}?organizationId={organizationId}&system={system}&olderThanDays=30&limit=1&cursor={cursor}"))
            .ShouldBe([$"{marker} year"]);

        foreach (var invalid in (string[])["olderThanDays=0", "olderThanDays=3651", "newerThanDays=0", "newerThanDays=3651", "system=atera%20alerts",
                     $"system={new string('a', 65)}"])
        {
            var response = await admin.GetAsync($"{Alerts}?{invalid}", Ct);
            response.StatusCode.ShouldBe(HttpStatusCode.BadRequest, invalid);
            (await response.Content.ReadAsStringAsync(Ct)).ShouldContain("SRV_ALERT_FILTER_INVALID");
        }
    }

    [Fact]
    public async Task All_that_match_are_selected_in_the_queue_order_with_the_etags_of_their_status()
    {
        var (system, organizationId, marker) = await ScenarioAsync();
        var admin = factory.ClientAs(CrmRoles.Admin);
        await SnapshotAsync(system, organizationId, marker, ("printer", 120, AlertSeverity.Warning), ("disk", 95, AlertSeverity.Critical),
            ("fresh", 1, AlertSeverity.Critical));

        var selection = await SelectionAsync(admin, $"organizationId={organizationId}&system={system}&olderThanDays=90");
        (selection.GetProperty("totalCount").GetInt32(), selection.GetProperty("limit").GetInt32()).ShouldBe((2, 500));
        var items = selection.GetProperty("items").EnumerateArray().ToList();
        items.Select(i => i.GetProperty("title").GetString()).ShouldBe([$"{marker} disk", $"{marker} printer"]);
        items[0].GetProperty("system").GetString().ShouldBe(system);
        items[0].GetProperty("externalId").GetString().ShouldBe("disk");
        items[0].GetProperty("organizationName").GetString().ShouldBe($"{marker} Bulk AS");
        items[0].GetProperty("severity").GetString().ShouldBe("Critical");
        items[0].GetProperty("createdAt").GetDateTimeOffset().ShouldBeLessThan(DateTimeOffset.UtcNow.AddDays(-95), "when the source raised it, for the dialog's age");
        items[0].TryGetProperty("deviceName", out var device).ShouldBeTrue("the device tells namesakes apart; this one has none");
        device.ValueKind.ShouldBe(JsonValueKind.Null);
        items.ShouldAllBe(i => !string.IsNullOrEmpty(i.GetProperty("etag").GetString()));
        // The ETag is the one the alert's own card gives: what a single change would send.
        var card = await (await admin.GetAsync($"{Alerts}/{items[0].GetProperty("id").GetGuid()}", Ct)).ReadJsonAsync();
        items[0].GetProperty("etag").GetString().ShouldBe(card.GetProperty("etag").GetString());

        // The chosen alerts by id, as they are now and in the order asked; an unknown id is left out.
        var lookup = await admin.PostAsJsonAsync($"{Alerts}/lookup",
            new { ids = new[] { items[1].GetProperty("id").GetGuid(), Guid.NewGuid(), items[0].GetProperty("id").GetGuid() } }, Ct);
        lookup.StatusCode.ShouldBe(HttpStatusCode.OK, await lookup.Content.ReadAsStringAsync(Ct));
        var found = await lookup.ReadJsonAsync();
        found.GetProperty("items").EnumerateArray().Select(i => i.GetProperty("title").GetString()).ShouldBe([$"{marker} printer", $"{marker} disk"]);
        found.GetProperty("totalCount").GetInt32().ShouldBe(2);

        // A reader of alerts may not act on them, so the selection and the lookup are not theirs either.
        var reader = factory.ClientAs(CrmRoles.ReadOnly);
        (await reader.GetAsync($"{Alerts}/selection?organizationId={organizationId}", Ct)).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        (await reader.PostAsJsonAsync($"{Alerts}/lookup", new { ids = new[] { Guid.NewGuid() } }, Ct)).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        (await admin.PostAsJsonAsync($"{Alerts}/lookup", new { ids = Array.Empty<Guid>() }, Ct)).StatusCode.ShouldBe(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task All_that_match_stops_at_five_hundred_and_says_how_many_matched()
    {
        var (system, organizationId, marker) = await ScenarioAsync();
        var admin = factory.ClientAs(CrmRoles.Admin);
        await SnapshotAsync(system, organizationId, marker, [.. Enumerable.Range(0, 501).Select(i => ($"n{i:D3}", 10 + i, AlertSeverity.Warning))]);

        var selection = await SelectionAsync(admin, $"system={system}");
        selection.GetProperty("totalCount").GetInt32().ShouldBe(501);
        var titles = selection.GetProperty("items").EnumerateArray().Select(i => i.GetProperty("title").GetString()).ToList();
        titles.Count.ShouldBe(500);
        titles[0].ShouldBe($"{marker} n000", "the newest first, as the queue shows them");
        titles.ShouldNotContain($"{marker} n500");
    }

    [Fact]
    public async Task Many_alerts_are_hidden_until_one_day_with_one_reason_and_each_says_what_happened()
    {
        var (system, organizationId, marker) = await ScenarioAsync();
        var admin = factory.ClientAs(CrmRoles.Admin);
        await SnapshotAsync(system, organizationId, marker, ("a", 100, AlertSeverity.Warning), ("b", 100, AlertSeverity.Warning),
            ("gone", 100, AlertSeverity.Warning), ("taken", 100, AlertSeverity.Warning));
        var read = await SelectionAsync(admin, $"system={system}");
        var etags = read.GetProperty("items").EnumerateArray().ToDictionary(i => i.GetProperty("externalId").GetString()!, Version);
        // Meanwhile the source stops listing one, and someone else hides another.
        await SnapshotAsync(system, organizationId, marker, ("a", 100, AlertSeverity.Warning), ("b", 100, AlertSeverity.Warning),
            ("taken", 100, AlertSeverity.Warning));
        var taken = etags["taken"];
        (await admin.PostWithETagAsync($"{Alerts}/{taken.Id}/hide", new { until = Tomorrow(), reason = "Someone else's decision" }, taken.Etag))
            .StatusCode.ShouldBe(HttpStatusCode.OK);
        var unknown = new { id = Guid.NewGuid(), etag = etags["a"].Etag };
        var until = Tomorrow().AddDays(13);

        var response = await admin.PostAsJsonAsync($"{Alerts}/hide", new
        {
            alerts = new object[] { Body(etags["a"]), Body(etags["b"]), Body(etags["gone"]), Body(taken), unknown, Body(etags["a"]) },
            until,
            reason = "  Printers are replaced next month  ",
        }, Ct);
        response.StatusCode.ShouldBe(HttpStatusCode.OK, await response.Content.ReadAsStringAsync(Ct));
        var result = await response.ReadJsonAsync();
        Outcomes(result).ShouldBe([(etags["a"].Id, "Hidden"), (etags["b"].Id, "Hidden"), (etags["gone"].Id, "Resolved"), (taken.Id, "Changed"),
            (unknown.id, "NotFound")], "each alert once, in the order asked");
        result.GetProperty("applied").GetInt32().ShouldBe(2);

        var hidden = await PageAsync(admin, $"{Alerts}?system={system}&hidden=true");
        Titles(hidden).ShouldBe([$"{marker} a", $"{marker} b", $"{marker} taken"], ignoreOrder: true);
        var holdOfA = hidden.GetProperty("items").EnumerateArray().Single(i => i.GetProperty("title").GetString() == $"{marker} a").GetProperty("hidden");
        holdOfA.GetProperty("reason").GetString().ShouldBe("Printers are replaced next month");
        holdOfA.GetProperty("until").GetDateTimeOffset().ShouldBe(StartInOslo(until));
        Titles(await PageAsync(admin, $"{Alerts}?system={system}")).ShouldBeEmpty();
        (await TransitionsAsync(etags["a"].Id)).ShouldBe([("Hidden", true)]);
        (await TransitionsAsync(etags["gone"].Id)).ShouldBeEmpty();

        // Shown again: the old ETags are stale now, so the status is read again first.
        (await ShowAsync(admin, etags["a"], etags["b"])).ShouldBe([(etags["a"].Id, "Changed"), (etags["b"].Id, "Changed")]);
        var fresh = (await SelectionAsync(admin, $"system={system}&hidden=true")).GetProperty("items").EnumerateArray()
            .ToDictionary(i => i.GetProperty("externalId").GetString()!, Version);
        (await ShowAsync(admin, fresh["a"], fresh["b"], etags["gone"])).ShouldBe([(fresh["a"].Id, "Shown"), (fresh["b"].Id, "Shown"),
            (etags["gone"].Id, "Resolved")]);
        Titles(await PageAsync(admin, $"{Alerts}?system={system}")).ShouldBe([$"{marker} a", $"{marker} b"], ignoreOrder: true);
        (await TransitionsAsync(etags["a"].Id)).ShouldBe([("Hidden", true), ("Shown", true)]);
        var openA = (await SelectionAsync(admin, $"system={system}")).GetProperty("items").EnumerateArray()
            .Single(i => i.GetProperty("externalId").GetString() == "a");
        (await ShowAsync(admin, Version(openA))).ShouldBe([(fresh["a"].Id, "NotHidden")], "an alert that is not hidden is left as it is");
    }

    [Fact]
    public async Task A_repeated_hide_counts_as_done_and_the_way_back_leaves_what_someone_decided_since()
    {
        var (system, organizationId, marker) = await ScenarioAsync();
        var admin = factory.ClientAs(CrmRoles.Admin);
        await SnapshotAsync(system, organizationId, marker, ("a", 40, AlertSeverity.Warning), ("b", 40, AlertSeverity.Warning),
            ("c", 40, AlertSeverity.Warning));
        var read = (await SelectionAsync(admin, $"system={system}")).GetProperty("items").EnumerateArray()
            .ToDictionary(i => i.GetProperty("externalId").GetString()!, Version);
        object HideBody() => new { alerts = new[] { Body(read["a"]), Body(read["b"]), Body(read["c"]) }, until = Tomorrow().AddDays(6), reason = "Office moves" };
        static List<string?> Etags(JsonElement result) => result.GetProperty("items").EnumerateArray().Select(i => i.GetProperty("etag").GetString()).ToList();

        var first = await admin.PostAsJsonAsync($"{Alerts}/hide", HideBody(), Ct);
        first.StatusCode.ShouldBe(HttpStatusCode.OK, await first.Content.ReadAsStringAsync(Ct));
        var hidden = await first.ReadJsonAsync();
        hidden.GetProperty("applied").GetInt32().ShouldBe(3);
        // Each hidden alert carries the ETag of its status as the hide left it: the one "all that match" gives now.
        var now = (await SelectionAsync(admin, $"system={system}&hidden=true")).GetProperty("items").EnumerateArray()
            .ToDictionary(i => i.GetProperty("id").GetGuid(), i => i.GetProperty("etag").GetString());
        Etags(hidden).ShouldBe([now[read["a"].Id], now[read["b"].Id], now[read["c"].Id]]);

        // The same request again, as after a lost answer: its ETags are stale, but each alert is hidden so by this person already.
        var again = await admin.PostAsJsonAsync($"{Alerts}/hide", HideBody(), Ct);
        again.StatusCode.ShouldBe(HttpStatusCode.OK, await again.Content.ReadAsStringAsync(Ct));
        var repeated = await again.ReadJsonAsync();
        Outcomes(repeated).ShouldBe([(read["a"].Id, "Hidden"), (read["b"].Id, "Hidden"), (read["c"].Id, "Hidden")]);
        repeated.GetProperty("applied").GetInt32().ShouldBe(3);
        Etags(repeated).ShouldBe(Etags(hidden), "nothing was written again");
        (await TransitionsAsync(read["a"].Id)).ShouldBe([("Hidden", true)]);

        // Someone hides one of them for longer; the way back with the ETags the hide left shows the others and leaves that one as decided.
        var left = Etags(hidden);
        var b = new AlertVersionRef(read["b"].Id, left[1]!);
        (await admin.PostWithETagAsync($"{Alerts}/{b.Id}/hide", new { until = Tomorrow().AddDays(30), reason = "Waiting for the new printer" }, b.Etag))
            .StatusCode.ShouldBe(HttpStatusCode.OK);
        (await ShowAsync(admin, new AlertVersionRef(read["a"].Id, left[0]!), b, new AlertVersionRef(read["c"].Id, left[2]!)))
            .ShouldBe([(read["a"].Id, "Shown"), (b.Id, "Changed"), (read["c"].Id, "Shown")]);
        Titles(await PageAsync(admin, $"{Alerts}?system={system}&hidden=true")).ShouldBe([$"{marker} b"]);
    }

    [Fact]
    public async Task A_bulk_change_names_up_to_five_hundred_alerts_a_valid_day_a_reason_and_their_etags()
    {
        var (system, organizationId, marker) = await ScenarioAsync();
        var admin = factory.ClientAs(CrmRoles.Admin);
        await SnapshotAsync(system, organizationId, marker, ("one", 3, AlertSeverity.Critical));
        var one = (await SelectionAsync(admin, $"system={system}")).GetProperty("items").EnumerateArray().Select(Version).Single();

        async Task RefusedAsync(object body, string? code = null, string url = $"{Alerts}/hide")
        {
            var response = await admin.PostAsJsonAsync(url, body, Ct);
            response.StatusCode.ShouldBe(HttpStatusCode.BadRequest);
            if (code is not null)
            {
                (await response.Content.ReadAsStringAsync(Ct)).ShouldContain(code);
            }
        }

        await RefusedAsync(new { alerts = Array.Empty<object>(), until = Tomorrow(), reason = "Later" });
        await RefusedAsync(new { alerts = Enumerable.Range(0, 501).Select(_ => new { id = Guid.NewGuid(), etag = one.Etag }), until = Tomorrow(), reason = "Later" });
        await RefusedAsync(new { alerts = new[] { Body(one) }, until = Tomorrow(), reason = "   " });
        await RefusedAsync(new { alerts = new[] { new { id = one.Id, etag = (string?)null } }, until = Tomorrow(), reason = "Later" });
        await RefusedAsync(new { alerts = new[] { Body(one) }, until = Tomorrow().AddDays(-1), reason = "Later" }, "SRV_ALERT_HIDE_DATE");
        await RefusedAsync(new { alerts = new[] { Body(one) }, until = Tomorrow().AddDays(400), reason = "Later" }, "SRV_ALERT_HIDE_DATE");
        await RefusedAsync(new { alerts = new[] { new { id = one.Id, etag = "not an etag!" } }, until = Tomorrow(), reason = "Later" }, "SRV_ALERT_ETAG_INVALID");
        await RefusedAsync(new { alerts = Array.Empty<object>() }, url: $"{Alerts}/show");
        (await factory.ClientAs(CrmRoles.ReadOnly).PostAsJsonAsync($"{Alerts}/hide", new { alerts = new[] { Body(one) }, until = Tomorrow(), reason = "Later" }, Ct))
            .StatusCode.ShouldBe(HttpStatusCode.Forbidden);

        Titles(await PageAsync(admin, $"{Alerts}?system={system}")).ShouldBe([$"{marker} one"], "nothing refused changed anything");
    }

    private sealed record AlertVersionRef(Guid Id, string Etag);

    private static AlertVersionRef Version(JsonElement item) => new(item.GetProperty("id").GetGuid(), item.GetProperty("etag").GetString()!);

    private static object Body(AlertVersionRef alert) => new { id = alert.Id, etag = alert.Etag };

    private static List<(Guid Id, string Outcome)> Outcomes(JsonElement result) =>
        result.GetProperty("items").EnumerateArray().Select(i => (i.GetProperty("id").GetGuid(), i.GetProperty("outcome").GetString()!)).ToList();

    private static async Task<List<(Guid Id, string Outcome)>> ShowAsync(HttpClient client, params AlertVersionRef[] alerts)
    {
        var response = await client.PostAsJsonAsync($"{Alerts}/show", new { alerts = alerts.Select(Body) }, Ct);
        response.StatusCode.ShouldBe(HttpStatusCode.OK, await response.Content.ReadAsStringAsync(Ct));
        return Outcomes(await response.ReadJsonAsync());
    }

    private static DateOnly Tomorrow() => DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, Oslo).DateTime).AddDays(1);

    private static DateTimeOffset StartInOslo(DateOnly day)
    {
        var start = day.ToDateTime(TimeOnly.MinValue);
        return new DateTimeOffset(start, Oslo.GetUtcOffset(start));
    }

    private async Task<(string System, Guid OrganizationId, string Marker)> ScenarioAsync()
    {
        var marker = $"M45{Guid.NewGuid():N}"[..11];
        var organizationId = await factory.ClientAs(CrmRoles.Admin).CreateOrganizationAsync(new { name = $"{marker} Bulk AS", status = "Customer" });
        return ($"m45b-{marker.ToLowerInvariant()}", organizationId, marker);
    }

    /// <summary>A complete read of the test's own system that lists these alerts open, each raised that many days ago.</summary>
    private async Task SnapshotAsync(string system, Guid organizationId, string marker, params (string Id, int DaysAgo, AlertSeverity Severity)[] alerts)
    {
        var now = DateTimeOffset.UtcNow;
        var listed = alerts.Select(a => new ExternalAlert(a.Id, organizationId, a.Severity, $"{marker} {a.Id}", null, now.AddDays(-a.DaysAgo).AddHours(-1)))
            .ToList();
        await using var scope = factory.Services.CreateAsyncScope();
        await scope.ServiceProvider.GetRequiredService<IServiceApi>().ApplyAlertSnapshotAsync(
            new AlertSnapshot(system, AlertKind.Monitoring, listed, listed.Select(a => a.ExternalId).ToList(), IsComplete: true), Ct);
    }

    private static async Task<JsonElement> PageAsync(HttpClient client, string url)
    {
        var response = await client.GetAsync(url, Ct);
        response.StatusCode.ShouldBe(HttpStatusCode.OK, await response.Content.ReadAsStringAsync(Ct));
        return await response.ReadJsonAsync();
    }

    private static async Task<JsonElement> SelectionAsync(HttpClient client, string query) => await PageAsync(client, $"{Alerts}/selection?{query}");

    private static List<string> Titles(JsonElement page) =>
        page.GetProperty("items").EnumerateArray().Select(a => a.GetProperty("title").GetString()!).ToList();

    private async Task<List<(string Kind, bool Audited)>> TransitionsAsync(Guid alertId)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        return (await scope.ServiceProvider.GetRequiredService<ServiceDbContext>().AlertTransitions.AsNoTracking()
                .Where(t => t.AlertId == alertId).OrderBy(t => t.CreatedAt).ToListAsync(Ct))
            .Select(t => (t.Kind.ToString(), t.CreatedBy is not null)).ToList();
    }
}
