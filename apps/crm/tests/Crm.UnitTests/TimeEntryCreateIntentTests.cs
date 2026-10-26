using System.Globalization;
using Crm.TimeTracking.Features;
using Crm.TimeTracking.Persistence;
using Crm.Infrastructure.Persistence;

namespace Crm.UnitTests;

public sealed class TimeEntryCreateIntentTests
{
    [Fact]
    public void Financial_receipts_are_insert_only_for_shared_runtime_role_in_the_permission_script()
    {
        var script = DatabasePermissions.Script(["time"], [new TimeTrackingDatabasePermissions()]);
        script.ShouldContain("DENY UPDATE, DELETE ON OBJECT::[time].[TimeEntryCreateReceipts] TO [crm_runtime]");
    }

    private static readonly Guid Employee = Guid.Parse("92222222-2222-2222-2222-222222222222");
    private static TimeEntryRequest Request() => new(Guid.Parse("91111111-1111-1111-1111-111111111111"), null, new(2099, 4, 23),
        1.25m, " Work ", false, false, false, " Explicit notes ", 12, "Caller title", null,
        Guid.Parse("93333333-3333-3333-3333-333333333333"), Guid.Parse("94444444-4444-4444-4444-444444444444"), Guid.NewGuid());

    [Fact]
    public void Verified_intent_uses_exact_ids_and_normalized_work_but_ignores_caller_ticket_text_number_and_client_key()
    {
        var request = Request(); var hash = TimeEntryCreateIntent.Hash(request, Employee); hash.Length.ShouldBe(64);
        TimeEntryCreateIntent.Hash(request with { ExternalTicketId = 999, TicketTitle = "Untrusted different title", ClientRequestId = Guid.NewGuid(),
            TechnicianId = Employee, WorkType = "Work", Description = "Explicit notes", Hours = 1.2500m }, Employee).ShouldBe(hash);
        foreach (var changed in new[] { request with { OrganizationId = Guid.NewGuid() }, request with { TicketId = Guid.NewGuid() },
            request with { SourceActivityId = Guid.NewGuid() }, request with { Hours = 2 }, request with { Billable = true }, request with { Onsite = true },
            request with { AfterHours = true }, request with { WorkDate = request.WorkDate.AddDays(1) }, request with { ProjectId = Guid.NewGuid() },
            request with { WorkType = "Other" }, request with { Description = "Different notes" } })
            TimeEntryCreateIntent.Hash(changed, Employee).ShouldNotBe(hash);
        TimeEntryCreateIntent.Hash(request, Guid.NewGuid()).ShouldNotBe(hash);
    }

    [Fact]
    public void Manual_reference_remains_part_of_the_intent_and_hash_is_culture_independent()
    {
        var request = Request() with { TicketId = null, SourceActivityId = null }; var hash = TimeEntryCreateIntent.Hash(request, Employee);
        TimeEntryCreateIntent.Hash(request with { ExternalTicketId = 99 }, Employee).ShouldNotBe(hash);
        TimeEntryCreateIntent.Hash(request with { TicketTitle = "Other" }, Employee).ShouldNotBe(hash);
        var original = CultureInfo.CurrentCulture;
        try { CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo("nb-NO"); TimeEntryCreateIntent.Hash(request, Employee).ShouldBe(hash); }
        finally { CultureInfo.CurrentCulture = original; }
    }
}
