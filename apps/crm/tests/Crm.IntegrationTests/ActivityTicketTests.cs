using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crm.Activities.Contracts;
using Crm.Activities.Domain;
using Crm.Activities.Persistence;
using Crm.Authorization;
using Crm.Infrastructure.Persistence;
using Crm.Service.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using static Crm.IntegrationTests.SourceTaskTestSupport;

namespace Crm.IntegrationTests;

public sealed class ActivityTicketTests(CrmWebFactory factory)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Linking_changing_and_unlinking_use_displayed_versions_and_leave_authored_task_fields_unchanged()
    {
        using var client = factory.ClientAs(CrmRoles.Technician, "ticket-task-" + Guid.NewGuid().ToString("N"));
        var actor = (await client.GetFromJsonAsync<JsonElement>("/bff/user", Ct)).GetProperty("id").GetGuid();
        var org = await Organization(factory); var task = await Task(factory, org, actor);
        var first = await WorkTicketTestSupport.Create(factory, org); var second = await WorkTicketTestSupport.Create(factory, org);
        var before = await State(task); var empty = await Read(client, org, task);
        empty.GetProperty("ticketId").ValueKind.ShouldBe(JsonValueKind.Null); empty.GetProperty("available").GetBoolean().ShouldBeFalse();
        using var linkedResponse = await Put(client, org, task, first.Id, Etag(empty)); linkedResponse.StatusCode.ShouldBe(HttpStatusCode.OK);
        var linked = await linkedResponse.Content.ReadFromJsonAsync<JsonElement>(Ct); linked.GetProperty("available").GetBoolean().ShouldBeTrue();
        linked.GetProperty("ticket").GetProperty("id").GetGuid().ShouldBe(first.Id); Etag(linked).ShouldNotBe(Etag(empty));
        var afterLink = await State(task); afterLink.Authored.ShouldBe(before.Authored); afterLink.Audits.ShouldBe(before.Audits + 1);
        afterLink.Events.ShouldBe(before.Events); afterLink.LinkedTicketId.ShouldBe(first.Id);
        using var stale = await Put(client, org, task, second.Id, Etag(empty));
        await Refused(stale, HttpStatusCode.PreconditionFailed, "CONCURRENCY_CONFLICT"); (await State(task)).ShouldBe(afterLink);
        using var changedResponse = await Put(client, org, task, second.Id, Etag(linked)); changedResponse.StatusCode.ShouldBe(HttpStatusCode.OK);
        var changed = await changedResponse.Content.ReadFromJsonAsync<JsonElement>(Ct); changed.GetProperty("ticketId").GetGuid().ShouldBe(second.Id);
        using var unlinkedResponse = await Put(client, org, task, null, Etag(changed)); unlinkedResponse.StatusCode.ShouldBe(HttpStatusCode.OK);
        var unlinked = await unlinkedResponse.Content.ReadFromJsonAsync<JsonElement>(Ct);
        unlinked.GetProperty("ticketId").ValueKind.ShouldBe(JsonValueKind.Null); unlinked.GetProperty("ticket").ValueKind.ShouldBe(JsonValueKind.Null);
        unlinked.GetProperty("available").GetBoolean().ShouldBeFalse();
        var afterUnlink = await State(task); afterUnlink.Authored.ShouldBe(before.Authored);
        afterUnlink.Audits.ShouldBe(before.Audits + 3); afterUnlink.Events.ShouldBe(before.Events);
    }

    [Fact]
    public async Task Many_tasks_can_share_one_ticket_and_no_op_link_requires_a_current_version()
    {
        var org = await Organization(factory); var ticket = await WorkTicketTestSupport.Create(factory, org);
        var one = await Task(factory, org); var two = await Task(factory, org); using var client = factory.ClientAs(CrmRoles.Technician);
        var old = await Read(client, org, one);
        using var first = await Put(client, org, one, ticket.Id, Etag(old)); first.StatusCode.ShouldBe(HttpStatusCode.OK);
        var current = await first.Content.ReadFromJsonAsync<JsonElement>(Ct); var before = await State(one);
        using var staleNoop = await Put(client, org, one, ticket.Id, Etag(old)); await Refused(staleNoop, HttpStatusCode.PreconditionFailed, "CONCURRENCY_CONFLICT");
        using var noop = await Put(client, org, one, ticket.Id, Etag(current)); noop.StatusCode.ShouldBe(HttpStatusCode.OK);
        (await State(one)).ShouldBe(before);
        using var shared = await Put(client, org, two, ticket.Id, Etag(await Read(client, org, two))); shared.StatusCode.ShouldBe(HttpStatusCode.OK);
        (await State(two)).LinkedTicketId.ShouldBe(ticket.Id);
    }

    [Fact]
    public async Task Wrong_customer_ticket_and_missing_precondition_make_no_task_audit_or_event_changes()
    {
        var org = await Organization(factory); var other = await Organization(factory); var task = await Task(factory, org);
        var foreign = await WorkTicketTestSupport.Create(factory, other); using var client = factory.ClientAs(CrmRoles.Technician);
        var empty = await Read(client, org, task); var before = await State(task);
        using var wrong = await Put(client, org, task, foreign.Id, Etag(empty)); await Refused(wrong, HttpStatusCode.NotFound, "SRV_WORK_TICKET_UNAVAILABLE");
        using var missing = await Put(client, org, task, foreign.Id, null); await Refused(missing, HttpStatusCode.PreconditionRequired, "IF_MATCH_REQUIRED");
        (await State(task)).ShouldBe(before);
    }

    [Fact]
    public async Task Deleted_or_moved_mirror_never_resolves_by_external_number_and_old_association_can_be_unlinked()
    {
        var org = await Organization(factory); var task = await Task(factory, org); var ticket = await WorkTicketTestSupport.Create(factory, org);
        using var client = factory.ClientAs(CrmRoles.Technician);
        using var link = await Put(client, org, task, ticket.Id, Etag(await Read(client, org, task))); link.StatusCode.ShouldBe(HttpStatusCode.OK);
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<ServiceDbContext>();
            await db.Tickets.Where(t => t.Id == ticket.Id).ExecuteDeleteAsync(Ct);
        }
        var replacement = await WorkTicketTestSupport.Create(factory, org, ticket.ExternalId); replacement.Id.ShouldNotBe(ticket.Id);
        var unavailable = await Read(client, org, task); unavailable.GetProperty("available").GetBoolean().ShouldBeFalse();
        unavailable.GetProperty("ticketId").GetGuid().ShouldBe(ticket.Id); unavailable.GetProperty("ticket").ValueKind.ShouldBe(JsonValueKind.Null);
        using var unlink = await Put(client, org, task, null, Etag(unavailable)); unlink.StatusCode.ShouldBe(HttpStatusCode.OK);
        (await State(task)).LinkedTicketId.ShouldBeNull();
    }

    [Theory]
    [InlineData("deleted")] [InlineData("erased")] [InlineData("moved")] [InlineData("note")]
    public async Task Nonlive_or_other_customer_tasks_are_unavailable_without_disclosing_the_ticket(string scenario)
    {
        var org = await Organization(factory); var other = await Organization(factory); var task = await Task(factory, org,
            type: scenario == "note" ? ActivityType.Note : ActivityType.Task);
        var ticket = await WorkTicketTestSupport.Create(factory, org); using var client = factory.ClientAs(CrmRoles.Technician);
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<ActivitiesDbContext>(); var row = await db.Activities.SingleAsync(a => a.Id == task, Ct);
            if (scenario == "deleted") row.MarkDeleted(); if (scenario == "erased") row.Erase("synthetic-erasure");
            if (scenario == "moved") row.MoveToOrganization(other); await db.SaveChangesAsync(Ct);
        }
        var before = await State(task);
        using var get = await client.GetAsync($"/api/v1/activities/{task}/ticket?organizationId={org}", Ct);
        await Refused(get, HttpStatusCode.NotFound, "ACT_TASK_UNAVAILABLE");
        using var put = await Put(client, org, task, ticket.Id, before.Etag); await Refused(put, HttpStatusCode.NotFound, "ACT_TASK_UNAVAILABLE");
        (await State(task)).ShouldBe(before);
    }

    [Fact]
    public async Task Competing_ticket_links_using_one_version_commit_only_one_association_audit_without_a_contact_event()
    {
        var org = await Organization(factory); var task = await Task(factory, org);
        var a = await WorkTicketTestSupport.Create(factory, org); var b = await WorkTicketTestSupport.Create(factory, org);
        using var first = factory.ClientAs(CrmRoles.Technician, "link-race-a"); using var second = factory.ClientAs(CrmRoles.Technician, "link-race-b");
        var current = await Read(first, org, task); _ = await Read(second, org, task); var before = await State(task);
        var responses = await System.Threading.Tasks.Task.WhenAll(Put(first, org, task, a.Id, Etag(current)), Put(second, org, task, b.Id, Etag(current)));
        try
        {
            responses.Count(r => r.StatusCode == HttpStatusCode.OK).ShouldBe(1);
            await Refused(responses.Single(r => r.StatusCode != HttpStatusCode.OK), HttpStatusCode.PreconditionFailed, "CONCURRENCY_CONFLICT");
            var after = await State(task); new[] { a.Id, b.Id }.ShouldContain(after.LinkedTicketId!.Value);
            after.Authored.ShouldBe(before.Authored); after.Audits.ShouldBe(before.Audits + 1); after.Events.ShouldBe(before.Events);
        }
        finally { foreach (var response in responses) response.Dispose(); }
    }

    internal static async Task<Guid> Task(CrmWebFactory factory, Guid org, Guid? assignee = null, ActivityType type = ActivityType.Task)
    {
        await using var scope = factory.Services.CreateAsyncScope(); var db = scope.ServiceProvider.GetRequiredService<ActivitiesDbContext>();
        var task = Activity.Create(new(type, org, null, null, null, "Synthetic employee-authored work", "Only employee notes",
            DateTimeOffset.Parse("2091-01-02T10:15:30Z"), ActivityPriority.High, assignee), DateTimeOffset.UtcNow).Value;
        db.Activities.Add(task); await db.SaveChangesAsync(Ct); return task.Id;
    }
    internal static Task<JsonElement> Read(HttpClient client, Guid org, Guid task) =>
        client.GetFromJsonAsync<JsonElement>($"/api/v1/activities/{task}/ticket?organizationId={org}", Ct);
    internal static string Etag(JsonElement value) => value.GetProperty("etag").GetString()!;
    internal static async Task<HttpResponseMessage> Put(HttpClient client, Guid org, Guid task, Guid? ticket, string? etag)
    {
        using var request = new HttpRequestMessage(HttpMethod.Put, $"/api/v1/activities/{task}/ticket") { Content = JsonContent.Create(new { organizationId = org, ticketId = ticket }) };
        if (etag is not null) request.Headers.TryAddWithoutValidation("If-Match", etag); return await client.SendAsync(request, Ct);
    }
    internal static async Task Refused(HttpResponseMessage response, HttpStatusCode status, string code)
    {
        response.StatusCode.ShouldBe(status); (await response.Content.ReadFromJsonAsync<JsonElement>(Ct)).GetProperty("code").GetString().ShouldBe(code);
    }
    private sealed record Snapshot(string Authored, Guid? LinkedTicketId, string Etag, int Audits, int Events);
    private async Task<Snapshot> State(Guid task)
    {
        await using var scope = factory.Services.CreateAsyncScope(); var db = scope.ServiceProvider.GetRequiredService<ActivitiesDbContext>();
        var row = await db.Activities.IgnoreQueryFilters().SingleAsync(a => a.Id == task, Ct);
        var authored = JsonSerializer.Serialize(new { row.Type, row.OrganizationId, row.Subject, row.Body, row.AssigneeId, row.DueAt, row.Priority, row.Status, row.CompletedAt, row.CompletedBy, row.IsDeleted });
        return new(authored, row.LinkedTicketId, db.GetETag(row), await db.AuditEntries.CountAsync(a => a.EntityType == nameof(Activity) && a.EntityId == task, Ct),
            await db.OutboxMessages.CountAsync(o => o.Type.Contains(nameof(ActivityLogged)) && o.Payload.Contains(task.ToString()), Ct));
    }
}
