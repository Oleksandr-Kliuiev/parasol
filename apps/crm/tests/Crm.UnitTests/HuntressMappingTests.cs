using Crm.Integrations.Huntress;
using Crm.Security.Contracts;
using Crm.Service.Contracts;

namespace Crm.UnitTests;

/// <summary>
/// M41: Huntress's records in the CRM's words. An agent is a device the machine matcher can join with the computer's Atera agent
/// (serial, MACs, host name), online only while it called back within the hour, carrying the organization its actions are allowed
/// for and Huntress's view of Defender and isolation. Critical and high are critical, low a warning. Alert ids keep one space per
/// kind, an urgent incident asks for a person's confirmation when Huntress closes it, and a notice names a device only when it is
/// about exactly one agent. Synthetic data only.
/// </summary>
public sealed class HuntressMappingTests
{
    private static readonly DateTimeOffset Now = DateTimeOffset.Parse("2026-10-22T08:00:00Z");
    private static readonly Guid Customer = Guid.Parse("41414141-0000-0000-0000-000000000001");

    [Fact]
    public void An_agent_becomes_a_device_with_its_keys_its_organization_and_its_protection()
    {
        var device = HuntressMapping.Device(Agent(), "https://huntress.example.invalid/agents/{0}", Now);

        (device.ExternalId, device.MachineName, device.Type, device.Os, device.Online, device.LastSeenAt)
            .ShouldBe(("4420", "SRV-01", DeviceType.Server, "Windows Server 2022 Standard", true, (DateTimeOffset?)Now.AddMinutes(-59)));
        (device.Url, device.SerialNumber, device.AlternateId, device.Platform)
            .ShouldBe(("https://huntress.example.invalid/agents/4420", "VMW-4C4C4544-0042", "4410", "windows"),
                "the second id is the organization the agent reports under, which its actions are allowed for");
        device.MacAddresses.ShouldBe(["00:15:5d:01:02:03"]);
        device.Protection.ShouldBe(new DeviceProtectionReading("Unhealthy", "Real-time protection off", "Compliant", Now.AddHours(-3), "Disabled"));

        var inventory = device.Inventory!;
        (inventory.AgentVersion, inventory.OsBuild, inventory.PublicIp, inventory.DomainName).ShouldBe(("0.13.140", "20348", "198.51.100.10", "FJORD"));
        inventory.IpAddresses.ShouldBe(["10.0.0.10", "172.27.240.1"]);
        (inventory.Vendor, inventory.Model, inventory.Processor, inventory.Memory, inventory.LoggedInUsers, inventory.LastRebootAt)
            .ShouldBe(((string?)null, (string?)null, (string?)null, (int?)null, (string?)null, (DateTimeOffset?)null), "Huntress says nothing of the hardware or the users");
        inventory.Disks.ShouldBeEmpty();

        HuntressMapping.Device(Agent(), null, Now).Url.ShouldBeNull("no link is guessed while the template is empty");
    }

    [Theory]
    [InlineData(-59, true)]
    [InlineData(-60, true)]
    [InlineData(-61, false)]
    [InlineData(-60 * 24 * 3, false)]
    public void An_agent_is_online_while_it_called_back_within_the_hour(int minutes, bool online) =>
        HuntressMapping.Device(Agent() with { LastCallbackAt = Now.AddMinutes(minutes) }, null, Now).Online.ShouldBe(online);

    [Fact]
    public void An_agent_that_never_called_back_is_not_online()
    {
        var device = HuntressMapping.Device(Agent() with { LastCallbackAt = null }, null, Now);
        (device.Online, device.LastSeenAt).ShouldBe((false, (DateTimeOffset?)null));
    }

    [Theory]
    [InlineData("windows", "Windows Server 2022 Standard", "", DeviceType.Server)]
    [InlineData("windows", "Windows 11 Pro", "Server", DeviceType.Server)]
    [InlineData("windows", "Windows 2019 Domain Controller", "", DeviceType.Server)]
    [InlineData("windows", "Windows 11 Pro", "Production", DeviceType.Workstation)]
    [InlineData("darwin", "macOS 15.1", "", DeviceType.Workstation)]
    [InlineData("linux", "Ubuntu 24.04 LTS", "", DeviceType.Other)]
    [InlineData("linux", "Ubuntu 24.04 LTS", "web-server", DeviceType.Server)]
    [InlineData(null, null, "", DeviceType.Other)]
    public void The_type_of_a_computer_comes_from_its_system_and_its_tags(string? platform, string? os, string tag, DeviceType type) =>
        HuntressMapping.DeviceTypeOf(Agent() with { Platform = platform, Os = os, Tags = tag.Length == 0 ? [] : [tag] }).ShouldBe(type);

    [Theory]
    [InlineData("critical", AlertSeverity.Critical)]
    [InlineData("high", AlertSeverity.Critical)]
    [InlineData("low", AlertSeverity.Warning)]
    [InlineData("informational", AlertSeverity.Warning)]
    public void Critical_and_high_are_critical_and_everything_else_a_warning(string severity, AlertSeverity expected) =>
        HuntressMapping.Severity(severity).ShouldBe(expected);

    [Fact]
    public void Alert_ids_keep_one_space_per_kind_and_read_back()
    {
        HuntressMapping.IncidentAlertId(7001).ShouldBe("incident:7001");
        HuntressMapping.NoticeAlertId(NoticeKind.Escalation, 7002).ShouldBe("escalation:7002");
        HuntressMapping.NoticeAlertId(NoticeKind.PlatformAction, 7003).ShouldBe("platform-action:7003");
        HuntressMapping.ReadAlertId("incident:7001").ShouldBe(("incident", 7001L));
        HuntressMapping.ReadAlertId("escalation:7002").ShouldBe(("escalation", 7002L));
        HuntressMapping.ReadAlertId("platform-action:7003").ShouldBe(("platform-action", 7003L));
        HuntressMapping.Kind(HuntressNoticeKind.Escalation).ShouldBe(NoticeKind.Escalation);
        HuntressMapping.Kind(HuntressNoticeKind.PlatformAction).ShouldBe(NoticeKind.PlatformAction);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("incident")]
    [InlineData("incident:")]
    [InlineData("incident:0")]
    [InlineData("incident:-5")]
    [InlineData("incident: 5")]
    [InlineData("incident:5x")]
    [InlineData("Incident:5")]
    [InlineData("ticket:5")]
    [InlineData("incident:5:6")]
    [InlineData("atera.agent-silent:0199f1a0400070008000000000004001")]
    public void An_id_that_names_no_huntress_record_is_not_read(string? alertId) =>
        HuntressMapping.ReadAlertId(alertId).ShouldBeNull();

    [Theory]
    [InlineData("sent", true)]
    [InlineData("auto_remediating", true)]
    [InlineData("draft", true)]
    [InlineData("closed", false)]
    [InlineData("dismissed", false)]
    [InlineData("partner_dismissed", false)]
    [InlineData("deleting", false)]
    public void An_incident_is_open_while_the_partner_its_automation_or_the_soc_has_it(string status, bool open) =>
        HuntressMapping.IsOpen(status).ShouldBe(open);

    [Fact]
    public void An_open_incident_is_an_alert_that_asks_a_person_to_confirm_its_closing()
    {
        var alert = HuntressMapping.Alert(Incident(), Customer, "SRV-01", "https://huntress.example.invalid/incidents/{0}", Now);

        (alert.ExternalId, alert.OrganizationId, alert.Severity, alert.Title, alert.DeviceName)
            .ShouldBe(("incident:4430", Customer, AlertSeverity.Critical, "HIGH - Incident on SRV-01 (Fjord IT AS)", "SRV-01"));
        (alert.CreatedAt, alert.ExternalCustomerId, alert.Url).ShouldBe((Now.AddHours(-2), "4410", "https://huntress.example.invalid/incidents/4430"),
            "created when the SOC sent it, under its Huntress organization");
        (alert.DeviceExternalId, alert.DeviceAlternateId, alert.ConfirmClose).ShouldBe(("4420", (string?)null, true));

        HuntressMapping.Alert(Incident() with { SentAt = null, StatusUpdatedAt = null, UpdatedAt = Now.AddHours(-1) }, Customer, null, null, Now).CreatedAt
            .ShouldBe(Now.AddHours(-1));
        var bare = HuntressMapping.Alert(Incident() with { SentAt = null, StatusUpdatedAt = null, UpdatedAt = null, AgentId = null }, Customer, null, null, Now);
        (bare.CreatedAt, bare.DeviceExternalId, bare.Url).ShouldBe((Now, (string?)null, (string?)null));
    }

    [Fact]
    public void A_notice_names_a_device_only_when_it_is_about_exactly_one_agent()
    {
        var one = HuntressMapping.Alert(Notice([new HuntressEntity("Agent", "4420", "SRV-01"), new HuntressEntity("Identity", "id-1", "Kari Test")]), Customer, 4411, null);
        (one.ExternalId, one.DeviceName, one.DeviceExternalId, one.ExternalCustomerId, one.ConfirmClose)
            .ShouldBe(("escalation:4470", "SRV-01", "4420", "4411", false), "only an incident waits for a person when Huntress closes it");
        (one.Severity, one.Title, one.CreatedAt).ShouldBe((AlertSeverity.Critical, "Unexpected login from US", Now.AddDays(-1)));

        var two = HuntressMapping.Alert(Notice([new HuntressEntity("Agent", "1", "PC-1"), new HuntressEntity("agent", "2", "PC-2")]), Customer, 4410, null);
        (two.DeviceName, two.DeviceExternalId).ShouldBe(((string?)null, (string?)null), "two hosts are no one device");
        HuntressMapping.Alert(Notice([new HuntressEntity("Identity", "id-1", "Kari Test")]), Customer, 4410, null).DeviceName.ShouldBeNull();
        HuntressMapping.Alert(Notice(null), Customer, 4410, "https://huntress.example.invalid/e/4470").Url.ShouldBe("https://huntress.example.invalid/e/4470");
        HuntressMapping.Alert(Notice([new HuntressEntity("Agent", "3", null)]), Customer, 4410, null).DeviceName.ShouldBeNull("an agent without a name names no device");
    }

    [Fact]
    public void A_reading_carries_the_plan_and_the_comments_only_when_they_were_read()
    {
        var incident = Incident();
        var read = HuntressMapping.Reading(incident, Customer, "SRV-01", "https://huntress.example.invalid/incidents/{0}",
            incident.Remediations, [new HuntressComment(1, "Seen", "Tor Tekniker", Now, null)]);
        (read.Incident.System, read.Incident.ExternalId, read.Incident.OrganizationId, read.Incident.ExternalOrganizationId, read.Incident.AgentExternalId)
            .ShouldBe(("huntress", 4430L, Customer, 4410L, "4420"));
        (read.Incident.DeviceName, read.Incident.Url).ShouldBe(("SRV-01", "https://huntress.example.invalid/incidents/4430"));
        read.Remediations!.ShouldHaveSingleItem().ShouldBe(new ExternalRemediation(4441, "manual", "Delete File", null, "unapproved", null, null, null));
        read.Comments!.ShouldHaveSingleItem().ShouldBe(new ExternalIncidentComment(1, "Seen", "Tor Tekniker", Now, null));

        var reportOnly = HuntressMapping.Reading(incident, Customer, null, null, null, null);
        (reportOnly.Remediations, reportOnly.Comments).ShouldBe(((IReadOnlyList<ExternalRemediation>?)null, (IReadOnlyList<ExternalIncidentComment>?)null),
            "a list not read this time stays as stored");
    }

    [Fact]
    public void A_notice_keeps_entities_it_did_not_read_as_not_read()
    {
        var listed = HuntressMapping.Notice(Notice(null), Customer, null);
        (listed.Entities, listed.Kind, listed.OrganizationId).ShouldBe(((IReadOnlyList<NoticeEntity>?)null, NoticeKind.Escalation, (Guid?)Customer));
        HuntressMapping.Notice(Notice([new HuntressEntity("Agent", "4420", "SRV-01")]), null, null).Entities!
            .ShouldHaveSingleItem().ShouldBe(new NoticeEntity("Agent", "4420", "SRV-01"));
    }

    private static HuntressAgent Agent() => new(4420, 4410, "SRV-01", "windows", "Windows Server 2022 Standard", "0.13.140", Now.AddMinutes(-59))
    {
        SerialNumber = "VMW-4C4C4544-0042",
        MacAddresses = ["00:15:5d:01:02:03"],
        Ipv4Addresses = ["10.0.0.10", "172.27.240.1"],
        ExternalIp = "198.51.100.10",
        DomainName = "FJORD",
        OsBuildVersion = "20348",
        DefenderStatus = "Unhealthy",
        DefenderSubstatus = "Real-time protection off",
        DefenderPolicyStatus = "Compliant",
        LastSurveyAt = Now.AddHours(-3),
        FirewallStatus = "Disabled",
        Tags = ["Production"],
    };

    private static HuntressIncident Incident() => new(
        4430, 4410, 4420, "sent", "high", "HIGH - Incident on SRV-01 (Fjord IT AS)", "Synthetic summary", "<Content>", "windows", ["footholds"],
        new Dictionary<string, int> { ["footholds"] = 1 }, Now.AddHours(-2), null, Now.AddHours(-2), Now.AddMinutes(-30),
        [new HuntressRemediation(4441, "manual", "Delete File", null, "unapproved", null, null, null)], true);

    private static HuntressNotice Notice(IReadOnlyList<HuntressEntity>? entities) =>
        new(HuntressNoticeKind.Escalation, 4470, [4410, 4411], "open", "critical", "Unexpected login from US", "Unexpected Country Access",
            "unexpected_country_access", "US", Now.AddDays(-1), null, Now.AddHours(-1)) { Entities = entities };
}
