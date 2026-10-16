using Crm.Billing.Contracts;
using Crm.Billing.Domain;
using Crm.Contracts.Contracts;
using Crm.Integrations.PowerOffice;
using Crm.SharedKernel.Results;

namespace Crm.UnitTests;

public class BillingScheduleTests
{
    private static readonly DateOnly ContractStart = new(2026, 1, 15);

    [Fact]
    public void A_monthly_contract_in_advance_bills_the_running_month()
    {
        var covered = BillingSchedule.Covers(ContractStart, InvoiceFrequency.Monthly, InvoiceTiming.InAdvance, new DateOnly(2026, 3, 1), ContractStart, null);

        covered.ShouldNotBeNull();
        covered.From.ShouldBe(new DateOnly(2026, 3, 1));
        covered.To.ShouldBe(new DateOnly(2026, 3, 31));
    }

    [Fact]
    public void A_monthly_contract_in_arrears_bills_the_month_before()
    {
        var covered = BillingSchedule.Covers(ContractStart, InvoiceFrequency.Monthly, InvoiceTiming.InArrears, new DateOnly(2026, 3, 1), ContractStart, null);

        covered!.From.ShouldBe(new DateOnly(2026, 2, 1));
        covered.To.ShouldBe(new DateOnly(2026, 2, 28));
    }

    [Fact]
    public void The_first_run_of_a_contract_in_arrears_bills_nothing()
    {
        BillingSchedule.Covers(ContractStart, InvoiceFrequency.Monthly, InvoiceTiming.InArrears, new DateOnly(2026, 1, 1), ContractStart, null).ShouldBeNull();
    }

    [Theory]
    [InlineData(1, true)]
    [InlineData(2, false)]
    [InlineData(3, false)]
    [InlineData(4, true)]
    public void A_quarterly_contract_bills_every_third_month_from_its_start(int month, bool due)
    {
        var covered = BillingSchedule.Covers(ContractStart, InvoiceFrequency.Quarterly, InvoiceTiming.InAdvance, new DateOnly(2026, month, 1), ContractStart, null);

        (covered is not null).ShouldBe(due);
        if (due)
        {
            covered!.To.ShouldBe(new DateOnly(2026, month, 1).AddMonths(3).AddDays(-1));
        }
    }

    [Fact]
    public void A_yearly_contract_bills_on_the_anniversary_month()
    {
        BillingSchedule.Covers(ContractStart, InvoiceFrequency.Yearly, InvoiceTiming.InAdvance, new DateOnly(2026, 1, 1), ContractStart, null).ShouldNotBeNull();
        BillingSchedule.Covers(ContractStart, InvoiceFrequency.Yearly, InvoiceTiming.InAdvance, new DateOnly(2026, 7, 1), ContractStart, null).ShouldBeNull();
        BillingSchedule.Covers(ContractStart, InvoiceFrequency.Yearly, InvoiceTiming.InAdvance, new DateOnly(2027, 1, 1), ContractStart, null).ShouldNotBeNull();
    }

    [Fact]
    public void A_line_that_ended_before_the_covered_period_is_not_billed()
    {
        BillingSchedule.Covers(ContractStart, InvoiceFrequency.Monthly, InvoiceTiming.InAdvance, new DateOnly(2026, 3, 1), ContractStart, new DateOnly(2026, 2, 28))
            .ShouldBeNull();
    }

    [Fact]
    public void Nothing_is_billed_before_the_contract_starts()
    {
        BillingSchedule.Covers(ContractStart, InvoiceFrequency.Monthly, InvoiceTiming.InAdvance, new DateOnly(2025, 12, 1), ContractStart, null).ShouldBeNull();
    }
}

public class BillingBasisTests
{
    private static BillingRun Run() => BillingRun.Create(2026, 9, null);

    private static readonly DateTimeOffset Now = DateTimeOffset.Parse("2026-10-01T08:00:00Z", System.Globalization.CultureInfo.InvariantCulture);

    private static LineDraft Draft(BillingGroup group = BillingGroup.Subscription, decimal quantity = 25, decimal price = 250, decimal discount = 0, string? key = null) =>
        new(group, Guid.NewGuid(), "Microsoft 365 Business Premium (01.09.2026–30.09.2026)", quantity, price, discount, 25m, null, key ?? $"contract:{Guid.NewGuid():N}");

    [Fact]
    public void The_total_is_the_sum_of_the_lines_after_discount()
    {
        var basis = BillingBasis.Create(Run(), Guid.NewGuid(), null);

        basis.ApplyCollected([Draft(), Draft(BillingGroup.HourlyWork, 3, 1_250), Draft(BillingGroup.Subscription, 1, 5_000)], null).IsSuccess.ShouldBeTrue();

        // 25 × 250 + 3 × 1 250 + 5 000 = 15 000 (docs/02 §4.9 acceptance criterion).
        basis.TotalExVat.ShouldBe(15_000m);
        basis.CurrentLines.Count().ShouldBe(3);
    }

    [Fact]
    public void A_discount_is_applied_per_line()
    {
        BillingLine.Amount(10, 100, 15).ShouldBe(850m);
        BillingLine.Amount(1, 1_234.56m, 0).ShouldBe(1_234.56m);
    }

    [Fact]
    public void Re_collecting_updates_the_same_collected_line_and_keeps_manual_ones()
    {
        var basis = BillingBasis.Create(Run(), Guid.NewGuid(), null);
        basis.ApplyCollected([Draft(key: "contract:a")], null);
        var collected = basis.CurrentLines.Single();
        basis.AddManualLine(Draft(BillingGroup.OneOff, 1, 2_000), Guid.NewGuid(), Now).IsSuccess.ShouldBeTrue();

        basis.ApplyCollected([Draft(quantity: 30, key: "contract:a")], null);

        basis.CurrentLines.Count().ShouldBe(2);
        basis.CurrentLines.Single(l => l.Origin == BillingLineOrigin.Manual).LineTotal.ShouldBe(2_000m);
        basis.CurrentLines.Single(l => l.Origin == BillingLineOrigin.Collected).ShouldBeSameAs(collected);
        collected.Quantity.ShouldBe(30m);
        basis.TotalExVat.ShouldBe(9_500m);
    }

    [Fact]
    public void An_approved_basis_cannot_be_changed_any_more()
    {
        var basis = BillingBasis.Create(Run(), Guid.NewGuid(), null);
        basis.ApplyCollected([Draft()], null);
        basis.Approve();
        var line = basis.CurrentLines.First();

        basis.Status.ShouldBe(BillingBasisStatus.Approved);
        basis.AddManualLine(Draft(), null, Now).Error!.Code.ShouldBe("BIL_BASIS_LOCKED");
        basis.ApplyCollected([Draft()], null).Error!.Code.ShouldBe("BIL_BASIS_LOCKED");
        basis.RemoveLine(line.Id, "Wrong period", null, Now).Error!.Code.ShouldBe("BIL_BASIS_LOCKED");
        basis.UpdateLine(line.Id, 1, 1, 0, "x", "Price", null, Now).Error!.Code.ShouldBe("BIL_BASIS_LOCKED");
        basis.RevertLine(line.Id, null, Now).Error!.Code.ShouldBe("BIL_BASIS_LOCKED");
        basis.KeepLine(line.Id, "Fine", null, Now).Error!.Code.ShouldBe("BIL_BASIS_LOCKED");
    }

    [Fact]
    public void A_basis_with_nothing_but_information_lines_is_cancelled_instead_of_exported()
    {
        var basis = BillingBasis.Create(Run(), Guid.NewGuid(), null);
        basis.ApplyCollected([new LineDraft(BillingGroup.Info, null, "Included in the contract", 4, 0, 0, 0, null, "info:Covered")], null);

        basis.Approve();

        basis.Status.ShouldBe(BillingBasisStatus.Cancelled);
        basis.TotalExVat.ShouldBe(0m);
    }

    [Fact]
    public void Exporting_twice_with_the_same_order_number_changes_nothing()
    {
        var basis = BillingBasis.Create(Run(), Guid.NewGuid(), null);
        basis.ApplyCollected([Draft()], null);
        basis.Approve();
        var now = DateTimeOffset.UtcNow;

        basis.MarkExported("poweroffice", "1042", now, null);
        basis.MarkExported("poweroffice", "1042", now.AddMinutes(1), null);

        basis.Attempts.Count.ShouldBe(1);
        basis.OrderNo.ShouldBe("1042");
        basis.Status.ShouldBe(BillingBasisStatus.Exported);
    }

    [Fact]
    public void A_failed_basis_can_be_sent_again_but_an_exported_one_cannot_be_cancelled()
    {
        var basis = BillingBasis.Create(Run(), Guid.NewGuid(), null);
        basis.ApplyCollected([Draft()], null);
        basis.Approve();
        basis.MarkFailed("poweroffice", "Customer is archived", DateTimeOffset.UtcNow, null);

        basis.Status.ShouldBe(BillingBasisStatus.Failed);
        basis.Retry().IsSuccess.ShouldBeTrue();
        basis.Status.ShouldBe(BillingBasisStatus.Approved);

        basis.MarkExported("poweroffice", "1043", DateTimeOffset.UtcNow, null);
        basis.Cancel(DateTimeOffset.UtcNow, "wrong period").Error!.Code.ShouldBe("BIL_ALREADY_EXPORTED");
    }

    [Fact]
    public void The_idempotency_key_holds_period_customer_and_run()
    {
        var run = Run();
        var organizationId = Guid.NewGuid();

        var basis = BillingBasis.Create(run, organizationId, "PO-4711");

        basis.IdempotencyKey.ShouldBe($"2026-09-{organizationId:N}-{run.Id:N}");
        basis.CustomerReference.ShouldBe("PO-4711");
    }
}

public class BillingRunTests
{
    private const decimal Threshold = 200_000m;
    private static readonly DateTimeOffset Now = DateTimeOffset.Parse("2026-10-04T08:00:00Z", System.Globalization.CultureInfo.InvariantCulture);

    /// <summary>A collected run with one basis per amount, each a single collected contract line.</summary>
    internal static (BillingRun Run, List<BillingBasis> Bases) Collected(params decimal[] amounts)
    {
        var run = BillingRun.Create(2026, 9, null);
        var bases = amounts.Select(amount => BasisOf(run, amount)).ToList();
        run.MarkCollected(Now, BillingRun.NeedsSecondApproval(bases, Threshold)).IsSuccess.ShouldBeTrue();
        return (run, bases);
    }

    internal static BillingBasis BasisOf(BillingRun run, decimal amount)
    {
        var basis = BillingBasis.Create(run, Guid.NewGuid(), null);
        var lineId = Guid.NewGuid();
        basis.ApplyCollected(
            [new LineDraft(BillingGroup.Subscription, Guid.NewGuid(), "Drift", 1, amount, 0, 25m, $"{{\"contractLineId\":\"{lineId}\"}}", $"contract:{lineId:N}:2026-09-01:2026-09-30")],
            null).IsSuccess.ShouldBeTrue();
        return basis;
    }

    private static Result Approve(BillingRun run, List<BillingBasis> bases, BillingApprovalKind kind, Guid? user, decimal threshold = Threshold) =>
        run.Approve(kind, user, Now, bases, threshold);

    [Fact]
    public void A_run_covers_the_whole_month()
    {
        var run = BillingRun.Create(2026, 2, " February ");

        run.PeriodStart.ShouldBe(new DateOnly(2026, 2, 1));
        run.PeriodEnd.ShouldBe(new DateOnly(2026, 2, 28));
        run.Notes.ShouldBe("February");
        run.Status.ShouldBe(BillingRunStatus.Draft);
    }

    [Fact]
    public void Approval_needs_a_collected_run_and_raises_one_event()
    {
        var run = BillingRun.Create(2026, 9, null);
        var bases = new List<BillingBasis> { BasisOf(run, 1_000m) };
        var user = Guid.NewGuid();

        Approve(run, bases, BillingApprovalKind.First, user).Error!.Code.ShouldBe("BIL_INVALID_STATUS");
        run.MarkCollected(Now, requiresSecondApproval: false);
        Approve(run, bases, BillingApprovalKind.First, user).IsSuccess.ShouldBeTrue();

        run.Status.ShouldBe(BillingRunStatus.Approved);
        run.ApprovedBy.ShouldBe(user);
        run.ApprovedRevision.ShouldBe(run.ContentRevision);
        run.ApprovedDigest.ShouldBe(BillingContentDigest.Compute(bases));
        run.DomainEvents.OfType<BillingRunApproved>().ShouldHaveSingleItem();

        // Approving again is refused and raises nothing more.
        Approve(run, bases, BillingApprovalKind.First, Guid.NewGuid()).Error!.Code.ShouldBe("BIL_INVALID_STATUS");
        run.DomainEvents.OfType<BillingRunApproved>().ShouldHaveSingleItem();
    }

    [Fact]
    public void Above_the_threshold_the_run_waits_for_a_second_approver()
    {
        var (run, bases) = Collected(250_000m);
        var finance = Guid.NewGuid();

        Approve(run, bases, BillingApprovalKind.First, finance).IsSuccess.ShouldBeTrue();
        run.Status.ShouldBe(BillingRunStatus.InReview);
        run.DomainEvents.ShouldBeEmpty();

        Approve(run, bases, BillingApprovalKind.Second, finance).Error!.Code.ShouldBe("BIL_SAME_APPROVER");
        Approve(run, bases, BillingApprovalKind.Second, Guid.NewGuid()).IsSuccess.ShouldBeTrue();

        run.Status.ShouldBe(BillingRunStatus.Approved);
        run.DomainEvents.OfType<BillingRunApproved>().ShouldHaveSingleItem();
    }

    [Fact]
    public void The_two_approvals_come_from_two_people_in_either_order()
    {
        var (run, bases) = Collected(250_000m);
        var admin = Guid.NewGuid();

        // Management may sign first; the first approval then still has to come from somebody else.
        Approve(run, bases, BillingApprovalKind.Second, admin).IsSuccess.ShouldBeTrue();
        run.Status.ShouldBe(BillingRunStatus.InReview);
        Approve(run, bases, BillingApprovalKind.First, admin).Error!.Code.ShouldBe("BIL_SAME_APPROVER");
        run.Status.ShouldBe(BillingRunStatus.InReview);

        Approve(run, bases, BillingApprovalKind.First, Guid.NewGuid()).IsSuccess.ShouldBeTrue();
        run.Status.ShouldBe(BillingRunStatus.Approved);
    }

    [Theory]
    [InlineData("199999.99", false)]
    [InlineData("200000", false)]
    [InlineData("200000.01", true)]
    public void The_second_approval_is_needed_when_one_basis_is_strictly_above_the_threshold_excluding_VAT(string amount, bool needed)
    {
        var (run, bases) = Collected(decimal.Parse(amount, System.Globalization.CultureInfo.InvariantCulture));

        BillingRun.NeedsSecondApproval(bases, Threshold).ShouldBe(needed);
        Approve(run, bases, BillingApprovalKind.First, Guid.NewGuid()).IsSuccess.ShouldBeTrue();
        run.Status.ShouldBe(needed ? BillingRunStatus.InReview : BillingRunStatus.Approved);
    }

    [Fact]
    public void The_threshold_applies_to_each_basis_and_not_to_the_run_total()
    {
        var (run, bases) = Collected(150_000m, 150_000m);

        BillingRun.NeedsSecondApproval(bases, Threshold).ShouldBeFalse();
        Approve(run, bases, BillingApprovalKind.Second, Guid.NewGuid()).Error!.Code.ShouldBe("BIL_NO_SECOND_APPROVAL");
        Approve(run, bases, BillingApprovalKind.First, Guid.NewGuid()).IsSuccess.ShouldBeTrue();
        run.Status.ShouldBe(BillingRunStatus.Approved);
    }

    [Fact]
    public void A_cancelled_basis_does_not_count_for_the_threshold()
    {
        var (_, bases) = Collected(250_000m, 1_000m);

        bases[0].Cancel(Now, "Fakturert manuelt").IsSuccess.ShouldBeTrue();

        BillingRun.NeedsSecondApproval(bases, Threshold).ShouldBeFalse();
    }

    [Fact]
    public void The_threshold_is_evaluated_from_the_content_at_approval_not_at_collect()
    {
        var (run, bases) = Collected(10_000m);
        run.RequiresSecondApproval.ShouldBeFalse();

        // A manual line lifts the basis over the threshold after the collect.
        bases[0].AddManualLine(new LineDraft(BillingGroup.OneOff, null, "Prosjekt", 1, 300_000m, 0, 25m, null), Guid.NewGuid(), Now, "Prosjektleveranse")
            .IsSuccess.ShouldBeTrue();
        run.ContentChanged(ApprovalResetReasons.LinesChanged, Now).IsSuccess.ShouldBeTrue();

        Approve(run, bases, BillingApprovalKind.First, Guid.NewGuid()).IsSuccess.ShouldBeTrue();

        run.Status.ShouldBe(BillingRunStatus.InReview);
        run.RequiresSecondApproval.ShouldBeTrue();
        run.DomainEvents.ShouldBeEmpty();
    }

    [Fact]
    public void A_collect_sets_earlier_approvals_aside_and_keeps_them_with_the_reason()
    {
        var (run, bases) = Collected(250_000m);
        var finance = Guid.NewGuid();
        Approve(run, bases, BillingApprovalKind.First, finance).IsSuccess.ShouldBeTrue();
        var revision = run.ContentRevision;

        run.MarkCollected(Now.AddMinutes(5), requiresSecondApproval: true).IsSuccess.ShouldBeTrue();

        run.ContentRevision.ShouldBe(revision + 1);
        run.Status.ShouldBe(BillingRunStatus.Collected);
        run.ApprovedBy.ShouldBeNull();
        run.CurrentApprovals.ShouldBeEmpty();
        var old = run.Approvals.ShouldHaveSingleItem();
        old.ApprovedBy.ShouldBe(finance);
        old.ContentRevision.ShouldBe(revision);
        old.InvalidationReason.ShouldBe(ApprovalResetReasons.Recollected);
        old.InvalidatedAt.ShouldBe(Now.AddMinutes(5));

        // The same person may approve the new revision; the second approval must still come from someone else.
        Approve(run, bases, BillingApprovalKind.First, finance).IsSuccess.ShouldBeTrue();
        Approve(run, bases, BillingApprovalKind.Second, finance).Error!.Code.ShouldBe("BIL_SAME_APPROVER");
    }

    [Fact]
    public void A_change_of_the_lines_sets_approvals_aside_and_sends_the_run_back_for_approval()
    {
        var (run, bases) = Collected(250_000m);
        Approve(run, bases, BillingApprovalKind.First, Guid.NewGuid()).IsSuccess.ShouldBeTrue();
        run.Status.ShouldBe(BillingRunStatus.InReview);

        run.ContentChanged(ApprovalResetReasons.LinesChanged, Now).IsSuccess.ShouldBeTrue();

        run.Status.ShouldBe(BillingRunStatus.Collected);
        run.CurrentApprovals.ShouldBeEmpty();
        run.Approvals.ShouldHaveSingleItem().InvalidationReason.ShouldBe(ApprovalResetReasons.LinesChanged);
    }

    [Fact]
    public void An_approved_run_does_not_change_any_more()
    {
        var (run, bases) = Collected(1_000m);
        Approve(run, bases, BillingApprovalKind.First, Guid.NewGuid()).IsSuccess.ShouldBeTrue();

        run.ContentChanged(ApprovalResetReasons.LinesChanged, Now).Error!.Code.ShouldBe("BIL_INVALID_STATUS");
        run.MarkCollected(Now, false).Error!.Code.ShouldBe("BIL_INVALID_STATUS");
        run.CurrentApprovals.ShouldHaveSingleItem();
    }

    [Fact]
    public void An_approval_records_the_revision_the_content_digest_and_the_rule()
    {
        var (run, bases) = Collected(250_000m);
        var user = Guid.NewGuid();

        Approve(run, bases, BillingApprovalKind.First, user).IsSuccess.ShouldBeTrue();

        var approval = run.Approvals.ShouldHaveSingleItem();
        approval.Kind.ShouldBe(BillingApprovalKind.First);
        approval.ApprovedBy.ShouldBe(user);
        approval.ApprovedAt.ShouldBe(Now);
        approval.ContentRevision.ShouldBe(run.ContentRevision);
        approval.ContentDigest.ShouldBe(BillingContentDigest.Compute(bases));
        approval.ContentDigest.Length.ShouldBe(64);
        approval.Policy.ShouldBe("basis-total-ex-vat>200000");
        approval.RequiredSecond.ShouldBeTrue();
    }

    [Fact]
    public void An_approval_of_other_content_within_the_revision_does_not_count()
    {
        var (run, bases) = Collected(250_000m);
        Approve(run, bases, BillingApprovalKind.First, Guid.NewGuid()).IsSuccess.ShouldBeTrue();

        // Defence in depth: a line changes without a new revision (a path that forgot to say so).
        bases[0].AddManualLine(new LineDraft(BillingGroup.OneOff, null, "Tillegg", 1, 5_000m, 0, 25m, null), Guid.NewGuid(), Now, "Tillegg")
            .IsSuccess.ShouldBeTrue();
        Approve(run, bases, BillingApprovalKind.Second, Guid.NewGuid()).IsSuccess.ShouldBeTrue();

        // The first approval was about other content: it is set aside, and one approval of this content is not enough.
        run.Status.ShouldBe(BillingRunStatus.InReview);
        run.Approvals.Single(a => a.Kind == BillingApprovalKind.First).InvalidationReason.ShouldBe(ApprovalResetReasons.ContentChanged);
        run.DomainEvents.ShouldBeEmpty();
    }

    [Fact]
    public void A_changed_rule_sets_an_earlier_approval_aside()
    {
        var (run, bases) = Collected(250_000m);
        Approve(run, bases, BillingApprovalKind.First, Guid.NewGuid()).IsSuccess.ShouldBeTrue();

        Approve(run, bases, BillingApprovalKind.Second, Guid.NewGuid(), threshold: 100_000m).IsSuccess.ShouldBeTrue();

        run.Status.ShouldBe(BillingRunStatus.InReview);
        run.Approvals.Single(a => a.Kind == BillingApprovalKind.First).InvalidationReason.ShouldBe(ApprovalResetReasons.RuleChanged);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("00000000-0000-0000-0000-000000000000")]
    public void An_approval_needs_a_person(string? user)
    {
        var (run, bases) = Collected(1_000m);

        Approve(run, bases, BillingApprovalKind.First, user is null ? null : Guid.Parse(user)).Error!.Code.ShouldBe("BIL_APPROVER_REQUIRED");

        run.Status.ShouldBe(BillingRunStatus.Collected);
        run.Approvals.ShouldBeEmpty();
    }

    [Fact]
    public void The_same_approval_is_given_once_per_revision()
    {
        var (run, bases) = Collected(250_000m);
        Approve(run, bases, BillingApprovalKind.First, Guid.NewGuid()).IsSuccess.ShouldBeTrue();

        Approve(run, bases, BillingApprovalKind.First, Guid.NewGuid()).Error!.Code.ShouldBe("BIL_ALREADY_APPROVED");
        run.Approvals.Count.ShouldBe(1);
    }

    [Fact]
    public void A_refused_approval_leaves_signatures_status_and_events_as_they_were()
    {
        var (run, bases) = Collected(250_000m);
        var admin = Guid.NewGuid();
        Approve(run, bases, BillingApprovalKind.Second, admin).IsSuccess.ShouldBeTrue();
        var before = (run.Status, run.ApprovedBy, run.SecondApprovedBy, run.Approvals.Count, run.ContentRevision, Events: run.DomainEvents.Count);

        Approve(run, bases, BillingApprovalKind.First, admin).Error!.Code.ShouldBe("BIL_SAME_APPROVER");
        Approve(run, bases, BillingApprovalKind.Second, Guid.NewGuid()).Error!.Code.ShouldBe("BIL_ALREADY_APPROVED");
        Approve(run, bases, BillingApprovalKind.First, null).Error!.Code.ShouldBe("BIL_APPROVER_REQUIRED");

        (run.Status, run.ApprovedBy, run.SecondApprovedBy, run.Approvals.Count, run.ContentRevision, Events: run.DomainEvents.Count).ShouldBe(before);
        run.CurrentApprovals.ShouldHaveSingleItem().InvalidatedAt.ShouldBeNull();
    }

    [Fact]
    public void A_line_waiting_for_a_decision_blocks_the_approval()
    {
        var run = BillingRun.Create(2026, 9, null);
        var basis = BillingBasis.Create(run, Guid.NewGuid(), null);
        var lineId = Guid.NewGuid();
        LineDraft Source(decimal price) => new(BillingGroup.Subscription, null, "Drift", 1, price, 0, 25m, "{}", $"contract:{lineId:N}:2026-09-01:2026-09-30");
        basis.ApplyCollected([Source(1_000m)], null).IsSuccess.ShouldBeTrue();
        basis.UpdateLine(basis.CurrentLines.Single().Id, 1, 900m, 0, "Drift", "Rabatt", Guid.NewGuid(), Now).IsSuccess.ShouldBeTrue();
        basis.ApplyCollected([Source(1_100m)], null).IsSuccess.ShouldBeTrue();
        run.MarkCollected(Now, false);

        run.Approve(BillingApprovalKind.First, Guid.NewGuid(), Now, [basis], Threshold).Error!.Code.ShouldBe("BIL_UNRESOLVED_CONFLICTS");
        run.Approvals.ShouldBeEmpty();
    }

    [Fact]
    public void A_run_is_closed_only_after_it_was_exported()
    {
        var (run, bases) = Collected(1_000m);
        Approve(run, bases, BillingApprovalKind.First, Guid.NewGuid()).IsSuccess.ShouldBeTrue();

        run.Close(DateTimeOffset.UtcNow).Error!.Code.ShouldBe("BIL_INVALID_STATUS");
        run.StartExport().IsSuccess.ShouldBeTrue();
        run.FinishExport(hasFailures: true, DateTimeOffset.UtcNow);
        run.Status.ShouldBe(BillingRunStatus.ExportedWithErrors);
        run.Close(DateTimeOffset.UtcNow).IsSuccess.ShouldBeTrue();
        run.Status.ShouldBe(BillingRunStatus.Closed);
    }

    [Fact]
    public void An_approved_run_cannot_be_discarded()
    {
        var run = BillingRun.Create(2026, 9, null);
        run.Discard().IsSuccess.ShouldBeTrue();

        var (approved, bases) = Collected(1_000m);
        Approve(approved, bases, BillingApprovalKind.First, Guid.NewGuid()).IsSuccess.ShouldBeTrue();
        approved.Discard().Error!.Code.ShouldBe("BIL_INVALID_STATUS");
    }
}

public class BillingContentDigestTests
{
    private static readonly DateTimeOffset Now = DateTimeOffset.Parse("2026-10-04T08:00:00Z", System.Globalization.CultureInfo.InvariantCulture);

    [Fact]
    public void The_digest_does_not_depend_on_the_order_of_bases_or_lines()
    {
        var (_, bases) = BillingRunTests.Collected(1_000m, 2_000m, 3_000m);

        var reversed = Enumerable.Reverse(bases).ToList();

        BillingContentDigest.Compute(reversed).ShouldBe(BillingContentDigest.Compute(bases));
        BillingContentDigest.Compute(bases).ShouldMatch("^[0-9a-f]{64}$");
    }

    [Fact]
    public void An_amount_a_payer_or_a_cancelled_invoice_changes_the_digest()
    {
        var (run, bases) = BillingRunTests.Collected(1_000m, 2_000m);
        var digest = BillingContentDigest.Compute(bases);

        var otherPayer = new List<BillingBasis> { bases[0], BillingRunTests.BasisOf(run, 2_000m) };
        BillingContentDigest.Compute(otherPayer).ShouldNotBe(digest);

        var line = bases[1].CurrentLines.Single();
        bases[1].UpdateLine(line.Id, 1, 2_000.01m, 0, line.Description, "Øreavrunding", Guid.NewGuid(), Now).IsSuccess.ShouldBeTrue();
        var changedAmount = BillingContentDigest.Compute(bases);
        changedAmount.ShouldNotBe(digest);

        bases[1].Cancel(Now, "Fakturert manuelt").IsSuccess.ShouldBeTrue();
        BillingContentDigest.Compute(bases).ShouldNotBe(changedAmount);
    }

    [Fact]
    public void The_delivery_status_of_a_released_basis_is_not_content()
    {
        var (_, bases) = BillingRunTests.Collected(1_000m);
        var digest = BillingContentDigest.Compute(bases);

        bases[0].Approve().IsSuccess.ShouldBeTrue();
        BillingContentDigest.Compute(bases).ShouldBe(digest);
        bases[0].MarkExported("poweroffice", "5042", Now, null);
        BillingContentDigest.Compute(bases).ShouldBe(digest);
    }
}

public class InvoiceMirrorTests
{
    private static ExternalInvoice Source(decimal total = 12_500m, decimal outstanding = 12_500m, InvoiceStatus status = InvoiceStatus.Sent) =>
        new("poweroffice", "10042", "1042", "2026-09-key", null, new DateOnly(2026, 10, 1), new DateOnly(2026, 10, 15), total, outstanding, status, null);

    private static readonly DateTimeOffset Seen = DateTimeOffset.Parse("2026-10-20T08:00:00Z", System.Globalization.CultureInfo.InvariantCulture);

    [Fact]
    public void A_smaller_outstanding_amount_is_an_observed_decrease_not_a_payment()
    {
        var invoice = Invoice.From(Source(), Guid.NewGuid(), Guid.NewGuid(), Seen);
        invoice.Payments.ShouldBeEmpty();

        invoice.Apply(Source(outstanding: 2_500m, status: InvoiceStatus.PartiallyPaid), null, null, Seen.AddDays(1)).ShouldBeTrue();

        var movement = invoice.Payments.ShouldHaveSingleItem();
        movement.Kind.ShouldBe(InvoiceMovementKind.BalanceDecrease);
        movement.Amount.ShouldBe(10_000m);
        movement.ObservedOn.ShouldBe(new DateOnly(2026, 10, 21));
        movement.Source.ShouldNotBeNullOrWhiteSpace();
        invoice.Outstanding.ShouldBe(2_500m);
    }

    [Fact]
    public void A_credited_invoice_with_a_lower_remaining_amount_is_a_credit_note()
    {
        var invoice = Invoice.From(Source(), Guid.NewGuid(), null, Seen);

        invoice.Apply(Source(outstanding: 0m, status: InvoiceStatus.Credited), null, null, Seen.AddDays(1)).ShouldBeTrue();

        var movement = invoice.Payments.ShouldHaveSingleItem();
        movement.Kind.ShouldBe(InvoiceMovementKind.CreditNote);
        movement.Amount.ShouldBe(12_500m);
    }

    [Fact]
    public void Flipping_to_credited_without_a_changed_amount_still_records_the_credit_note()
    {
        var invoice = Invoice.From(Source(), Guid.NewGuid(), null, Seen);

        invoice.Apply(Source(status: InvoiceStatus.Credited), null, null, Seen.AddDays(1)).ShouldBeTrue();

        var movement = invoice.Payments.ShouldHaveSingleItem();
        movement.Kind.ShouldBe(InvoiceMovementKind.CreditNote);
        movement.Amount.ShouldBe(0m);

        // Seeing the same credited state again adds nothing.
        invoice.Apply(Source(status: InvoiceStatus.Credited), null, null, Seen.AddDays(2)).ShouldBeFalse();
        invoice.Payments.Count.ShouldBe(1);
    }

    [Fact]
    public void A_higher_remaining_amount_is_kept_as_a_flagged_increase()
    {
        var invoice = Invoice.From(Source(outstanding: 2_500m, status: InvoiceStatus.PartiallyPaid), Guid.NewGuid(), null, Seen);

        invoice.Apply(Source(outstanding: 4_000m, status: InvoiceStatus.PartiallyPaid), null, null, Seen.AddDays(1)).ShouldBeTrue();

        var movement = invoice.Payments.ShouldHaveSingleItem();
        movement.Kind.ShouldBe(InvoiceMovementKind.BalanceIncrease);
        movement.Amount.ShouldBe(1_500m);
    }

    [Fact]
    public void The_first_sync_records_no_movement_whatever_the_amount()
    {
        Invoice.From(Source(outstanding: 3_000m), null, null, Seen).Payments.ShouldBeEmpty();
        Invoice.From(Source(outstanding: 0m, status: InvoiceStatus.Credited), null, null, Seen).Payments.ShouldBeEmpty();
    }

    [Fact]
    public void An_unchanged_invoice_reports_no_change()
    {
        var now = DateTimeOffset.UtcNow;
        var invoice = Invoice.From(Source(), Guid.NewGuid(), null, now);

        invoice.Apply(Source(), null, null, now.AddHours(1)).ShouldBeFalse();
        invoice.Payments.ShouldBeEmpty();
    }

    [Fact]
    public void An_invoice_past_its_due_date_with_an_outstanding_amount_is_overdue()
    {
        var invoice = Invoice.From(Source(), null, null, DateTimeOffset.UtcNow);

        invoice.IsOverdue(new DateOnly(2026, 10, 16)).ShouldBeTrue();
        invoice.IsOverdue(new DateOnly(2026, 10, 10)).ShouldBeFalse();

        invoice.Apply(Source(outstanding: 0, status: InvoiceStatus.Paid), null, null, DateTimeOffset.UtcNow);
        invoice.IsOverdue(new DateOnly(2026, 11, 1)).ShouldBeFalse();
    }

    [Fact]
    public void PowerOffice_invoices_are_mapped_defensively()
    {
        PowerOfficeInvoiceSyncJob.Map(new PoOutgoingInvoice(1, null, null, null, null, null, null, null, null, null, null, null, null)).ShouldBeNull();

        var mapped = PowerOfficeInvoiceSyncJob.Map(new PoOutgoingInvoice(
            1, "10042", 1042, 7, "2026-09-key", DateTimeOffset.Parse("2026-10-01T00:00:00Z", System.Globalization.CultureInfo.InvariantCulture),
            DateTimeOffset.Parse("2026-10-15T00:00:00Z", System.Globalization.CultureInfo.InvariantCulture), 12_500m, 2_500m, "Sent", false, null, null));

        mapped!.InvoiceNo.ShouldBe("10042");
        mapped.OrderNo.ShouldBe("1042");
        mapped.ExternalReference.ShouldBe("2026-09-key");
        mapped.Status.ShouldBe(InvoiceStatus.PartiallyPaid);
        mapped.DueDate.ShouldBe(new DateOnly(2026, 10, 15));

        // Without a remaining amount the full total is still outstanding.
        PowerOfficeInvoiceSyncJob.Map(new PoOutgoingInvoice(
                2, "10043", null, null, null, DateTimeOffset.UtcNow, null, 1_000m, null, null, null, null, null))!
            .Outstanding.ShouldBe(1_000m);
    }
}

public class ProrationTests
{
    private static readonly CoveredPeriod September = new(new DateOnly(2026, 9, 1), new DateOnly(2026, 9, 30));

    [Fact]
    public void A_line_in_force_all_period_is_billed_in_full()
    {
        var full = BillingSchedule.Prorate(September, new DateOnly(2026, 1, 1), null);

        full.Factor.ShouldBe(1m);
        full.IsPartial.ShouldBeFalse();
        full.From.ShouldBe(September.From);
        full.To.ShouldBe(September.To);
    }

    [Fact]
    public void A_line_that_starts_mid_period_pays_for_its_days()
    {
        var half = BillingSchedule.Prorate(September, new DateOnly(2026, 9, 16), null);

        // 16.09–30.09 is 15 of 30 days.
        half.Factor.ShouldBe(0.5m);
        half.From.ShouldBe(new DateOnly(2026, 9, 16));
        half.To.ShouldBe(September.To);
    }

    [Fact]
    public void A_line_that_ends_mid_period_stops_paying_the_day_after()
    {
        var part = BillingSchedule.Prorate(September, new DateOnly(2026, 1, 1), new DateOnly(2026, 9, 10));

        part.Factor.ShouldBe(0.3333m);
        part.To.ShouldBe(new DateOnly(2026, 9, 10));
    }

    [Fact]
    public void The_two_halves_of_a_mid_period_change_add_up_to_one_period()
    {
        // A revision on the 16th ends the old version on the 15th and starts the new one; together they are the whole month.
        var before = BillingSchedule.Prorate(September, new DateOnly(2026, 1, 1), new DateOnly(2026, 9, 15));
        var after = BillingSchedule.Prorate(September, new DateOnly(2026, 9, 16), null);

        (before.Factor + after.Factor).ShouldBe(1m);
    }

    [Fact]
    public void A_line_outside_the_period_is_not_billed()
    {
        BillingSchedule.Prorate(September, new DateOnly(2026, 10, 1), null).Factor.ShouldBe(0m);
        BillingSchedule.Prorate(September, new DateOnly(2026, 1, 1), new DateOnly(2026, 8, 31)).Factor.ShouldBe(0m);
    }

    [Fact]
    public void A_quarter_is_prorated_over_its_own_days()
    {
        var quarter = new CoveredPeriod(new DateOnly(2026, 7, 1), new DateOnly(2026, 9, 30));
        quarter.Days.ShouldBe(92);

        // 01.09–30.09 of a 92-day quarter.
        BillingSchedule.Prorate(quarter, new DateOnly(2026, 9, 1), null).Factor.ShouldBe(0.3261m);
    }
}
