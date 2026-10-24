using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crm.Activities.Contracts;
using Crm.Activities.Domain;
using Crm.Activities.Persistence;
using Crm.Authorization;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using static Crm.IntegrationTests.SourceTaskTestSupport;

namespace Crm.IntegrationTests;

public sealed class SourceTaskEditTests(CrmWebFactory factory)
{
    [Fact]
    public async Task Existing_task_edits_reassign_and_reschedule_once_stale_edits_change_nothing_and_status_commands_keep_the_assignment()
    {
        // Provision both employees before any write-count baseline; sign-in itself may legitimately create an audit.
        using var first = factory.ClientAs(CrmRoles.Technician, "source-edit-a-" + Guid.NewGuid().ToString("N"));
        using var second = factory.ClientAs(CrmRoles.Technician, "source-edit-b-" + Guid.NewGuid().ToString("N"));
        var employeeA = (await first.GetFromJsonAsync<JsonElement>("/bff/user")).GetProperty("id").GetGuid();
        var employeeB = (await second.GetFromJsonAsync<JsonElement>("/bff/user")).GetProperty("id").GetGuid();
        var organization = await Organization(factory); var source = Source();
        var originalDue = DateTimeOffset.Parse("2027-01-10T10:30:45.123Z");
        var editedDue = DateTimeOffset.Parse("2027-07-10T08:15:43.456Z");
        await using var host = Host(factory, employeeA);
        var task = (await Create(host, new(source, organization, employeeA, originalDue, ActivityPriority.Normal, Subject))).Value;
        var url = $"/api/v1/activities/{task.ActivityId}";
        var original = await Read(first, organization, task.ActivityId);
        original.GetProperty("assignee").GetProperty("id").GetGuid().ShouldBe(employeeA);
        original.GetProperty("dueAt").GetDateTimeOffset().ShouldBe(originalDue);
        var etag0 = original.GetProperty("etag").GetString()!;
        (await Read(second, organization, task.ActivityId)).GetProperty("etag").GetString().ShouldBe(etag0);
        var before = await State(task.ActivityId);

        using var changed = await Update(first, url, organization, employeeB, editedDue, etag0);
        changed.StatusCode.ShouldBe(HttpStatusCode.OK);
        var edited = await changed.Content.ReadFromJsonAsync<JsonElement>();
        var etag1 = edited.GetProperty("etag").GetString()!; etag1.ShouldNotBe(etag0);
        edited.GetProperty("assignee").GetProperty("id").GetGuid().ShouldBe(employeeB);
        edited.GetProperty("dueAt").GetDateTimeOffset().ShouldBe(editedDue);
        edited.GetProperty("hasTechnicalSource").GetBoolean().ShouldBeTrue();
        var afterEdit = await State(task.ActivityId);
        afterEdit.Task.ShouldBe(before.Task with { AssigneeId = employeeB, DueAt = editedDue });
        afterEdit.Source.ShouldBe(source); afterEdit.SourceKey.ShouldBe(before.SourceKey);
        afterEdit.AuditIds.Length.ShouldBe(before.AuditIds.Length + 1);
        afterEdit.OutboxIds.Length.ShouldBe(before.OutboxIds.Length + 1);

        using var stale = await Update(second, url, organization, employeeA, editedDue.AddDays(1), etag0);
        stale.StatusCode.ShouldBe(HttpStatusCode.PreconditionFailed);
        (await stale.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString().ShouldBe("CONCURRENCY_CONFLICT");
        Unchanged(await State(task.ActivityId), afterEdit);
        (await Read(first, organization, task.ActivityId)).GetProperty("etag").GetString().ShouldBe(etag1);

        using var missing = await Update(second, url, organization, employeeA, editedDue.AddDays(1), null);
        missing.StatusCode.ShouldBe(HttpStatusCode.PreconditionRequired);
        Unchanged(await State(task.ActivityId), afterEdit);

        using var completedResponse = await second.PostWithETagAsync(url + "/complete", new { }, etag1);
        completedResponse.StatusCode.ShouldBe(HttpStatusCode.OK);
        var completedDto = await completedResponse.Content.ReadFromJsonAsync<JsonElement>();
        var completed = await State(task.ActivityId);
        completed.Task.ShouldBe(afterEdit.Task with { Status = ActivityStatus.Done });
        completed.Source.ShouldBe(source); completed.SourceKey.ShouldBe(before.SourceKey);
        (await first.PostWithETagAsync(url + "/reopen", new { }, completedDto.GetProperty("etag").GetString()!))
            .StatusCode.ShouldBe(HttpStatusCode.OK);
        var reopened = await State(task.ActivityId);
        reopened.Task.ShouldBe(afterEdit.Task); reopened.Source.ShouldBe(source); reopened.SourceKey.ShouldBe(before.SourceKey);
    }

    private static async Task<JsonElement> Read(HttpClient client, Guid organization, Guid activity)
    {
        var page = await client.GetFromJsonAsync<JsonElement>($"/api/v1/activities?organizationId={organization}&type=Task");
        return page.GetProperty("items").EnumerateArray().Single(item => item.GetProperty("id").GetGuid() == activity).Clone();
    }

    private static async Task<HttpResponseMessage> Update(HttpClient client, string url, Guid organization, Guid assignee,
        DateTimeOffset due, string? etag)
    {
        using var request = new HttpRequestMessage(HttpMethod.Put, url)
        {
            Content = JsonContent.Create(new { type = "Task", organizationId = organization,
                subject = Subject, body = (string?)null, priority = "Normal", assigneeId = assignee, dueAt = due }),
        };
        if (etag is not null) request.Headers.TryAddWithoutValidation("If-Match", etag);
        return await client.SendAsync(request);
    }

    private sealed record TaskState(Guid OrganizationId, ActivityType Type, Guid? AssigneeId, DateTimeOffset? DueAt,
        ActivityStatus Status, string Subject, string? Body);
    private sealed record Evidence(TaskState Task, SourceTaskIdentity Source, string SourceKey, long[] AuditIds, Guid[] OutboxIds);
    private async Task<Evidence> State(Guid activityId)
    {
        await using var scope = factory.Services.CreateAsyncScope(); var db = scope.ServiceProvider.GetRequiredService<ActivitiesDbContext>();
        var activity = await db.Activities.AsNoTracking().SingleAsync(row => row.Id == activityId);
        var receipt = await db.SourceTaskLinks.AsNoTracking().SingleAsync(row => row.ActivityId == activityId);
        var audits = await db.AuditEntries.AsNoTracking().Where(row => row.EntityType == nameof(Activity) && row.EntityId == activityId)
            .OrderBy(row => row.Id).Select(row => row.Id).ToArrayAsync();
        var id = activityId.ToString();
        var events = await db.OutboxMessages.AsNoTracking().Where(row => row.Type.Contains(nameof(ActivityLogged)) && row.Payload.Contains(id))
            .OrderBy(row => row.Id).Select(row => row.Id).ToArrayAsync();
        return new(new(activity.OrganizationId, activity.Type, activity.AssigneeId, activity.DueAt, activity.Status, activity.Subject, activity.Body),
            receipt.Source, receipt.SourceKey, audits, events);
    }
    private static void Unchanged(Evidence actual, Evidence expected)
    {
        actual.Task.ShouldBe(expected.Task); actual.Source.ShouldBe(expected.Source); actual.SourceKey.ShouldBe(expected.SourceKey);
        actual.AuditIds.ShouldBe(expected.AuditIds); actual.OutboxIds.ShouldBe(expected.OutboxIds);
    }
}
