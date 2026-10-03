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
