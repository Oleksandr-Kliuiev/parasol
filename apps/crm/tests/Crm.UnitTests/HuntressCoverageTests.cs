using Crm.Service.Contracts;
using Crm.Service.Features.Coverage;

namespace Crm.UnitTests;

/// <summary>
/// M41: the coverage rules that compare Atera with Huntress and read Huntress's agents. A machine watched by one source but not the
/// other is a gap once its agent is older than the grace period (never network equipment, a server critical). An agent is outdated
/// only while the newest version of its platform has run in the account longer than the limit, and only if it still calls back.
/// Defender is "off" only by Huntress's own words Unhealthy and Disabled, on Windows. Synthetic data only.
/// </summary>
public sealed class HuntressCoverageTests
{
    private static readonly DateTimeOffset Now = DateTimeOffset.Parse("2026-10-22T01:30:00Z");
    private static readonly Guid Customer = Guid.Parse("43434343-0000-0000-0000-000000000001");
    private static readonly Guid OtherCustomer = Guid.Parse("43434343-0000-0000-0000-000000000002");

    [Fact]
    public void A_machine_atera_watches_without_huntress_is_a_gap_once_its_agent_is_older_than_the_grace_period()
    {
        var watched = Machine(1);
        var both = Machine(2);
        var fresh = Machine(3);
        var switchGear = Machine(4);
        var server = Machine(5);
        var devices = new[]
        {
            Device(11, watched, "atera", "PC-17", firstSeen: Now.AddDays(-5)),
            Device(12, watched, "atera", "PC-17", firstSeen: Now.AddDays(-9)),
            Device(21, both, "atera", "PC-21", firstSeen: Now.AddDays(-30)),
            Device(22, both, "huntress", "PC-21", firstSeen: Now.AddDays(-30)),
            Device(31, fresh, "atera", "PC-NEW", firstSeen: Now.AddDays(-1)),
            Device(41, switchGear, "atera", "SW-CORE", type: DeviceType.Network, firstSeen: Now.AddDays(-60)),
            Device(51, server, "atera", "SRV-01", type: DeviceType.Server, firstSeen: Now.AddDays(-60)),
            Device(61, null, "atera", "UNMATCHED", firstSeen: Now.AddDays(-60)),
        };

        var findings = HuntressCoverage.Missing(devices, "atera", "huntress", Now.AddDays(-2), (name, since) => $"{name} since {since:yyyy-MM-dd}");

        findings.Select(f => f.Subject).ShouldBe([watched.ToString("N"), server.ToString("N")], ignoreOrder: true,
            "both agents, a new machine in its grace period, network equipment and a device without a machine are no gap");
        var pc = findings.Single(f => f.Subject == watched.ToString("N"));
        (pc.OrganizationId, pc.Severity, pc.DeviceName, pc.DeviceId, pc.Title)
            .ShouldBe((Customer, AlertSeverity.Warning, "PC-17", (Guid?)Id(12), $"PC-17 since {Now.AddDays(-9):yyyy-MM-dd}"),
                "the machine's earliest agent of the source speaks for it");
        pc.Facts.ShouldBe(new Dictionary<string, string> { ["device"] = "PC-17", ["since"] = Now.AddDays(-9).ToString("O", System.Globalization.CultureInfo.InvariantCulture) });
        findings.Single(f => f.Subject == server.ToString("N")).Severity.ShouldBe(AlertSeverity.Critical, "an unwatched server is critical");
    }

    [Fact]
    public void A_machine_huntress_watches_without_atera_is_found_the_same_way_the_other_way_round()
    {
        var machine = Machine(7);
        var devices = new[]
        {
            Device(71, machine, "huntress", "PC-71", firstSeen: Now.AddDays(-3)),
            Device(81, Machine(8), "huntress", "PC-81", firstSeen: Now.AddDays(-3)),
            Device(82, Machine(8), "atera", "PC-81", firstSeen: Now.AddDays(-3)),
        };

        HuntressCoverage.Missing(devices, "huntress", "atera", Now.AddDays(-2), (name, _) => name)
            .ShouldHaveSingleItem().Subject.ShouldBe(machine.ToString("N"));
        HuntressCoverage.Missing(devices, "huntress", "atera", Now.AddDays(-4), (name, _) => name)
            .ShouldBeEmpty("an agent known for exactly the grace period or less is still new");
    }

    [Fact]
    public void An_agent_is_outdated_once_the_newest_version_of_its_platform_has_run_longer_than_the_limit()
    {
        var account = new[]
        {
            Device(1, Machine(1), "huntress", "PC-NEW-1", platform: "windows", version: "0.13.140", versionSince: Now.AddDays(-20), lastSeen: Now),
            Device(2, Machine(2), "huntress", "PC-NEW-2", platform: "windows", version: "0.13.140", versionSince: Now.AddDays(-30), lastSeen: Now, organization: OtherCustomer),
            Device(3, Machine(3), "huntress", "PC-OLD", platform: "windows", version: "0.13.120", versionSince: Now.AddDays(-90), lastSeen: Now.AddHours(-1)),
            Device(4, Machine(4), "huntress", "PC-SILENT", platform: "windows", version: "0.13.100", versionSince: Now.AddDays(-90), lastSeen: Now.AddDays(-20)),
            Device(5, Machine(5), "huntress", "PC-ELSEWHERE", platform: "windows", version: "0.13.120", versionSince: Now.AddDays(-90), lastSeen: Now, organization: OtherCustomer),
            Device(6, Machine(6), "huntress", "PC-TAG", platform: "windows", version: "build-7", versionSince: Now.AddDays(-90), lastSeen: Now),
            Device(7, Machine(7), "huntress", "PC-UNKNOWN", platform: null, version: "0.10.0", versionSince: Now.AddDays(-90), lastSeen: Now),
        };

        var finding = HuntressCoverage.Outdated(account, [Customer], Now, 14).ShouldHaveSingleItem(
            "the silent agent is left to its own rule, another customer's agent to its customer, a version that is no number to no one");
        (finding.Subject, finding.OrganizationId, finding.Severity, finding.DeviceId).ShouldBe((Id(3).ToString("N"), Customer, AlertSeverity.Warning, (Guid?)Id(3)));
        finding.Facts.ShouldBe(new Dictionary<string, string>
        {
            ["device"] = "PC-OLD",
            ["version"] = "0.13.120",
            ["newest"] = "0.13.140",
            ["since"] = Now.AddDays(-30).ToString("O", System.Globalization.CultureInfo.InvariantCulture),
        }, "the newest version counts from the first device read with it, whichever customer it belongs to");
        finding.Title.ShouldContain("0.13.140");

        HuntressCoverage.Outdated(account, [Customer], Now, 31).ShouldBeEmpty("the newest version has not run longer than 31 days");
        HuntressCoverage.Outdated(account, [OtherCustomer], Now, 14).ShouldHaveSingleItem().DeviceName.ShouldBe("PC-ELSEWHERE");
    }

    [Fact]
    public void Versions_are_compared_as_numbers_within_one_platform_and_a_missing_number_counts_as_zero()
    {
        var account = new[]
        {
            Device(1, Machine(1), "huntress", "MAC-A", platform: "darwin", version: "1.2", versionSince: Now.AddDays(-30), lastSeen: Now),
            Device(2, Machine(2), "huntress", "MAC-B", platform: "darwin", version: "1.2.0", versionSince: Now.AddDays(-30), lastSeen: Now),
            Device(3, Machine(3), "huntress", "MAC-C", platform: "darwin", version: "1.1.9", versionSince: Now.AddDays(-60), lastSeen: Now),
            Device(4, Machine(4), "huntress", "PC-A", platform: "windows", version: "0.13.140", versionSince: Now.AddDays(-30), lastSeen: Now),
            Device(5, Machine(5), "huntress", "PC-B", platform: "windows", version: "0.13.99", versionSince: Now.AddDays(-60), lastSeen: Now),
        };

        HuntressCoverage.Outdated(account, [Customer], Now, 14).Select(f => f.DeviceName).ShouldBe(["MAC-C", "PC-B"], ignoreOrder: true,
            "1.2 and 1.2.0 are one version, 0.13.99 is older than 0.13.140, and a Mac is never compared with Windows");

        HuntressCoverage.Version("0.13.140").ShouldBe([0, 13, 140]);
        HuntressCoverage.Version(" v1.2.3 ").ShouldBe([1, 2, 3]);
        HuntressCoverage.Version("0.13.x").ShouldBeNull();
        HuntressCoverage.Version("1..2").ShouldBeNull();
        HuntressCoverage.Version("-1.2").ShouldBeNull();
        HuntressCoverage.Version(" ").ShouldBeNull();
        HuntressCoverage.Version(null).ShouldBeNull();
    }

    [Fact]
    public void A_newest_version_without_a_known_start_raises_nothing()
    {
        var account = new[]
        {
            Device(1, Machine(1), "huntress", "PC-NEW", platform: "windows", version: "0.13.140", versionSince: null, lastSeen: Now),
            Device(2, Machine(2), "huntress", "PC-OLD", platform: "windows", version: "0.13.120", versionSince: Now.AddDays(-90), lastSeen: Now),
        };

        HuntressCoverage.Outdated(account, [Customer], Now, 14).ShouldBeEmpty("how long the newest version has run is unknown");
    }

    [Theory]
    [InlineData("Unhealthy", true)]
    [InlineData("unhealthy", true)]
    [InlineData("DISABLED", true)]
    [InlineData("Healthy", false)]
    [InlineData("Unmanaged", false)]
    [InlineData("Protected", false)]
    [InlineData(null, false)]
    public void Defender_is_off_only_by_huntress_s_own_words(string? status, bool off) =>
        HuntressCoverage.DefenderOff([Device(1, Machine(1), "huntress", "PC-1", platform: "windows", antivirus: status)]).Count.ShouldBe(off ? 1 : 0);

    [Fact]
    public void Defender_off_names_its_words_and_a_server_is_critical()
    {
        var devices = new[]
        {
            Device(1, Machine(1), "huntress", "SRV-01", type: DeviceType.Server, platform: "windows", antivirus: "Unhealthy",
                substatus: "Real-time protection off", reportedAt: Now.AddHours(-3)),
            Device(2, Machine(2), "huntress", "PC-2", platform: null, antivirus: "Disabled"),
            Device(3, Machine(3), "huntress", "MAC-3", platform: "darwin", antivirus: "Unhealthy"),
        };

        var findings = HuntressCoverage.DefenderOff(devices);

        findings.Select(f => f.DeviceName).ShouldBe(["SRV-01", "PC-2"], "Defender is Windows's: a Mac is not asked about it");
        var server = findings[0];
        (server.Subject, server.Severity, server.Title)
            .ShouldBe((Id(1).ToString("N"), AlertSeverity.Critical, "Microsoft Defender does not protect SRV-01: Unhealthy (Real-time protection off)"));
        server.Facts.ShouldBe(new Dictionary<string, string>
        {
            ["device"] = "SRV-01",
            ["status"] = "Unhealthy",
            ["substatus"] = "Real-time protection off",
            ["reportedAt"] = Now.AddHours(-3).ToString("O", System.Globalization.CultureInfo.InvariantCulture),
        });
        findings[1].Severity.ShouldBe(AlertSeverity.Warning);
        findings[1].Facts.ShouldBe(new Dictionary<string, string> { ["device"] = "PC-2", ["status"] = "Disabled" }, "facts it does not have are not named");
    }

    private static Guid Id(int n) => Guid.Parse($"43434343-0000-0000-0000-{n:D12}");

    private static Guid Machine(int n) => Guid.Parse($"43434343-1111-0000-0000-{n:D12}");

    private static CoverageDevice Device(
        int id, Guid? machine, string system, string name, DeviceType type = DeviceType.Workstation, DateTimeOffset? firstSeen = null,
        string? platform = "windows", string? version = null, DateTimeOffset? versionSince = null, DateTimeOffset? lastSeen = null,
        Guid? organization = null, string? antivirus = null, string? substatus = null, DateTimeOffset? reportedAt = null) =>
        new(Id(id), organization ?? Customer, machine, system, name, type, platform, version, versionSince, antivirus, substatus, reportedAt,
            lastSeen ?? Now, firstSeen ?? Now.AddDays(-100));
}
