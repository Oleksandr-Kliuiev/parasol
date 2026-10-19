using System.Data.Common;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crm.Activities.Persistence;
using Crm.Authorization;
using Crm.Integrations.Core.Persistence;
using Crm.TimeTracking.Domain;
using Crm.TimeTracking.Features;
using Crm.TimeTracking.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using static Crm.IntegrationTests.SourceTaskTestSupport;
using static Crm.IntegrationTests.ActivityTicketTests;

namespace Crm.IntegrationTests;

public sealed class TimeEntryCreateReceiptTests(CrmWebFactory factory)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Concurrent_same_create_intent_converges_on_one_financial_row_receipt_and_audit()
    {
        var org = await Organization(factory); var ticket = await WorkTicketTestSupport.Create(factory, org);
        var task = await Task(factory, org); using var client = factory.ClientAs(CrmRoles.Technician, "receipt-race-" + Guid.NewGuid().ToString("N"));
        using var link = await Put(client, org, task, ticket.Id, Etag(await Read(client, org, task))); link.StatusCode.ShouldBe(HttpStatusCode.OK);
        var request = TaskTimeEntryTests.Request(org, ticket.Id, task) with { ClientRequestId = Guid.NewGuid() };
        var responses = await System.Threading.Tasks.Task.WhenAll(client.PostAsJsonAsync("/api/v1/time/entries", request, Ct), client.PostAsJsonAsync("/api/v1/time/entries", request, Ct));
        try
        {
            responses.ShouldAllBe(response => response.StatusCode == HttpStatusCode.Created);
            var first = await responses[0].Content.ReadFromJsonAsync<JsonElement>(Ct); var second = await responses[1].Content.ReadFromJsonAsync<JsonElement>(Ct);
            first.GetProperty("id").GetGuid().ShouldBe(second.GetProperty("id").GetGuid());
            await OneAdmission(org, request.ClientRequestId!.Value, first.GetProperty("id").GetGuid(), 1);
        }
        finally { foreach (var response in responses) response.Dispose(); }
    }

    [Fact]
    public async Task Reused_key_with_changed_intent_or_another_employee_is_conflict_without_disclosing_a_time_id()
    {
        var org = await Organization(factory); var ticket = await WorkTicketTestSupport.Create(factory, org);
        using var author = factory.ClientAs(CrmRoles.Technician, "receipt-author-" + Guid.NewGuid().ToString("N"));
        using var other = factory.ClientAs(CrmRoles.Technician, "receipt-other-" + Guid.NewGuid().ToString("N"));
        var request = TaskTimeEntryTests.Request(org, ticket.Id, null) with { ClientRequestId = Guid.NewGuid() };
        using var created = await author.PostAsJsonAsync("/api/v1/time/entries", request, Ct); created.StatusCode.ShouldBe(HttpStatusCode.Created);
        var entry = await created.Content.ReadFromJsonAsync<JsonElement>(Ct); var id = entry.GetProperty("id").GetGuid();
        using var changed = await author.PostAsJsonAsync("/api/v1/time/entries", request with { Hours = 2, Description = "Changed financial intent" }, Ct);
        await Refused(changed, HttpStatusCode.Conflict, "TIM_CREATE_REQUEST_CONFLICT");
        (await changed.Content.ReadAsStringAsync(Ct)).ShouldNotContain(id.ToString());
        using var foreign = await other.PostAsJsonAsync("/api/v1/time/entries", request, Ct);
        await Refused(foreign, HttpStatusCode.Conflict, "TIM_CREATE_REQUEST_CONFLICT");
        (await foreign.Content.ReadAsStringAsync(Ct)).ShouldNotContain(id.ToString());
        await OneAdmission(org, request.ClientRequestId!.Value, id, 1);
    }

    [Fact]
    public async Task Deleted_accepted_entry_is_never_recreated_and_the_permanent_receipt_does_not_add_audit_rows()
    {
        var org = await Organization(factory); using var client = factory.ClientAs(CrmRoles.Technician, "receipt-delete-" + Guid.NewGuid().ToString("N"));
        var request = TaskTimeEntryTests.Request(org, null, null) with { ClientRequestId = Guid.NewGuid() };
        using var created = await client.PostAsJsonAsync("/api/v1/time/entries", request, Ct); created.StatusCode.ShouldBe(HttpStatusCode.Created);
        var id = (await created.Content.ReadFromJsonAsync<JsonElement>(Ct)).GetProperty("id").GetGuid();
        using var deleted = await client.DeleteAsync($"/api/v1/time/entries/{id}", Ct); deleted.StatusCode.ShouldBe(HttpStatusCode.NoContent);
        using var replay = await client.PostAsJsonAsync("/api/v1/time/entries", request, Ct); await Refused(replay, HttpStatusCode.Conflict, "TIM_CREATE_REQUEST_UNAVAILABLE");
        await OneAdmission(org, request.ClientRequestId!.Value, id, 2);
        await using var scope = factory.Services.CreateAsyncScope(); var db = scope.ServiceProvider.GetRequiredService<TimeTrackingDbContext>();
        (await db.TimeEntries.IgnoreQueryFilters().SingleAsync(e => e.Id == id, Ct)).IsDeleted.ShouldBeTrue();
    }

    [Fact]
    public async Task Lost_commit_acknowledgement_can_be_retried_after_task_unlink_and_owner_removal_without_creating_or_rewriting_work()
    {
        var org = await Organization(factory); var employee = await Employee(factory, CrmRoles.Technician);
        var ticket = await WorkTicketTestSupport.Create(factory, org); var task = await Task(factory, org); var lost = new LoseCommitOnce(org);
        await using (var initialScope = factory.Services.CreateAsyncScope())
        {
            var activities = initialScope.ServiceProvider.GetRequiredService<ActivitiesDbContext>();
            (await activities.Activities.SingleAsync(a => a.Id == task, Ct)).LinkTicket(ticket.Id); await activities.SaveChangesAsync(Ct);
        }
        var request = TaskTimeEntryTests.Request(org, ticket.Id, task) with { ClientRequestId = Guid.NewGuid() };
        await using (var host = Host(factory, employee, configure: services => services.AddDbContext<TimeTrackingDbContext>(options => options.AddInterceptors(lost))))
        {
            await using var scope = host.Services.CreateAsyncScope();
            await Should.ThrowAsync<SyntheticLostAcknowledgement>(() => scope.ServiceProvider.GetRequiredService<TimeEntryService>().CreateAsync(request, Ct));
        }
        Guid id;
        await using (var changedScope = factory.Services.CreateAsyncScope())
        {
            var time = changedScope.ServiceProvider.GetRequiredService<TimeTrackingDbContext>();
            id = (await time.TimeEntries.Where(e => e.OrganizationId == org).ToListAsync(Ct)).ShouldHaveSingleItem().Id;
            var activities = changedScope.ServiceProvider.GetRequiredService<ActivitiesDbContext>();
            (await activities.Activities.SingleAsync(a => a.Id == task, Ct)).LinkTicket(null); await activities.SaveChangesAsync(Ct);
            await changedScope.ServiceProvider.GetRequiredService<IntegrationDbContext>().ExternalLinks.Where(l => l.EntityId == org && l.System == "atera").ExecuteDeleteAsync(Ct);
        }
        await using (var replayHost = Host(factory, employee))
        {
            await using var scope = replayHost.Services.CreateAsyncScope();
            var replay = await scope.ServiceProvider.GetRequiredService<TimeEntryService>().CreateAsync(request with { ExternalTicketId = 77, TicketTitle = "Different untrusted text" }, Ct);
            replay.IsSuccess.ShouldBeTrue(); replay.Value.Id.ShouldBe(id); replay.Value.TicketId.ShouldBe(ticket.Id);
            replay.Value.SourceActivityId.ShouldBe(task); replay.Value.ExternalTicketId.ShouldBe(ticket.ExternalId); replay.Value.TicketTitle.ShouldBe(ticket.Title);
            replay.Value.Hours.ShouldBe(1.25m); replay.Value.Description.ShouldBe("Employee entered actual work");
        }
        lost.Commits.ShouldBe(1); await OneAdmission(org, request.ClientRequestId!.Value, id, 1);
    }

    [Fact]
    public async Task Refused_first_attempt_leaves_no_receipt_and_can_be_corrected_with_the_same_form_key()
    {
        var org = await Organization(factory); var ticket = await WorkTicketTestSupport.Create(factory, org); var task = await Task(factory, org);
        using var client = factory.ClientAs(CrmRoles.Technician, "receipt-refused-" + Guid.NewGuid().ToString("N"));
        var request = TaskTimeEntryTests.Request(org, ticket.Id, task) with { ClientRequestId = Guid.NewGuid() };
        using var refused = await client.PostAsJsonAsync("/api/v1/time/entries", request, Ct); await Refused(refused, HttpStatusCode.NotFound, "ACT_TASK_UNAVAILABLE");
        await using (var scope = factory.Services.CreateAsyncScope())
            (await scope.ServiceProvider.GetRequiredService<TimeTrackingDbContext>().TimeEntryCreateReceipts.AnyAsync(r => r.ClientRequestId == request.ClientRequestId, Ct)).ShouldBeFalse();
        using var link = await Put(client, org, task, ticket.Id, Etag(await Read(client, org, task))); link.StatusCode.ShouldBe(HttpStatusCode.OK);
        using var accepted = await client.PostAsJsonAsync("/api/v1/time/entries", request with { Description = "Corrected before acceptance" }, Ct); accepted.StatusCode.ShouldBe(HttpStatusCode.Created);
        var id = (await accepted.Content.ReadFromJsonAsync<JsonElement>(Ct)).GetProperty("id").GetGuid(); await OneAdmission(org, request.ClientRequestId!.Value, id, 1);
    }

    private async Task OneAdmission(Guid org, Guid request, Guid entry, int audits)
    {
        await using var scope = factory.Services.CreateAsyncScope(); var db = scope.ServiceProvider.GetRequiredService<TimeTrackingDbContext>();
        (await db.TimeEntries.IgnoreQueryFilters().CountAsync(e => e.OrganizationId == org, Ct)).ShouldBe(1);
        var receipt = (await db.TimeEntryCreateReceipts.Where(r => r.ClientRequestId == request).ToListAsync(Ct)).ShouldHaveSingleItem();
        receipt.TimeEntryId.ShouldBe(entry); receipt.IntentHash.Length.ShouldBe(64);
        (await db.AuditEntries.CountAsync(a => a.EntityType == nameof(TimeEntry) && a.EntityId == entry, Ct)).ShouldBe(audits);
        (await db.AuditEntries.CountAsync(a => a.EntityType == nameof(TimeEntryCreateReceipt) && a.EntityId == request, Ct)).ShouldBe(0);
    }
    private sealed class SyntheticLostAcknowledgement : Exception { }
    private sealed class LoseCommitOnce(Guid org) : DbTransactionInterceptor
    {
        public int Commits { get; private set; }
        public override System.Threading.Tasks.Task TransactionCommittedAsync(DbTransaction transaction, TransactionEndEventData eventData, CancellationToken cancellationToken = default)
        {
            if (eventData.Context is TimeTrackingDbContext db && db.TimeEntries.Local.Any(e => e.OrganizationId == org))
            { Commits++; if (Commits == 1) throw new SyntheticLostAcknowledgement(); }
            return System.Threading.Tasks.Task.CompletedTask;
        }
    }
}
