using System.Text.Json;
using Crm.Integrations.Atera;
using Crm.Service.Contracts;
using Crm.Service.Domain;
using Crm.Service.Features;

namespace Crm.UnitTests;

/// <summary>
/// M40: an Atera agent of API v3 is read with the keys that tell machines apart, the inventory, Atera's own link and its Windows
/// updates; an alert names its agent exactly; a device no longer reported forgets who was logged in. Synthetic data only.
/// </summary>
public sealed class AteraInventoryTests
{
    private static readonly Guid Customer = Guid.Parse("22222222-0000-0000-0000-000000000001");
    private static readonly Guid OtherCustomer = Guid.Parse("22222222-0000-0000-0000-000000000002");

    [Fact]
    public void An_agent_of_api_v3_is_read_with_its_keys_its_inventory_and_atera_own_link()
    {
        var agent = AteraClient.ReadAgent(Fixture().GetProperty("agents")[1])!;
        (agent.AgentId, agent.CustomerId, agent.MachineName, agent.Online).ShouldBe(("1201", 101L, "PC-ALFA-02", false));
        agent.LastSeenAt.ShouldBe(DateTimeOffset.Parse("2026-10-20T07:30:00Z"), "LastSeen, never the reboot or the change of the item");
        (agent.SerialNumber, agent.DeviceGuid).ShouldBe(("5CG1234ABC", "5369e175-0000-4000-8000-000000001201"));
        agent.MacAddresses.ShouldBe(["00:1A:2B:3C:4D:5E", "02:42:AC:11:00:02"]);
        agent.AppViewUrl.ShouldBe("https://atera.example.invalid/Admin#/rmm/device/5369e175-0000-4000-8000-000000001201/agent");

        var i = agent.Inventory!;
        (i.Vendor, i.Model, i.Processor, i.ProcessorCores, i.ProcessorClock, i.Memory, i.BiosVersion)
            .ShouldBe(("Dell Inc.", "Latitude 5440", "13th Gen Intel(R) Core(TM) i5-1345U", (int?)10, "1.6", (int?)16384, "1.15.0"));
        (i.OsVersion, i.OsBuild, i.DomainName, i.PublicIp, i.AgentVersion).ShouldBe(("23H2", "22631.4317", "ALFA", "203.0.113.10", "1.8.7.4"));
        (i.LoggedInUsers, i.LastLoginUser, i.LastRebootAt).ShouldBe(("ALFA\\testbruker", "testbruker", (DateTimeOffset?)DateTimeOffset.Parse("2026-10-19T05:00:00Z")));
        i.IpAddresses.ShouldBe(["10.0.0.21"]);
        i.Disks.ShouldBe([new AteraDisk("C:", 120.5, 355.4, 475.9)]);
    }

    [Fact]
    public void An_agent_without_last_seen_has_no_last_contact_even_after_a_reboot()
    {
        var agent = AteraClient.ReadAgent(Json("""{ "AgentID": 7, "CustomerID": 101, "MachineName": "PC-7", "LastRebootTime": "2026-10-01T06:00:00Z", "Modified": "2026-10-21T06:00:00Z" }"""))!;
        agent.LastSeenAt.ShouldBeNull();
        agent.Inventory!.LastRebootAt.ShouldBe(DateTimeOffset.Parse("2026-10-01T06:00:00Z"));
    }

    [Fact]
    public void Updates_are_read_in_either_spelling_and_an_entry_without_a_name_is_no_update()
    {
        var installed = AteraClient.ReadPatches(Fixture().GetProperty("installedPatches"), installed: true);
        installed.CollectedAt.ShouldBe(DateTimeOffset.Parse("2026-10-21T06:00:00Z"));
        var patch = installed.Patches.ShouldHaveSingleItem();
        (patch.KbId, patch.Class, patch.InstalledAt, patch.Status)
            .ShouldBe(("KB5044284", "Security Updates", (DateTimeOffset?)DateTimeOffset.Parse("2026-10-16T03:00:00Z"), (string?)null));

        var available = AteraClient.ReadPatches(Fixture().GetProperty("availablePatches"), installed: false);
        available.CollectedAt.ShouldBe(DateTimeOffset.Parse("2026-10-21T06:00:00Z"));
        var pending = available.Patches.ShouldHaveSingleItem();
        (pending.KbId, pending.Name, pending.Status, pending.InstalledAt)
            .ShouldBe(("KB5045993", "2026-10 .NET 8.0.11 Security Update (KB5045993)", "Pending", (DateTimeOffset?)null));
    }

    [Fact]
    public void An_alert_names_its_agent_by_id_and_by_device_guid()
    {
        var alert = AteraClient.ReadAlert(Fixture().GetProperty("alerts")[0])!;
        (alert.AlertId, alert.AgentId, alert.DeviceGuid).ShouldBe(("255", "1201", "5369e175-0000-4000-8000-000000001201"));
    }

    [Fact]
    public void A_device_takes_atera_own_link_before_the_template_and_no_licence_key()
    {
        var agent = AteraClient.ReadAgent(Fixture().GetProperty("agents")[1])!;
        var device = AteraServiceMapping.Device(agent, "https://app.atera.com/new/device/{0}");
        device.Url.ShouldBe(agent.AppViewUrl);
        (device.ExternalId, device.AlternateId, device.SerialNumber).ShouldBe(("1201", agent.DeviceGuid, "5CG1234ABC"));
        device.Inventory!.Disks.ShouldBe([new DeviceDisk("C:", 120.5, 355.4, 475.9)]);
        JsonSerializer.Serialize(device).ShouldNotContain("XXXXX", Case.Sensitive, "the Windows licence key is never taken");

        AteraServiceMapping.Device(agent with { AppViewUrl = "javascript:alert(1)" }, "https://app.atera.com/new/device/{0}").Url
            .ShouldBe("https://app.atera.com/new/device/1201", "a link that is no https address is not kept");
    }

    [Theory]
    [InlineData("Microsoft Windows 11 Pro", true)]
    [InlineData("Windows Server 2022", true)]
    [InlineData("macOS 15.1", false)]
    [InlineData(null, false)]
    public void Only_a_windows_agent_is_asked_for_updates(string? os, bool asked) => AteraServiceMapping.HasWindowsUpdates(os).ShouldBe(asked);

    [Fact]
    public void An_alert_gets_the_agent_it_names_before_a_device_of_the_same_name()
    {
        var named = Guid.NewGuid();
        var exact = Guid.NewGuid();
        var other = Guid.NewGuid();
        var index = new AlertDeviceIndex([
            new AlertDeviceCandidate(named, Customer, "PC-01", "1100", "5369E175-0000-4000-8000-000000001100"),
            new AlertDeviceCandidate(exact, Customer, "PC-01-OLD", "1201", "5369e175-0000-4000-8000-000000001201"),
            new AlertDeviceCandidate(other, OtherCustomer, "PC-09", "1300", "5369e175-0000-4000-8000-000000001300"),
        ]);

        index.Find(Alert("PC-01", agentId: "1201")).ShouldBe(exact, "the agent id is exact, the name a fallback");
        index.Find(Alert("PC-01", guid: "5369E175-0000-4000-8000-000000001201")).ShouldBe(exact, "a DeviceGuid matches in any case");
        index.Find(Alert("PC-01", agentId: "9999")).ShouldBe(named, "an agent the CRM does not know leaves the name to decide");
        index.Find(Alert(null, agentId: "1300")).ShouldBeNull("another customer's agent is never this alert's device");
    }

    [Fact]
    public void A_device_no_longer_reported_forgets_who_was_logged_in()
    {
        var agent = AteraClient.ReadAgent(Fixture().GetProperty("agents")[1])!;
        var device = Device.From("atera", Customer, AteraServiceMapping.Device(agent, null), DateTimeOffset.Parse("2026-10-21T00:00:00Z"));
        (device.LoggedInUsers, device.LastLoginUser, device.Processor).ShouldBe(("ALFA\\testbruker", "testbruker", "13th Gen Intel(R) Core(TM) i5-1345U"));

        device.MarkRemoved(DateTimeOffset.Parse("2026-10-22T00:00:00Z"));
        (device.LoggedInUsers, device.LastLoginUser).ShouldBe((null, null));
        device.Processor.ShouldNotBeNull("the hardware is no personal data and stays as history");
        DeviceDisks.Read(device.Disks).ShouldBe([new DeviceDisk("C:", 120.5, 355.4, 475.9)]);
    }

    private static ExternalAlert Alert(string? deviceName, string? agentId = null, string? guid = null) =>
        new("a-1", Customer, AlertSeverity.Warning, "Disk usage", deviceName, DateTimeOffset.Parse("2026-10-20T08:00:00Z"), "101", null, agentId, guid);

    private static JsonElement Fixture() =>
        JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "providers", "atera.json"))).RootElement;

    private static JsonElement Json(string json) => JsonDocument.Parse(json).RootElement;
}
