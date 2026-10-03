using Crm.Contracts.Contracts;
using Crm.TimeTracking;
using Crm.TimeTracking.Contracts;
using Crm.TimeTracking.Domain;

namespace Crm.UnitTests;

public class TariffEngineTests
{
    private static readonly TimeTrackingOptions Options = new();

    private static ContractBillingTerms Terms(
        decimal includedHours = 0,
        string[]? coveredWorkTypes = null,
        decimal? overageRate = 1250m,
        decimal afterHoursMultiplier = 1.5m,
        SupportHours coverage = SupportHours.Business8x5) =>
        new(Guid.NewGuid(), "K-2026-0001", null, coverage, includedHours, coveredWorkTypes ?? [], afterHoursMultiplier, overageRate, new Dictionary<Guid, decimal>());

    private static TariffContext Context(
        ContractBillingTerms? contract = null,
        decimal coveredUsed = 0,
        IReadOnlyList<HourBankBalance>? banks = null,
        decimal? contractRate = null,
        decimal? catalogRate = 1100m) =>
        new(contract, coveredUsed, banks ?? [], contractRate, catalogRate, Options);

    private static HourBankBalance Bank(decimal remaining, decimal? overageRate = null) =>
        new(Guid.NewGuid(), "Klippekort", remaining, overageRate, new DateOnly(2026, 1, 1), null);

    [Fact]
    public void Work_that_is_not_billable_at_the_source_is_never_billed()
    {
        var parts = TariffEngine.Classify(new TariffInput(2m, Billable: false, "Remote", Onsite: false, AfterHours: false), Context());

        var part = parts.ShouldHaveSingleItem();
        part.Classification.ShouldBe(TimeClassification.NonBillable);
        part.BilledHours.ShouldBe(0);
    }

    [Fact]
    public void Sla_hours_are_used_first_and_only_up_to_the_monthly_limit()
    {
        var parts = TariffEngine.Classify(
            new TariffInput(3m, true, "Remote", false, false),
            Context(Terms(includedHours: 2m), coveredUsed: 0.5m));

        parts.Select(p => p.Classification).ShouldBe([TimeClassification.Covered, TimeClassification.Rate]);
        parts[0].Hours.ShouldBe(1.5m);
        parts[1].Hours.ShouldBe(1.5m);
        parts[1].Rate.ShouldBe(1250m);
    }

    [Fact]
    public void Sla_covers_only_the_work_types_it_lists()
    {
        var terms = Terms(includedHours: 5m, coveredWorkTypes: ["Remote"]);

        TariffEngine.Classify(new TariffInput(1m, true, "Remote", false, false), Context(terms))
            .ShouldHaveSingleItem().Classification.ShouldBe(TimeClassification.Covered);
        TariffEngine.Classify(new TariffInput(1m, true, "Onsite", false, false), Context(terms))
            .ShouldHaveSingleItem().Classification.ShouldBe(TimeClassification.Rate);
    }

    [Fact]
    public void An_hour_bank_with_too_few_hours_left_splits_the_entry()
    {
        var bank = Bank(1.5m, overageRate: 1400m);

        var parts = TariffEngine.Classify(new TariffInput(4m, true, "Remote", false, false), Context(banks: [bank]));

        parts.Select(p => p.Classification).ShouldBe([TimeClassification.HourBank, TimeClassification.Rate]);
        parts[0].Hours.ShouldBe(1.5m);
        parts[0].HourBankId.ShouldBe(bank.Id);
        parts[1].Hours.ShouldBe(2.5m);
        // The rest goes at the bank's own overage rate (BR-CON-05).
        parts[1].Rate.ShouldBe(1400m);
    }

    [Fact]
    public void The_rate_comes_from_the_contract_then_the_sla_then_the_catalog()
    {
        TariffEngine.Classify(new TariffInput(1m, true, "Remote", false, false), Context(Terms(), contractRate: 990m))
            .ShouldHaveSingleItem().Rate.ShouldBe(990m);
        TariffEngine.Classify(new TariffInput(1m, true, "Remote", false, false), Context(Terms()))
            .ShouldHaveSingleItem().Rate.ShouldBe(1250m);
        TariffEngine.Classify(new TariffInput(1m, true, "Remote", false, false), Context(Terms(overageRate: null)))
            .ShouldHaveSingleItem().Rate.ShouldBe(1100m);
        TariffEngine.Classify(new TariffInput(1m, true, "Remote", false, false), Context(contract: null))
            .ShouldHaveSingleItem().Rate.ShouldBe(1100m);
    }

    [Theory]
    [InlineData(0.1, 0.25)]
    [InlineData(0.25, 0.25)]
    [InlineData(0.3, 0.5)]
    [InlineData(1.6, 1.75)]
    public void Billed_hours_are_rounded_up_to_a_quarter(double hours, double expected) =>
        TariffEngine.Classify(new TariffInput((decimal)hours, true, "Remote", false, false), Context())
            .ShouldHaveSingleItem().BilledHours.ShouldBe((decimal)expected);

    [Fact]
    public void An_on_site_visit_bills_at_least_the_minimum()
    {
        TariffEngine.Classify(new TariffInput(0.5m, true, "Onsite", Onsite: true, AfterHours: false), Context())
            .ShouldHaveSingleItem().BilledHours.ShouldBe(1m);

        // Not when the visit already used covered or bank hours: the minimum applies to the visit, not to each part.
        var parts = TariffEngine.Classify(new TariffInput(1.5m, true, "Onsite", true, false), Context(banks: [Bank(1m)]));
        parts[1].BilledHours.ShouldBe(0.5m);
    }

    [Fact]
    public void Work_outside_support_hours_gets_the_contract_multiplier()
    {
        var parts = TariffEngine.Classify(new TariffInput(2m, true, "Remote", false, AfterHours: true), Context(Terms(afterHoursMultiplier: 2m)));

        parts.ShouldHaveSingleItem().Rate.ShouldBe(2500m);
    }

    [Theory]
    [InlineData("2026-09-16T09:00:00+02:00", SupportHours.Business8x5, false)]
    [InlineData("2026-09-16T17:30:00+02:00", SupportHours.Business8x5, true)]
    [InlineData("2026-09-16T17:30:00+02:00", SupportHours.Extended12x5, false)]
    [InlineData("2026-09-19T11:00:00+02:00", SupportHours.Extended12x5, true)]
    [InlineData("2026-09-19T11:00:00+02:00", SupportHours.Always24x7, false)]
    public void After_hours_follows_the_sla_coverage(string startedAt, SupportHours coverage, bool expected) =>
        TariffEngine.IsAfterHours(DateTimeOffset.Parse(startedAt, System.Globalization.CultureInfo.InvariantCulture), coverage).ShouldBe(expected);
}

public class TimeEntryTests
{
    private static ExternalTimeEntry Source(decimal hours = 1m, bool billable = true, string? description = "Work") => new(
        "Atera", "wh-1", Guid.NewGuid(), null, 42, "Printer", null, "17", "Kari", new DateOnly(2026, 9, 16),
        new DateTimeOffset(2026, 9, 16, 8, 0, 0, TimeSpan.FromHours(2)), null, hours, "Remote", billable, false, description);

    [Fact]
    public void Imported_entries_report_what_changed()
    {
        var source = Source();
        var entry = TimeEntry.FromSource(source);

        entry.DiffersFrom(source).ShouldBeFalse();
        entry.DiffersFrom(source with { Hours = 1.5m }).ShouldBeTrue();
        entry.DiffersFrom(source with { Description = "Other" }).ShouldBeTrue();
        entry.ApplySource(source with { Hours = 2m }).ShouldBeTrue();
        entry.Hours.ShouldBe(2m);
    }

    [Fact]
    public void Entries_from_the_service_desk_cannot_be_edited_in_the_crm()
    {
        var entry = TimeEntry.FromSource(Source());

        entry.Update(new ManualTimeEntry(Guid.NewGuid(), Guid.NewGuid(), new DateOnly(2026, 9, 16), 2m, "Remote", true, false, false, null, null, null, null, null))
            .Error!.Code.ShouldBe("TIM_SOURCE_OWNED");
    }

    [Fact]
    public void Approval_sums_the_amount_and_the_key_changes_on_every_approval()
    {
        var entry = TimeEntry.FromSource(Source(hours: 3m));
        var bankId = Guid.NewGuid();
        var firstKey = entry.ConsumptionKey(bankId);

        entry.Approve(Guid.NewGuid(), DateTimeOffset.UtcNow, null, [
            new TimeAllocation(entry.Id, TimeClassification.HourBank, 1m, 1m, null, bankId),
            new TimeAllocation(entry.Id, TimeClassification.Rate, 2m, 2m, 1000m, null),
        ]);

        entry.Status.ShouldBe(TimeEntryStatus.Approved);
        entry.Amount.ShouldBe(2000m);
        entry.DomainEvents.ShouldContain(e => e is TimeEntriesApproved);
        entry.Withdraw().IsSuccess.ShouldBeTrue();
        entry.Status.ShouldBe(TimeEntryStatus.New);
        // Withdrawn allocations stay as history; only the current ones are billed.
        entry.CurrentAllocations.ShouldBeEmpty();
        entry.Allocations.Count.ShouldBe(2);
        entry.ConsumptionKey(bankId).ShouldNotBe(firstKey);
    }

    [Fact]
    public void Entries_that_are_only_non_billable_end_up_non_billable()
    {
        var entry = TimeEntry.FromSource(Source(billable: false));

        entry.Approve(null, DateTimeOffset.UtcNow, null, [new TimeAllocation(entry.Id, TimeClassification.NonBillable, 1m, 0, null, null)]);

        entry.Status.ShouldBe(TimeEntryStatus.NonBillable);
        entry.Amount.ShouldBe(0);
    }
}

/// <summary>What may change on a time entry, and when (BR-TIM-01…03): the parts the approval scenario does not reach.</summary>
public class TimeEntryRulesTests
{
    private static ManualTimeEntry Manual(decimal hours = 2m, string? workType = "Remote") => new(
        Guid.NewGuid(), Guid.NewGuid(), new DateOnly(2026, 9, 16), hours, workType, true, false, false, " Oppsett ", null, null, null, null);

    private static TimeEntry Approved(TimeEntry entry)
    {
        entry.Approve(Guid.NewGuid(), DateTimeOffset.UtcNow, null, [new TimeAllocation(entry.Id, TimeClassification.Rate, entry.Hours, entry.Hours, 1_000m, null)]);
        return entry;
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    [InlineData(24.01)]
    public void Hours_are_above_zero_and_at_most_a_day(decimal hours)
    {
        TimeEntry.CreateManual(Manual(hours)).Error!.Code.ShouldBe("TIM_INVALID_HOURS");
        TimeEntry.CreateManual(Manual()).Value.Update(Manual(hours)).Error!.Code.ShouldBe("TIM_INVALID_HOURS");
    }

    [Fact]
    public void A_new_manual_entry_takes_every_change()
    {
        var entry = TimeEntry.CreateManual(Manual()).Value;
        var changed = Manual(3.456m, " Onsite ") with { Onsite = true, AfterHours = true, Description = "  ", ProjectId = Guid.NewGuid() };

        entry.Update(changed).IsSuccess.ShouldBeTrue();

        entry.Hours.ShouldBe(3.46m);
        entry.WorkType.ShouldBe("Onsite");
        entry.Onsite.ShouldBeTrue();
        entry.AfterHours.ShouldBeTrue();
        entry.Description.ShouldBeNull();
        entry.ProjectId.ShouldBe(changed.ProjectId);
        entry.OrganizationId.ShouldBe(changed.OrganizationId);
    }

    [Fact]
    public void An_approved_entry_is_changed_only_after_the_approval_is_withdrawn()
    {
        var entry = Approved(TimeEntry.CreateManual(Manual()).Value);

        entry.Update(Manual(4m)).Error!.Code.ShouldBe("TIM_NOT_EDITABLE");
        entry.Adjust(false, "Remote", false).Error!.Code.ShouldBe("TIM_NOT_EDITABLE");

        entry.Withdraw().IsSuccess.ShouldBeTrue();
        entry.Adjust(false, " Onsite ", true).IsSuccess.ShouldBeTrue();
        entry.Billable.ShouldBeFalse();
        entry.WorkType.ShouldBe("Onsite");
        entry.AfterHours.ShouldBeTrue();
    }

    [Fact]
    public void An_invoiced_entry_stays_as_it_was_billed()
    {
        var entry = Approved(TimeEntry.CreateManual(Manual()).Value);
        entry.MarkInvoiced();

        entry.Status.ShouldBe(TimeEntryStatus.Invoiced);
        entry.Withdraw().Error!.Code.ShouldBe("TIM_INVOICED");
        entry.Adjust(false, null, false).Error!.Code.ShouldBe("TIM_NOT_EDITABLE");
        entry.CurrentAllocations.ShouldHaveSingleItem();
    }

    [Fact]
    public void Marking_an_unapproved_entry_invoiced_changes_nothing()
    {
        var entry = TimeEntry.CreateManual(Manual()).Value;

        entry.MarkInvoiced();

        entry.Status.ShouldBe(TimeEntryStatus.New);
    }

    [Fact]
    public void A_review_note_is_kept_short_and_can_be_cleared()
    {
        var entry = TimeEntry.CreateManual(Manual()).Value;

        entry.FlagForReview(new string('x', 600));
        entry.ReviewNote!.Length.ShouldBe(512);

        entry.ClearReview();
        entry.ReviewNote.ShouldBeNull();
    }

    [Fact]
    public void Deleting_an_entry_deletes_its_allocations()
    {
        var entry = Approved(TimeEntry.CreateManual(Manual()).Value);

        entry.MarkDeleted();

        entry.IsDeleted.ShouldBeTrue();
        entry.Allocations.ShouldAllBe(a => a.IsDeleted);
    }

    [Fact]
    public void A_mapped_technician_is_assigned_to_an_imported_entry()
    {
        var entry = TimeEntry.FromSource(new ExternalTimeEntry(
            "Atera", "wh-9", Guid.NewGuid(), null, null, null, null, "17", "Kari", new DateOnly(2026, 9, 16), null, null, 1m, "Remote", true, false, null));
        var userId = Guid.NewGuid();

        entry.AssignTechnician(userId);

        entry.TechnicianId.ShouldBe(userId);
    }
}
