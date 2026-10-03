using System.Globalization;
using Crm.Billing.Contracts;
using Crm.Billing.Domain;

namespace Crm.UnitTests;

/// <summary>
/// Charge identity inside a basis (DEV-01, docs/adr/ADR-011): a collect matches source lines by charge key, keeps Finance's
/// decisions exactly once and flags them when the source moves on (FINANCIAL_DESIGN "Пересборка и ручные изменения").
/// </summary>
public class BillingChargeIdentityTests
{
    private static readonly DateTimeOffset Now = DateTimeOffset.Parse("2026-10-01T08:00:00Z", CultureInfo.InvariantCulture);
    private static readonly Guid Finance = Guid.NewGuid();
    private static readonly Guid Product = Guid.NewGuid();

    private static BillingBasis Basis() => BillingBasis.Create(BillingRun.Create(2026, 9, null), Guid.NewGuid(), null);

    private static LineDraft Source(string key, decimal unitPrice = 1_000m, string description = "Managed services (01.09.2026–30.09.2026)", decimal quantity = 1) =>
        new(BillingGroup.Subscription, Product, description, quantity, unitPrice, 0, 25m, null, key);

    private static LineDraft Manual(decimal unitPrice, string description = "Onboarding") =>
        new(BillingGroup.OneOff, null, description, 1, unitPrice, 0, 25m, null);

    private static BillingLine Line(BillingBasis basis, string key) => basis.CurrentLines.Single(l => l.SourceKey == key);

    [Theory]
    [InlineData(1)]
    [InlineData(10)]
    public void An_override_and_a_manual_line_each_stay_once_through_any_number_of_collects(int collects)
    {
        var basis = Basis();
        basis.ApplyCollected([Source("contract:a")], null);
        var line = Line(basis, "contract:a");
        basis.UpdateLine(line.Id, 1, 900m, 0, line.Description, "Price agreed with the customer", Finance, Now).IsSuccess.ShouldBeTrue();
        basis.AddManualLine(Manual(2_500m), Finance, Now).IsSuccess.ShouldBeTrue();

        for (var i = 0; i < collects; i++)
        {
            basis.ApplyCollected([Source("contract:a")], null).Value.Conflicts.ShouldBe(0);
        }

        // FINANCIAL_DESIGN control example: one position at 900 and the separate manual 2 500, once each.
        basis.CurrentLines.Count().ShouldBe(2);
        basis.TotalExVat.ShouldBe(3_400m);
        line.LineTotal.ShouldBe(900m);
        line.Decision.ShouldBe(BillingLineDecision.Override);
        line.SourceLineTotal.ShouldBe(1_000m);
        line.ChangeReason.ShouldBe("Price agreed with the customer");
        line.ChangedBy.ShouldBe(Finance);
        basis.CurrentLines.Single(l => l.Origin == BillingLineOrigin.Manual).LineTotal.ShouldBe(2_500m);
    }

    [Fact]
    public void Lines_with_the_same_text_from_different_sources_stay_apart()
    {
        var basis = Basis();
        basis.ApplyCollected([Source("contract:a"), Source("contract:b")], null);
        var first = Line(basis, "contract:a");
        basis.UpdateLine(first.Id, 1, 800m, 0, first.Description, "Goodwill", Finance, Now);
        basis.AddManualLine(Manual(1_000m, first.Description), Finance, Now);

        basis.ApplyCollected([Source("contract:a"), Source("contract:b")], null);

        // Same description three times: two sources and a manual line, none of them merged or suppressed.
        basis.CurrentLines.Count(l => l.Description == first.Description).ShouldBe(3);
        Line(basis, "contract:a").LineTotal.ShouldBe(800m);
        Line(basis, "contract:b").LineTotal.ShouldBe(1_000m);
        basis.TotalExVat.ShouldBe(2_800m);
    }

    [Fact]
    public void A_source_that_changes_after_an_override_is_a_conflict_until_finance_decides()
    {
        var basis = Basis();
        basis.ApplyCollected([Source("contract:a")], null);
        var line = Line(basis, "contract:a");
        basis.UpdateLine(line.Id, 1, 900m, 0, line.Description, "Discount", Finance, Now);

        var changes = basis.ApplyCollected([Source("contract:a", 1_100m)], null).Value;

        // The decision is not dropped and the new source price is not billed silently: Finance sees both.
        changes.Conflicts.ShouldBe(1);
        line.Conflict.ShouldBe(BillingLineConflict.SourceChanged);
        line.LineTotal.ShouldBe(900m);
        line.SourceLineTotal.ShouldBe(1_100m);
        basis.Approve().Error!.Code.ShouldBe("BIL_UNRESOLVED_CONFLICTS");
        basis.Status.ShouldBe(BillingBasisStatus.Draft);

        basis.KeepLine(line.Id, "Discount stays after the price change", Finance, Now).IsSuccess.ShouldBeTrue();
        line.Conflict.ShouldBe(BillingLineConflict.None);
        line.LineTotal.ShouldBe(900m);
        basis.ApplyCollected([Source("contract:a", 1_100m)], null).Value.Conflicts.ShouldBe(0);

        basis.ApplyCollected([Source("contract:a", 1_200m)], null).Value.Conflicts.ShouldBe(1);
        basis.RevertLine(line.Id, Finance, Now).IsSuccess.ShouldBeTrue();
        line.Decision.ShouldBe(BillingLineDecision.None);
        line.Conflict.ShouldBe(BillingLineConflict.None);
        line.LineTotal.ShouldBe(1_200m);
        basis.TotalExVat.ShouldBe(1_200m);
    }

    [Fact]
    public void A_source_that_disappears_under_an_override_is_a_conflict_and_can_be_kept_or_dropped()
    {
        var basis = Basis();
        basis.ApplyCollected([Source("contract:a"), Source("contract:b")], null);
        var kept = Line(basis, "contract:a");
        var dropped = Line(basis, "contract:b");
        basis.UpdateLine(kept.Id, 1, 900m, 0, kept.Description, "Discount", Finance, Now);
        basis.UpdateLine(dropped.Id, 1, 950m, 0, dropped.Description, "Discount", Finance, Now);

        basis.ApplyCollected([], null).Value.Conflicts.ShouldBe(2);
        kept.Conflict.ShouldBe(BillingLineConflict.SourceRemoved);
        kept.SourceSignature.ShouldBeNull();

        basis.KeepLine(kept.Id, "Billed by hand this month", Finance, Now);
        basis.RevertLine(dropped.Id, Finance, Now);
        dropped.IsDeleted.ShouldBeTrue();
        basis.ApplyCollected([], null).Value.Conflicts.ShouldBe(0);
        basis.TotalExVat.ShouldBe(900m);

        // The source coming back is a change Finance has to see again.
        basis.ApplyCollected([Source("contract:a")], null).Value.Conflicts.ShouldBe(1);
        kept.Conflict.ShouldBe(BillingLineConflict.SourceChanged);
    }

    [Fact]
    public void An_excluded_line_stays_out_on_every_collect_and_says_who_excluded_it_and_why()
    {
        var basis = Basis();
        basis.ApplyCollected([Source("contract:a"), Source("contract:b", 500m)], null);
        var line = Line(basis, "contract:a");

        basis.RemoveLine(line.Id, "Delivered free of charge", Finance, Now).IsSuccess.ShouldBeTrue();
        for (var i = 0; i < 10; i++)
        {
            basis.ApplyCollected([Source("contract:a"), Source("contract:b", 500m)], null).Value.Conflicts.ShouldBe(0);
        }

        basis.CurrentLines.Count().ShouldBe(2);
        basis.BilledLines.ShouldHaveSingleItem().SourceKey.ShouldBe("contract:b");
        basis.TotalExVat.ShouldBe(500m);
        line.Decision.ShouldBe(BillingLineDecision.Exclusion);
        line.ChangeReason.ShouldBe("Delivered free of charge");
        line.ChangedBy.ShouldBe(Finance);
        line.ChangedAt.ShouldBe(Now);

        // A changed source does not bring the line back either; Finance decides again.
        basis.ApplyCollected([Source("contract:a", 1_300m), Source("contract:b", 500m)], null).Value.Conflicts.ShouldBe(1);
        basis.TotalExVat.ShouldBe(500m);
        basis.RevertLine(line.Id, Finance, Now).IsSuccess.ShouldBeTrue();
        basis.TotalExVat.ShouldBe(1_800m);
    }

    [Fact]
    public void A_collected_line_is_corrected_or_left_out_only_with_a_reason_while_a_manual_line_is_simply_edited()
    {
        var basis = Basis();
        basis.ApplyCollected([Source("contract:a")], null);
        var collected = Line(basis, "contract:a");
        var manual = basis.AddManualLine(Manual(100m), Finance, Now).Value;

        basis.UpdateLine(collected.Id, 1, 900m, 0, "x", " ", Finance, Now).Error!.Code.ShouldBe("BIL_REASON_REQUIRED");
        basis.RemoveLine(collected.Id, null, Finance, Now).Error!.Code.ShouldBe("BIL_REASON_REQUIRED");
        basis.RevertLine(collected.Id, Finance, Now).Error!.Code.ShouldBe("BIL_NOTHING_TO_REVERT");
        basis.KeepLine(collected.Id, "x", Finance, Now).Error!.Code.ShouldBe("BIL_NO_CONFLICT");

        basis.UpdateLine(manual.Id, 2, 150m, 0, "Onboarding, two days", null, Finance, Now).IsSuccess.ShouldBeTrue();
        manual.LineTotal.ShouldBe(300m);
        manual.Decision.ShouldBe(BillingLineDecision.None);
        basis.RevertLine(manual.Id, Finance, Now).Error!.Code.ShouldBe("BIL_NOT_COLLECTED");
        basis.RemoveLine(manual.Id, null, Finance, Now).IsSuccess.ShouldBeTrue();
        manual.IsDeleted.ShouldBeTrue();

        basis.RemoveLine(collected.Id, "Not ours", Finance, Now).IsSuccess.ShouldBeTrue();
        basis.UpdateLine(collected.Id, 1, 900m, 0, "x", "Price", Finance, Now).Error!.Code.ShouldBe("BIL_LINE_EXCLUDED");
        basis.RemoveLine(collected.Id, "Again", Finance, Now).Error!.Code.ShouldBe("BIL_LINE_EXCLUDED");
        basis.RemoveLine(Guid.NewGuid(), "x", Finance, Now).Error!.Code.ShouldBe("BIL_LINE_NOT_FOUND");
    }

    [Fact]
    public void A_collect_refuses_lines_without_a_charge_key_or_with_the_same_key_twice()
    {
        var basis = Basis();

        basis.ApplyCollected([Source("contract:a") with { SourceKey = null }], null).Error!.Code.ShouldBe("BIL_MISSING_SOURCE_KEY");
        basis.ApplyCollected([Source("contract:a"), Source("contract:a", 2_000m)], null).Error!.Code.ShouldBe("BIL_DUPLICATE_SOURCE_KEY");
        basis.CurrentLines.ShouldBeEmpty();
    }

    [Fact]
    public void Every_change_to_the_lines_moves_the_revision_and_a_collect_that_changes_nothing_does_not()
    {
        var basis = Basis();
        basis.ApplyCollected([Source("contract:a")], null);
        var line = Line(basis, "contract:a");
        var revisions = new List<int> { basis.Revision };

        basis.ApplyCollected([Source("contract:a")], null);
        basis.Revision.ShouldBe(revisions[^1]);

        basis.UpdateLine(line.Id, 1, 900m, 0, line.Description, "Discount", Finance, Now);
        revisions.Add(basis.Revision);
        basis.ApplyCollected([Source("contract:a", 1_100m)], null);
        revisions.Add(basis.Revision);
        basis.KeepLine(line.Id, "Keep", Finance, Now);
        revisions.Add(basis.Revision);
        basis.RemoveLine(line.Id, "Leave out", Finance, Now);
        revisions.Add(basis.Revision);
        basis.RevertLine(line.Id, Finance, Now);
        revisions.Add(basis.Revision);
        basis.AddManualLine(Manual(10m), Finance, Now);
        revisions.Add(basis.Revision);

        revisions.ShouldBeInOrder(SortDirection.Ascending);
        revisions.Distinct().Count().ShouldBe(revisions.Count);
    }

    [Fact]
    public void The_customer_a_line_was_delivered_to_travels_with_it()
    {
        var basis = Basis();
        var subsidiary = Guid.NewGuid();

        basis.ApplyCollected([Source("contract:a") with { SourceOrganizationId = subsidiary }], null);

        Line(basis, "contract:a").SourceOrganizationId.ShouldBe(subsidiary);
        basis.AddManualLine(Manual(10m), Finance, Now).Value.SourceOrganizationId.ShouldBe(basis.OrganizationId);
    }
}
