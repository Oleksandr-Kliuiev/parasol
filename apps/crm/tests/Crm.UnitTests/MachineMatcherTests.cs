using Crm.Service.Domain;
using Crm.Service.Features;

namespace Crm.UnitTests;

/// <summary>
/// M40: one customer's devices become machines by serial number, shared MAC address and host name, with a person's decisions
/// first. Each case names the devices by a letter; the expected machines are groups of letters and the proposals say which newer
/// machine may be which older one, and why. Synthetic data only.
/// </summary>
public sealed class MachineMatcherTests
{
    private static readonly DateTimeOffset First = DateTimeOffset.Parse("2026-10-01T08:00:00Z");

    public sealed record Case(string Name, Dev[] Devices, Decided[] Decisions, string Machines, string Proposals)
    {
        public override string ToString() => Name;
    }

    /// <summary>A device of a case: its letter is its id, its position the order it was first seen in.</summary>
    public sealed record Dev(string Id, string System, string? Name, string? Serial = null, string[]? Macs = null, string? Machine = null);

    public sealed record Decided(string Device, string Other, MachineLinkKind Kind);

    private static Dev Atera(string id, string? name, string? serial = null, string[]? macs = null, string? machine = null) => new(id, "atera", name, serial, macs, machine);

    private static Dev Huntress(string id, string? name, string? serial = null, string[]? macs = null) => new(id, "huntress", name, serial, macs);

    private static Decided Same(string a, string b) => new(a, b, MachineLinkKind.Same);

    private static Decided Apart(string a, string b) => new(a, b, MachineLinkKind.Different);

    private const string S1 = "5CG1234ABC";
    private const string S2 = "5CG9876XYZ";
    private const string S3 = "PF2ABCDE";
    private const string S9 = "MXL1122334";
    private const string MacA = "00:1A:2B:3C:4D:5E";
    private const string MacB = "00-1A-2B-3C-4D-5F";
    private const string Dock = "00:50:B6:11:22:33";
    private const string Random = "02:42:AC:11:00:02";

    public static TheoryData<Case> Cases => new()
    {
        new Case("one device is one machine", [Atera("A", "PC-01", S1)], [], "A", ""),
        new Case("serial, name and MAC all match: one machine even within one source",
            [Atera("A", "PC-01", S1, [MacA]), Atera("B", "pc-01", "5cg 1234 abc", [MacA, MacB])], [], "A B", ""),
        new Case("three agents of one computer keep their shared MAC address as a key",
            [Atera("A", "PC-01", S1, [MacA]), Atera("B", "PC-01", S1, [MacA]), Huntress("C", "PC-01", S1, [MacA])], [], "A B C", ""),
        new Case("two agents of one source with one name and nothing else to tell: a person decides",
            [Atera("A", "PC-01"), Atera("B", "PC-01")], [], "A | B", "B→A Name"),
        new Case("a name unique to one machine of each source: one machine",
            [Atera("A", "PC-01.contoso.local", S1), Huntress("B", "pc-01")], [], "A B", ""),
        new Case("a unique name whose serial numbers contradict: a person decides",
            [Atera("A", "PC-01", S1), Huntress("B", "PC-01", S2)], [], "A | B", "B→A Name SerialConflict"),
        new Case("a name three machines carry is not unique",
            [Atera("A", "PC-01", S1), Atera("B", "PC-01", S2), Huntress("C", "PC-01")], [],
            "A | B | C", "B→A Name SerialConflict; C→A Name; C→B Name"),
        new Case("the serial number matches but the name does not: a renamed machine is a proposal",
            [Atera("A", "PC-01", S1), Atera("B", "PC-07", S1)], [], "A | B", "B→A Serial"),
        new Case("only a MAC address is shared: a proposal",
            [Atera("A", "PC-01", macs: [MacA]), Atera("B", "LAPTOP-9", macs: [MacA])], [], "A | B", "B→A Mac"),
        new Case("a MAC address three differently named devices share is a docking station, not a key",
            [Atera("A", "PC-01", macs: [Dock]), Atera("B", "PC-02", macs: [Dock]), Atera("C", "PC-03", macs: [Dock])], [], "A | B | C", ""),
        new Case("a host name more than five devices carry proposes nothing",
            [Atera("A", "PC-SAME"), Atera("B", "PC-SAME"), Atera("C", "PC-SAME"), Atera("D", "PC-SAME"), Atera("E", "PC-SAME"), Atera("F", "PC-SAME")],
            [], "A | B | C | D | E | F", ""),
        new Case("a locally administered MAC address is no key",
            [Atera("A", "PC-01", macs: [Random]), Atera("B", "PC-02", macs: [Random])], [], "A | B", ""),
        new Case("placeholder serial numbers are no key: within one source a person decides",
            [Atera("A", "PC-01", "To be filled by O.E.M.", [MacA]), Atera("B", "PC-01", "To be filled by O.E.M.", [MacA])], [],
            "A | B", "B→A Mac Name"),
        new Case("placeholder serial numbers do not contradict a unique name across sources",
            [Atera("A", "PC-01", "Default string"), Huntress("B", "PC-01", "System Serial Number")], [], "A B", ""),
        new Case("NetBIOS keeps 15 characters of the name",
            [Atera("A", "ACCOUNTING-DESKT"), Huntress("B", "accounting-desktop-07.corp.example")], [], "A B", ""),
        new Case("a person's same machine joins devices that share nothing",
            [Atera("A", "PC-01", S1), Atera("B", "NEW-PC", S9)], [Same("B", "A")], "A B", ""),
        new Case("a person's different machines keep a full match apart and leave no proposal",
            [Atera("A", "PC-01", S1, [MacA]), Atera("B", "PC-01", S1, [MacA])], [Apart("A", "B")], "A | B", ""),
        new Case("a person's different machines also stop a join through a third device",
            [Atera("A", "PC-01", S1, [MacA]), Atera("B", "PC-01", S1, [MacA]), Atera("C", "PC-01", S1, [MacA])], [Apart("A", "C")],
            "A B | C", ""),
        new Case("a rejected proposal does not come back",
            [Atera("A", "PC-01", S1), Atera("B", "PC-07", S1)], [Apart("B", "A")], "A | B", ""),
        new Case("two agents of one source joined by all keys still meet the other source's agent by a unique name",
            [Atera("A", "PC-01", S1, [MacA]), Atera("B", "PC-01", S1, [MacA]), Huntress("C", "PC-01")], [], "A B C", ""),
        new Case("a decision about a device that is not reported any more is left alone",
            [Atera("A", "PC-01", S1)], [Same("A", "Z"), Apart("A", "Y")], "A", ""),
        new Case("a machine that serial numbers already contradict does not take a third device by name",
            [Atera("A", "PC-01", S1), Huntress("B", "NEW-NAME", S2), Huntress("C", "PC-01", S3)], [Same("A", "B")],
            "A B | C", "C→A Name SerialConflict"),
    };

    [Theory]
    [MemberData(nameof(Cases))]
    public void Devices_become_machines(Case @case)
    {
        var (machines, proposals) = Run(@case.Devices, @case.Decisions);
        machines.ShouldBe(@case.Machines, @case.Name);
        proposals.ShouldBe(@case.Proposals, @case.Name);
    }

    [Theory]
    [MemberData(nameof(Cases))]
    public void The_order_devices_are_listed_in_changes_nothing(Case @case)
    {
        var (machines, proposals) = Run(@case.Devices, @case.Decisions);
        var reversed = Run(@case.Devices, @case.Decisions, reverse: true);
        reversed.ShouldBe((machines, proposals), @case.Name);
    }

    [Fact]
    public void A_machine_keeps_its_id_and_a_device_that_joins_it_takes_that_id()
    {
        var devices = new[] { Atera("A", "PC-01", S1, [MacA], machine: "M1"), Atera("B", "PC-01", S1, [MacA]) };
        var (match, ids) = Raw(devices, []);
        match.NewMachines.ShouldBeEmpty("both devices are one machine, the one A already belonged to");
        match.MachineOfDevice[ids["A"]].ShouldBe(MachineId("M1"));
        match.MachineOfDevice[ids["B"]].ShouldBe(MachineId("M1"));
    }

    [Fact]
    public void Splitting_a_machine_leaves_its_id_with_the_device_seen_first()
    {
        var devices = new[] { Atera("A", "PC-01", S1, [MacA], machine: "M1"), Atera("B", "PC-01", S1, [MacA], machine: "M1") };
        var (match, ids) = Raw(devices, [Apart("B", "A")]);
        match.MachineOfDevice[ids["A"]].ShouldBe(MachineId("M1"));
        var made = match.NewMachines.ShouldHaveSingleItem();
        match.MachineOfDevice[ids["B"]].ShouldBe(made);
    }

    [Fact]
    public void Joining_two_machines_keeps_the_id_of_the_older_one()
    {
        var devices = new[] { Atera("A", "PC-01", S1, machine: "M1"), Atera("B", "NEW-PC", S9, machine: "M2") };
        var (match, ids) = Raw(devices, [Same("A", "B")]);
        match.NewMachines.ShouldBeEmpty();
        match.MachineOfDevice[ids["A"]].ShouldBe(MachineId("M1"));
        match.MachineOfDevice[ids["B"]].ShouldBe(MachineId("M1"));
    }

    [Fact]
    public void A_proposal_names_the_newer_machine_first_and_the_strongest_pair_of_devices()
    {
        var devices = new[] { Atera("A", "PC-01", S1), Atera("B", "PC-01", S1, [MacA]), Atera("C", "PC-07", S1, [MacA], machine: "M3") };
        var (match, ids) = Raw(devices, [Apart("A", "B")]);
        // A and B were kept apart; C shares the serial number with both and a MAC address with B, so it is B's machine C may be.
        var proposals = match.Proposals.OrderBy(p => p.OtherDeviceId == ids["A"] ? 0 : 1).ToList();
        proposals.Count.ShouldBe(2);
        proposals[0].DeviceId.ShouldBe(ids["C"]);
        proposals[0].OtherDeviceId.ShouldBe(ids["A"]);
        proposals[0].Evidence.ShouldBe(MachineEvidence.Serial);
        proposals[1].DeviceId.ShouldBe(ids["C"]);
        proposals[1].OtherDeviceId.ShouldBe(ids["B"]);
        proposals[1].Evidence.ShouldBe(MachineEvidence.Serial | MachineEvidence.Mac);
        proposals[1].MachineId.ShouldBe(MachineId("M3"));
    }

    [Theory]
    [InlineData("To be filled by O.E.M.", null)]
    [InlineData("To Be Filled By OEM", null)]
    [InlineData("Default string", null)]
    [InlineData("System Serial Number", null)]
    [InlineData("Chassis Serial Number", null)]
    [InlineData("Not Specified", null)]
    [InlineData("N/A", null)]
    [InlineData("None", null)]
    [InlineData("0", null)]
    [InlineData("00000000", null)]
    [InlineData("FFFFFFFF", null)]
    [InlineData("123456789", null)]
    [InlineData("   ", null)]
    [InlineData(null, null)]
    [InlineData("5CG1234ABC", "5CG1234ABC")]
    [InlineData(" 5cg 1234 abc ", "5CG1234ABC")]
    [InlineData("VMware-56 4d 2b 9a", "VMWARE-564D2B9A")]
    public void A_serial_number_is_spelled_one_way_and_a_placeholder_is_no_serial(string? reported, string? expected) =>
        MachineKeys.Serial(reported).ShouldBe(expected);

    [Theory]
    [InlineData("pc-01.contoso.local", "PC-01")]
    [InlineData("  srv01 ", "SRV01")]
    [InlineData("ACCOUNTING-DESKTOP-07", "ACCOUNTING-DESK")]
    [InlineData("", null)]
    [InlineData(".local", null)]
    [InlineData(null, null)]
    public void A_host_name_loses_its_domain_and_keeps_15_characters(string? reported, string? expected) =>
        MachineKeys.Hostname(reported).ShouldBe(expected);

    [Theory]
    [InlineData("00:1A:2B:3C:4D:5E", "001A2B3C4D5E")]
    [InlineData("00-1a-2b-3c-4d-5e", "001A2B3C4D5E")]
    [InlineData("001a.2b3c.4d5e", "001A2B3C4D5E")]
    [InlineData("02:42:AC:11:00:02", null)]
    [InlineData("01:00:5E:00:00:FB", null)]
    [InlineData("FF:FF:FF:FF:FF:FF", null)]
    [InlineData("00:00:00:00:00:00", null)]
    [InlineData("00:1A:2B", null)]
    [InlineData("ZZ:1A:2B:3C:4D:5E", null)]
    [InlineData(null, null)]
    public void A_mac_address_is_twelve_hex_digits_of_one_adapter(string? reported, string? expected) =>
        MachineKeys.Mac(reported).ShouldBe(expected);

    private static (string Machines, string Proposals) Run(Dev[] devices, Decided[] decisions, bool reverse = false)
    {
        var (match, ids) = Raw(devices, decisions, reverse);
        var label = ids.ToDictionary(kv => kv.Value, kv => kv.Key);
        var groups = match.MachineOfDevice.GroupBy(kv => kv.Value).Select(g => string.Join(' ', g.Select(kv => label[kv.Key]).Order()))
            .Order(StringComparer.Ordinal).ToList();
        var memberOf = match.MachineOfDevice.GroupBy(kv => kv.Value).ToDictionary(g => g.Key, g => g.Select(kv => label[kv.Key]).Order().First());
        var proposals = match.Proposals
            .Select(p => $"{memberOf[p.MachineId]}→{memberOf[p.OtherMachineId]} {Evidence(p.Evidence)}")
            .Order(StringComparer.Ordinal).ToList();
        return (string.Join(" | ", groups), string.Join("; ", proposals));
    }

    private static (MachineMatch Match, Dictionary<string, Guid> Ids) Raw(Dev[] devices, Decided[] decisions, bool reverse = false)
    {
        var ids = devices.Select(d => d.Id).Concat(decisions.SelectMany(d => new[] { d.Device, d.Other })).Distinct()
            .ToDictionary(id => id, DeviceId);
        var listed = devices.Select((d, i) => new MatchDevice(
            ids[d.Id], d.System, d.Name, d.Serial, d.Macs ?? [], First.AddHours(i), d.Machine is { } m ? MachineId(m) : null)).ToList();
        if (reverse)
        {
            listed.Reverse();
        }

        var made = 0;
        var match = MachineMatcher.Match(
            listed, decisions.Select(d => new MatchDecision(ids[d.Device], ids[d.Other], d.Kind)).ToList(),
            () => Guid.Parse($"99999999-0000-0000-0000-{++made:D12}"));
        return (match, ids);
    }

    private static string Evidence(MachineEvidence found) => string.Join(' ',
        new[] { MachineEvidence.Serial, MachineEvidence.Mac, MachineEvidence.Name, MachineEvidence.SerialConflict }.Where(e => found.HasFlag(e)));

    private static Guid DeviceId(string label) => Guid.Parse($"00000000-0000-0000-0000-{(int)label[0]:D12}");

    private static Guid MachineId(string label) => Guid.Parse($"88888888-0000-0000-0000-{int.Parse(label[1..]):D12}");
}
