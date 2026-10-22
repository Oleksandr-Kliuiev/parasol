using Crm.Service.Contracts;
using Crm.Service.Domain;
using Crm.Service.Features;

namespace Crm.UnitTests;

/// <summary>
/// M41: an urgent alert of a source that asks for it (a critical Huntress incident) is not closed by the read that no longer lists it:
/// it stays open, marked closed at the source, until a person confirms. A warning closes as before, the source opening it again clears
/// the mark, and a read that may have missed something changes nothing. Synthetic data only.
/// </summary>
public sealed class AlertConfirmCloseTests
{
    private const string System = "huntress";
    private static readonly Guid Customer = Guid.Parse("42424242-0000-0000-0000-000000000001");
    private static readonly DateTimeOffset First = DateTimeOffset.Parse("2026-10-22T06:00:00Z");
    private static readonly AlertDeviceIndex NoDevices = new([]);

    [Fact]
    public void A_critical_alert_its_source_closed_stays_open_until_a_person_confirms()
    {
        var alert = Stored("incident:1", AlertSeverity.Critical);
        alert.NeedsConfirmedClose.ShouldBeTrue();

        var (_, result) = Apply(Complete([]), [alert], First.AddMinutes(5));
        result.ShouldBe(new AlertSnapshotResult(true, 0, 0, 0, 0, 1));
        result.Changed.ShouldBe(1, "waiting for a person is a change");
        (alert.State, alert.SourceClosedAt, alert.ResolvedAt).ShouldBe((AlertState.Open, (DateTimeOffset?)First.AddMinutes(5), (DateTimeOffset?)null));

        Apply(Complete([]), [alert], First.AddMinutes(10)).Result.ShouldBe(new AlertSnapshotResult(true, 0, 0, 0, 0, 0), "marked once");
        alert.SourceClosedAt.ShouldBe(First.AddMinutes(5), "the time the source closed it stays");

        alert.ConfirmClosed(First.AddMinutes(20)).ShouldBeTrue();
        (alert.State, alert.ResolvedAt, alert.SourceClosedAt).ShouldBe((AlertState.Resolved, (DateTimeOffset?)First.AddMinutes(20), (DateTimeOffset?)null));
        alert.ConfirmClosed(First.AddMinutes(30)).ShouldBeFalse("confirmed once");
    }

    [Fact]
    public void An_alert_the_source_opens_again_before_anyone_confirms_is_open_without_the_mark()
    {
        var alert = Stored("incident:1", AlertSeverity.Critical);
        Apply(Complete([]), [alert], First.AddMinutes(5));

        var (added, result) = Apply(Complete([Source("incident:1", AlertSeverity.Critical)]), [alert], First.AddMinutes(10));
        added.ShouldBeEmpty();
        result.ShouldBe(new AlertSnapshotResult(true, 0, 0, 1, 0, 0), "listed again: the mark goes, which is a change");
        (alert.State, alert.SourceClosedAt).ShouldBe((AlertState.Open, (DateTimeOffset?)null));
        alert.ConfirmClosed(First.AddMinutes(15)).ShouldBeFalse("nothing waits for a confirmation any more");
        alert.State.ShouldBe(AlertState.Open);
    }

    [Fact]
    public void A_read_that_began_before_an_alert_was_resolved_does_not_open_it_again_and_a_later_read_does()
    {
        // A person's close was read back and resolved the alert at +7 min; a read that began at +5 min still lists it.
        var alert = Stored("incident:1", AlertSeverity.Critical);
        alert.Resolve(First.AddMinutes(7)).ShouldBeTrue();

        var (_, stale) = Apply(Complete([Source("incident:1", AlertSeverity.Critical)]) with { ReadStartedAt = First.AddMinutes(5) }, [alert], First.AddMinutes(8));
        stale.ShouldBe(new AlertSnapshotResult(true, 0, 0, 0, 0, 0), "the read knew less than the resolution");
        (alert.State, alert.ResolvedAt).ShouldBe((AlertState.Resolved, (DateTimeOffset?)First.AddMinutes(7)));

        // A read that began after the resolution and still lists it is newer knowledge: the alert opens again, as always.
        var (_, later) = Apply(Complete([Source("incident:1", AlertSeverity.Critical)]) with { ReadStartedAt = First.AddMinutes(9) }, [alert], First.AddMinutes(10));
        later.Reopened.ShouldBe(1);
        alert.State.ShouldBe(AlertState.Open);
    }

    [Fact]
    public void A_warning_or_an_alert_that_does_not_ask_closes_by_itself_as_before()
    {
        var warning = Stored("incident:2", AlertSeverity.Warning);
        var escalation = Alert.Open(System, AlertKind.Security, Source("escalation:3", AlertSeverity.Critical, confirm: false), null, First);
        (warning.NeedsConfirmedClose, escalation.NeedsConfirmedClose).ShouldBe((false, false));

        var (_, result) = Apply(Complete([]), [warning, escalation], First.AddMinutes(5));

        result.ShouldBe(new AlertSnapshotResult(true, 0, 0, 0, 2, 0));
        (warning.State, warning.SourceClosedAt).ShouldBe((AlertState.Resolved, (DateTimeOffset?)null));
        escalation.State.ShouldBe(AlertState.Resolved);
    }

    [Fact]
    public void An_alert_that_became_a_warning_closes_by_itself()
    {
        var alert = Stored("incident:4", AlertSeverity.Critical);
        Apply(Complete([Source("incident:4", AlertSeverity.Warning)]), [alert], First.AddMinutes(5)).Result.Updated.ShouldBe(1);

        Apply(Complete([]), [alert], First.AddMinutes(10)).Result.Resolved.ShouldBe(1, "only an urgent one waits for a person");
        alert.State.ShouldBe(AlertState.Resolved);
    }

    [Fact]
    public void A_read_that_may_have_missed_something_neither_closes_nor_marks()
    {
        var alert = Stored("incident:5", AlertSeverity.Critical);
        var (_, result) = Apply(new AlertSnapshot(System, AlertKind.Security, [], [], IsComplete: false), [alert], First.AddMinutes(5));

        result.ShouldBe(AlertSnapshotResult.NotApplied);
        (alert.State, alert.SourceClosedAt).ShouldBe((AlertState.Open, (DateTimeOffset?)null));
    }

    [Fact]
    public void A_person_resolving_through_the_source_or_a_hidden_alert_still_follow_the_same_rules()
    {
        var alert = Stored("incident:6", AlertSeverity.Critical);
        alert.ConfirmClosed(First).ShouldBeFalse("the source has not closed it");
        alert.Resolve(First.AddMinutes(1)).ShouldBeTrue("an action asked from Parasoll resolves it directly");
        alert.SourceClosedAt.ShouldBeNull();

        var hidden = Stored("incident:7", AlertSeverity.Critical);
        hidden.Hide(First.AddDays(3), "Waiting for the customer", null, First);
        Apply(Complete([]), [hidden], First.AddMinutes(5)).Result.AwaitingConfirmation.ShouldBe(1);
        (hidden.State, hidden.IsHidden(First.AddMinutes(6))).ShouldBe((AlertState.Open, true), "a hidden alert keeps its hold while it waits");
    }

    private static (IReadOnlyList<Alert> Added, AlertSnapshotResult Result) Apply(AlertSnapshot snapshot, IReadOnlyCollection<Alert> stored, DateTimeOffset now) =>
        AlertSnapshotRules.Apply(snapshot, stored, NoDevices, now);

    private static AlertSnapshot Complete(IReadOnlyCollection<ExternalAlert> alerts) =>
        new(System, AlertKind.Security, alerts, alerts.Select(a => a.ExternalId).ToList(), IsComplete: true);

    private static Alert Stored(string id, AlertSeverity severity) => Alert.Open(System, AlertKind.Security, Source(id, severity), null, First);

    private static ExternalAlert Source(string id, AlertSeverity severity, bool confirm = true) =>
        new(id, Customer, severity, "HIGH - Incident on SRV-01 (Fjord IT AS)", "SRV-01", First.AddHours(-1), "4410", ConfirmClose: confirm);
}
