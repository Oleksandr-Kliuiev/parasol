using Crm.Notifications.Contracts;
using Crm.Notifications.Domain;
using Crm.Notifications.Features;
using Crm.Service.Contracts;
using Crm.Service.Domain;
using Crm.Service.Features;
using Crm.Service.Features.Coverage;

namespace Crm.UnitTests;

/// <summary>
/// M43: an alert announces when it becomes urgent — stored as critical, opened again as critical, or a warning turned critical — and
/// never on a re-read; the notice for the operations channel keeps ids and codes, one per alert and Norwegian day, and its card is
/// worded in bokmål or English when it is sent. Synthetic data only.
/// </summary>
public sealed class UrgentAlertNoticeTests
{
    private const string System = "atera";
    private static readonly Guid Customer = Guid.Parse("43434343-0000-0000-0000-000000000001");
    private static readonly DateTimeOffset First = DateTimeOffset.Parse("2026-10-21T08:00:00Z");
    private static readonly AlertDeviceIndex NoDevices = new([]);

    [Fact]
    public void A_new_critical_alert_announces_itself_once_and_a_new_warning_does_not()
    {
        var (added, _) = AlertSnapshotRules.Apply(Complete(Source("c1"), Source("w1", AlertSeverity.Warning)), [], NoDevices, First);

        var critical = added.Single(a => a.ExternalId == "c1");
        Urgent(critical).ShouldBe([critical.Id]);
        added.Single(a => a.ExternalId == "w1").DomainEvents.ShouldBeEmpty();
    }

    [Fact]
    public void A_re_read_of_an_alert_that_is_urgent_already_announces_nothing()
    {
        var alert = Stored("1");
        alert.ClearDomainEvents();

        AlertSnapshotRules.Apply(Complete(Source("1", title: "Disk full now")), [alert], NoDevices, First.AddMinutes(30)).Result.Updated.ShouldBe(1);

        Urgent(alert).ShouldBeEmpty("the alert was open and critical before the read");
    }

    [Fact]
    public void A_resolved_critical_alert_listed_open_again_announces_itself_again()
    {
        var alert = Stored("1");
        AlertSnapshotRules.Apply(Complete(), [alert], NoDevices, First.AddHours(1)).Result.Resolved.ShouldBe(1);
        alert.ClearDomainEvents();

        AlertSnapshotRules.Apply(Complete(Source("1")), [alert], NoDevices, First.AddHours(2)).Result.Reopened.ShouldBe(1);

        Urgent(alert).ShouldBe([alert.Id]);
    }

    [Fact]
    public void A_warning_that_turns_critical_announces_itself_and_one_that_turns_back_does_not()
    {
        var alert = Alert.Open(System, AlertKind.Monitoring, Source("1", AlertSeverity.Warning), null, First);
        Urgent(alert).ShouldBeEmpty();

        alert.Observe(AlertKind.Monitoring, Source("1"), null, First.AddMinutes(5));
        Urgent(alert).ShouldBe([alert.Id]);
        alert.ClearDomainEvents();

        alert.Observe(AlertKind.Monitoring, Source("1", AlertSeverity.Warning), null, First.AddMinutes(10));
        Urgent(alert).ShouldBeEmpty("a downgrade is no news for the channel");
    }

    [Fact]
    public void A_critical_coverage_gap_announces_itself_when_found_and_when_found_again_after_it_closed()
    {
        const string rule = "huntress.agent-missing";
        var gap = CoverageGapRules.Apply(rule, AlertKind.Security, [Finding()], [], First).Added.Single();
        Urgent(gap).ShouldBe([gap.Id]);
        gap.ClearDomainEvents();

        CoverageGapRules.Apply(rule, AlertKind.Security, [Finding()], [gap], First.AddDays(1));
        Urgent(gap).ShouldBeEmpty("found again while open");

        CoverageGapRules.Apply(rule, AlertKind.Security, [], [gap], First.AddDays(2));
        CoverageGapRules.Apply(rule, AlertKind.Security, [], [gap], First.AddDays(3));
        gap.State.ShouldBe(AlertState.Resolved);
        CoverageGapRules.Apply(rule, AlertKind.Security, [Finding()], [gap], First.AddDays(4));
        Urgent(gap).ShouldBe([gap.Id]);
    }

    [Fact]
    public void An_alert_is_urgent_while_it_is_open_critical_and_not_hidden()
    {
        var alert = Ref();
        alert.IsUrgentAt(First).ShouldBeTrue();
        (alert with { HiddenUntil = First.AddDays(1) }).IsUrgentAt(First).ShouldBeFalse();
        (alert with { HiddenUntil = First.AddDays(-1) }).IsUrgentAt(First).ShouldBeTrue("the day it was hidden until has come");
        (alert with { State = AlertState.Resolved }).IsUrgentAt(First).ShouldBeFalse();
        (alert with { Severity = AlertSeverity.Warning }).IsUrgentAt(First).ShouldBeFalse();
    }

    [Fact]
    public void A_notice_keeps_ids_and_codes_and_its_key_carries_the_Norwegian_day()
    {
        var alert = Ref(title: "Kari Nordmann logged in from Lagos", system: "huntress", kind: AlertKind.Security);
        var parameters = UrgentAlertNotices.Parameters(alert);

        parameters.Keys.ShouldBe(["alertId", "organizationId", "system", "kind", "severity"], ignoreOrder: true);
        parameters.Values.ShouldNotContain(v => v.Contains("Kari", StringComparison.Ordinal) || v.Contains("SRV-01", StringComparison.Ordinal));
        (parameters["system"], parameters["kind"], parameters["severity"]).ShouldBe(("huntress", "Security", "Critical"));
        UrgentAlertNotices.Parameters(Ref(system: CoverageGaps.System, rule: "huntress.agent-missing"))["rule"].ShouldBe("huntress.agent-missing");

        // 22:30 UTC on 22 October is half past midnight on 23 October in Oslo.
        UrgentAlertNotices.DedupeKey(alert.Id, DateTimeOffset.Parse("2026-10-22T22:30:00Z")).ShouldBe($"urgent-alert:{alert.Id:N}:2026-10-23");
        UrgentAlertNotices.DedupeKey(alert.Id, DateTimeOffset.Parse("2026-10-22T21:30:00Z")).ShouldBe($"urgent-alert:{alert.Id:N}:2026-10-22");
    }

    [Fact]
    public void A_notice_is_queued_with_its_kind_and_parameters_and_no_card()
    {
        var parameters = new Dictionary<string, string> { ["system"] = "atera", ["alertId"] = Guid.Empty.ToString("D") };
        var post = ChannelPost.Notice(TeamsChannel.Operations, ChannelPostKind.UrgentAlert, parameters, "urgent-alert:x:2026-10-23", First);

        (post.Kind, post.Channel, post.Status, post.DedupeKey, post.CardJson).ShouldBe(
            (ChannelPostKind.UrgentAlert, TeamsChannel.Operations, ChannelPostStatus.Pending, "urgent-alert:x:2026-10-23", "{}"));
        post.Parameters.ShouldBe(parameters, ignoreOrder: true);
        post.ParametersJson.ShouldBe("""{"alertId":"00000000-0000-0000-0000-000000000000","system":"atera"}""", "sorted, so the same notice reads the same");
        ChannelPost.For(TeamsChannel.Sales, new TeamsCard("T", "X", [], null, null), First).Kind.ShouldBeNull();
    }

    [Fact]
    public void An_urgent_alert_card_names_the_customer_the_source_the_device_and_when_it_opened()
    {
        var card = UrgentAlertNotices.Card(Ref(), "Fjord IT AS", "nb", "https://crm.example/alerts?alert=1");

        card.ShouldBe(new TeamsCard("Kritisk driftsvarsel for Fjord IT AS", "Disk almost full",
            [new TeamsFact("Kilde", "Atera"), new TeamsFact("Enhet", "SRV-01"), new TeamsFact("Åpnet", "21.10.2026 10:00")],
            "https://crm.example/alerts?alert=1", "Åpne i Parasoll"), new CardComparer());

        var english = UrgentAlertNotices.Card(Ref() with { DeviceName = null }, null, "en", null);
        english.ShouldBe(new TeamsCard("Critical alert", "Disk almost full", [new TeamsFact("Source", "Atera"), new TeamsFact("Opened", "21.10.2026 10:00")],
            null, "Open in Parasoll"), new CardComparer());
        UrgentAlertNotices.Card(Ref(), "Fjord IT AS", "nn", null).Title.ShouldBe("Kritisk driftsvarsel for Fjord IT AS", "a nynorsk channel gets bokmål");
    }

    [Fact]
    public void A_gap_card_names_its_rule_instead_of_the_stored_english_sentence()
    {
        var gap = Ref(system: CoverageGaps.System, rule: "huntress.agent-missing", title: "SRV-01 has an Atera agent but no Huntress agent");

        UrgentAlertNotices.Card(gap, "Fjord IT AS", "nb", null).Text.ShouldBe("Enhet uten Huntress");
        UrgentAlertNotices.Card(gap, "Fjord IT AS", "en", null).Text.ShouldBe("Device without Huntress");
        UrgentAlertNotices.Card(gap, null, "nb", null).Facts[0].ShouldBe(new TeamsFact("Kilde", "Parasoll"));
        UrgentAlertNotices.Card(gap with { Rule = "new.rule" }, null, "en", null).Text.ShouldBe("Coverage gap found by Parasoll");
        UrgentAlertNotices.RuleName("cloudally.backup-failed", nb: true).ShouldBe("Sikkerhetskopi som feilet (CloudAlly)");
    }

    [Fact]
    public void Every_kind_of_alert_is_announced_unless_the_settings_name_some()
    {
        var all = new UrgentAlertOptions();
        Enum.GetValues<AlertKind>().ShouldAllBe(kind => all.Covers(kind));

        var security = new UrgentAlertOptions { Kinds = [AlertKind.Security] };
        (security.Covers(AlertKind.Security), security.Covers(AlertKind.Monitoring), security.Covers(AlertKind.Backup)).ShouldBe((true, false, false));
    }

    [Theory]
    [InlineData("no channel")]
    [InlineData("switched off")]
    [InlineData("other kind")]
    [InlineData("resolved")]
    [InlineData("hidden")]
    public async Task The_handler_queues_nothing_without_a_channel_a_switch_or_an_alert_urgent_now(string why)
    {
        var options = new TeamsNotificationOptions { UrgentAlerts = { Enabled = why != "switched off", Kinds = why == "other kind" ? [AlertKind.Security] : [] } };
        var alert = why switch
        {
            "resolved" => Ref() with { State = AlertState.Resolved },
            "hidden" => Ref() with { HiddenUntil = First.AddDays(1) },
            _ => Ref(),
        };
        var service = AlertReader.For(why is "no channel" or "switched off" ? null : alert);

        // No database: a handler that went on to queue a notice would fail here.
        var handler = new UrgentAlertTeamsHandler(new Channel(configured: why != "no channel"), service, null!,
            new FixedTime(First), Microsoft.Extensions.Options.Options.Create(options));
        await handler.HandleAsync(new AlertBecameUrgent(alert.Id), TestContext.Current.CancellationToken);
    }

    /// <summary>The alerts an alert's events announce as urgent; an alert raises no other event, so this is every event it raised.</summary>
    private static Guid[] Urgent(Alert alert)
    {
        alert.DomainEvents.ShouldAllBe(e => e is AlertBecameUrgent);
        return [.. alert.DomainEvents.OfType<AlertBecameUrgent>().Select(e => e.AlertId)];
    }

    private static AlertSnapshot Complete(params IReadOnlyCollection<ExternalAlert> alerts) =>
        new(System, AlertKind.Monitoring, alerts, alerts.Select(a => a.ExternalId).ToList(), IsComplete: true);

    private static Alert Stored(string id) => Alert.Open(System, AlertKind.Monitoring, Source(id), null, First);

    private static ExternalAlert Source(string id, AlertSeverity severity = AlertSeverity.Critical, string title = "Disk almost full") =>
        new(id, Customer, severity, title, "SRV-01", First, "501");

    private static CoverageFinding Finding() => new(
        "srv-01", Customer, AlertSeverity.Critical, "SRV-01 has an Atera agent but no Huntress agent", "SRV-01", null,
        new Dictionary<string, string> { ["device"] = "SRV-01" });

    private static AlertRef Ref(string system = System, AlertKind kind = AlertKind.Monitoring, string title = "Disk almost full", string? rule = null) =>
        new(Guid.Parse("43434343-0000-0000-0000-0000000000a1"), Customer, system, kind, "1", "501", title, AlertSeverity.Critical, AlertState.Open,
            "SRV-01", null, First, null, Rule: rule);

    private sealed class Channel(bool configured) : ITeamsChannelSender
    {
        public bool IsConfigured(TeamsChannel channel) => configured && channel == TeamsChannel.Operations;

        public Task SendAsync(TeamsChannel channel, TeamsCard card, CancellationToken cancellationToken) =>
            throw new InvalidOperationException("A handler never sends.");
    }

    private sealed class FixedTime(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }

    /// <summary>
    /// The Service API as the handler uses it: one alert by id. Without an alert any call fails, so a test shows the handler stopped
    /// before reading.
    /// </summary>
    public class AlertReader : System.Reflection.DispatchProxy
    {
        private AlertRef? _alert;

        public static IServiceApi For(AlertRef? alert)
        {
            var proxy = Create<IServiceApi, AlertReader>();
            ((AlertReader)(object)proxy)._alert = alert;
            return proxy;
        }

        protected override object? Invoke(System.Reflection.MethodInfo? targetMethod, object?[]? args) =>
            _alert is not null && targetMethod?.Name == nameof(IServiceApi.GetAlertAsync) && args?[0] is Guid
                ? Task.FromResult<AlertRef?>(_alert)
                : throw new InvalidOperationException($"The handler should not call {targetMethod?.Name} here.");
    }

    /// <summary>A card's facts are a list, which records compare by reference.</summary>
    private sealed class CardComparer : IEqualityComparer<TeamsCard>
    {
        public bool Equals(TeamsCard? x, TeamsCard? y) =>
            x is not null && y is not null && x.Title == y.Title && x.Text == y.Text && x.Link == y.Link && x.LinkText == y.LinkText &&
            x.Facts.SequenceEqual(y.Facts);

        public int GetHashCode(TeamsCard obj) => obj.Title.GetHashCode(StringComparison.Ordinal);
    }
}
