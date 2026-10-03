using Crm.Billing.Contracts;
using Crm.Billing.Domain;
using Crm.Contracts.Contracts;
using Crm.Integrations.PowerOffice;

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

    private static LineDraft Draft(BillingGroup group = BillingGroup.Subscription, decimal quantity = 25, decimal price = 250, decimal discount = 0) =>
        new(group, Guid.NewGuid(), "Microsoft 365 Business Premium (01.09.2026–30.09.2026)", quantity, price, discount, 25m, null);

    [Fact]
    public void The_total_is_the_sum_of_the_lines_after_discount()
    {
        var basis = BillingBasis.Create(Run(), Guid.NewGuid(), null);

        basis.ReplaceCollectedLines([Draft(), Draft(BillingGroup.HourlyWork, 3, 1_250), Draft(BillingGroup.Subscription, 1, 5_000)], null).IsSuccess.ShouldBeTrue();

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
    public void Re_collecting_replaces_collected_lines_and_keeps_manual_ones()
    {
        var basis = BillingBasis.Create(Run(), Guid.NewGuid(), null);
        basis.ReplaceCollectedLines([Draft()], null);
        basis.AddManualLine(Draft(BillingGroup.OneOff, 1, 2_000)).IsSuccess.ShouldBeTrue();

        basis.ReplaceCollectedLines([Draft(quantity: 30)], null);

        basis.CurrentLines.Count().ShouldBe(2);
        basis.CurrentLines.Single(l => l.Group == BillingGroup.OneOff).LineTotal.ShouldBe(2_000m);
        basis.CurrentLines.Single(l => l.Group == BillingGroup.Subscription).Quantity.ShouldBe(30m);
        basis.TotalExVat.ShouldBe(9_500m);
    }

    [Fact]
    public void An_approved_basis_cannot_be_changed_any_more()
    {
        var basis = BillingBasis.Create(Run(), Guid.NewGuid(), null);
        basis.ReplaceCollectedLines([Draft()], null);
        basis.Approve();

        basis.Status.ShouldBe(BillingBasisStatus.Approved);
        basis.AddManualLine(Draft()).Error!.Code.ShouldBe("BIL_BASIS_LOCKED");
        basis.ReplaceCollectedLines([Draft()], null).Error!.Code.ShouldBe("BIL_BASIS_LOCKED");
        basis.RemoveLine(basis.CurrentLines.First().Id).Error!.Code.ShouldBe("BIL_BASIS_LOCKED");
    }

    [Fact]
    public void A_basis_with_nothing_but_information_lines_is_cancelled_instead_of_exported()
    {
        var basis = BillingBasis.Create(Run(), Guid.NewGuid(), null);
        basis.ReplaceCollectedLines([new LineDraft(BillingGroup.Info, null, "Included in the contract", 4, 0, 0, 0, null)], null);

        basis.Approve();

        basis.Status.ShouldBe(BillingBasisStatus.Cancelled);
        basis.TotalExVat.ShouldBe(0m);
    }

    [Fact]
    public void Exporting_twice_with_the_same_order_number_changes_nothing()
    {
        var basis = BillingBasis.Create(Run(), Guid.NewGuid(), null);
        basis.ReplaceCollectedLines([Draft()], null);
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
        basis.ReplaceCollectedLines([Draft()], null);
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
    public void Approval_needs_a_collected_run_and_raises_an_event()
    {
        var run = BillingRun.Create(2026, 9, null);
        var user = Guid.NewGuid();

        run.Approve(user, DateTimeOffset.UtcNow).Error!.Code.ShouldBe("BIL_INVALID_STATUS");
        run.MarkCollected(DateTimeOffset.UtcNow, requiresSecondApproval: false);
        run.Approve(user, DateTimeOffset.UtcNow).IsSuccess.ShouldBeTrue();

        run.Status.ShouldBe(BillingRunStatus.Approved);
        run.DomainEvents.OfType<BillingRunApproved>().ShouldHaveSingleItem();
    }

    [Fact]
    public void Above_the_threshold_the_run_waits_for_a_second_approver()
    {
        var run = BillingRun.Create(2026, 9, null);
        run.MarkCollected(DateTimeOffset.UtcNow, requiresSecondApproval: true);
        var finance = Guid.NewGuid();

        run.Approve(finance, DateTimeOffset.UtcNow).IsSuccess.ShouldBeTrue();
        run.Status.ShouldBe(BillingRunStatus.InReview);
        run.DomainEvents.ShouldBeEmpty();

        run.SecondApprove(finance, DateTimeOffset.UtcNow).Error!.Code.ShouldBe("BIL_SAME_APPROVER");
        run.SecondApprove(Guid.NewGuid(), DateTimeOffset.UtcNow).IsSuccess.ShouldBeTrue();

        run.Status.ShouldBe(BillingRunStatus.Approved);
        run.DomainEvents.OfType<BillingRunApproved>().ShouldHaveSingleItem();
    }

    [Fact]
    public void A_run_is_closed_only_after_it_was_exported()
    {
        var run = BillingRun.Create(2026, 9, null);
        run.MarkCollected(DateTimeOffset.UtcNow, false);
        run.Approve(Guid.NewGuid(), DateTimeOffset.UtcNow);

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

        var approved = BillingRun.Create(2026, 10, null);
        approved.MarkCollected(DateTimeOffset.UtcNow, false);
        approved.Approve(Guid.NewGuid(), DateTimeOffset.UtcNow);
        approved.Discard().Error!.Code.ShouldBe("BIL_INVALID_STATUS");
    }
}

public class InvoiceMirrorTests
{
    private static ExternalInvoice Source(decimal total = 12_500m, decimal outstanding = 12_500m, InvoiceStatus status = InvoiceStatus.Sent) =>
        new("poweroffice", "10042", "1042", "2026-09-key", null, new DateOnly(2026, 10, 1), new DateOnly(2026, 10, 15), total, outstanding, status, null);

    [Fact]
    public void A_smaller_outstanding_amount_becomes_a_payment()
    {
        var now = DateTimeOffset.Parse("2026-10-20T08:00:00Z", System.Globalization.CultureInfo.InvariantCulture);
        var invoice = Invoice.From(Source(), Guid.NewGuid(), Guid.NewGuid(), now);
        invoice.Payments.ShouldBeEmpty();

        invoice.Apply(Source(outstanding: 2_500m, status: InvoiceStatus.PartiallyPaid), null, null, now.AddDays(1)).ShouldBeTrue();

        var payment = invoice.Payments.ShouldHaveSingleItem();
        payment.Amount.ShouldBe(10_000m);
        payment.PaidAt.ShouldBe(new DateOnly(2026, 10, 21));
        invoice.Outstanding.ShouldBe(2_500m);
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
