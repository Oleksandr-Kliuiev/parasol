using System.Globalization;
using System.Net;
using System.Text.Json;
using Crm.Authorization;
using Crm.Backup.Contracts;
using Crm.Service.Contracts;
using Crm.Service.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crm.IntegrationTests;

/// <summary>
/// The global search over the operations records on SQL Server: devices by name, serial number and logged-in user, with a word that
/// names the customer narrowing them; alerts that are not resolved, hidden ones last and marked; saved tickets by number or title; the
/// people and sites of backups, one hit per name; a group that found more than it shows says so; and a caller without the Drift rights
/// gets none of them. Each test reads its records under a system and names of its own: the database is shared by every class.
/// </summary>
public sealed class GlobalSearchOperationsTests(CrmWebFactory factory)
{
    private static readonly TimeZoneInfo Oslo = TimeZoneInfo.FindSystemTimeZoneById("Europe/Oslo");

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Devices_are_found_by_name_serial_number_and_logged_in_user_and_a_customer_word_narrows_them()
    {
        var (m, fjord, havbris) = await CustomersAsync();
        var system = $"gs-{m}";
        await DevicesAsync(fjord, system, Agent($"{m}-a", $"DC01-{m}", serial: $"SN{m}A", user: $"VARDE\\kari{m}"), Agent($"{m}-b", $"FS01-{m}"));
        await DevicesAsync(havbris, system, Agent($"{m}-c", $"DC01-{m}"));
        var reader = factory.ClientAs(CrmRoles.ReadOnly);

        var both = Group(await SearchAsync(reader, $"dc01-{m}"), "devices");
        both.Select(h => h.GetProperty("subtitle").GetString()).Order().ShouldBe([$"Fjord{m} AS", $"Havbris{m} AS"]);

        // "dc01 fjord": the second word names the customer and leaves one of the two.
        var hit = Group(await SearchAsync(reader, $"dc01-{m} fjord{m}"), "devices").ShouldHaveSingleItem();
        var machineId = await MachineIdAsync(fjord, $"DC01-{m}");
        hit.GetProperty("id").GetGuid().ShouldBe(machineId);
        hit.GetProperty("title").GetString().ShouldBe($"DC01-{m}");
        hit.GetProperty("url").GetString().ShouldBe($"/organizations/{fjord}?tab=drift&device={machineId}");
        Facts(hit).ShouldBe(new Dictionary<string, string> { ["type"] = "Workstation", ["os"] = "Windows 11 Pro" });

        Group(await SearchAsync(reader, $"fjord{m}"), "devices").ShouldBeEmpty("the customer's name alone lists none of its devices");

        var bySerial = Group(await SearchAsync(reader, $"sn{m}a"), "devices").ShouldHaveSingleItem();
        bySerial.GetProperty("id").GetGuid().ShouldBe(machineId);
        Facts(bySerial)["serial"].ShouldBe($"SN{m}A");
        var byUser = Group(await SearchAsync(reader, $"kari{m}"), "devices").ShouldHaveSingleItem();
        Facts(byUser)["lastLogin"].ShouldBe($"VARDE\\kari{m}");
    }

    [Fact]
    public async Task A_device_no_longer_reported_comes_after_the_current_ones_and_a_full_group_says_there_is_more()
    {
        var (m, fjord, _) = await CustomersAsync();
        var system = $"gs-{m}";
        await DevicesAsync(fjord, system, Agent($"{m}-0", $"PC{m}-0"), Agent($"{m}-1", $"PC{m}-1"), Agent($"{m}-2", $"PC{m}-2"));
        // The next complete read no longer lists PC-0: its machine is history.
        await DevicesAsync(fjord, system, Agent($"{m}-1", $"PC{m}-1"), Agent($"{m}-2", $"PC{m}-2"));
        var reader = factory.ClientAs(CrmRoles.ReadOnly);

        var all = await SearchAsync(reader, $"pc{m}");
        Group(all, "devices").Select(h => h.GetProperty("title").GetString()).ShouldBe([$"PC{m}-1", $"PC{m}-2", $"PC{m}-0"]);
        Facts(Group(all, "devices")[2]).ShouldContainKey("removedAt");
        More(all, "devices").ShouldBeFalse();

        var two = await SearchAsync(reader, $"pc{m}", take: 2);
        Group(two, "devices").Count.ShouldBe(2);
        More(two, "devices").ShouldBeTrue("a third device was found and is not shown");
    }

    [Fact]
    public async Task Alerts_not_resolved_are_found_by_title_or_device_with_hidden_ones_last()
    {
        var (m, fjord, _) = await CustomersAsync();
        var system = $"gs-{m}";
        var admin = factory.ClientAs(CrmRoles.Admin);
        await AlertsAsync(system,
            new ExternalAlert("disk", fjord, AlertSeverity.Critical, $"Disk {m} almost full", $"DC01-{m}", DateTimeOffset.UtcNow.AddHours(-5)),
            new ExternalAlert("cpu", fjord, AlertSeverity.Warning, $"CPU {m} high", null, DateTimeOffset.UtcNow.AddHours(-3)),
            new ExternalAlert("gone", fjord, AlertSeverity.Critical, $"Gone {m}", null, DateTimeOffset.UtcNow.AddHours(-9)));
        // A complete read without "gone" resolves it.
        await AlertsAsync(system,
            new ExternalAlert("disk", fjord, AlertSeverity.Critical, $"Disk {m} almost full", $"DC01-{m}", DateTimeOffset.UtcNow.AddHours(-5)),
            new ExternalAlert("cpu", fjord, AlertSeverity.Warning, $"CPU {m} high", null, DateTimeOffset.UtcNow.AddHours(-3)));
        var (diskId, cpuId) = (await AlertIdAsync(system, "disk"), await AlertIdAsync(system, "cpu"));
        var reader = factory.ClientAs(CrmRoles.ReadOnly);

        var open = Group(await SearchAsync(reader, m), "alerts");
        open.Select(h => h.GetProperty("id").GetGuid()).ShouldBe([diskId, cpuId], "critical first, and the resolved one is not searched");
        var disk = open[0];
        disk.GetProperty("url").GetString().ShouldBe($"/alerts?alert={diskId}");
        disk.GetProperty("subtitle").GetString().ShouldBe($"Fjord{m} AS");
        Facts(disk).ShouldBe(new Dictionary<string, string> { ["severity"] = "Critical", ["system"] = system, ["device"] = $"DC01-{m}" });
        Group(await SearchAsync(reader, $"dc01-{m}"), "alerts").ShouldHaveSingleItem().GetProperty("id").GetGuid().ShouldBe(diskId);
        Group(await SearchAsync(reader, $"{m} havbris{m}"), "alerts").ShouldBeEmpty("both belong to another customer");

        // Hidden in Parasoll until a later day: still found, after the others, with the day it comes back.
        var card = await (await admin.GetAsync($"/api/v1/service/alerts/{diskId}", Ct)).ReadJsonAsync();
        var until = DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, Oslo).DateTime).AddDays(3);
        (await admin.PostWithETagAsync($"/api/v1/service/alerts/{diskId}/hide", new { until, reason = "Waiting for a new disk" },
            card.GetProperty("etag").GetString()!)).StatusCode.ShouldBe(HttpStatusCode.OK);
        var hidden = Group(await SearchAsync(reader, m), "alerts");
        hidden.Select(h => h.GetProperty("id").GetGuid()).ShouldBe([cpuId, diskId]);
        Facts(hidden[1]).ShouldContainKey("hiddenUntil");
        Facts(hidden[0]).ShouldNotContainKey("hiddenUntil");
    }

    [Fact]
    public async Task Tickets_are_found_by_their_number_alone_or_by_words_of_the_title_open_ones_first()
    {
        var (m, fjord, _) = await CustomersAsync();
        var (jams, toner) = (TestData.AteraId(), TestData.AteraId());
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            await scope.ServiceProvider.GetRequiredService<IServiceApi>().UpsertTicketsAsync(
            [
                Ticket(jams, fjord, $"Printer {m} jams", "Open", DateTimeOffset.UtcNow.AddHours(-6)),
                Ticket(toner, fjord, $"Printer {m} toner", "Closed", DateTimeOffset.UtcNow.AddHours(-1)),
            ], Ct);
        }

        var reader = factory.ClientAs(CrmRoles.ReadOnly);
        var byNumber = Group(await SearchAsync(reader, $"#{jams}"), "tickets").ShouldHaveSingleItem();
        byNumber.GetProperty("title").GetString().ShouldBe($"#{jams} Printer {m} jams");
        byNumber.GetProperty("url").GetString().ShouldBe($"/tickets?ticket={byNumber.GetProperty("id").GetGuid()}");
        Facts(byNumber).ShouldBe(new Dictionary<string, string> { ["status"] = "Open", ["open"] = "true" });
        Group(await SearchAsync(reader, jams.ToString(CultureInfo.InvariantCulture)), "tickets").ShouldHaveSingleItem()
            .GetProperty("id").GetGuid().ShouldBe(byNumber.GetProperty("id").GetGuid());

        var byWords = Group(await SearchAsync(reader, $"printer {m}"), "tickets");
        byWords.Select(h => h.GetProperty("title").GetString()).ShouldBe([$"#{jams} Printer {m} jams", $"#{toner} Printer {m} toner"],
            "open before closed, although the closed one moved later");
        Facts(byWords[1])["open"].ShouldBe("false");
        Group(await SearchAsync(reader, $"printer {m} fjord{m}"), "tickets").Count.ShouldBe(2);
        Group(await SearchAsync(reader, $"printer {m} havbris{m}"), "tickets").ShouldBeEmpty();
    }

    [Fact]
    public async Task A_person_in_a_backup_is_one_hit_with_the_services_they_are_backed_up_in()
    {
        var (m, fjord, _) = await CustomersAsync();
        var address = $"kari.{m.ToLowerInvariant()}@fjord.example";
        await BackupsAsync($"gs-{m}", fjord, m,
            ("Mail", BackupService.Mail, [(address, $"Kari {m}")]),
            ("OneDrive", BackupService.OneDrive, [(address, $"Kari {m}")]),
            ("Sites", BackupService.SharePoint, [($"Prosjekter {m}", null)]));
        var reader = factory.ClientAs(CrmRoles.ReadOnly);

        var person = Group(await SearchAsync(reader, $"kari {m}"), "backup").ShouldHaveSingleItem();
        person.GetProperty("title").GetString().ShouldBe($"Kari {m}");
        person.GetProperty("subtitle").GetString().ShouldBe($"Fjord{m} AS");
        person.GetProperty("url").GetString().ShouldBe($"/organizations/{fjord}?tab=backup&search={Uri.EscapeDataString(address)}");
        Facts(person).ShouldBe(new Dictionary<string, string> { ["services"] = "Mail,OneDrive", ["address"] = address });
        Group(await SearchAsync(reader, address), "backup").ShouldHaveSingleItem().GetProperty("id").GetGuid().ShouldBe(person.GetProperty("id").GetGuid());

        var site = Group(await SearchAsync(reader, $"prosjekter {m}"), "backup").ShouldHaveSingleItem();
        site.GetProperty("title").GetString().ShouldBe($"Prosjekter {m}");
        Facts(site).ShouldBe(new Dictionary<string, string> { ["services"] = "SharePoint" });
        Group(await SearchAsync(reader, $"kari {m} havbris{m}"), "backup").ShouldBeEmpty();
    }

    [Fact]
    public async Task The_operations_groups_need_the_drift_rights_and_a_picker_asks_for_its_own_group_only()
    {
        var (m, fjord, _) = await CustomersAsync();
        await DevicesAsync(fjord, $"gs-{m}", Agent($"{m}-a", $"Fjord{m}-GW"));

        var nobody = await SearchAsync(factory.ClientAs("Crm.Unknown", userKey: "search-nobody"), $"fjord{m}");
        nobody.GetProperty("groups").GetArrayLength().ShouldBe(0, "a caller without permissions searches nothing");

        var reader = factory.ClientAs(CrmRoles.ReadOnly);
        var everything = await SearchAsync(reader, $"fjord{m}");
        Group(everything, "organizations").ShouldHaveSingleItem();
        Group(everything, "devices").ShouldHaveSingleItem().GetProperty("title").GetString().ShouldBe($"Fjord{m}-GW");

        var picked = await SearchAsync(reader, $"fjord{m}", groups: "organizations");
        picked.GetProperty("groups").EnumerateArray().Select(g => g.GetProperty("group").GetString()).ShouldBe(["organizations"]);
    }

    private async Task<(string Marker, Guid Fjord, Guid Havbris)> CustomersAsync()
    {
        var marker = $"Gs{Guid.NewGuid():N}"[..10];
        var admin = factory.ClientAs(CrmRoles.Admin);
        var fjord = await admin.CreateOrganizationAsync(new { name = $"Fjord{marker} AS", status = "Customer" });
        var havbris = await admin.CreateOrganizationAsync(new { name = $"Havbris{marker} AS", status = "Customer" });
        return (marker, fjord, havbris);
    }

    private static ExternalDevice Agent(string id, string name, string? serial = null, string? user = null) =>
        new(id, name, DeviceType.Workstation, "Windows 11 Pro", true, DateTimeOffset.UtcNow.AddHours(-1), null, serial, [],
            Inventory: user is null ? null : new DeviceInventoryReading(
                null, null, null, null, null, null, null, null, null, null, [], null, null, null, user, null, [], null));

    /// <summary>One complete read of the test's own source for the customer: the machines are matched from what it lists.</summary>
    private async Task DevicesAsync(Guid organizationId, string system, params ExternalDevice[] devices)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        await scope.ServiceProvider.GetRequiredService<IServiceApi>().ReplaceDevicesAsync(organizationId, system, devices, Ct);
    }

    private async Task<Guid> MachineIdAsync(Guid organizationId, string name)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<ServiceDbContext>().Machines.AsNoTracking()
            .Where(x => x.OrganizationId == organizationId && x.Name == name).Select(x => x.Id).SingleAsync(Ct);
    }

    /// <summary>A complete read of the test's own alert source: what it lists is open, what it no longer lists is resolved.</summary>
    private async Task AlertsAsync(string system, params ExternalAlert[] alerts)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        await scope.ServiceProvider.GetRequiredService<IServiceApi>().ApplyAlertSnapshotAsync(
            new AlertSnapshot(system, AlertKind.Monitoring, alerts, alerts.Select(a => a.ExternalId).ToList(), IsComplete: true), Ct);
    }

    private async Task<Guid> AlertIdAsync(string system, string externalId)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<ServiceDbContext>().Alerts.AsNoTracking()
            .Where(a => a.System == system && a.ExternalId == externalId).Select(a => a.Id).SingleAsync(Ct);
    }

    private static ExternalTicket Ticket(long number, Guid organizationId, string title, string status, DateTimeOffset lastActivity) =>
        new("atera", number, organizationId, null, title, status, "Medium", null, "Problem", "Email", null, null, null, null,
            lastActivity.AddDays(-1), null, status == "Closed" ? lastActivity : null, lastActivity, null);

    /// <summary>A complete read of the test's own backup source: one account of the customer with these tasks and entities.</summary>
    private async Task BackupsAsync(string system, Guid organizationId, string marker,
        params (string Id, BackupService Service, (string Name, string? FullName)[] Entities)[] tasks)
    {
        var account = new ExternalBackupAccount($"{marker}-account", $"Fjord{marker} AS", null, "ACTIVE", "EU", tasks.Select(t =>
            new ExternalBackupTask($"{marker}-{t.Id}", t.Service, t.Id.ToUpperInvariant(), null, "ACTIVE", false, DateTimeOffset.UtcNow.AddHours(-2),
                null, t.Entities.Length, t.Entities.Length, null, t.Entities.Select((e, i) => new ExternalBackupEntity(
                    $"{marker}-{t.Id}-{i}", e.Name, e.FullName, null, "ACTIVE", false, DateTimeOffset.UtcNow.AddHours(-2), null, null, null, null, null)).ToList()))
            .ToList());
        await using var scope = factory.Services.CreateAsyncScope();
        await scope.ServiceProvider.GetRequiredService<IBackupApi>().ApplySnapshotAsync(
            new BackupSnapshot(system, new Dictionary<Guid, IReadOnlyList<ExternalBackupAccount>> { [organizationId] = [account] }, true), Ct);
    }

    private static async Task<JsonElement> SearchAsync(HttpClient client, string q, int take = 6, string? groups = null)
    {
        var response = await client.GetAsync(
            $"/api/v1/search?q={Uri.EscapeDataString(q)}&take={take}{(groups is null ? string.Empty : $"&groups={groups}")}", Ct);
        response.StatusCode.ShouldBe(HttpStatusCode.OK);
        return await response.ReadJsonAsync();
    }

    private static List<JsonElement> Group(JsonElement response, string name) =>
        response.GetProperty("groups").EnumerateArray()
            .Where(g => g.GetProperty("group").GetString() == name)
            .SelectMany(g => g.GetProperty("items").EnumerateArray())
            .ToList();

    private static bool More(JsonElement response, string name) =>
        response.GetProperty("groups").EnumerateArray().Single(g => g.GetProperty("group").GetString() == name).GetProperty("more").GetBoolean();

    private static Dictionary<string, string> Facts(JsonElement hit) =>
        hit.GetProperty("facts").EnumerateObject().ToDictionary(p => p.Name, p => p.Value.GetString()!);
}
