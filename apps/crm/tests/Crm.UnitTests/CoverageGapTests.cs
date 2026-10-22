using Crm.Service.Contracts;
using Crm.Service.Domain;
using Crm.Service.Features.Coverage;

namespace Crm.UnitTests;

/// <summary>
/// M40: a coverage gap the CRM finds keeps one alert while it lasts, closes only after two complete checks in a row that no longer
/// find it, opens again as a new occurrence, and keeps its facts in a fixed order. Synthetic data only.
/// </summary>
public sealed class CoverageGapTests
{
    private const string Rule = "atera.agent-silent";
    private static readonly Guid Customer = Guid.Parse("44444444-0000-0000-0000-000000000001");
    private static readonly Guid Device = Guid.Parse("44444444-0000-0000-0000-0000000000d1");
    private static readonly DateTimeOffset Now = DateTimeOffset.Parse("2026-10-22T01:30:00Z");

    [Fact]
    public void A_finding_opens_a_gap_of_the_crm_and_the_next_finding_keeps_the_same_gap()
    {
        var (added, first) = Check([Finding()], [], Now);
        first.ShouldBe(new CoverageCheckResult(1, 1, 1, 0, 0));
        var gap = added.ShouldHaveSingleItem();
        (gap.System, gap.ExternalId, gap.Rule, gap.Kind, gap.State, gap.Severity).ShouldBe(
            (CoverageGaps.System, $"{Rule}:{Device:N}", Rule, AlertKind.Monitoring, AlertState.Open, AlertSeverity.Critical));
        (gap.OrganizationId, gap.ExternalCustomerId, gap.DeviceId, gap.CreatedAtSource).ShouldBe((Customer, Customer.ToString("N"), (Guid?)Device, Now));
        CoverageGaps.ReadFacts(gap.Facts).ShouldBe(new Dictionary<string, string> { ["device"] = "SRV-01", ["lastSeenAt"] = "2026-10-12T08:00:00.0000000+00:00" });
        gap.Hold.ShouldNotBeNull("a person may hide a gap like any alert");

        var (again, second) = Check([Finding()], [gap], Now.AddDays(1));
        again.ShouldBeEmpty();
        second.ShouldBe(new CoverageCheckResult(1, 1, 0, 0, 0));
        (gap.State, gap.CreatedAtSource, gap.LastSeenAt).ShouldBe((AlertState.Open, Now, (DateTimeOffset?)Now.AddDays(1)), "found when it began, seen at every check");
    }

    [Fact]
    public void An_open_gap_closes_only_after_two_clean_checks_in_a_row()
    {
        var gap = Check([Finding()], [], Now).Added.Single();

        Check([], [gap], Now.AddDays(1)).Result.Resolved.ShouldBe(0, "one clean check is not enough");
        (gap.State, gap.CleanChecks).ShouldBe((AlertState.Open, 1));
        Check([Finding()], [gap], Now.AddDays(2)).Result.ShouldBe(new CoverageCheckResult(1, 1, 0, 0, 0));
        gap.CleanChecks.ShouldBe(0, "found again: the count starts over");

        Check([], [gap], Now.AddDays(3)).Result.Resolved.ShouldBe(0);
        Check([], [gap], Now.AddDays(4)).Result.Resolved.ShouldBe(1);
        (gap.State, gap.ResolvedAt).ShouldBe((AlertState.Resolved, (DateTimeOffset?)Now.AddDays(4)));
        Check([], [gap], Now.AddDays(5)).Result.Resolved.ShouldBe(0, "closed once");
    }

    [Fact]
    public void A_closed_gap_found_again_opens_as_a_new_occurrence_and_is_not_hidden_by_the_last_one()
    {
        var gap = Check([Finding()], [], Now).Added.Single();
        gap.Hide(Now.AddDays(30), "Server is being replaced", null, Now);
        Check([Finding()], [gap], Now.AddDays(1)).Result.Opened.ShouldBe(0);
        gap.IsHidden(Now.AddDays(1)).ShouldBeTrue("a gap found again while hidden stays hidden");
        Check([], [gap], Now.AddDays(2));
        Check([], [gap], Now.AddDays(3));
        gap.State.ShouldBe(AlertState.Resolved);

        Check([Finding()], [gap], Now.AddDays(4)).Result.ShouldBe(new CoverageCheckResult(1, 1, 0, 1, 0));
        (gap.State, gap.CreatedAtSource, gap.ResolvedAt).ShouldBe((AlertState.Open, Now.AddDays(4), (DateTimeOffset?)null));
        gap.IsHidden(Now.AddDays(4)).ShouldBeFalse();
    }

    [Fact]
    public void Facts_keep_a_fixed_order_and_are_left_out_when_they_do_not_fit()
    {
        var shuffled = Finding() with { Facts = new Dictionary<string, string> { ["lastSeenAt"] = "x", ["device"] = "SRV-01" } };
        CoverageGapRules.Facts(shuffled).ShouldBe("""{"device":"SRV-01","lastSeenAt":"x"}""");
        CoverageGapRules.Facts(Finding() with { Facts = new Dictionary<string, string> { ["device"] = new string('a', Alert.FactsLength) } }).ShouldBeNull();
        CoverageGapRules.Facts(Finding() with { Facts = new Dictionary<string, string>() }).ShouldBeNull();
        CoverageGaps.ReadFacts("""{"device":"SRV-01"}""").ShouldBe(new Dictionary<string, string> { ["device"] = "SRV-01" });
        CoverageGaps.ReadFacts("not json").ShouldBeNull();
    }

    private static (IReadOnlyList<Alert> Added, CoverageCheckResult Result) Check(CoverageFinding[] findings, Alert[] stored, DateTimeOffset now) =>
        CoverageGapRules.Apply(Rule, AlertKind.Monitoring, findings, stored, now);

    private static CoverageFinding Finding() => new(
        Device.ToString("N"), Customer, AlertSeverity.Critical, "The Atera agent on SRV-01 has not reported since 2026-10-12", "SRV-01", Device,
        new Dictionary<string, string> { ["device"] = "SRV-01", ["lastSeenAt"] = "2026-10-12T08:00:00.0000000+00:00" });
}
