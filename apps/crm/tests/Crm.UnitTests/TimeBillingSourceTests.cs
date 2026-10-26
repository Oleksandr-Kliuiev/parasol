using System.Text.Json;
using Crm.Billing.Features;
using Crm.TimeTracking.Contracts;
using Crm.TimeTracking.Domain;
using Crm.TimeTracking.Features;

namespace Crm.UnitTests;

public sealed class TimeBillingSourceTests
{
    [Fact]
    public void Entry_identity_without_allocation_identity_is_an_unproven_legacy_snapshot()
    {
        var claim = TimeBillingSources.Read(Guid.NewGuid(), Guid.NewGuid(), JsonSerializer.Serialize(new { timeEntryIds = new[] { Guid.NewGuid() } }), true, true)!;
        claim.Proven.ShouldBeFalse(); claim.EntryIds.Count.ShouldBe(1); claim.AllocationIds.ShouldBeEmpty();
    }

    [Fact]
    public void Duplicate_json_properties_cannot_select_a_different_financial_revision()
    {
        var entry = Guid.NewGuid(); var allocation = Guid.NewGuid();
        var json = $$"""{"timeEntryIds":["{{entry}}"],"allocationIds":["{{allocation}}"],"allocationIds":["{{Guid.NewGuid()}}"]}""";
        TimeBillingSources.Read(Guid.NewGuid(), Guid.NewGuid(), json, true, true)!.Proven.ShouldBeFalse();
    }

    [Theory]
    [InlineData("not-json")] [InlineData("[]")] [InlineData("{\"timeEntryIds\":[]}")]
    public void Broken_collected_time_references_require_review_instead_of_becoming_an_empty_success(string json) =>
        TimeBillingSources.Read(Guid.NewGuid(), Guid.NewGuid(), json, true, false)!.Proven.ShouldBeFalse();

    [Fact]
    public void A_partially_selected_current_approval_is_valid_but_a_same_hours_new_revision_is_not()
    {
        var org = Guid.NewGuid(); var user = Guid.NewGuid(); var date = new DateOnly(2098, 6, 17);
        var entry = TimeEntry.CreateManual(new(org, user, date, 2m, "Remote", true, false, false, "Synthetic revision", null, null, null, null)).Value;
        var first = new TimeAllocation(entry.Id, TimeClassification.Covered, 1m, 0m, null, null);
        var second = new TimeAllocation(entry.Id, TimeClassification.Rate, 1m, 1m, 100m, null);
        entry.Approve(user, DateTimeOffset.UtcNow, null, [first, second]);
        TimeBillingSelection selection = new(org, [entry.Id], [first.Id], true);
        TimeBillingAdmission.Matches([selection], [entry]).ShouldBeTrue();
        TimeBillingAdmission.Matches([selection with { OrganizationId = Guid.NewGuid() }], [entry]).ShouldBeFalse();
        entry.Withdraw().IsSuccess.ShouldBeTrue();
        entry.Approve(user, DateTimeOffset.UtcNow, null, [new(entry.Id, TimeClassification.Covered, 2m, 0m, null, null)]);
        TimeBillingAdmission.Matches([selection], [entry]).ShouldBeFalse();
    }
}
