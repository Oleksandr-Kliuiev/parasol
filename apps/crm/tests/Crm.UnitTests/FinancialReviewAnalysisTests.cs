using Crm.Billing.Contracts;
using Crm.Contracts.Contracts;
using Crm.SharedKernel.Application;
using Crm.TimeTracking.Contracts;
using Crm.TimeTracking.Domain;
using Crm.TimeTracking.Features;

namespace Crm.UnitTests;

public sealed class FinancialReviewAnalysisTests
{
    private static readonly DateOnly Date = new(2093, 5, 17);
    private static TimeEntry Entry(decimal hours = 2m) => TimeEntry.CreateManual(new(Guid.NewGuid(), Guid.NewGuid(), Date, hours,
        "Remote", true, false, false, "Synthetic review", null, null, null, null)).Value;
    private static TimeAllocation BankPart(TimeEntry entry, Guid bank, decimal hours = 2m) => new(entry.Id, TimeClassification.HourBank, hours, hours, null, bank);
    private static SourceBankUsage Receipt(TimeEntry entry, Guid bank, int approval, decimal used, decimal returned = 0) =>
        new($"{entry.Id}:{approval}:{bank}", bank, entry.WorkDate, used, used, returned, true);
    private static HourBankReviewRef Bank(TimeEntry entry, Guid bank) => new(bank, entry.OrganizationId, "Synthetic bank", "Active", false);

    [Fact]
    public void Matching_saved_current_bank_facts_do_not_invent_a_review_or_a_repair()
    {
        var entry = Entry(); var bank = Guid.NewGuid(); var part = BankPart(entry, bank);
        entry.Approve(Guid.NewGuid(), DateTimeOffset.UtcNow, null, [part]);
        var result = FinancialReviewAnalysis.Evaluate(entry, [part.Id], [Receipt(entry, bank, 1, 2)], [Bank(entry, bank)], [], false);
        result.RequiresReview.ShouldBeFalse(); result.Findings.ShouldBeEmpty();
        result.Banks.ShouldHaveSingleItem().NetHours.ShouldBe(2m); entry.Status.ShouldBe(TimeEntryStatus.Approved);
    }

    [Fact]
    public void Pending_receipts_are_found_even_in_a_closed_bank_and_when_the_entry_is_still_new()
    {
        var entry = Entry(); var bank = Guid.NewGuid();
        var result = FinancialReviewAnalysis.Evaluate(entry, [], [Receipt(entry, bank, 1, 1)], [Bank(entry, bank) with { Status = "Closed" }], [], false);
        result.Findings.ShouldContain(f => f.Code == "BANK_PENDING_APPROVAL");
        result.Findings.ShouldContain(f => f.Code == "BANK_ALLOCATION_MISMATCH");
        result.Banks.ShouldHaveSingleItem().State.ShouldBe("Closed"); entry.Status.ShouldBe(TimeEntryStatus.New);
    }

    [Fact]
    public void Fully_returned_older_approvals_do_not_look_like_extra_current_consumption()
    {
        var entry = Entry(); var bank = Guid.NewGuid(); var first = BankPart(entry, bank);
        entry.Approve(null, DateTimeOffset.UtcNow, null, [first]); entry.Withdraw().IsSuccess.ShouldBeTrue();
        var next = BankPart(entry, bank); entry.Approve(null, DateTimeOffset.UtcNow, null, [next]);
        var result = FinancialReviewAnalysis.Evaluate(entry, [first.Id, next.Id], [Receipt(entry, bank, 1, 2, 2), Receipt(entry, bank, 2, 2)], [Bank(entry, bank)], [], false);
        result.RequiresReview.ShouldBeFalse(); result.Banks.ShouldHaveSingleItem().NetHours.ShouldBe(2m);
    }

    [Fact]
    public void A_returned_bank_with_still_approved_time_is_reported_without_changing_either_snapshot()
    {
        var entry = Entry(); var bank = Guid.NewGuid(); var part = BankPart(entry, bank); entry.Approve(null, DateTimeOffset.UtcNow, null, [part]);
        var result = FinancialReviewAnalysis.Evaluate(entry, [part.Id], [Receipt(entry, bank, 1, 2, 2)], [Bank(entry, bank)], [], false);
        result.Findings.ShouldContain(f => f.Code == "BANK_ALLOCATION_MISMATCH");
        result.Banks.ShouldHaveSingleItem().NetHours.ShouldBe(0m); entry.CurrentAllocations.Single().Hours.ShouldBe(2m);
    }

    [Fact]
    public void Balanced_totals_do_not_hide_inconsistent_receipts()
    {
        var entry = Entry(); var bank = Guid.NewGuid(); var part = BankPart(entry, bank); entry.Approve(null, DateTimeOffset.UtcNow, null, [part]);
        var result = FinancialReviewAnalysis.Evaluate(entry, [part.Id], [Receipt(entry, bank, 1, 2) with { Consistent = false }], [Bank(entry, bank)], [], false);
        result.Findings.ShouldContain(f => f.Code == "BANK_HISTORY_UNPROVEN"); result.RequiresReview.ShouldBeTrue();
    }

    [Fact]
    public void A_foreign_bank_name_is_not_returned_as_if_it_were_this_customers_bank()
    {
        var entry = Entry(); var bank = Guid.NewGuid(); var part = BankPart(entry, bank); entry.Approve(null, DateTimeOffset.UtcNow, null, [part]);
        var result = FinancialReviewAnalysis.Evaluate(entry, [part.Id], [Receipt(entry, bank, 1, 2)],
            [Bank(entry, bank) with { OrganizationId = Guid.NewGuid(), Name = "Synthetic other customer bank" }], [], false);
        result.Findings.ShouldContain(f => f.Code == "BANK_REFERENCE_UNAVAILABLE");
        result.Banks.ShouldHaveSingleItem().Name.ShouldBeNull(); result.Banks.Single().Available.ShouldBeFalse();
    }

    [Fact]
    public void A_same_entry_id_in_old_billing_does_not_prove_the_current_allocation_version()
    {
        var entry = Entry(); var old = new TimeAllocation(entry.Id, TimeClassification.Rate, 2m, 2m, 100m, null);
        entry.Approve(null, DateTimeOffset.UtcNow, null, [old]); entry.Withdraw().IsSuccess.ShouldBeTrue();
        var current = new TimeAllocation(entry.Id, TimeClassification.Rate, 2m, 2m, 100m, null); entry.Approve(null, DateTimeOffset.UtcNow, null, [current]);
        var result = FinancialReviewAnalysis.Evaluate(entry, [old.Id, current.Id], [], [], [new(Guid.NewGuid(), entry.OrganizationId, [entry.Id], [old.Id], true, true)], false);
        result.Findings.ShouldContain(f => f.Code == "BILLING_SOURCE_UNPROVEN");
        result.Billing.ShouldHaveSingleItem().CurrentRevision.ShouldBeFalse();
    }

    [Fact]
    public void Partial_export_is_explained_without_claiming_that_the_remaining_rate_was_exported()
    {
        var entry = Entry(3); var bank = Guid.NewGuid(); var prepaid = BankPart(entry, bank);
        var rate = new TimeAllocation(entry.Id, TimeClassification.Rate, 1m, 1m, 100m, null); entry.Approve(null, DateTimeOffset.UtcNow, null, [prepaid, rate]);
        var result = FinancialReviewAnalysis.Evaluate(entry, [prepaid.Id, rate.Id], [Receipt(entry, bank, 1, 2)], [Bank(entry, bank)],
            [new(Guid.NewGuid(), entry.OrganizationId, [entry.Id], [prepaid.Id], true, true)], false);
        result.Findings.ShouldContain(f => f.Code == "PARTIAL_EXPORT" && f.Level == FinancialFindingLevel.Info);
        result.Billing.ShouldHaveSingleItem().MatchedAllocations.ShouldBe(1); result.RequiresReview.ShouldBeFalse();
        entry.Status.ShouldBe(TimeEntryStatus.Approved);
    }

    [Fact]
    public void A_terminal_status_without_export_proof_requires_review()
    {
        var entry = Entry(); var part = new TimeAllocation(entry.Id, TimeClassification.Rate, 2m, 2m, 100m, null);
        entry.Approve(null, DateTimeOffset.UtcNow, null, [part]); entry.MarkInvoiced();
        FinancialReviewAnalysis.Evaluate(entry, [part.Id], [], [], [], true).Findings.ShouldContain(f => f.Code == "BILLING_SOURCE_UNPROVEN");
    }

    [Theory]
    [InlineData("time.read")] [InlineData("finance.read")] [InlineData("contracts.read")]
    [InlineData("billing.read")] [InlineData("customers.read")]
    public async Task Every_read_permission_is_required_before_any_data_lookup(string missing)
    {
        var service = new TimeFinancialReviewService(null!, null!, null!, null!, new User(missing), TimeProvider.System);
        (await service.ReadAsync(Guid.NewGuid(), TestContext.Current.CancellationToken)).Error!.Code.ShouldBe("TIM_REVIEW_FORBIDDEN");
    }

    private sealed class User(string missing) : ICurrentUser
    {
        public Guid? UserId { get; } = Guid.NewGuid();
        public string DisplayName => "Synthetic reviewer";
        public bool IsAuthenticated => true;
        public bool HasPermission(string permission) => permission != missing && TimeFinancialReviewService.RequiredPermissions.Contains(permission);
    }
}
