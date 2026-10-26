using Crm.Service.Contracts;
using Crm.Service.Domain;
using Crm.Service.Features;

namespace Crm.UnitTests;

/// <summary>
/// M40: an alert hidden in Parasoll is hidden until its time and no longer, its source's state stays as the source says, and a new
/// occurrence (a resolved alert listed open again) is not hidden by what someone decided about the last one. Synthetic data only.
/// </summary>
public sealed class AlertHidingDomainTests
{
    private static readonly Guid Customer = Guid.Parse("33333333-0000-0000-0000-000000000001");
    private static readonly DateTimeOffset Now = DateTimeOffset.Parse("2026-10-22T08:00:00Z");

    [Fact]
    public void A_hidden_alert_is_hidden_until_its_time_and_keeps_its_source_state()
    {
        var alert = Open();
        alert.Hide(Now.AddDays(2), "Waiting for a part", Guid.NewGuid(), Now);

        alert.IsHidden(Now).ShouldBeTrue();
        alert.IsHidden(Now.AddDays(2)).ShouldBeFalse("it comes back at the start of its day by itself");
        alert.State.ShouldBe(AlertState.Open);
        (alert.Hold!.Id, alert.Hold.Reason, alert.Hold.At).ShouldBe((alert.Id, "Waiting for a part", (DateTimeOffset?)Now), "the hold shares the alert's id");
    }

    [Fact]
    public void Showing_again_clears_the_hold_and_an_alert_not_hidden_is_not_shown_again()
    {
        var alert = Open();
        alert.Unhide(Now).ShouldBeFalse();
        alert.Hide(Now.AddDays(1), "Later", null, Now);

        alert.Unhide(Now).ShouldBeTrue();
        (alert.Hold!.Until, alert.Hold.Reason, alert.Hold.By).ShouldBe((null, null, null));
        alert.IsHidden(Now).ShouldBeFalse();
    }

    [Fact]
    public void A_resolved_alert_listed_open_again_is_a_new_occurrence_and_not_hidden()
    {
        var alert = Open();
        alert.Hide(Now.AddDays(5), "Known issue", null, Now);
        alert.Resolve(Now.AddHours(1));
        alert.IsHidden(Now.AddHours(2)).ShouldBeFalse("a resolved alert is not hidden");

        alert.Observe(AlertKind.Monitoring, Source(), null, Now.AddHours(3)).ShouldBe(AlertChange.Reopened);
        alert.Hold!.Until.ShouldBeNull();
        alert.IsHidden(Now.AddHours(3)).ShouldBeFalse();
    }

    [Fact]
    public void An_open_list_leaves_out_what_is_hidden_now_and_the_hidden_list_has_just_that()
    {
        var hidden = Open();
        hidden.Hide(Now.AddDays(1), "Later", null, Now);
        var expired = Open();
        expired.Hide(Now.AddMinutes(-1), "Was later", null, Now.AddDays(-1));
        var plain = Open();
        var all = new[] { hidden, expired, plain }.AsQueryable();

        all.Where(AlertVisibility.OpenNow(Now)).ShouldBe([expired, plain], ignoreOrder: true);
        all.Where(AlertVisibility.HiddenNow(Now)).ShouldBe([hidden]);
    }

    private static ExternalAlert Source() => new($"a-{Guid.NewGuid():N}", Customer, AlertSeverity.Critical, "Disk almost full", "SRV-01", Now.AddHours(-1), "501");

    private static Alert Open() => Alert.Open("atera", AlertKind.Monitoring, Source(), null, Now);
}
