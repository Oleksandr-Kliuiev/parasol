using System.Globalization;
using System.Text.Json;
using Crm.Billing.Contracts;
using Crm.Billing.Domain;

namespace Crm.UnitTests;

/// <summary>
/// Regressions for the billing defects of the audit of 2026-10-03 (docs/10-audit-2026-10-03.md, A01 and A02). Each test states
/// the required invariant, not the audited behaviour, so it stays red until DEV-01 (A01) or DEV-02 (A02) fixes the defect.
/// The "Regression" trait lists them; they are never skipped.
/// </summary>
public class BillingRegressionTests
{
    private static readonly DateTimeOffset Now = DateTimeOffset.Parse("2026-10-03T08:00:00Z", CultureInfo.InvariantCulture);
    private static readonly Guid ProductId = Guid.NewGuid();

    /// <summary>A collected contract line, with the source references the collector writes.</summary>
    private static LineDraft ContractLine(decimal unitPrice, Guid contractId, Guid contractLineId) => new(
        BillingGroup.Subscription,
        ProductId,
        "Managed services (01.09.2026–30.09.2026)",
        1,
        unitPrice,
        0,
        25m,
        JsonSerializer.Serialize(new { contractId, contractLineId, subscriptionIds = (string[]?)null, prorationFactor = (decimal?)null }),
        $"contract:{contractLineId:N}:2026-09-01:2026-09-30");

    private static BillingRun CollectedRun(bool requiresSecondApproval)
    {
        var run = BillingRun.Create(2026, 9, null);
        run.MarkCollected(Now, requiresSecondApproval).IsSuccess.ShouldBeTrue();
        return run;
    }

    [Theory]
    [InlineData(1)]
    [InlineData(10)]
    [Trait("Regression", "A01")]
    public void A01_a_corrected_line_stays_one_position_at_the_corrected_amount_when_its_source_is_collected_again(int recollects)
    {
        var basis = BillingBasis.Create(BillingRun.Create(2026, 9, null), Guid.NewGuid(), null);
        var source = ContractLine(1_000m, Guid.NewGuid(), Guid.NewGuid());
        basis.ApplyCollected([source], null).IsSuccess.ShouldBeTrue();
        var collected = basis.CurrentLines.Single();

        // Finance corrects the collected 1 000 to 900.
        basis.UpdateLine(collected.Id, 1, 900m, 0, collected.Description, "Agreed discount", Guid.NewGuid(), Now).IsSuccess.ShouldBeTrue();
        basis.TotalExVat.ShouldBe(900m);

        // The same, unchanged contract line is collected again.
        for (var i = 0; i < recollects; i++)
        {
            basis.ApplyCollected([source], null).IsSuccess.ShouldBeTrue();
        }

        // One economic position keeps the correction; the audited code keeps it and bills the source a second time (1 900).
        basis.TotalExVat.ShouldBe(900m);
        basis.CurrentLines.Count().ShouldBe(1);
    }

    [Fact]
    [Trait("Regression", "A02")]
    public void A02_one_person_cannot_give_both_approvals_by_signing_the_second_one_first()
    {
        var run = CollectedRun(requiresSecondApproval: true);
        var approver = Guid.NewGuid();

        run.SecondApprove(approver, Now);
        run.Approve(approver, Now);

        // Two approvals are two people, whichever order they sign in (BR-BIL-04).
        run.Status.ShouldNotBe(BillingRunStatus.Approved);
        run.DomainEvents.OfType<BillingRunApproved>().ShouldBeEmpty();
    }

    [Fact]
    [Trait("Regression", "A02")]
    public void A02_an_approval_given_before_a_recollect_does_not_count_for_the_recollected_content()
    {
        var run = CollectedRun(requiresSecondApproval: true);
        run.Approve(Guid.NewGuid(), Now).IsSuccess.ShouldBeTrue();

        // The run is collected again after the first signature, so its content may have changed.
        run.MarkCollected(Now.AddMinutes(5), requiresSecondApproval: true);
        run.SecondApprove(Guid.NewGuid(), Now.AddMinutes(10));

        // Only one signature belongs to the recollected content; it must not be released.
        run.Status.ShouldNotBe(BillingRunStatus.Approved);
        run.DomainEvents.OfType<BillingRunApproved>().ShouldBeEmpty();
    }

    [Fact]
    [Trait("Regression", "A02")]
    public void A02_a_manual_line_that_lifts_a_basis_over_the_threshold_needs_a_second_approval()
    {
        // Collected below the 200 000 threshold (BillingOptions.SecondApprovalThreshold).
        var run = CollectedRun(requiresSecondApproval: false);
        var basis = BillingBasis.Create(run, Guid.NewGuid(), null);
        basis.ApplyCollected([ContractLine(10_000m, Guid.NewGuid(), Guid.NewGuid())], null).IsSuccess.ShouldBeTrue();
        basis.AddManualLine(new LineDraft(BillingGroup.OneOff, null, "Prosjektleveranse", 1, 300_000m, 0, 25m, null), Guid.NewGuid(), Now).IsSuccess.ShouldBeTrue();
        basis.TotalExVat.ShouldBe(310_000m);

        run.Approve(Guid.NewGuid(), Now);

        // A basis above the threshold is never released by one person, however its amount got there (BR-BIL-04).
        run.Status.ShouldNotBe(BillingRunStatus.Approved);
        run.DomainEvents.OfType<BillingRunApproved>().ShouldBeEmpty();
    }
}
