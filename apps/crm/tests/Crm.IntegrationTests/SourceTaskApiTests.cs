using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crm.Activities.Contracts;
using Crm.Activities.Domain;
using Crm.Activities.Persistence;
using Crm.Authorization;
using Crm.Identity.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using static Crm.IntegrationTests.SourceTaskTestSupport;

namespace Crm.IntegrationTests;

public sealed class SourceTaskApiTests(CrmWebFactory factory)
{
    [Fact]
    public async Task Two_independent_employee_requests_converge_on_one_Task_receipt_audit_and_event()
    {
        var organization = await Organization(factory); var firstEmployee = await Employee(factory, CrmRoles.Technician);
        var secondEmployee = await Employee(factory, CrmRoles.Technician); var source = Source();
        await using var firstHost = Host(factory, firstEmployee); await using var secondHost = Host(factory, secondEmployee);
        // Start both hosts before the competing transactions, with separate request scopes/connections.
        _ = firstHost.Services; _ = secondHost.Services;
        var first = new SourceTaskDraft(source, organization, firstEmployee, DateTimeOffset.Parse("2027-01-10T10:00:00Z"), ActivityPriority.High);
        var second = first with { AssigneeId = secondEmployee, DueAt = first.DueAt!.Value.AddDays(1) };
        var results = await Task.WhenAll(Create(firstHost, first), Create(secondHost, second));
        results.All(r => r.IsSuccess).ShouldBeTrue(); results.Select(r => r.Value.ActivityId).Distinct().Count().ShouldBe(1);
        results.Count(r => r.Value.Created).ShouldBe(1);
        var winner = results.Single(r => r.Value.Created).Value;
        var replay = (await Create(firstHost, second)).Value;
        replay.ActivityId.ShouldBe(winner.ActivityId); replay.Created.ShouldBeFalse(); replay.AssigneeId.ShouldBe(winner.AssigneeId); replay.DueAt.ShouldBe(winner.DueAt);
        await using var scope = factory.Services.CreateAsyncScope(); var db = scope.ServiceProvider.GetRequiredService<ActivitiesDbContext>();
        (await db.Activities.CountAsync(a => a.Id == winner.ActivityId)).ShouldBe(1);
        (await db.SourceTaskLinks.CountAsync(l => l.ActivityId == winner.ActivityId)).ShouldBe(1);
        var task = await db.Activities.AsNoTracking().SingleAsync(a => a.Id == winner.ActivityId);
        task.Type.ShouldBe(ActivityType.Task); task.Subject.ShouldBe("Review technical observation"); task.Body.ShouldBeNull(); task.Priority.ShouldBe(ActivityPriority.High);
        var audit = await db.AuditEntries.AsNoTracking().Where(a => a.EntityType == nameof(Activity) && a.EntityId == task.Id).ToListAsync();
        audit.Count.ShouldBe(1); audit[0].UserId.ShouldBe(winner.AssigneeId);
        (await db.OutboxMessages.CountAsync(m => m.Type.Contains(nameof(ActivityLogged)) && m.Payload.Contains(task.Id.ToString()))).ShouldBe(1);
        audit[0].Changes.ShouldNotBeNull();
        foreach (var excluded in new[] { source.WorkspaceId, source.ClientId, source.ObservationId }) audit[0].Changes!.ShouldNotContain(excluded);
        using var client = factory.ClientAs(CrmRoles.Technician);
        var timeline = await client.GetFromJsonAsync<JsonElement>($"/api/v1/activities?organizationId={organization}");
        var dto = timeline.GetProperty("items").EnumerateArray().Single(a => a.GetProperty("id").GetGuid() == task.Id);
        dto.GetProperty("hasTechnicalSource").GetBoolean().ShouldBeTrue(); dto.ToString().ShouldNotContain(source.ObservationId);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Replay_keeps_completed_state_and_deleted_or_erased_receipts_never_recreate_tasks(bool erase)
    {
        var organization = await Organization(factory); var employee = await Employee(factory, CrmRoles.Technician); var source = Source();
        await using var host = Host(factory, employee);
        var draft = new SourceTaskDraft(source, organization, employee, null, ActivityPriority.Normal);
        var created = (await Create(host, draft)).Value;
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<ActivitiesDbContext>(); var task = await db.Activities.SingleAsync(a => a.Id == created.ActivityId);
            task.Complete(employee, DateTimeOffset.UtcNow); await db.SaveChangesAsync();
        }
        var done = (await Create(host, draft with { DueAt = DateTimeOffset.Parse("2027-02-10T10:00:00Z") })).Value;
        done.ActivityId.ShouldBe(created.ActivityId); done.Status.ShouldBe(ActivityStatus.Done); done.DueAt.ShouldBeNull(); done.Created.ShouldBeFalse();
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<ActivitiesDbContext>(); var task = await db.Activities.SingleAsync(a => a.Id == created.ActivityId);
            if (erase) task.Erase("SYNTHETIC-ERASURE"); else task.MarkDeleted();
            await db.SaveChangesAsync();
        }
        var unavailable = (await Create(host, draft)).Value;
        unavailable.ActivityId.ShouldBe(created.ActivityId); unavailable.IsAvailable.ShouldBeFalse(); unavailable.AssigneeId.ShouldBeNull(); unavailable.DueAt.ShouldBeNull(); unavailable.Created.ShouldBeFalse();
        await using var verify = factory.Services.CreateAsyncScope(); var store = verify.ServiceProvider.GetRequiredService<ActivitiesDbContext>();
        (await store.Activities.IgnoreQueryFilters().CountAsync(a => a.Id == created.ActivityId)).ShouldBe(1);
        (await store.SourceTaskLinks.CountAsync(l => l.ActivityId == created.ActivityId)).ShouldBe(1);
    }

    [Fact]
    public async Task Receipt_lookup_uses_current_Task_customer_and_never_exposes_another_customers_task()
    {
        var organization = await Organization(factory); var other = await Organization(factory); var employee = await Employee(factory, CrmRoles.Technician);
        await using var host = Host(factory, employee); var source = Source();
        var draft = new SourceTaskDraft(source, organization, employee, null, ActivityPriority.Normal);
        var created = (await Create(host, draft)).Value;
        var wrong = await Find(host, source, other); wrong.Error!.Code.ShouldBe("ACT_SOURCE_TASK_CUSTOMER_CHANGED");
        (await Create(host, draft with { OrganizationId = other })).Error!.Code.ShouldBe("ACT_SOURCE_TASK_CUSTOMER_CHANGED");
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<ActivitiesDbContext>();
            // The merge handler moves this same Activity; its receipt does not carry a stale customer copy.
            await db.Activities.Where(a => a.Id == created.ActivityId).ExecuteUpdateAsync(u => u.SetProperty(a => a.OrganizationId, other));
        }
        (await Find(host, source, organization)).Error!.Code.ShouldBe("ACT_SOURCE_TASK_CUSTOMER_CHANGED");
        (await Find(host, source, other)).Value!.ActivityId.ShouldBe(created.ActivityId);
        await using var read = host.Services.CreateAsyncScope();
        var details = (await read.ServiceProvider.GetRequiredService<IActivitiesApi>().GetSourceTaskAsync(created.ActivityId, default)).Value;
        details.Task.OrganizationId.ShouldBe(other); details.Source.ShouldBe(source);
    }

    [Theory]
    [InlineData("unknown")][InlineData("inactive")][InlineData(CrmRoles.ReadOnly)]
    public async Task A_new_task_requires_an_active_eligible_assignee(string scenario)
    {
        var organization = await Organization(factory); var actor = await Employee(factory, CrmRoles.Technician);
        var assignee = scenario == "unknown" ? Guid.NewGuid() : await Employee(factory, scenario == "inactive" ? CrmRoles.Technician : scenario);
        if (scenario == "inactive")
        {
            await using var scope = factory.Services.CreateAsyncScope(); var identity = scope.ServiceProvider.GetRequiredService<IdentityDbContext>();
            (await identity.Users.SingleAsync(u => u.Id == assignee)).Deactivate(); await identity.SaveChangesAsync();
        }
        await using var host = Host(factory, actor); var source = Source();
        (await Create(host, new(source, organization, assignee, null, ActivityPriority.Normal))).Error!.Code.ShouldBe("ACT_SOURCE_TASK_ASSIGNEE_INVALID");
        (await Find(host, source, organization)).Value.ShouldBeNull();
    }

    [Fact]
    public async Task Direct_module_calls_enforce_the_intersection_of_permissions()
    {
        // Every role that reads activities also reads service data, so a reader without activities.write is the one to refuse.
        var organization = await Organization(factory); var actor = await Employee(factory, CrmRoles.ReadOnly);
        await using var host = Host(factory, actor, CrmRoles.ReadOnly);
        (await Create(host, new(Source(), organization, actor, null, ActivityPriority.Normal))).Error!.Code.ShouldBe("ACT_SOURCE_TASK_FORBIDDEN");
        (await Find(host, Source(), organization)).IsSuccess.ShouldBeTrue();
    }

    [Fact]
    public async Task Ordinary_updates_preserve_source_Task_identity_and_only_validate_changed_assignees()
    {
        var organization = await Organization(factory); var other = await Organization(factory); var actor = await Employee(factory, CrmRoles.Technician);
        var reader = await Employee(factory, CrmRoles.ReadOnly); await using var host = Host(factory, actor);
        var created = (await Create(host, new(Source(), organization, actor, null, ActivityPriority.Normal))).Value;
        using var client = factory.ClientAs(CrmRoles.Technician);
        var rows = await client.GetFromJsonAsync<JsonElement>($"/api/v1/activities?organizationId={organization}");
        var dto = rows.GetProperty("items").EnumerateArray().Single(a => a.GetProperty("id").GetGuid() == created.ActivityId);
        async Task<HttpResponseMessage> Update(string type, Guid customer, Guid assignee)
        {
            using var request = new HttpRequestMessage(HttpMethod.Put, $"/api/v1/activities/{created.ActivityId}")
            {
                Content = JsonContent.Create(new { type, organizationId = customer, subject = "Ordinary employee-authored task title", priority = "Normal", assigneeId = assignee }),
            };
            request.Headers.TryAddWithoutValidation("If-Match", dto.GetProperty("etag").GetString());
            return await client.SendAsync(request);
        }
        (await Update("Note", organization, actor)).StatusCode.ShouldBe(HttpStatusCode.Conflict);
        (await Update("Task", other, actor)).StatusCode.ShouldBe(HttpStatusCode.Conflict);
        var invalid = await Update("Task", organization, reader); invalid.StatusCode.ShouldBe(HttpStatusCode.BadRequest);
        (await invalid.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString().ShouldBe("ACT_SOURCE_TASK_ASSIGNEE_INVALID");
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var identity = scope.ServiceProvider.GetRequiredService<IdentityDbContext>(); (await identity.Users.SingleAsync(u => u.Id == actor)).Deactivate(); await identity.SaveChangesAsync();
        }
        // Another active employee may edit/complete work without silently reassigning an inactive existing assignee.
        using var edited = await Update("Task", organization, actor);
        edited.StatusCode.ShouldBe(HttpStatusCode.OK);
        var updated = await edited.Content.ReadFromJsonAsync<JsonElement>();
        (await client.PostWithETagAsync($"/api/v1/activities/{created.ActivityId}/complete", new { }, updated.GetProperty("etag").GetString()!))
            .StatusCode.ShouldBe(HttpStatusCode.OK);
    }
}
