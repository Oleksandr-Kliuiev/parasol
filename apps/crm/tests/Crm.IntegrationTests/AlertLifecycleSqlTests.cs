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
/// M38 on SQL Server: an alert keeps its row across reads, a complete read resolves, an incomplete one changes nothing, the device
/// link needs one unambiguous device, and the queue, the urgent list and the contract read what the lifecycle stored. Each test
/// reads under a system of its own: a complete read resolves every other open alert of its system, and other tests mirror "atera".
/// </summary>
public sealed class AlertLifecycleSqlTests(CrmWebFactory factory)
{
    private const string Alerts = "/api/v1/service/alerts";
    private static readonly DateTimeOffset At = new(2026, 9, 20, 8, 0, 0, TimeSpan.Zero);

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task An_alert_keeps_its_row_a_complete_read_resolves_it_and_a_later_read_opens_the_same_row_again()
    {
        var (system, organizationId, marker) = await ScenarioAsync();
        (await ApplyAsync(Complete(system, Source(marker, "1", organizationId)))).ShouldBe(new AlertSnapshotResult(true, 1, 0, 0, 0));
        var opened = await StoredAsync(system, "1");
        (opened.State, opened.ResolvedAt, opened.Kind).ShouldBe((AlertState.Open, (DateTimeOffset?)null, AlertKind.Monitoring));
        opened.LastSeenAt.ShouldNotBeNull();

        (await ApplyAsync(Complete(system, Source(marker, "1", organizationId)))).Changed.ShouldBe(0, "a refreshed last-seen time is no change");
        var seen = await StoredAsync(system, "1");
        seen.Id.ShouldBe(opened.Id);
        seen.LastSeenAt!.Value.ShouldBeGreaterThanOrEqualTo(opened.LastSeenAt!.Value);

        (await ApplyAsync(Complete(system))).ShouldBe(new AlertSnapshotResult(true, 0, 0, 0, 1));
        var resolved = await StoredAsync(system, "1");
        (resolved.Id, resolved.State).ShouldBe((opened.Id, AlertState.Resolved));
        resolved.ResolvedAt.ShouldNotBeNull();
        (await ApplyAsync(Complete(system))).Changed.ShouldBe(0, "resolved once");

        (await ApplyAsync(Complete(system, Source(marker, "1", organizationId, title: $"{marker} disk full again")))).ShouldBe(new AlertSnapshotResult(true, 0, 1, 0, 0));
        var reopened = await StoredAsync(system, "1");
        (reopened.Id, reopened.State, reopened.ResolvedAt, reopened.Title).ShouldBe((opened.Id, AlertState.Open, (DateTimeOffset?)null, $"{marker} disk full again"));
        (await RowsAsync(system)).Count.ShouldBe(1, "one row per source alert, whatever happened to it");
    }

    [Fact]
    public async Task An_incomplete_read_resolves_nothing_and_adds_nothing()
    {
        var (system, organizationId, marker) = await ScenarioAsync();
        await ApplyAsync(Complete(system, Source(marker, "1", organizationId), Source(marker, "2", organizationId)));
        var before = await RowsAsync(system);

        var partial = new AlertSnapshot(system, AlertKind.Monitoring, [Source(marker, "1", organizationId, title: "changed"), Source(marker, "3", organizationId)],
            ["1", "3"], IsComplete: false);
        (await ApplyAsync(partial)).ShouldBe(AlertSnapshotResult.NotApplied);

        var after = await RowsAsync(system);
        after.Select(a => (a.Id, a.ExternalId, a.State, a.Title, a.LastSeenAt, a.ResolvedAt))
            .ShouldBe(before.Select(a => (a.Id, a.ExternalId, a.State, a.Title, a.LastSeenAt, a.ResolvedAt)), ignoreOrder: true);
    }

    [Fact]
    public async Task A_device_is_linked_only_when_exactly_one_current_device_of_the_customer_carries_the_alerts_device_name()
    {
        var (system, organizationId, marker) = await ScenarioAsync();
        var other = await factory.ClientAs(CrmRoles.Admin).CreateOrganizationAsync(new { name = $"{marker} Annen AS", status = "Customer" });
        await DevicesAsync(organizationId, system, ("srv", "SRV-01"), ("pc-a", "PC-SAME"), ("pc-b", "pc-same"), ("old", "OLD-01"));
        // OLD-01 is no longer reported: it stops counting as a device of the customer.
        await DevicesAsync(organizationId, system, ("srv", "SRV-01"), ("pc-a", "PC-SAME"), ("pc-b", "pc-same"));
        await DevicesAsync(other, system, ("laptop", "LAPTOP-7"));
        var server = await DeviceIdAsync(system, "srv");

        await ApplyAsync(Complete(system,
            Source(marker, "unique", organizationId, deviceName: "srv-01"),
            Source(marker, "twice", organizationId, deviceName: "PC-SAME"),
            Source(marker, "removed", organizationId, deviceName: "OLD-01"),
            Source(marker, "elsewhere", organizationId, deviceName: "LAPTOP-7"),
            Source(marker, "none", organizationId, deviceName: null)));

        var rows = (await RowsAsync(system)).ToDictionary(a => a.ExternalId);
        rows["unique"].DeviceId.ShouldBe(server, "one device carries the name, whatever its case");
        rows["twice"].DeviceId.ShouldBeNull("two devices carry the name");
        rows["removed"].DeviceId.ShouldBeNull("the device is no longer reported");
        rows["elsewhere"].DeviceId.ShouldBeNull("the device belongs to another customer");
        rows["none"].DeviceId.ShouldBeNull();

        var byDevice = await factory.ClientAs(CrmRoles.Technician).GetFromJsonAsync<JsonElement>($"{Alerts}?deviceId={server}", Ct);
        byDevice.GetProperty("totalCount").GetInt32().ShouldBe(1);
        byDevice.GetProperty("items")[0].GetProperty("externalId").GetString().ShouldBe("unique");

        // The device list says how many open alerts each device has, counted for the page in one query.
        var devices = await factory.ClientAs(CrmRoles.Technician).GetFromJsonAsync<JsonElement>($"/api/v1/service/devices?organizationId={organizationId}", Ct);
        devices.GetProperty("items").EnumerateArray().ToDictionary(d => d.GetProperty("machineName").GetString()!, d => d.GetProperty("openAlerts").GetInt32())
            .ShouldBe(new Dictionary<string, int> { ["SRV-01"] = 1, ["PC-SAME"] = 0, ["pc-same"] = 0 }, ignoreOrder: true);
        await ApplyAsync(Complete(system, Source(marker, "twice", organizationId, deviceName: "PC-SAME")));
        devices = await factory.ClientAs(CrmRoles.Technician).GetFromJsonAsync<JsonElement>($"/api/v1/service/devices?organizationId={organizationId}", Ct);
        devices.GetProperty("items").EnumerateArray().Single(d => d.GetProperty("machineName").GetString() == "SRV-01")
            .GetProperty("openAlerts").GetInt32().ShouldBe(0, "a resolved alert is not open");
    }

    [Fact]
    public async Task One_alert_is_read_by_id_in_any_state_with_its_customer_and_an_unknown_id_is_not_found()
    {
        var (system, organizationId, marker) = await ScenarioAsync();
        await ApplyAsync(Complete(system, Source(marker, "one", organizationId)));
        await ApplyAsync(Complete(system));
        var stored = await StoredAsync(system, "one");

        var reader = factory.ClientAs(CrmRoles.Technician, userKey: "m38-one");
        var one = await reader.GetFromJsonAsync<JsonElement>($"{Alerts}/{stored.Id}", Ct);
        (one.GetProperty("id").GetGuid(), one.GetProperty("state").GetString(), one.GetProperty("organizationName").GetString(), one.GetProperty("url").GetString())
            .ShouldBe((stored.Id, "Resolved", $"{marker} Varsel AS", "https://atera.example/alerts/one"));
        one.GetProperty("resolvedAt").GetDateTimeOffset().ShouldBe(stored.ResolvedAt!.Value);

        var missing = await reader.GetAsync($"{Alerts}/{Guid.NewGuid()}", Ct);
        missing.StatusCode.ShouldBe(HttpStatusCode.NotFound);
        (await missing.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe("SRV_ALERT_NOT_FOUND");
        (await factory.ClientAs("Crm.Unknown", "m38-one-nobody").GetAsync($"{Alerts}/{stored.Id}", Ct)).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        await using var scope = factory.Services.CreateAsyncScope();
        (await scope.ServiceProvider.GetRequiredService<IServiceApi>().GetAlertAsync(system, "one", Ct))!.ResolvedAt.ShouldBe(stored.ResolvedAt);
        (await scope.ServiceProvider.GetRequiredService<IServiceApi>().GetAlertAsync(system, "none", Ct)).ShouldBeNull();
    }

    [Fact]
    public async Task The_queue_filters_and_counts_before_the_page_and_pages_critical_first_then_oldest_across_customers()
    {
        var (system, organizationId, marker) = await ScenarioAsync();
        var admin = factory.ClientAs(CrmRoles.Admin);
        var other = await admin.CreateOrganizationAsync(new { name = $"{marker} Annen AS", status = "Customer" });
        // 30 alerts of one customer, three to an instant, a third of them critical; then two are closed in the source.
        var mine = Enumerable.Range(0, 30).Select(i => Source(marker, $"a{i:00}", organizationId,
            severity: i % 3 == 0 ? AlertSeverity.Critical : AlertSeverity.Warning, createdAt: At.AddMinutes(i / 3),
            deviceName: i == 7 ? $"{marker}-DEV" : null)).ToList();
        var theirs = Enumerable.Range(0, 3).Select(i => Source(marker, $"b{i}", other, createdAt: At.AddHours(1).AddMinutes(i))).ToList();
        await ApplyAsync(Complete(system, [.. mine, .. theirs]));
        await ApplyAsync(Complete(system, [.. mine.Where(a => a.ExternalId is not ("a00" or "a01")), .. theirs]));

        var reader = factory.ClientAs(CrmRoles.Technician, userKey: "m38-queue");
        var first = await reader.GetFromJsonAsync<JsonElement>($"{Alerts}?organizationId={organizationId}", Ct);
        first.GetProperty("items").GetArrayLength().ShouldBe(25, "25 by default");
        first.GetProperty("nextCursor").GetString().ShouldNotBeNullOrEmpty();
        (first.GetProperty("totalCount").GetInt32(), first.GetProperty("critical").GetInt32(), first.GetProperty("warning").GetInt32()).ShouldBe((28, 9, 19));
        // The page says how fresh the stored alerts are, as the urgent list does: one read per source, the same for any filter. Huntress
        // is switched off in this host, so its read is named only once its own tests have read it into the shared database (M41).
        var reads = first.GetProperty("reads").EnumerateArray().ToList();
        reads.Select(r => r.GetProperty("system").GetString()).ShouldBeSubsetOf(["atera", "huntress"]);
        var read = reads.Single(r => r.GetProperty("system").GetString() == "atera");
        read.EnumerateObject().Select(p => p.Name).ShouldBe(["system", "startedAt", "complete", "late"]);
        var item = first.GetProperty("items")[0];
        (item.GetProperty("organizationName").GetString(), item.GetProperty("state").GetString(), item.GetProperty("kind").GetString())
            .ShouldBe(($"{marker} Varsel AS", "Open", "Monitoring"));

        var pages = await AllAsync(reader, $"{Alerts}?organizationId={organizationId}", 4);
        pages.Select(a => a.GetProperty("externalId").GetString()).ShouldBe(
            mine.Where(a => a.ExternalId is not ("a00" or "a01")).Select(a => a.ExternalId), ignoreOrder: true);
        pages.Select(a => a.GetProperty("id").GetGuid()).Distinct().Count().ShouldBe(28, "every alert once, ties at an instant included");
        // The order to look at them in, across pages: every critical alert before any warning, and the oldest first within each.
        pages.Zip(pages.Skip(1)).ShouldAllBe(pair => Rank(pair.First) < Rank(pair.Second) ||
            (Rank(pair.First) == Rank(pair.Second) && pair.First.GetProperty("createdAt").GetDateTimeOffset() <= pair.Second.GetProperty("createdAt").GetDateTimeOffset()));
        pages.TakeWhile(a => Rank(a) == 0).Count().ShouldBe(9);
        first.GetProperty("items")[0].GetProperty("externalId").GetString().ShouldBe("a03", "the oldest open critical alert leads");

        // Resolved alerts newest resolved first: a01 and a00 resolved together (the id breaks the tie), then a later one on top.
        await ApplyAsync(Complete(system, [.. mine.Where(a => a.ExternalId is not ("a00" or "a01" or "a29")), .. theirs]));
        var resolved = await reader.GetFromJsonAsync<JsonElement>($"{Alerts}?organizationId={organizationId}&state=Resolved", Ct);
        var resolvedIds = resolved.GetProperty("items").EnumerateArray().Select(a => a.GetProperty("externalId").GetString()).ToList();
        resolvedIds.ShouldBe(["a29", "a01", "a00"]);
        resolved.GetProperty("items")[0].GetProperty("resolvedAt").GetDateTimeOffset()
            .ShouldBeGreaterThan(resolved.GetProperty("items")[1].GetProperty("resolvedAt").GetDateTimeOffset());
        var resolvedPages = await AllAsync(reader, $"{Alerts}?organizationId={organizationId}&state=Resolved", 2);
        resolvedPages.Select(a => a.GetProperty("externalId").GetString()).ShouldBe(resolvedIds);
        // A cursor of one order is no page of the other.
        var openCursor = first.GetProperty("nextCursor").GetString()!;
        (await reader.GetAsync($"{Alerts}?organizationId={organizationId}&state=Resolved&cursor={Uri.EscapeDataString(openCursor)}", Ct))
            .StatusCode.ShouldBe(HttpStatusCode.BadRequest);
        await ApplyAsync(Complete(system, [.. mine.Where(a => a.ExternalId is not ("a00" or "a01")), .. theirs]));

        // Across customers, narrowed by the marker in the titles: both customers, each row with its customer's name.
        var across = await AllAsync(reader, $"{Alerts}?q={marker}", 10);
        across.Count.ShouldBe(31);
        across.Select(a => a.GetProperty("organizationName").GetString()).Distinct().Order().ShouldBe([$"{marker} Annen AS", $"{marker} Varsel AS"]);
        var warnings = await reader.GetFromJsonAsync<JsonElement>($"{Alerts}?q={marker}&severity=Warning&limit=5", Ct);
        (warnings.GetProperty("totalCount").GetInt32(), warnings.GetProperty("critical").GetInt32(), warnings.GetProperty("warning").GetInt32()).ShouldBe((19, 0, 19));
        warnings.GetProperty("items").EnumerateArray().ShouldAllBe(a => a.GetProperty("severity").GetString() == "Warning");
        var byDeviceName = await reader.GetFromJsonAsync<JsonElement>($"{Alerts}?q={marker}-dev", Ct);
        byDeviceName.GetProperty("items").EnumerateArray().Select(a => a.GetProperty("externalId").GetString()).ShouldBe(["a07"]);

        var invalid = await reader.GetAsync($"{Alerts}?organizationId={organizationId}&cursor=not-a-cursor", Ct);
        invalid.StatusCode.ShouldBe(HttpStatusCode.BadRequest);
        (await invalid.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe("SRV_ALERT_CURSOR_INVALID");
        var unknownState = await reader.GetAsync($"{Alerts}?state=7", Ct);
        unknownState.StatusCode.ShouldBe(HttpStatusCode.BadRequest);
        (await reader.GetFromJsonAsync<JsonElement>($"{Alerts}?organizationId={organizationId}&limit=500", Ct)).GetProperty("items").GetArrayLength().ShouldBe(28);
    }

    [Fact]
    public async Task The_urgent_list_starts_with_the_oldest_critical_alerts_and_counts_every_open_alert()
    {
        var (system, organizationId, marker) = await ScenarioAsync();
        // Older than anything else the tests store, so these lead the list whatever other classes add meanwhile.
        var old = new DateTimeOffset(1990, 1, 1, 0, 0, 0, TimeSpan.Zero);
        await ApplyAsync(Complete(system,
            Source(marker, "resolved", organizationId, createdAt: old.AddYears(-10)),
            Source(marker, "critical-newer", organizationId, createdAt: old.AddDays(1)),
            Source(marker, "critical-oldest", organizationId, createdAt: old),
            Source(marker, "warning-older", organizationId, severity: AlertSeverity.Warning, createdAt: old.AddYears(-5)),
            Source(marker, "w1", organizationId, severity: AlertSeverity.Warning, createdAt: old.AddYears(-4)),
            Source(marker, "w2", organizationId, severity: AlertSeverity.Warning, createdAt: old.AddYears(-3)),
            Source(marker, "w3", organizationId, severity: AlertSeverity.Warning, createdAt: old.AddYears(-2))));
        await ApplyAsync(new AlertSnapshot(system, AlertKind.Monitoring, [], ["critical-newer", "critical-oldest", "warning-older", "w1", "w2", "w3"], IsComplete: true));

        var reader = factory.ClientAs(CrmRoles.Technician, userKey: "m38-urgent");
        var urgent = await reader.GetFromJsonAsync<JsonElement>($"{Alerts}/urgent?limit=2", Ct);
        urgent.GetProperty("items").EnumerateArray().Select(a => a.GetProperty("externalId").GetString()).ShouldBe(["critical-oldest", "critical-newer"]);
        urgent.GetProperty("items")[0].GetProperty("organizationName").GetString().ShouldBe($"{marker} Varsel AS");
        urgent.GetProperty("totalCount").GetInt32().ShouldBeGreaterThanOrEqualTo(6);
        (urgent.GetProperty("critical").GetInt32() + urgent.GetProperty("warning").GetInt32()).ShouldBe(urgent.GetProperty("totalCount").GetInt32());
        var reads = urgent.GetProperty("reads").EnumerateArray().Select(r => r.GetProperty("system").GetString()).ToList();
        reads.ShouldContain("atera");
        reads.ShouldBeSubsetOf(["atera", "huntress"]);

        var five = await reader.GetFromJsonAsync<JsonElement>($"{Alerts}/urgent", Ct);
        var items = five.GetProperty("items").EnumerateArray().ToList();
        items.Count.ShouldBe(5, "five by default");
        items.ShouldAllBe(a => a.GetProperty("state").GetString() == "Open");
        // Critical before warning, and within a severity the oldest first, whatever else is open.
        items.Zip(items.Skip(1)).ShouldAllBe(pair =>
            Rank(pair.First) < Rank(pair.Second) ||
            (Rank(pair.First) == Rank(pair.Second) && pair.First.GetProperty("createdAt").GetDateTimeOffset() <= pair.Second.GetProperty("createdAt").GetDateTimeOffset()));
    }

    [Fact]
    public async Task Other_modules_read_alerts_by_id_in_any_state()
    {
        var (system, organizationId, marker) = await ScenarioAsync();
        await ApplyAsync(Complete(system, Source(marker, "open", organizationId), Source(marker, "closed", organizationId)));
        await ApplyAsync(Complete(system, Source(marker, "open", organizationId)));
        var open = await StoredAsync(system, "open");
        var closed = await StoredAsync(system, "closed");

        await using var scope = factory.Services.CreateAsyncScope();
        var service = scope.ServiceProvider.GetRequiredService<IServiceApi>();
        var one = (await service.GetAlertAsync(open.Id, Ct)).ShouldNotBeNull();
        one.ShouldBe(new AlertRef(open.Id, organizationId, system, AlertKind.Monitoring, "open", "501", $"{marker} disk full", AlertSeverity.Critical,
            AlertState.Open, "SRV-01", null, open.CreatedAtSource, "https://atera.example/alerts/open"));
        (await service.GetAlertAsync(Guid.NewGuid(), Ct)).ShouldBeNull();

        var many = await service.GetAlertsAsync([open.Id, closed.Id, closed.Id, Guid.NewGuid()], Ct);
        many.Keys.ShouldBe([open.Id, closed.Id], ignoreOrder: true);
        many[closed.Id].State.ShouldBe(AlertState.Resolved);
        (await service.GetAlertsAsync([], Ct)).ShouldBeEmpty();
    }

    private static int Rank(JsonElement alert) => alert.GetProperty("severity").GetString() == "Critical" ? 0 : 1;

    private async Task<(string System, Guid OrganizationId, string Marker)> ScenarioAsync()
    {
        var marker = $"M38{Guid.NewGuid():N}"[..11];
        var organizationId = await factory.ClientAs(CrmRoles.Admin).CreateOrganizationAsync(new { name = $"{marker} Varsel AS", status = "Customer" });
        return ($"m38-{marker}", organizationId, marker);
    }

    private static ExternalAlert Source(
        string marker, string id, Guid organizationId, AlertSeverity severity = AlertSeverity.Critical, DateTimeOffset? createdAt = null,
        string? deviceName = "SRV-01", string? title = null) =>
        new(id, organizationId, severity, title ?? $"{marker} disk full", deviceName, createdAt ?? At, "501", $"https://atera.example/alerts/{id}");

    private static AlertSnapshot Complete(string system, params IReadOnlyCollection<ExternalAlert> alerts) =>
        new(system, AlertKind.Monitoring, alerts, alerts.Select(a => a.ExternalId).ToList(), IsComplete: true);

    private async Task<AlertSnapshotResult> ApplyAsync(AlertSnapshot snapshot)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<IServiceApi>().ApplyAlertSnapshotAsync(snapshot, Ct);
    }

    private async Task<List<Alert>> RowsAsync(string system)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<ServiceDbContext>().Alerts.AsNoTracking().Where(a => a.System == system).ToListAsync(Ct);
    }

    private async Task<Alert> StoredAsync(string system, string externalId) => (await RowsAsync(system)).Single(a => a.ExternalId == externalId);

    private async Task DevicesAsync(Guid organizationId, string system, params (string Id, string Name)[] devices)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        await scope.ServiceProvider.GetRequiredService<IServiceApi>().ReplaceDevicesAsync(organizationId, system,
            devices.Select(d => new ExternalDevice($"{system}-{d.Id}", d.Name, DeviceType.Server, null, true, At, null)).ToList(), Ct);
    }

    private async Task<Guid> DeviceIdAsync(string system, string id)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<ServiceDbContext>().Devices.AsNoTracking()
            .Where(d => d.System == system && d.ExternalId == $"{system}-{id}").Select(d => d.Id).SingleAsync(Ct);
    }

    private static async Task<List<JsonElement>> AllAsync(HttpClient client, string url, int limit)
    {
        var items = new List<JsonElement>();
        string? cursor = null;
        for (var guard = 0; guard < 100; guard++)
        {
            var page = await client.GetFromJsonAsync<JsonElement>($"{url}&limit={limit}{(cursor is null ? "" : $"&cursor={Uri.EscapeDataString(cursor)}")}", Ct);
            page.GetProperty("items").GetArrayLength().ShouldBeLessThanOrEqualTo(limit);
            items.AddRange(page.GetProperty("items").EnumerateArray());
            if (page.GetProperty("nextCursor").ValueKind == JsonValueKind.Null)
            {
                return items;
            }

            cursor = page.GetProperty("nextCursor").GetString();
        }

        throw new InvalidOperationException("The pages never ended.");
    }
}
