using Crm.Contracts.Contracts;
using Crm.Contracts.Domain;

namespace Crm.UnitTests;

public class ContractsDomainTests
{
    private static readonly DateOnly Start = new(2026, 1, 1);
    private static readonly DateOnly End = new(2026, 12, 31);

    private static ContractTerms Terms(bool autoRenew = true, int noticeDays = 90) => new(
        "Managed services", ContractType.Msp, Start, End, autoRenew, 12, noticeDays, null, InvoiceFrequency.Monthly, InvoiceTiming.InAdvance,
        null, false, null, null, null, null);

    private static Contract ActiveContract(bool autoRenew = true)
    {
        var contract = Contract.Create("K-2026-0001", Guid.NewGuid(), Terms(autoRenew)).Value;
        contract.Activate().IsSuccess.ShouldBeTrue();
        contract.ClearDomainEvents();
        return contract;
    }

    private static LineTerms Line(decimal? price = 450m) =>
        new(Guid.NewGuid(), null, QuantityModel.PerAteraDevice, DeviceFilter.Workstations, 23, price, 0, Start, null);

    [Fact]
    public void Status_flow_follows_the_specification()
    {
        var contract = Contract.Create("K-2026-0001", Guid.NewGuid(), Terms()).Value;
        contract.Suspend().Error!.Code.ShouldBe("CON_INVALID_STATUS");

        contract.Activate().IsSuccess.ShouldBeTrue();
        contract.DomainEvents.ShouldContain(e => e is ContractActivated);
        contract.Suspend().IsSuccess.ShouldBeTrue();
        contract.Activate().IsSuccess.ShouldBeTrue();
        contract.GiveNotice(new DateOnly(2026, 9, 1), End).IsSuccess.ShouldBeTrue();
        contract.Status.ShouldBe(ContractStatus.NoticeGiven);
        contract.WithdrawNotice().IsSuccess.ShouldBeTrue();
        contract.Status.ShouldBe(ContractStatus.Active);
        contract.End(new DateOnly(2026, 6, 30)).IsSuccess.ShouldBeTrue();
        contract.Status.ShouldBe(ContractStatus.Ended);
        contract.EndDate.ShouldBe(new DateOnly(2026, 6, 30));
        contract.Activate().Error!.Code.ShouldBe("CON_INVALID_STATUS");
    }

    [Fact]
    public void Notice_cannot_be_shorter_than_the_notice_period()
    {
        var contract = ActiveContract();
        var result = contract.GiveNotice(new DateOnly(2026, 11, 1), End);

        result.Error!.Code.ShouldBe("CON_NOTICE_TOO_SHORT");
        result.Error.Metadata!["earliestEndDate"].ShouldBe("2027-01-30");
    }

    [Fact]
    public void Auto_renewing_contract_is_extended_by_the_renewal_term_at_the_end_date()
    {
        var contract = ActiveContract();

        contract.ApplyEndOfTerm(End).ShouldBeFalse();
        contract.ApplyEndOfTerm(End.AddDays(1)).ShouldBeTrue();

        contract.Status.ShouldBe(ContractStatus.Active);
        contract.EndDate.ShouldBe(new DateOnly(2027, 12, 31));
        contract.RenewalCount.ShouldBe(1);
        contract.DomainEvents.ShouldHaveSingleItem().ShouldBeOfType<ContractRenewed>();
    }

    [Fact]
    public void Contract_under_notice_or_without_auto_renewal_ends_at_the_end_date()
    {
        var noRenewal = ActiveContract(autoRenew: false);
        noRenewal.AddLine(Line());
        noRenewal.ApplyEndOfTerm(End.AddDays(1)).ShouldBeTrue();
        noRenewal.Status.ShouldBe(ContractStatus.Ended);
        noRenewal.Lines.ShouldAllBe(l => l.ValidTo == End);

        var underNotice = ActiveContract();
        underNotice.GiveNotice(new DateOnly(2026, 8, 1), End);
        underNotice.ApplyEndOfTerm(End.AddDays(1)).ShouldBeTrue();
        underNotice.Status.ShouldBe(ContractStatus.Ended);
    }

    [Fact]
    public void Price_change_on_a_running_contract_creates_a_new_line_version()
    {
        var contract = ActiveContract();
        var original = contract.AddLine(Line()).Value;
        var effective = new DateOnly(2026, 7, 1);

        var revised = contract.ReviseLine(original.Id, Line(480m) with { ProductId = original.ProductId }, effective).Value;

        original.ValidTo.ShouldBe(new DateOnly(2026, 6, 30));
        revised.SeriesId.ShouldBe(original.SeriesId);
        revised.Version.ShouldBe(2);
        revised.UnitPrice.ShouldBe(480m);
        revised.ValidFrom.ShouldBe(effective);
        contract.LinesOn(new DateOnly(2026, 6, 30)).ShouldHaveSingleItem().ShouldBe(original);
        contract.LinesOn(effective).ShouldHaveSingleItem().ShouldBe(revised);
        contract.ReviseLine(revised.Id, Line(500m), effective).Error!.Code.ShouldBe("CON_REVISION_DATE");
    }

    [Fact]
    public void Draft_lines_are_edited_in_place()
    {
        var contract = Contract.Create("K-2026-0002", Guid.NewGuid(), Terms()).Value;
        var line = contract.AddLine(Line()).Value;

        contract.ReviseLine(line.Id, Line(399m), Start).Value.ShouldBeSameAs(line);
        contract.Lines.ShouldHaveSingleItem().UnitPrice.ShouldBe(399m);
    }

    [Fact]
    public void Line_amount_matches_the_acceptance_example() =>
        ContractLine.Amount(23, 450m, 0).ShouldBe(10_350m);

    [Fact]
    public void Hour_bank_warns_below_twenty_percent_and_records_overage()
    {
        var now = DateTimeOffset.UtcNow;
        var (bank, _) = HourBank.Create(Guid.NewGuid(), null, "Klippekort 20 t", 20m, Start, null, 1250m, null).Value;
        bank.Consume(15.5m, Start, "Setup", null, null, now);
        bank.RemainingHours.ShouldBe(4.5m);
        bank.DomainEvents.ShouldBeEmpty();

        bank.Consume(1m, Start, "Printer", null, null, now);
        bank.RemainingHours.ShouldBe(3.5m);
        bank.DomainEvents.ShouldHaveSingleItem().ShouldBeOfType<HourBankLow>().RemainingHours.ShouldBe(3.5m);

        bank.Consume(1m, Start, "More", null, null, now);
        bank.DomainEvents.Count.ShouldBe(1);

        var overage = bank.Consume(5m, Start, "Big job", null, null, now).Value;
        overage.Hours.ShouldBe(-2.5m);
        overage.OverageHours.ShouldBe(2.5m);
        bank.RemainingHours.ShouldBe(0m);

        bank.Purchase(20m, Start, "Top-up");
        bank.LowBalanceNotifiedAt.ShouldBeNull();
    }

    [Theory]
    [InlineData("2026-10-01", null)]
    [InlineData("2026-11-01", 60)]
    [InlineData("2026-12-01", 30)]
    [InlineData("2026-12-20", 30)]
    [InlineData("2026-12-24", 7)]
    [InlineData("2026-12-31", 7)]
    [InlineData("2027-01-01", null)]
    public void Renewal_reminder_step_is_the_nearest_threshold(string today, int? expected) =>
        RenewalSchedule.DueStep(End, DateOnly.Parse(today, System.Globalization.CultureInfo.InvariantCulture)).ShouldBe(expected);

    [Fact]
    public void Notice_task_is_due_from_notice_period_plus_thirty_days_before_the_end()
    {
        var contract = ActiveContract();
        RenewalSchedule.NoticeTaskDue(contract, End.AddDays(-121)).ShouldBeFalse();
        RenewalSchedule.NoticeTaskDue(contract, End.AddDays(-120)).ShouldBeTrue();
        RenewalSchedule.NoticeTaskDue(contract, End.AddDays(-90)).ShouldBeTrue();
        RenewalSchedule.NoticeTaskDue(contract, End.AddDays(-89)).ShouldBeFalse();
    }
}

public class ContractIndexationTests
{
    private static readonly DateOnly Start = new(2026, 1, 1);

    private static Contract Contract(bool indexation = true) =>
        Crm.Contracts.Domain.Contract.Create("K-2026-0007", Guid.NewGuid(), new ContractTerms(
            "Managed services", ContractType.Msp, Start, null, true, 12, 90, null, InvoiceFrequency.Monthly, InvoiceTiming.InAdvance,
            null, indexation, new DateOnly(2027, 1, 1), null, null, null)).Value;

    private static LineTerms Line(decimal? price, DateOnly? validFrom = null) =>
        new(Guid.NewGuid(), null, QuantityModel.Fixed, DeviceFilter.All, 10, price, 0, validFrom ?? Start, null);

    [Fact]
    public void Indexation_gives_every_priced_line_a_new_version_from_the_effective_date()
    {
        var contract = Contract();
        var line = contract.AddLine(Line(450m)).Value;
        contract.Activate();
        var effectiveFrom = new DateOnly(2027, 1, 1);

        var indexed = contract.Index(3.5m, effectiveFrom).Value;

        var change = indexed.ShouldHaveSingleItem();
        change.PriceBefore.ShouldBe(450m);
        change.PriceAfter.ShouldBe(465.75m);
        // The old version stops the day before, so the run bills each version for its own days (FR-BIL-05).
        line.ValidTo.ShouldBe(new DateOnly(2026, 12, 31));
        var versions = contract.Lines.Where(l => l.SeriesId == line.SeriesId).OrderBy(l => l.Version).ToList();
        versions.Count.ShouldBe(2);
        versions[1].UnitPrice.ShouldBe(465.75m);
        versions[1].ValidFrom.ShouldBe(effectiveFrom);
        contract.NextIndexationDate.ShouldBe(new DateOnly(2028, 1, 1));
    }

    [Fact]
    public void A_line_that_follows_the_price_list_is_left_alone()
    {
        var contract = Contract();
        contract.AddLine(Line(null));
        contract.Activate();

        contract.Index(3.5m, new DateOnly(2027, 1, 1)).Value.ShouldBeEmpty();
        contract.Lines.ShouldHaveSingleItem().UnitPrice.ShouldBeNull();
    }

    [Fact]
    public void A_line_that_has_not_started_yet_carries_the_new_price_without_a_version()
    {
        var contract = Contract();
        contract.AddLine(Line(1000m, new DateOnly(2027, 3, 1)));
        contract.Activate();

        contract.Index(10m, new DateOnly(2027, 1, 1)).Value.ShouldBeEmpty();
        var line = contract.Lines.ShouldHaveSingleItem();
        line.UnitPrice.ShouldBe(1000m);

        // From its own start date the line is in force, and then indexation does reach it.
        contract.Index(10m, new DateOnly(2027, 3, 1)).Value.ShouldHaveSingleItem().PriceAfter.ShouldBe(1100m);
        contract.Lines.ShouldHaveSingleItem().UnitPrice.ShouldBe(1100m);
    }

    [Fact]
    public void An_ended_contract_is_not_indexed()
    {
        var contract = Contract();
        contract.AddLine(Line(450m));
        contract.Activate();
        contract.End(new DateOnly(2026, 6, 30));

        contract.Index(3m, new DateOnly(2027, 1, 1)).Error!.Code.ShouldBe("CON_INVALID_STATUS");
    }
}

/// <summary>Rules of a contract's life that the scenario tests above do not reach (BR-CON-01…04).</summary>
public class ContractRulesTests
{
    private static readonly DateOnly Start = new(2026, 1, 1);
    private static readonly DateOnly End = new(2026, 12, 31);

    private static ContractTerms Terms(DateOnly? end = null, Guid? slaPolicyId = null) => new(
        "Managed services", ContractType.Msp, Start, end ?? End, false, 0, 90, slaPolicyId, InvoiceFrequency.Monthly, InvoiceTiming.InAdvance,
        null, false, null, null, null, null);

    private static Contract Draft(ContractTerms? terms = null) => Contract.Create("K-2026-0002", Guid.NewGuid(), terms ?? Terms()).Value;

    private static Contract Active(ContractTerms? terms = null)
    {
        var contract = Draft(terms);
        contract.Activate().IsSuccess.ShouldBeTrue();
        contract.ClearDomainEvents();
        return contract;
    }

    private static LineTerms Line(DateOnly from, DateOnly? to = null) =>
        new(Guid.NewGuid(), null, QuantityModel.Fixed, DeviceFilter.All, 1, 1_000m, 0, from, to);

    [Fact]
    public void A_contract_that_ends_before_it_starts_is_refused()
    {
        Contract.Create("K-2026-0003", Guid.NewGuid(), Terms(end: Start.AddDays(-1))).Error!.Code.ShouldBe("CON_INVALID_PERIOD");
        Active().Update(Guid.NewGuid(), Terms(end: Start.AddDays(-1))).Error!.Code.ShouldBe("CON_INVALID_PERIOD");
    }

    [Fact]
    public void Only_a_draft_can_be_moved_to_another_customer()
    {
        var draft = Draft();
        var newCustomer = Guid.NewGuid();
        draft.Update(newCustomer, Terms()).IsSuccess.ShouldBeTrue();
        draft.OrganizationId.ShouldBe(newCustomer);

        var running = Active();
        var customer = running.OrganizationId;
        running.Update(Guid.NewGuid(), Terms()).IsSuccess.ShouldBeTrue();
        running.OrganizationId.ShouldBe(customer);
    }

    [Fact]
    public void An_ended_contract_cannot_be_edited_and_a_notice_freezes_the_end_date()
    {
        var underNotice = Active();
        underNotice.GiveNotice(new DateOnly(2026, 6, 1), End).IsSuccess.ShouldBeTrue();
        underNotice.Update(underNotice.OrganizationId, Terms(end: End.AddMonths(6))).Error!.Code.ShouldBe("CON_NOTICE_GIVEN");
        underNotice.Update(underNotice.OrganizationId, Terms() with { Title = "Drift" }).IsSuccess.ShouldBeTrue();

        var ended = Active();
        ended.End(new DateOnly(2026, 3, 31)).IsSuccess.ShouldBeTrue();
        ended.Update(ended.OrganizationId, Terms()).Error!.Code.ShouldBe("CON_INVALID_STATUS");
    }

    [Fact]
    public void Changing_the_sla_of_a_running_contract_tells_the_service_desk()
    {
        var draft = Draft();
        draft.Update(draft.OrganizationId, Terms(slaPolicyId: Guid.NewGuid())).IsSuccess.ShouldBeTrue();
        draft.DomainEvents.OfType<OrganizationSlaChanged>().ShouldBeEmpty();

        var running = Active();
        running.Update(running.OrganizationId, Terms(slaPolicyId: Guid.NewGuid())).IsSuccess.ShouldBeTrue();
        running.DomainEvents.OfType<OrganizationSlaChanged>().ShouldHaveSingleItem().OrganizationId.ShouldBe(running.OrganizationId);

        // The same SLA again is no change.
        running.ClearDomainEvents();
        running.Update(running.OrganizationId, Terms(slaPolicyId: running.SlaPolicyId)).IsSuccess.ShouldBeTrue();
        running.DomainEvents.ShouldBeEmpty();
    }

    [Fact]
    public void Notice_is_given_only_on_a_running_contract_and_never_ends_it_before_its_start()
    {
        Draft().GiveNotice(new DateOnly(2026, 6, 1), End).Error!.Code.ShouldBe("CON_INVALID_STATUS");

        // Notice given before the start: the earliest end is still before the contract begins.
        Active().GiveNotice(new DateOnly(2025, 6, 1), new DateOnly(2025, 9, 30)).Error!.Code.ShouldBe("CON_INVALID_PERIOD");

        Active().WithdrawNotice().Error!.Code.ShouldBe("CON_INVALID_STATUS");
    }

    [Fact]
    public void A_contract_ends_only_while_running_and_not_before_its_start()
    {
        Draft().End(new DateOnly(2026, 3, 31)).Error!.Code.ShouldBe("CON_INVALID_STATUS");
        Active().End(Start.AddDays(-1)).Error!.Code.ShouldBe("CON_INVALID_PERIOD");

        var contract = Active();
        contract.End(new DateOnly(2026, 3, 31)).IsSuccess.ShouldBeTrue();
        contract.EndedOn.ShouldBe(new DateOnly(2026, 3, 31));
    }

    [Fact]
    public void A_line_lies_within_the_contract_and_is_ended_rather_than_removed_once_it_runs()
    {
        var contract = Active();
        contract.AddLine(Line(Start.AddMonths(1), Start)).Error!.Code.ShouldBe("CON_INVALID_PERIOD");
        contract.AddLine(Line(Start.AddDays(-1))).Error!.Code.ShouldBe("CON_LINE_OUTSIDE_CONTRACT");
        contract.AddLine(Line(End.AddDays(1))).Error!.Code.ShouldBe("CON_LINE_OUTSIDE_CONTRACT");

        var line = contract.AddLine(Line(Start)).Value;
        contract.RemoveLine(line.Id).Error!.Code.ShouldBe("CON_NOT_DRAFT");
        contract.EndLine(line.Id, Start.AddDays(-1)).Error!.Code.ShouldBe("CON_REVISION_DATE");
        contract.EndLine(Guid.NewGuid(), End).Error!.Code.ShouldBe("CON_LINE_NOT_FOUND");
        contract.EndLine(line.Id, new DateOnly(2026, 6, 30)).IsSuccess.ShouldBeTrue();
        contract.LinesOn(new DateOnly(2026, 7, 1)).ShouldBeEmpty();
        contract.LinesOn(new DateOnly(2026, 6, 30)).ShouldHaveSingleItem();
    }

    [Fact]
    public void A_draft_line_is_removed_and_deleting_a_contract_deletes_its_lines()
    {
        var draft = Draft();
        var first = draft.AddLine(Line(Start)).Value;
        var second = draft.AddLine(Line(Start)).Value;

        draft.RemoveLine(Guid.NewGuid()).Error!.Code.ShouldBe("CON_LINE_NOT_FOUND");
        draft.RemoveLine(first.Id).IsSuccess.ShouldBeTrue();
        first.IsDeleted.ShouldBeTrue();
        second.IsDeleted.ShouldBeFalse();

        draft.MarkDeleted();
        draft.IsDeleted.ShouldBeTrue();
        second.IsDeleted.ShouldBeTrue();
    }

    [Fact]
    public void A_merge_moves_the_contract_and_undoing_it_moves_it_back()
    {
        var contract = Active();
        var original = contract.OrganizationId;
        var target = Guid.NewGuid();
        var mergeId = Guid.NewGuid();

        contract.MoveToOrganization(target, mergeId);
        contract.OrganizationId.ShouldBe(target);
        contract.PreviousOrganizationId.ShouldBe(original);
        contract.MovedByMergeId.ShouldBe(mergeId);

        contract.UndoMove();
        contract.OrganizationId.ShouldBe(original);
        contract.PreviousOrganizationId.ShouldBeNull();
        contract.MovedByMergeId.ShouldBeNull();
    }
}

/// <summary>The prepaid hours ledger (BR-CON-05): what the scenario test in ContractsDomainTests leaves out.</summary>
public class HourBankRulesTests
{
    private static readonly DateOnly From = new(2026, 1, 1);
    private static readonly DateTimeOffset Now = new(2026, 3, 1, 9, 0, 0, TimeSpan.Zero);

    private static HourBank Bank(decimal hours = 10m) =>
        HourBank.Create(Guid.NewGuid(), null, " Klippekort ", hours, From, null, 1_250m, null).Value.Bank;

    [Fact]
    public void A_bank_cannot_end_before_it_starts()
    {
        HourBank.Create(Guid.NewGuid(), null, "Klippekort", 10m, From, From.AddDays(-1), null, null).Error!.Code.ShouldBe("CON_INVALID_PERIOD");
    }

    [Fact]
    public void The_terms_change_without_touching_the_balance()
    {
        var bank = Bank();
        bank.Consume(4m, From, null, null, null, Now).IsSuccess.ShouldBeTrue();

        bank.UpdateTerms(" Klippekort 2026 ", new DateOnly(2026, 12, 31), 1_400m, 10m);

        bank.Name.ShouldBe("Klippekort 2026");
        bank.ValidTo.ShouldBe(new DateOnly(2026, 12, 31));
        bank.OverageRate.ShouldBe(1_400m);
        bank.LowBalancePct.ShouldBe(10m);
        bank.RemainingHours.ShouldBe(6m);
    }

    [Fact]
    public void A_closed_bank_takes_no_more_hours()
    {
        var bank = Bank();
        bank.Close();

        bank.Consume(1m, From, null, null, null, Now).Error!.Code.ShouldBe("CON_HOUR_BANK_CLOSED");
        bank.UsedHours.ShouldBe(0);
    }

    [Fact]
    public void Giving_back_more_hours_than_were_used_adds_them_to_the_purchase()
    {
        var bank = Bank();
        bank.Consume(2m, From, null, null, null, Now);

        var entry = bank.Adjust(3m, From, "Goodwill", Now);

        bank.UsedHours.ShouldBe(0);
        bank.PurchasedHours.ShouldBe(11m);
        bank.RemainingHours.ShouldBe(11m);
        entry.Kind.ShouldBe(HourBankEntryKind.Adjustment);
        entry.Hours.ShouldBe(3m);
    }

    [Fact]
    public void A_correction_that_leaves_the_bank_low_warns_once_and_a_top_up_rearms_the_warning()
    {
        var bank = Bank();

        bank.Adjust(-9m, From, "Booked twice in Atera", Now);
        bank.DomainEvents.OfType<HourBankLow>().ShouldHaveSingleItem().RemainingHours.ShouldBe(1m);
        bank.Adjust(-0.5m, From, "Again", Now);
        bank.DomainEvents.OfType<HourBankLow>().ShouldHaveSingleItem();

        bank.Purchase(20m, From, "Top-up");
        bank.LowBalanceNotifiedAt.ShouldBeNull();
        bank.Adjust(1m, From, "Correction", Now);
        bank.LowBalanceNotifiedAt.ShouldBeNull();
    }

    [Fact]
    public void A_merge_moves_the_bank_and_undoing_it_moves_it_back()
    {
        var bank = Bank();
        var original = bank.OrganizationId;
        var target = Guid.NewGuid();

        bank.MoveToOrganization(target, Guid.NewGuid());
        bank.OrganizationId.ShouldBe(target);
        bank.PreviousOrganizationId.ShouldBe(original);

        bank.UndoMove();
        bank.OrganizationId.ShouldBe(original);
        bank.PreviousOrganizationId.ShouldBeNull();
        bank.MovedByMergeId.ShouldBeNull();
    }
}
