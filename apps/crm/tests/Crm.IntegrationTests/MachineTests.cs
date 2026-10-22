using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crm.Authorization;
using Crm.Integrations.Atera;
using Crm.Service.Contracts;
using Crm.Service.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crm.IntegrationTests;

/// <summary>
/// M40 on SQL Server: a device read makes one machine per computer and keeps its id, a person's decision is applied before any rule
/// and survives the next read, a decision needs the card the person saw, a device that moves takes nothing of the old customer's
/// along, and billing counts Atera's devices only. Each test reads its devices under systems of its own (other tests mirror "atera").
/// </summary>
public sealed class MachineTests(CrmWebFactory factory)
{
    private const string Machines = "/api/v1/service/machines";
    private const string MacA = "00:1A:2B:3C:4D:5E";
    private static readonly DateTimeOffset At = new(2026, 10, 20, 8, 0, 0, TimeSpan.Zero);

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task The_agents_of_one_computer_are_one_machine_and_the_machine_keeps_its_id_from_read_to_read()
    {
        var (system, organizationId, _) = await ScenarioAsync();
        var admin = factory.ClientAs(CrmRoles.Admin);
        await DevicesAsync(organizationId, system, Agent("old", "PC-01", "5CG1234ABC", MacA, online: false), Agent("new", "PC-01", "5CG1234ABC", MacA));

        var machine = (await ListAsync(admin, organizationId)).ShouldHaveSingleItem();
        machine.GetProperty("name").GetString().ShouldBe("PC-01");
        machine.GetProperty("online").GetBoolean().ShouldBeTrue("one of its devices is online");
        machine.GetProperty("sources").GetArrayLength().ShouldBe(2);
        machine.GetProperty("proposals").GetInt32().ShouldBe(0);
        var id = machine.GetProperty("id").GetGuid();

        await DevicesAsync(organizationId, system, Agent("old", "PC-01", "5CG1234ABC", MacA, online: false), Agent("new", "PC-01", "5CG1234ABC", MacA));
        (await ListAsync(admin, organizationId)).ShouldHaveSingleItem().GetProperty("id").GetGuid().ShouldBe(id);
        var summary = await (await admin.GetAsync($"/api/v1/service/organizations/{organizationId}/summary", Ct)).ReadJsonAsync();
        summary.GetProperty("devices").GetProperty("Workstation").GetInt32().ShouldBe(1, "the summary counts machines, not agents");
    }

    [Fact]
    public async Task A_person_joins_a_proposal_and_the_decision_survives_the_next_read()
    {
        var (system, organizationId, _) = await ScenarioAsync();
        var admin = factory.ClientAs(CrmRoles.Admin);
        // PC-07 is seen first, so its machine is the older one.
        await DevicesAsync(organizationId, system, Agent("pc", "PC-07", "MXL1122334"));
        await DevicesAsync(organizationId, system, Agent("pc", "PC-07", "MXL1122334"), Agent("renamed", "ACCOUNTS-7", "MXL1122334"));
        var machines = await ListAsync(admin, organizationId);
        machines.Count.ShouldBe(2, "a serial number alone joins nothing: the name differs");
        machines.ShouldAllBe(m => m.GetProperty("proposals").GetInt32() == 1);
        var newer = await CardAsync(admin, machines.Single(m => m.GetProperty("name").GetString() == "ACCOUNTS-7").GetProperty("id").GetGuid());
        var proposal = newer.GetProperty("proposals").EnumerateArray().ShouldHaveSingleItem();
        proposal.GetProperty("evidence").EnumerateArray().Select(e => e.GetString()).ShouldBe(["serial"]);
        var older = proposal.GetProperty("otherMachineId").GetGuid();

        var joined = await admin.PostWithETagAsync($"{Machines}/{newer.GetProperty("id").GetGuid()}/join", new { otherMachineId = older }, Etag(newer));
        joined.StatusCode.ShouldBe(HttpStatusCode.OK);
        var card = await joined.ReadJsonAsync();
        card.GetProperty("id").GetGuid().ShouldBe(older, "the older machine keeps its id");
        card.GetProperty("devices").GetArrayLength().ShouldBe(2);
        card.GetProperty("proposals").GetArrayLength().ShouldBe(0);

        await DevicesAsync(organizationId, system, Agent("pc", "PC-07", "MXL1122334"), Agent("renamed", "ACCOUNTS-7", "MXL1122334"));
        (await ListAsync(admin, organizationId)).ShouldHaveSingleItem().GetProperty("id").GetGuid().ShouldBe(older);
        (await DecisionsAsync(organizationId)).ShouldBe([("Same", true)]);
    }

    [Fact]
    public async Task Machines_kept_apart_lose_their_proposal_for_good()
    {
        var (system, organizationId, _) = await ScenarioAsync();
        var admin = factory.ClientAs(CrmRoles.Admin);
        await DevicesAsync(organizationId, system, Agent("a", "PC-01"), Agent("b", "PC-01"));
        var machines = await ListAsync(admin, organizationId);
        machines.Count.ShouldBe(2, "two agents of one source with one name and nothing else: a person decides");
        var card = await CardAsync(admin, machines[0].GetProperty("id").GetGuid());
        var other = card.GetProperty("proposals").EnumerateArray().ShouldHaveSingleItem().GetProperty("otherMachineId").GetGuid();

        (await admin.PostWithETagAsync($"{Machines}/{card.GetProperty("id").GetGuid()}/keep-apart", new { otherMachineId = other }, Etag(card)))
            .StatusCode.ShouldBe(HttpStatusCode.OK);
        await DevicesAsync(organizationId, system, Agent("a", "PC-01"), Agent("b", "PC-01"));
        var after = await ListAsync(admin, organizationId);
        after.Count.ShouldBe(2);
        after.ShouldAllBe(m => m.GetProperty("proposals").GetInt32() == 0);
    }

    [Fact]
    public async Task A_detached_device_is_a_machine_of_its_own_and_stays_one()
    {
        var (system, organizationId, _) = await ScenarioAsync();
        var admin = factory.ClientAs(CrmRoles.Admin);
        await DevicesAsync(organizationId, system, Agent("a", "PC-01", "5CG1234ABC", MacA), Agent("b", "PC-01", "5CG1234ABC", MacA));
        var card = await CardAsync(admin, (await ListAsync(admin, organizationId)).ShouldHaveSingleItem().GetProperty("id").GetGuid());
        var second = card.GetProperty("devices")[1].GetProperty("id").GetGuid();

        var detached = await admin.PostWithETagAsync($"{Machines}/{card.GetProperty("id").GetGuid()}/detach", new { deviceId = second }, Etag(card));
        detached.StatusCode.ShouldBe(HttpStatusCode.OK);
        var remaining = await detached.ReadJsonAsync();
        remaining.GetProperty("id").GetGuid().ShouldBe(card.GetProperty("id").GetGuid(), "the machine stays with the device seen first");
        remaining.GetProperty("devices").GetArrayLength().ShouldBe(1);

        await DevicesAsync(organizationId, system, Agent("a", "PC-01", "5CG1234ABC", MacA), Agent("b", "PC-01", "5CG1234ABC", MacA));
        var machines = await ListAsync(admin, organizationId);
        machines.Count.ShouldBe(2, "the decision survives the read that would join them again");
        machines.ShouldAllBe(m => m.GetProperty("proposals").GetInt32() == 0, "kept apart, not proposed again");
    }

    [Fact]
    public async Task A_decision_needs_the_card_the_person_saw()
    {
        var (system, organizationId, _) = await ScenarioAsync();
        var admin = factory.ClientAs(CrmRoles.Admin);
        await DevicesAsync(organizationId, system, Agent("a", "PC-01"), Agent("b", "PC-01"));
        var card = await CardAsync(admin, (await ListAsync(admin, organizationId))[0].GetProperty("id").GetGuid());
        var other = card.GetProperty("proposals")[0].GetProperty("otherMachineId").GetGuid();
        var url = $"{Machines}/{card.GetProperty("id").GetGuid()}/join";

        (await admin.PostAsJsonAsync(url, new { otherMachineId = other }, Ct)).StatusCode.ShouldBe(HttpStatusCode.PreconditionRequired);
        // The next read changes what the card showed (the agent was seen later), so the card the person decided on is stale.
        await DevicesAsync(organizationId, system, Agent("a", "PC-01", seenHoursLater: 2), Agent("b", "PC-01", seenHoursLater: 2));
        var stale = await admin.PostWithETagAsync(url, new { otherMachineId = other }, Etag(card));
        stale.StatusCode.ShouldBe(HttpStatusCode.PreconditionFailed);
        (await ListAsync(admin, organizationId)).Count.ShouldBe(2, "nothing was decided");
    }

    [Fact]
    public async Task A_device_that_moves_to_another_customer_takes_no_machine_of_the_old_one_along()
    {
        var (system, organizationId, marker) = await ScenarioAsync();
        var admin = factory.ClientAs(CrmRoles.Admin);
        var other = await admin.CreateOrganizationAsync(new { name = $"{marker} Ny kunde AS", status = "Customer" });
        await DevicesAsync(organizationId, system, Agent("a", "PC-01"));
        var before = (await ListAsync(admin, organizationId)).ShouldHaveSingleItem().GetProperty("id").GetGuid();

        await DevicesAsync(other, system, Agent("a", "PC-01"));
        (await ListAsync(admin, organizationId)).ShouldBeEmpty();
        var moved = (await ListAsync(admin, other)).ShouldHaveSingleItem();
        moved.GetProperty("id").GetGuid().ShouldNotBe(before);
        await using var scope = factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ServiceDbContext>();
        (await db.Machines.AnyAsync(m => m.Id == before, Ct)).ShouldBeFalse("a machine no device names is removed");
    }

    [Fact]
    public async Task Billing_counts_the_atera_devices_while_the_machine_shows_every_source()
    {
        var (system, organizationId, marker) = await ScenarioAsync();
        var admin = factory.ClientAs(CrmRoles.Admin);
        await DevicesAsync(organizationId, AteraTypes.System, new ExternalDevice($"{marker}-atera", "PC-01", DeviceType.Workstation, null, true, At, null));
        await DevicesAsync(organizationId, system, Agent("other", "pc-01.contoso.local"));

        var machine = (await ListAsync(admin, organizationId)).ShouldHaveSingleItem("a unique name joins the agents of two sources");
        machine.GetProperty("sources").EnumerateArray().Select(s => s.GetProperty("system").GetString()).ShouldBe([AteraTypes.System, system], ignoreOrder: true);
        await using var scope = factory.Services.CreateAsyncScope();
        var counts = await scope.ServiceProvider.GetRequiredService<IServiceApi>()
            .GetDeviceCountReadingsAsync([organizationId], DateOnly.FromDateTime(DateTime.UtcNow), Ct);
        counts[organizationId].Counts.ShouldBe(new Dictionary<DeviceType, int> { [DeviceType.Workstation] = 1 }, "the other source's agent is the same machine, not another device to bill");
    }

    private static ExternalDevice Agent(
        string id, string name, string? serial = null, string? mac = null, bool online = true, int seenHoursLater = 0) =>
        new(id, name, DeviceType.Workstation, "Windows 11 Pro", online, At.AddHours(seenHoursLater), null, serial, mac is null ? [] : [mac]);

    private async Task<(string System, Guid OrganizationId, string Marker)> ScenarioAsync()
    {
        var marker = $"M40{Guid.NewGuid():N}"[..11];
        var organizationId = await factory.ClientAs(CrmRoles.Admin).CreateOrganizationAsync(new { name = $"{marker} Maskin AS", status = "Customer" });
        return ($"m40-{marker}", organizationId, marker);
    }

    /// <summary>One read of a source's devices for the customer; ids are made unique per test from the system.</summary>
    private async Task DevicesAsync(Guid organizationId, string system, params ExternalDevice[] devices)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        await scope.ServiceProvider.GetRequiredService<IServiceApi>().ReplaceDevicesAsync(organizationId, system,
            devices.Select(d => system == AteraTypes.System ? d : d with { ExternalId = $"{system}-{d.ExternalId}" }).ToList(), Ct);
    }

    private static async Task<List<JsonElement>> ListAsync(HttpClient client, Guid organizationId)
    {
        var page = await (await client.GetAsync($"{Machines}?organizationId={organizationId}&limit=100", Ct)).ReadJsonAsync();
        return page.GetProperty("items").EnumerateArray().ToList();
    }

    private static async Task<JsonElement> CardAsync(HttpClient client, Guid machineId)
    {
        var response = await client.GetAsync($"{Machines}/{machineId}", Ct);
        response.StatusCode.ShouldBe(HttpStatusCode.OK);
        return await response.ReadJsonAsync();
    }

    private static string Etag(JsonElement card) => card.GetProperty("etag").GetString()!;

    private async Task<List<(string Kind, bool Audited)>> DecisionsAsync(Guid organizationId)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ServiceDbContext>();
        return (await db.MachineLinkDecisions.AsNoTracking().Where(d => d.OrganizationId == organizationId).ToListAsync(Ct))
            .Select(d => (d.Kind.ToString(), d.CreatedBy is not null)).ToList();
    }
}
