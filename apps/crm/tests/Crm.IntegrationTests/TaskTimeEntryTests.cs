using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crm.Activities.Contracts;
using Crm.Activities.Domain;
using Crm.Activities.Persistence;
using Crm.Authorization;
using Crm.Infrastructure.Persistence;
using Crm.Service.Persistence;
using Crm.TimeTracking.Contracts;
using Crm.TimeTracking.Domain;
using Crm.TimeTracking.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using static Crm.IntegrationTests.SourceTaskTestSupport;
using static Crm.IntegrationTests.ActivityTicketTests;

namespace Crm.IntegrationTests;

public sealed class TaskTimeEntryTests(CrmWebFactory factory)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;
    private static readonly DateOnly WorkDate = new(2099, 4, 23);

    [Fact]
    public async Task Verified_task_time_uses_canonical_ticket_identity_current_employee_and_explicit_hours_notes_and_work_date()
    {
        var org = await Organization(factory); var assignee = await Employee(factory, CrmRoles.Technician);
        using var client = factory.ClientAs(CrmRoles.Technician, "task-time-author-" + Guid.NewGuid().ToString("N"));
        var author = (await client.GetFromJsonAsync<JsonElement>("/bff/user", Ct)).GetProperty("id").GetGuid(); author.ShouldNotBe(assignee);
        var task = await Task(factory, org, assignee); var ticket = await WorkTicketTestSupport.Create(factory, org);
        using var link = await Put(client, org, task, ticket.Id, Etag(await Read(client, org, task))); link.StatusCode.ShouldBe(HttpStatusCode.OK);
        using var response = await client.PostAsJsonAsync("/api/v1/time/entries", Request(org, ticket.Id, task), Ct);
        response.StatusCode.ShouldBe(HttpStatusCode.Created); var entry = await response.Content.ReadFromJsonAsync<JsonElement>(Ct);
        entry.GetProperty("ticketId").GetGuid().ShouldBe(ticket.Id); entry.GetProperty("sourceActivityId").GetGuid().ShouldBe(task);
        entry.GetProperty("externalTicketId").GetInt64().ShouldBe(ticket.ExternalId); entry.GetProperty("ticketTitle").GetString().ShouldBe(ticket.Title);
        entry.GetProperty("technicianId").GetGuid().ShouldBe(author); entry.GetProperty("source").GetString().ShouldBe("Crm");
        entry.GetProperty("hours").GetDecimal().ShouldBe(1.25m); entry.GetProperty("description").GetString().ShouldBe("Employee entered actual work");
        entry.GetProperty("workDate").GetString().ShouldBe("2099-04-23"); entry.GetProperty("billable").GetBoolean().ShouldBeFalse();
        await using var scope = factory.Services.CreateAsyncScope(); var db = scope.ServiceProvider.GetRequiredService<TimeTrackingDbContext>();
        var row = await db.TimeEntries.SingleAsync(e => e.Id == entry.GetProperty("id").GetGuid(), Ct);
        row.TicketId.ShouldBe(ticket.Id); row.SourceActivityId.ShouldBe(task); row.TechnicianId.ShouldBe(author);
        (await db.AuditEntries.CountAsync(a => a.EntityType == nameof(TimeEntry) && a.EntityId == row.Id, Ct)).ShouldBe(1);
    }

    [Theory]
    [InlineData("other-ticket")] [InlineData("unlinked")] [InlineData("deleted-task")] [InlineData("moved-task")] [InlineData("deleted-ticket")]
    public async Task Invalid_origin_never_creates_time_or_time_audit(string scenario)
    {
        var org = await Organization(factory); var other = await Organization(factory);
        var task = await Task(factory, org); var ticket = await WorkTicketTestSupport.Create(factory, org);
        using var client = factory.ClientAs(CrmRoles.Technician);
        using var linked = await Put(client, org, task, ticket.Id, Etag(await Read(client, org, task))); linked.StatusCode.ShouldBe(HttpStatusCode.OK);
        var selected = ticket.Id;
        if (scenario == "other-ticket") selected = (await WorkTicketTestSupport.Create(factory, org)).Id;
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            if (scenario == "deleted-ticket") await scope.ServiceProvider.GetRequiredService<ServiceDbContext>().Tickets.Where(t => t.Id == ticket.Id).ExecuteDeleteAsync(Ct);
            else
            {
                var db = scope.ServiceProvider.GetRequiredService<ActivitiesDbContext>(); var row = await db.Activities.SingleAsync(a => a.Id == task, Ct);
                if (scenario == "unlinked") row.LinkTicket(null);
                if (scenario == "deleted-task") row.MarkDeleted(); if (scenario == "moved-task") row.MoveToOrganization(other);
                await db.SaveChangesAsync(Ct);
            }
        }
        using var response = await client.PostAsJsonAsync("/api/v1/time/entries", Request(org, selected, task), Ct);
        await Refused(response, HttpStatusCode.NotFound, scenario == "deleted-ticket" ? "SRV_WORK_TICKET_UNAVAILABLE" : "ACT_TASK_UNAVAILABLE");
        await NoTime(org);
    }

    [Fact]
    public async Task Manual_conversion_after_unlink_clears_entire_internal_origin_and_stale_time_version_is_refused()
    {
        var org = await Organization(factory); var other = await Organization(factory); var task = await Task(factory, org);
        var ticket = await WorkTicketTestSupport.Create(factory, org); using var client = factory.ClientAs(CrmRoles.Technician);
        using var link = await Put(client, org, task, ticket.Id, Etag(await Read(client, org, task))); link.StatusCode.ShouldBe(HttpStatusCode.OK);
        using var created = await client.PostAsJsonAsync("/api/v1/time/entries", Request(org, ticket.Id, task), Ct); created.StatusCode.ShouldBe(HttpStatusCode.Created);
        var original = await created.Content.ReadFromJsonAsync<JsonElement>(Ct); var id = original.GetProperty("id").GetGuid();
        using var unlink = await Put(client, org, task, null, Etag(await Read(client, org, task))); unlink.StatusCode.ShouldBe(HttpStatusCode.OK);
        using var manualRequest = new HttpRequestMessage(HttpMethod.Put, $"/api/v1/time/entries/{id}")
        { Content = JsonContent.Create(Request(other, null, null) with { ExternalTicketId = 999, TicketTitle = "Manual external reference" }) };
        manualRequest.Headers.TryAddWithoutValidation("If-Match", Etag(original)); using var converted = await client.SendAsync(manualRequest, Ct);
        converted.StatusCode.ShouldBe(HttpStatusCode.OK); var manual = await converted.Content.ReadFromJsonAsync<JsonElement>(Ct);
        manual.GetProperty("ticketId").ValueKind.ShouldBe(JsonValueKind.Null); manual.GetProperty("sourceActivityId").ValueKind.ShouldBe(JsonValueKind.Null);
        manual.GetProperty("externalTicketId").GetInt64().ShouldBe(999); manual.GetProperty("ticketTitle").GetString().ShouldBe("Manual external reference");
        using var staleRequest = new HttpRequestMessage(HttpMethod.Put, $"/api/v1/time/entries/{id}") { Content = JsonContent.Create(Request(other, null, null)) };
        staleRequest.Headers.TryAddWithoutValidation("If-Match", Etag(original)); using var stale = await client.SendAsync(staleRequest, Ct);
        await Refused(stale, HttpStatusCode.PreconditionFailed, "CONCURRENCY_CONFLICT");
        await using var scope = factory.Services.CreateAsyncScope(); var db = scope.ServiceProvider.GetRequiredService<TimeTrackingDbContext>();
        var row = await db.TimeEntries.SingleAsync(e => e.Id == id, Ct); row.OrganizationId.ShouldBe(other); row.TicketId.ShouldBeNull(); row.SourceActivityId.ShouldBeNull();
        (await db.AuditEntries.CountAsync(a => a.EntityType == nameof(TimeEntry) && a.EntityId == id, Ct)).ShouldBe(2);
    }

    [Fact]
    public async Task Closed_period_and_imported_rows_keep_existing_restrictions_on_verified_path()
    {
        var org = await Organization(factory); var ticket = await WorkTicketTestSupport.Create(factory, org);
        using var client = factory.ClientAs(CrmRoles.Technician, "time-restrictions-" + Guid.NewGuid().ToString("N"));
        var author = (await client.GetFromJsonAsync<JsonElement>("/bff/user", Ct)).GetProperty("id").GetGuid(); Guid importedId; string etag;
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<TimeTrackingDbContext>();
            var closed = new TimePeriod(2101, 8); closed.Close(author, DateTimeOffset.UtcNow); db.TimePeriods.Add(closed);
            var imported = TimeEntry.FromSource(new("atera", "synthetic-" + Guid.NewGuid().ToString("N"), org, null, ticket.ExternalId,
                "Imported snapshot", author, null, null, WorkDate, null, null, 2, null, false, false, null));
            db.TimeEntries.Add(imported); await db.SaveChangesAsync(Ct); importedId = imported.Id; etag = db.GetETag(imported);
        }
        using var period = await client.PostAsJsonAsync("/api/v1/time/entries", Request(org, ticket.Id, null) with { WorkDate = new(2101, 8, 2) }, Ct);
        await Refused(period, HttpStatusCode.Conflict, "TIM_PERIOD_CLOSED");
        using var update = new HttpRequestMessage(HttpMethod.Put, $"/api/v1/time/entries/{importedId}") { Content = JsonContent.Create(Request(org, ticket.Id, null)) };
        update.Headers.TryAddWithoutValidation("If-Match", etag); using var refused = await client.SendAsync(update, Ct);
        await Refused(refused, HttpStatusCode.Conflict, "TIM_SOURCE_OWNED");
        await using var finalScope = factory.Services.CreateAsyncScope(); var final = finalScope.ServiceProvider.GetRequiredService<TimeTrackingDbContext>();
        (await final.TimeEntries.CountAsync(e => e.OrganizationId == org, Ct)).ShouldBe(1);
        var source = await final.TimeEntries.SingleAsync(e => e.Id == importedId, Ct); source.TicketId.ShouldBeNull(); source.SourceActivityId.ShouldBeNull(); source.Hours.ShouldBe(2);
    }

    private async Task NoTime(Guid org)
    {
        await using var scope = factory.Services.CreateAsyncScope(); var db = scope.ServiceProvider.GetRequiredService<TimeTrackingDbContext>();
        (await db.TimeEntries.CountAsync(e => e.OrganizationId == org, Ct)).ShouldBe(0);
        (await db.AuditEntries.CountAsync(a => a.EntityType == nameof(TimeEntry) && a.Changes != null && a.Changes.Contains(org.ToString()), Ct)).ShouldBe(0);
    }
    internal static Crm.TimeTracking.Features.TimeEntryRequest Request(Guid org, Guid? ticket, Guid? task) =>
        new(org, null, WorkDate, 1.25m, null, false, false, false, "Employee entered actual work", 9999999, "Untrusted client title", null, ticket, task);
}
