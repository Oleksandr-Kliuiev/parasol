using System.Globalization;
using Crm.Billing.Contracts;
using Crm.Billing.Domain;

namespace Crm.UnitTests;

/// <summary>
/// The charge register across runs (DEV-03, docs/adr/ADR-013): an obligation moves Reserved → Committed → ExportConfirmed, an
/// unknown send holds it for reconciliation, only something never sent is released, and contract intervals of one series
/// never overlap however their boundaries are drawn.
/// </summary>
public class ChargeRegisterTests
{
    private static readonly DateTimeOffset Now = DateTimeOffset.Parse("2026-10-04T08:00:00Z", CultureInfo.InvariantCulture);

    private static DateOnly D(string date) => DateOnly.Parse(date, CultureInfo.InvariantCulture);

    private static (BillingBasis Basis, Charge Charge) Reserved(ChargeKind kind = ChargeKind.Contract)
    {
        var run = BillingRun.Create(2026, 9, null);
        var basis = BillingBasis.Create(run, Guid.NewGuid(), null);
        var claim = new ChargeClaim("contract:x:2026-09-01:2026-09-30", kind, 1_000m, Guid.NewGuid(), D("2026-09-01"), D("2026-09-30"), Guid.NewGuid());
        return (basis, Charge.Reserve(claim, basis.OrganizationId, basis, Guid.NewGuid(), Now));
    }

    [Fact]
    public void A_reserved_charge_is_committed_by_the_approval_and_confirmed_by_the_export()
    {
        var (basis, charge) = Reserved();
        charge.Status.ShouldBe(ChargeStatus.Reserved);
        charge.PayerOrganizationId.ShouldBe(basis.OrganizationId);
        charge.RunId.ShouldBe(basis.RunId);
        charge.Currency.ShouldBe("NOK");

        charge.Commit(Now).IsSuccess.ShouldBeTrue();
        charge.Status.ShouldBe(ChargeStatus.Committed);
        charge.ConfirmExport(Now).IsSuccess.ShouldBeTrue();
        charge.Status.ShouldBe(ChargeStatus.ExportConfirmed);

        // Confirming twice is fine; an exported obligation is never released — it is corrected with a new charge.
        charge.ConfirmExport(Now).IsSuccess.ShouldBeTrue();
        charge.Release(Now, "cancel").Error!.Code.ShouldBe("BIL_CHARGE_INVALID_STATUS");
        charge.IsActive.ShouldBeTrue();
    }

    [Fact]
    public void Only_a_charge_that_was_never_sent_is_released()
    {
        var (_, reserved) = Reserved();
        reserved.Release(Now, "The line left the basis.").IsSuccess.ShouldBeTrue();
        reserved.Status.ShouldBe(ChargeStatus.Released);
        reserved.IsActive.ShouldBeFalse();
        reserved.Reason.ShouldBe("The line left the basis.");

        var (_, committed) = Reserved();
        committed.Commit(Now).IsSuccess.ShouldBeTrue();
        committed.Release(Now, "Cancelled before sending.").IsSuccess.ShouldBeTrue();

        var (_, unknown) = Reserved();
        unknown.Commit(Now).IsSuccess.ShouldBeTrue();
        unknown.RequireReconciliation(Now, "No answer from PowerOffice.").IsSuccess.ShouldBeTrue();
        unknown.Release(Now, "cancel").Error!.Code.ShouldBe("BIL_CHARGE_INVALID_STATUS");
        unknown.Status.ShouldBe(ChargeStatus.ReconciliationRequired);
    }

    [Fact]
    public void Reconciliation_either_confirms_the_order_or_commits_the_charge_again()
    {
        var (_, found) = Reserved();
        found.Commit(Now).IsSuccess.ShouldBeTrue();
        found.RequireReconciliation(Now, "unknown").IsSuccess.ShouldBeTrue();
        found.ConfirmExport(Now, "Order 4711 found").IsSuccess.ShouldBeTrue();
        found.Status.ShouldBe(ChargeStatus.ExportConfirmed);

        var (_, missing) = Reserved();
        missing.Commit(Now).IsSuccess.ShouldBeTrue();
        missing.RequireReconciliation(Now, "unknown").IsSuccess.ShouldBeTrue();
        missing.ReconciledNotCreated(Now, "No order in PowerOffice").IsSuccess.ShouldBeTrue();
        missing.Status.ShouldBe(ChargeStatus.Committed);
        missing.Release(Now, "Cancelled after the check").IsSuccess.ShouldBeTrue();
    }

    [Fact]
    public void A_charge_follows_its_line_within_the_run_but_never_into_another_run()
    {
        var (basis, charge) = Reserved();
        var other = BillingBasis.Create(BillingRun.Create(2026, 9, null), Guid.NewGuid(), null);
        var claim = new ChargeClaim(charge.Key, ChargeKind.Contract, 900m);

        // Another run never takes over an obligation this run holds.
        charge.Refresh(claim, other.OrganizationId, other, Guid.NewGuid()).Error!.Code.ShouldBe("BIL_CHARGE_HELD_ELSEWHERE");

        var line = Guid.NewGuid();
        charge.Refresh(claim, basis.OrganizationId, basis, line).IsSuccess.ShouldBeTrue();
        charge.LineId.ShouldBe(line);
        charge.Amount.ShouldBe(900m);

        // Once committed the obligation is fixed.
        charge.Commit(Now).IsSuccess.ShouldBeTrue();
        charge.Refresh(claim, basis.OrganizationId, basis, Guid.NewGuid()).IsSuccess.ShouldBeFalse();
    }

    [Fact]
    public void Finance_decides_about_a_legacy_charge_once()
    {
        var run = BillingRun.Create(2026, 5, null);
        var legacy = Charge.Legacy("legacy:x", Guid.NewGuid(), run.Id, Guid.NewGuid(), Guid.NewGuid(), 5_000m, D("2026-05-01"), D("2026-05-31"), Guid.NewGuid(), "Unprovable", Now);
        legacy.Status.ShouldBe(ChargeStatus.LegacyUnresolved);
        legacy.Kind.ShouldBe(ChargeKind.Legacy);

        legacy.DecideLegacy(billed: true, "Invoiced in May by the old system", Now).IsSuccess.ShouldBeTrue();
        legacy.Status.ShouldBe(ChargeStatus.ExportConfirmed);
        legacy.DecideLegacy(billed: false, "again", Now).IsSuccess.ShouldBeFalse();

        var notBilled = Charge.Legacy("legacy:y", Guid.NewGuid(), run.Id, Guid.NewGuid(), Guid.NewGuid(), 5_000m, D("2026-05-01"), D("2026-05-31"), null, "Unprovable", Now);
        notBilled.DecideLegacy(billed: false, "Never reached PowerOffice", Now).IsSuccess.ShouldBeTrue();
        notBilled.Status.ShouldBe(ChargeStatus.Released);
    }

    [Fact]
    public void A_legacy_line_follows_its_basis_when_it_is_exported_or_cancelled_only_now()
    {
        var run = BillingRun.Create(2026, 5, null);
        var exported = Charge.Legacy("legacy:a", Guid.NewGuid(), run.Id, Guid.NewGuid(), Guid.NewGuid(), 1_000m, D("2026-05-01"), D("2026-05-31"), null, "Unprovable", Now);
        exported.ConfirmExport(Now, "exported with its basis").IsSuccess.ShouldBeTrue();
        exported.Status.ShouldBe(ChargeStatus.ExportConfirmed);

        var cancelled = Charge.Legacy("legacy:b", Guid.NewGuid(), run.Id, Guid.NewGuid(), Guid.NewGuid(), 1_000m, D("2026-05-01"), D("2026-05-31"), null, "Unprovable", Now);
        cancelled.Release(Now, "The basis was cancelled before anything was sent.").IsSuccess.ShouldBeTrue();
        cancelled.Status.ShouldBe(ChargeStatus.Released);

        // A released obligation is never confirmed: a new basis bills it with a new charge.
        cancelled.ConfirmExport(Now).IsSuccess.ShouldBeFalse();
    }

    [Fact]
    public void Nothing_taken_leaves_the_whole_interval()
    {
        ChargeCoverage.Uncovered(D("2027-01-01"), D("2027-03-31"), []).ShouldBe([(D("2027-01-01"), D("2027-03-31"))]);
    }

    [Fact]
    public void A_month_billed_before_leaves_the_rest_of_a_quarter()
    {
        // Monthly in advance for January, then the contract moves to quarterly: the quarter bills February and March only.
        ChargeCoverage.Uncovered(D("2027-01-01"), D("2027-03-31"), [(D("2027-01-01"), D("2027-01-31"))])
            .ShouldBe([(D("2027-02-01"), D("2027-03-31"))]);
    }

    [Fact]
    public void A_taken_interval_in_the_middle_splits_the_rest_in_two()
    {
        ChargeCoverage.Uncovered(D("2027-01-01"), D("2027-12-31"), [(D("2027-04-01"), D("2027-06-30"))])
            .ShouldBe([(D("2027-01-01"), D("2027-03-31")), (D("2027-07-01"), D("2027-12-31"))]);
    }

    [Fact]
    public void Overlapping_and_touching_intervals_are_subtracted_across_a_year_boundary()
    {
        ChargeCoverage.Uncovered(
                D("2026-12-01"), D("2027-02-28"),
                [(D("2027-01-15"), D("2027-03-31")), (D("2026-11-01"), D("2026-12-10")), (D("2026-12-11"), D("2026-12-31"))])
            .ShouldBe([(D("2027-01-01"), D("2027-01-14"))]);
    }

    [Fact]
    public void A_fully_billed_interval_leaves_nothing()
    {
        ChargeCoverage.Uncovered(D("2027-02-01"), D("2027-02-28"), [(D("2027-01-01"), D("2027-03-31"))]).ShouldBeEmpty();
    }

    [Fact]
    public void A_basis_whose_order_may_exist_is_neither_cancelled_nor_sent_again_without_reconciliation()
    {
        var run = BillingRun.Create(2026, 9, null);
        var basis = BillingBasis.Create(run, Guid.NewGuid(), null);
        basis.ApplyCollected([new LineDraft(BillingGroup.Subscription, null, "Drift", 1, 1_000m, 0, 25m, "{}", "contract:a:2026-09-01:2026-09-30")], null)
            .IsSuccess.ShouldBeTrue();
        basis.Approve().IsSuccess.ShouldBeTrue();

        basis.MarkSending("poweroffice", Now, "op-1").IsSuccess.ShouldBeTrue();
        basis.SendStartedAt.ShouldBe(Now);
        basis.Cancel(Now, "wrong customer").Error!.Code.ShouldBe("BIL_RECONCILE_FIRST");

        basis.RequireReconciliation("poweroffice", "No answer", Now, "op-2").IsSuccess.ShouldBeTrue();
        basis.Status.ShouldBe(BillingBasisStatus.ReconciliationRequired);
        basis.Cancel(Now, "wrong customer").Error!.Code.ShouldBe("BIL_RECONCILE_FIRST");
        basis.Retry().IsSuccess.ShouldBeFalse();

        basis.Reconcile(created: false, null, " ", "poweroffice", Now, null).Error!.Code.ShouldBe("BIL_REASON_REQUIRED");
        basis.Reconcile(created: true, null, "Checked", "poweroffice", Now, null).Error!.Code.ShouldBe("BIL_ORDER_NO_REQUIRED");
        basis.Reconcile(created: false, null, "Not in PowerOffice", "poweroffice", Now, null).IsSuccess.ShouldBeTrue();
        basis.Status.ShouldBe(BillingBasisStatus.Failed);
        basis.SendStartedAt.ShouldBeNull();
        basis.Cancel(Now, "wrong customer").IsSuccess.ShouldBeTrue();
        basis.Attempts.Select(a => a.Result).ShouldBe(["Sending", "ReconciliationRequired", "Reconciled", "Cancelled"]);
    }

    [Fact]
    public void Reconciliation_that_finds_the_order_records_it_like_a_send()
    {
        var basis = BillingBasis.Create(BillingRun.Create(2026, 9, null), Guid.NewGuid(), null);
        basis.ApplyCollected([new LineDraft(BillingGroup.Subscription, null, "Drift", 1, 1_000m, 0, 25m, "{}", "contract:a:2026-09-01:2026-09-30")], null)
            .IsSuccess.ShouldBeTrue();
        basis.Approve().IsSuccess.ShouldBeTrue();
        basis.MarkSending("poweroffice", Now, "op-1").IsSuccess.ShouldBeTrue();
        basis.RequireReconciliation("poweroffice", "No answer", Now, "op-2").IsSuccess.ShouldBeTrue();

        basis.Reconcile(created: true, " 4711 ", "Found by reference", "poweroffice", Now, null).IsSuccess.ShouldBeTrue();

        basis.Status.ShouldBe(BillingBasisStatus.Exported);
        basis.OrderNo.ShouldBe("4711");
        basis.DomainEvents.OfType<BillingBasisExported>().ShouldHaveSingleItem();
    }

    [Fact]
    public void An_order_made_by_hand_is_recorded_on_a_basis_that_is_not_being_sent()
    {
        var waiting = BillingBasis.Create(BillingRun.Create(2026, 9, null), Guid.NewGuid(), null);
        waiting.ApplyCollected([new LineDraft(BillingGroup.Subscription, null, "Drift", 1, 1_000m, 0, 25m, "{}", "contract:a:2026-09-01:2026-09-30")], null)
            .IsSuccess.ShouldBeTrue();
        waiting.Reconcile(created: true, "M-1", "Invoiced by hand", "poweroffice", Now, null).Error!.Code.ShouldBe("BIL_INVALID_BASIS_STATUS");
        waiting.Approve().IsSuccess.ShouldBeTrue();

        // "No order" only answers an unknown send; an order made by hand is recorded while nothing is being sent.
        waiting.Reconcile(created: false, null, "No order", "poweroffice", Now, null).Error!.Code.ShouldBe("BIL_INVALID_BASIS_STATUS");
        waiting.Reconcile(created: true, "M-1", "Invoiced by hand during the incident", "poweroffice", Now, null).IsSuccess.ShouldBeTrue();
        waiting.Status.ShouldBe(BillingBasisStatus.Exported);
        waiting.OrderNo.ShouldBe("M-1");

        var sending = BillingBasis.Create(BillingRun.Create(2026, 9, null), Guid.NewGuid(), null);
        sending.ApplyCollected([new LineDraft(BillingGroup.Subscription, null, "Drift", 1, 1_000m, 0, 25m, "{}", "contract:a:2026-09-01:2026-09-30")], null)
            .IsSuccess.ShouldBeTrue();
        sending.Approve().IsSuccess.ShouldBeTrue();
        sending.MarkSending("poweroffice", Now, "op").IsSuccess.ShouldBeTrue();
        sending.Reconcile(created: true, "M-2", "by hand", "poweroffice", Now, null).Error!.Code.ShouldBe("BIL_INVALID_BASIS_STATUS");
    }

    [Fact]
    public void A_rejected_order_clears_the_send_so_the_basis_can_be_fixed_and_cancelled()
    {
        var basis = BillingBasis.Create(BillingRun.Create(2026, 9, null), Guid.NewGuid(), null);
        basis.ApplyCollected([new LineDraft(BillingGroup.Subscription, null, "Drift", 1, 1_000m, 0, 25m, "{}", "contract:a:2026-09-01:2026-09-30")], null)
            .IsSuccess.ShouldBeTrue();
        basis.Approve().IsSuccess.ShouldBeTrue();
        basis.MarkSending("poweroffice", Now, "op-1").IsSuccess.ShouldBeTrue();

        basis.MarkFailed("poweroffice", "PowerOffice rejected the order: 400", Now, "op-1");

        basis.SendStartedAt.ShouldBeNull();
        basis.Cancel(Now, "Customer left").IsSuccess.ShouldBeTrue();
    }

    [Fact]
    public void A_cancelled_basis_is_never_sent()
    {
        var basis = BillingBasis.Create(BillingRun.Create(2026, 9, null), Guid.NewGuid(), null);
        basis.ApplyCollected([new LineDraft(BillingGroup.Subscription, null, "Drift", 1, 1_000m, 0, 25m, "{}", "contract:a:2026-09-01:2026-09-30")], null)
            .IsSuccess.ShouldBeTrue();
        basis.Approve().IsSuccess.ShouldBeTrue();
        basis.Cancel(Now, "Billed by hand").IsSuccess.ShouldBeTrue();

        basis.MarkSending("poweroffice", Now, "op-1").Error!.Code.ShouldBe("BIL_NOT_WAITING");
    }

    [Theory]
    [InlineData(400, true)]
    [InlineData(401, true)]
    [InlineData(422, true)]
    [InlineData(408, false)]
    [InlineData(409, false)]
    [InlineData(429, false)]
    [InlineData(500, false)]
    [InlineData(503, false)]
    [InlineData(200, false)]
    public void Only_a_refusal_proves_that_no_order_was_created(int status, bool rejection)
    {
        Crm.Integrations.PowerOffice.PowerOfficeCreateSalesOrderHandler.IsRejection((System.Net.HttpStatusCode)status).ShouldBe(rejection);
    }

    [Fact]
    public void A_correction_is_a_new_one_time_charge_that_refers_to_the_line_it_adds_to()
    {
        var line = Guid.NewGuid();
        var correction = PendingCharge.Correction(
            Guid.NewGuid(), Guid.NewGuid(), "Drift (correction)", 250m, 25m, line, Guid.NewGuid(), new string('x', 600), D("2026-10-04"));

        correction.SourceType.ShouldBe(PendingCharge.CorrectionSource);
        correction.SourceId.ShouldBe(line);
        correction.Quantity.ShouldBe(1m);
        correction.UnitPrice.ShouldBe(250m);
        correction.Reason!.Length.ShouldBe(512);
    }
}
