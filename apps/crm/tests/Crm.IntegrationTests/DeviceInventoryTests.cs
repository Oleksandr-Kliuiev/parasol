using System.Globalization;
using System.Text.Json;
using Crm.Authorization;
using Crm.Integrations.Atera;
using Crm.Integrations.Core.Persistence;
using Crm.Service.Contracts;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using WireMock.ResponseBuilders;
using static Crm.IntegrationTests.IntegrationTestHelpers;

namespace Crm.IntegrationTests;

/// <summary>
/// M40 on SQL Server: what Atera's agent read says about the computer reaches the machine card with Atera's own link, the update
/// read stores each Windows agent's updates through Atera's patch routes, a device Atera cannot read keeps the updates it had and
/// leaves the run incomplete, and a device no longer reported loses its users and its updates. Atera answers from a stub of the test.
/// </summary>
[Collection(AteraCollection.Name)]
public sealed class DeviceInventoryTests(CrmWebFactory factory)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task The_card_shows_what_atera_says_about_the_computer_and_its_windows_updates()
    {
        await using var host = AteraTicketHost.Start(factory);
        var (organizationId, guid) = await AgentAsync(host);
        Patches(host, guid, installed: true, Installed("KB5044284", "2026-10-16T03:00:00Z"), Installed("KB2267602", "2026-10-20T03:00:00Z"));
        Patches(host, guid, installed: false, new { name = ".NET 8.0.11 Security Update (KB5045993)", @class = "Security Updates", kbId = "KB5045993", status = "Pending" });

        await RunPatchesAsync(host);

        var card = await CardAsync(host, organizationId);
        var device = card.GetProperty("devices").EnumerateArray().ShouldHaveSingleItem();
        device.GetProperty("url").GetString().ShouldBe($"https://atera.example.invalid/Admin#/rmm/device/{guid}/agent", "Atera's own link, not the template");
        var inventory = device.GetProperty("inventory");
        inventory.GetProperty("processor").GetString().ShouldBe("13th Gen Intel(R) Core(TM) i5-1345U");
        inventory.GetProperty("memory").GetInt32().ShouldBe(16384);
        inventory.GetProperty("serialNumber").GetString().ShouldStartWith("SN");
        inventory.GetProperty("loggedInUsers").GetString().ShouldBe("KUNDE\\testbruker");
        inventory.GetProperty("ipAddresses").EnumerateArray().Select(i => i.GetString()).ShouldBe(["10.0.0.21"]);
        inventory.GetProperty("disks")[0].GetProperty("total").GetDouble().ShouldBe(475.9);

        var patches = device.GetProperty("patches");
        patches.GetProperty("readAt").ValueKind.ShouldBe(JsonValueKind.String);
        patches.GetProperty("collectedAt").GetDateTimeOffset().ShouldBe(DateTimeOffset.Parse("2026-10-21T06:00:00Z", CultureInfo.InvariantCulture));
        patches.GetProperty("installedCount").GetInt32().ShouldBe(2);
        patches.GetProperty("latestInstalled").EnumerateArray().Select(p => p.GetProperty("kbId").GetString()).ShouldBe(["KB2267602", "KB5044284"], "newest first");
        patches.GetProperty("available").EnumerateArray().ShouldHaveSingleItem().GetProperty("status").GetString().ShouldBe("Pending");
        card.GetProperty("reads").EnumerateArray().Select(r => r.GetProperty("source").GetString()).ShouldBe(["devices", "patches"]);
    }

    [Fact]
    public async Task A_device_atera_cannot_read_keeps_the_updates_it_had_and_the_run_is_incomplete()
    {
        await using var host = AteraTicketHost.Start(factory);
        var (organizationId, guid) = await AgentAsync(host);
        Patches(host, guid, installed: true, Installed("KB5044284", "2026-10-16T03:00:00Z"));
        Patches(host, guid, installed: false);
        await RunPatchesAsync(host);
        var before = (await CardAsync(host, organizationId)).GetProperty("devices")[0].GetProperty("patches");

        host.On("GET", $"/api/v3/agents/{guid}/installed-patches").RespondWith(Response.Create().WithStatusCode(503));
        await RunPatchesAsync(host);

        var after = (await CardAsync(host, organizationId)).GetProperty("devices")[0].GetProperty("patches");
        after.GetProperty("installedCount").GetInt32().ShouldBe(1, "the device keeps what its last complete read found");
        after.GetProperty("readAt").GetString().ShouldBe(before.GetProperty("readAt").GetString(), "and says when that read was");
        await using var scope = host.Services.CreateAsyncScope();
        var run = await scope.ServiceProvider.GetRequiredService<IntegrationDbContext>().SyncRuns.AsNoTracking()
            .Where(r => r.System == "atera" && r.Job == AteraPatchSyncJob.JobId).OrderByDescending(r => r.StartedAt).FirstAsync(Ct);
        run.Failed.ShouldBeGreaterThan(0, "a device that could not be read makes the run incomplete");
    }

    [Fact]
    public async Task A_device_atera_keeps_no_update_data_for_is_counted_apart_and_fails_nothing()
    {
        await using var host = AteraTicketHost.Start(factory);
        var (_, guid) = await AgentAsync(host);
        host.On("GET", $"/api/v3/agents/{guid}/installed-patches").RespondWith(Response.Create().WithStatusCode(500));
        Patches(host, guid, installed: false);

        await RunPatchesAsync(host);

        await using var scope = host.Services.CreateAsyncScope();
        var run = await scope.ServiceProvider.GetRequiredService<IntegrationDbContext>().SyncRuns.AsNoTracking()
            .Where(r => r.System == "atera" && r.Job == AteraPatchSyncJob.JobId).OrderByDescending(r => r.StartedAt).FirstAsync(Ct);
        run.Message!.ShouldContain("without update data 1");
    }

    [Fact]
    public async Task A_device_no_longer_reported_loses_its_users_and_its_updates()
    {
        await using var host = AteraTicketHost.Start(factory);
        var (organizationId, guid) = await AgentAsync(host);
        Patches(host, guid, installed: true, Installed("KB5044284", "2026-10-16T03:00:00Z"));
        Patches(host, guid, installed: false);
        await RunPatchesAsync(host);

        await using (var scope = host.Services.CreateAsyncScope())
        {
            await scope.ServiceProvider.GetRequiredService<IServiceApi>().ReplaceDevicesAsync(organizationId, AteraTypes.System, [], Ct);
        }

        var page = await (await host.Client().GetAsync($"/api/v1/service/machines?organizationId={organizationId}&includeRemoved=true", Ct)).ReadJsonAsync();
        var card = await (await host.Client().GetAsync($"/api/v1/service/machines/{page.GetProperty("items")[0].GetProperty("id").GetGuid()}", Ct)).ReadJsonAsync();
        card.GetProperty("removedAt").ValueKind.ShouldBe(JsonValueKind.String);
        var device = card.GetProperty("devices")[0];
        device.GetProperty("inventory").GetProperty("loggedInUsers").ValueKind.ShouldBe(JsonValueKind.Null);
        device.GetProperty("inventory").GetProperty("lastLoginUser").ValueKind.ShouldBe(JsonValueKind.Null);
        device.GetProperty("patches").GetProperty("installedCount").GetInt32().ShouldBe(0);
    }

    /// <summary>A linked customer with one Windows agent as Atera's API v3 describes it; the agent's DeviceGuid.</summary>
    private static async Task<(Guid OrganizationId, string Guid)> AgentAsync(AteraTicketHost host)
    {
        var organizationId = await host.Client().CreateOrganizationAsync(new { name = $"Inventar {Guid.NewGuid():N}"[..20], status = "Customer" });
        var agentId = Random.Shared.NextInt64(80_000_000, 89_999_999);
        var guid = $"5369e175-0000-4000-8000-{agentId:D12}";
        var agent = AteraClient.ReadAgent(JsonDocument.Parse(JsonSerializer.Serialize(new
        {
            AgentID = agentId, DeviceGuid = guid, CustomerID = 101, MachineName = $"PC-{agentId}", OS = "Microsoft Windows 11 Pro", OSType = "Work Station",
            Online = true, LastSeen = DateTimeOffset.UtcNow, AppViewUrl = $"https://atera.example.invalid/Admin#/rmm/device/{guid}/agent",
            VendorSerialNumber = $"SN{agentId}", Processor = "13th Gen Intel(R) Core(TM) i5-1345U", Memory = 16384, CurrentLoggedUsers = "KUNDE\\testbruker",
            LastLoginUser = "testbruker", IpAddresses = new[] { "10.0.0.21" },
            HardwareDisks = new[] { new { Drive = "C:", Free = 120.5, Used = 355.4, Total = 475.9 } },
        })).RootElement)!;
        await using var scope = host.Services.CreateAsyncScope();
        await scope.ServiceProvider.GetRequiredService<IServiceApi>().ReplaceDevicesAsync(organizationId, AteraTypes.System,
            [AteraServiceMapping.Device(agent, "https://app.atera.com/new/device/{0}")], Ct);
        return (organizationId, guid);
    }

    private static object Installed(string kb, string at) =>
        new { name = $"Update ({kb})", @class = "Security Updates", kbId = kb, installDate = at };

    private static void Patches(AteraTicketHost host, string guid, bool installed, params object[] updates) =>
        host.On("GET", $"/api/v3/agents/{guid}/{(installed ? "installed" : "available")}-patches").RespondWith(JsonReply(installed
            ? new { deviceGuid = guid, timestamp = "2026-10-21T06:00:00Z", installedUpdates = updates }
            : (object)new { deviceGuid = guid, timestamp = "2026-10-21T06:00:00Z", availableUpdates = updates }));

    private static async Task RunPatchesAsync(AteraTicketHost host)
    {
        await using var scope = host.Services.CreateAsyncScope();
        try
        {
            await scope.ServiceProvider.GetRequiredService<AteraPatchSyncJob>().RunAsync(Ct);
        }
        catch (Crm.Integrations.Core.SyncFailedException)
        {
            // A run that ends early is recorded as failed; the tests read what it stored.
        }
    }

    private static async Task<JsonElement> CardAsync(AteraTicketHost host, Guid organizationId)
    {
        var page = await (await host.Client().GetAsync($"/api/v1/service/machines?organizationId={organizationId}", Ct)).ReadJsonAsync();
        return await (await host.Client().GetAsync($"/api/v1/service/machines/{page.GetProperty("items")[0].GetProperty("id").GetGuid()}", Ct)).ReadJsonAsync();
    }
}
