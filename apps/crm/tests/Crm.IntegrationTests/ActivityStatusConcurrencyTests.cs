using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crm.Activities.Contracts;
using Crm.Activities.Domain;
using Crm.Activities.Persistence;
using Crm.Authorization;
using Crm.Infrastructure.Persistence;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using static Crm.IntegrationTests.SourceTaskTestSupport;

namespace Crm.IntegrationTests;

/// <summary>Status commands compare the version the employee actually saw, including commands that would change nothing.</summary>
public sealed class ActivityStatusConcurrencyTests(CrmWebFactory factory)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Stale_status_commands_change_nothing_and_reviewed_commands_preserve_source_assignment_and_due_date()
    {
        using var first = factory.ClientAs(CrmRoles.Technician, "status-first-" + Guid.NewGuid().ToString("N"));
        using var second = factory.ClientAs(CrmRoles.Finance, "status-second-" + Guid.NewGuid().ToString("N"));
        var actor = (await first.GetFromJsonAsync<JsonElement>("/bff/user", Ct)).GetProperty("id").GetGuid();
        var reviewer = (await second.GetFromJsonAsync<JsonElement>("/bff/user", Ct)).GetProperty("id").GetGuid();
        var task = await SourceTask(actor);
        var initial = await Read(first, task); var oldEtag = Etag(initial);
        var due = DateTimeOffset.Parse("2090-07-01T08:15:43.456Z");
        using var editedResponse = await Edit(second, task, oldEtag, "Employee-authored status review", due, actor);
        editedResponse.StatusCode.ShouldBe(HttpStatusCode.OK);
        var edited = await editedResponse.Content.ReadFromJsonAsync<JsonElement>(Ct); var editedEtag = Etag(edited);
        editedEtag.ShouldNotBe(oldEtag);
        var afterEdit = await State(task);

        using var staleComplete = await Status(first, task, "complete", oldEtag);
        await Refused(staleComplete, HttpStatusCode.PreconditionFailed, "CONCURRENCY_CONFLICT");
        Unchanged(await State(task), afterEdit);
        using var complete = await Status(second, task, "complete", editedEtag);
        complete.StatusCode.ShouldBe(HttpStatusCode.OK);
        var completed = await complete.Content.ReadFromJsonAsync<JsonElement>(Ct); var completedEtag = Etag(completed);
        completedEtag.ShouldNotBe(editedEtag); completed.GetProperty("status").GetString().ShouldBe("Done");
        completed.GetProperty("assignee").GetProperty("id").GetGuid().ShouldBe(actor);
        completed.GetProperty("dueAt").GetDateTimeOffset().ShouldBe(due);
        completed.GetProperty("hasTechnicalSource").GetBoolean().ShouldBeTrue();
        var afterComplete = await State(task);
        afterComplete.Task.ShouldBe(afterEdit.Task with
        { Status = ActivityStatus.Done, CompletedAt = completed.GetProperty("completedAt").GetDateTimeOffset(), CompletedBy = reviewer });
        afterComplete.Source.ShouldBe(afterEdit.Source); afterComplete.SourceKey.ShouldBe(afterEdit.SourceKey);
        afterComplete.AuditIds.Length.ShouldBe(afterEdit.AuditIds.Length + 1);
        afterComplete.OutboxIds.Length.ShouldBe(afterEdit.OutboxIds.Length + 1);

        using var staleReopen = await Status(first, task, "reopen", editedEtag);
        await Refused(staleReopen, HttpStatusCode.PreconditionFailed, "CONCURRENCY_CONFLICT");
        Unchanged(await State(task), afterComplete);
        using var reopen = await Status(first, task, "reopen", completedEtag);
        reopen.StatusCode.ShouldBe(HttpStatusCode.OK);
        var reopened = await reopen.Content.ReadFromJsonAsync<JsonElement>(Ct);
        Etag(reopened).ShouldNotBe(completedEtag); reopened.GetProperty("status").GetString().ShouldBe("Open");
        reopened.GetProperty("assignee").GetProperty("id").GetGuid().ShouldBe(actor);
        reopened.GetProperty("dueAt").GetDateTimeOffset().ShouldBe(due);
        var afterReopen = await State(task);
        afterReopen.Task.ShouldBe(afterEdit.Task); afterReopen.Source.ShouldBe(afterEdit.Source); afterReopen.SourceKey.ShouldBe(afterEdit.SourceKey);
        afterReopen.AuditIds.Length.ShouldBe(afterComplete.AuditIds.Length + 1);
        // Preserve the existing reopen domain contract: it updates the Activity but does not log a new ActivityLogged event.
        afterReopen.OutboxIds.ShouldBe(afterComplete.OutboxIds);
    }

    [Theory]
    [InlineData("complete")]
    [InlineData("reopen")]
    public async Task Missing_and_malformed_preconditions_have_the_existing_codes_and_leave_every_task_store_unchanged(string action)
    {
        var task = await SourceTask(); using var client = factory.ClientAs(CrmRoles.Technician);
        var before = await State(task);
        using var missing = await Status(client, task, action, null);
        await Refused(missing, HttpStatusCode.PreconditionRequired, "IF_MATCH_REQUIRED");
        Unchanged(await State(task), before);
        using var malformed = await Status(client, task, action, "not-an-etag!");
        await Refused(malformed, HttpStatusCode.PreconditionFailed, "INVALID_ETAG");
        Unchanged(await State(task), before);
    }

    [Fact]
    public async Task A_stale_already_open_reopen_is_refused_while_a_current_no_op_keeps_its_version_and_stores()
    {
        var task = await SourceTask(); using var client = factory.ClientAs(CrmRoles.Technician);
        var initial = await Read(client, task);
        using var changedResponse = await Edit(client, task, Etag(initial), "Reviewed open task",
            initial.GetProperty("dueAt").GetDateTimeOffset(), initial.GetProperty("assignee").GetProperty("id").GetGuid());
        changedResponse.StatusCode.ShouldBe(HttpStatusCode.OK);
        var changed = await changedResponse.Content.ReadFromJsonAsync<JsonElement>(Ct); var before = await State(task);
        before.Task.Status.ShouldBe(ActivityStatus.Open);
        using var stale = await Status(client, task, "reopen", Etag(initial));
        await Refused(stale, HttpStatusCode.PreconditionFailed, "CONCURRENCY_CONFLICT");
        Unchanged(await State(task), before);
        using var current = await Status(client, task, "reopen", Etag(changed));
        current.StatusCode.ShouldBe(HttpStatusCode.OK);
        var unchanged = await current.Content.ReadFromJsonAsync<JsonElement>(Ct);
        Etag(unchanged).ShouldBe(Etag(changed)); unchanged.GetProperty("status").GetString().ShouldBe("Open");
        Unchanged(await State(task), before);
        // A successful no-op linearizes at its version check; it neither advances rowversion nor promises a later SQL CAS.
    }

    [Fact]
    public async Task Two_completions_that_both_read_the_same_version_commit_only_one_status_audit_and_event()
    {
        var employeeA = await Employee(factory, CrmRoles.Technician); var employeeB = await Employee(factory, CrmRoles.Finance);
        var task = await SourceTask(employeeA); var gate = new BothStatusSaves(task.ActivityId);
        await using var firstHost = Host(factory, employeeA, configure: services =>
            services.AddDbContext<ActivitiesDbContext>(options => options.AddInterceptors(gate)));
        await using var secondHost = Host(factory, employeeB, CrmRoles.Finance, services =>
            services.AddDbContext<ActivitiesDbContext>(options => options.AddInterceptors(gate)));
        using var first = Client(firstHost, CrmRoles.Technician); using var second = Client(secondHost, CrmRoles.Finance);
        // Provision both clients before the write baseline; authentication itself has legitimate identity audit effects.
        _ = await first.GetFromJsonAsync<JsonElement>("/bff/user", Ct); _ = await second.GetFromJsonAsync<JsonElement>("/bff/user", Ct);
        var current = await Read(first, task); var before = await State(task);
        var pendingA = Status(first, task, "complete", Etag(current));
        var pendingB = Status(second, task, "complete", Etag(current));
        HttpResponseMessage[] responses;
        try { await gate.BothEntered.Task.WaitAsync(TimeSpan.FromSeconds(10), Ct); }
        finally { gate.Resume.TrySetResult(); responses = await Task.WhenAll(pendingA, pendingB); }
        try
        {
            responses.Count(response => response.StatusCode == HttpStatusCode.OK).ShouldBe(1);
            var refused = responses.Single(response => response.StatusCode != HttpStatusCode.OK);
            await Refused(refused, HttpStatusCode.PreconditionFailed, "CONCURRENCY_CONFLICT");
            var after = await State(task); after.Task.Status.ShouldBe(ActivityStatus.Done);
            after.Task.AssigneeId.ShouldBe(before.Task.AssigneeId); after.Task.DueAt.ShouldBe(before.Task.DueAt);
            after.Source.ShouldBe(before.Source); after.SourceKey.ShouldBe(before.SourceKey); after.Etag.ShouldNotBe(before.Etag);
            after.AuditIds.Length.ShouldBe(before.AuditIds.Length + 1); after.OutboxIds.Length.ShouldBe(before.OutboxIds.Length + 1);
        }
        finally { foreach (var response in responses) response.Dispose(); }
    }

    [Theory]
    [InlineData("complete")]
    [InlineData("reopen")]
    public async Task A_deleted_task_with_a_previously_valid_version_is_not_found_and_never_revived(string action)
    {
        var task = await SourceTask(); using var client = factory.ClientAs(CrmRoles.Technician);
        var old = await Read(client, task);
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<ActivitiesDbContext>();
            (await db.Activities.SingleAsync(a => a.Id == task.ActivityId, Ct)).MarkDeleted(); await db.SaveChangesAsync(Ct);
        }
        var before = await State(task);
        using var response = await Status(client, task, action, Etag(old));
        await Refused(response, HttpStatusCode.NotFound, "ACT_NOT_FOUND");
        Unchanged(await State(task), before); (await State(task)).Task.IsDeleted.ShouldBeTrue();
    }

    [Fact]
    public async Task A_stale_meeting_edit_is_refused_before_calendar_effects_and_a_reviewed_edit_still_reaches_the_calendar()
    {
        var organization = await Organization(factory); var employee = await Employee(factory, CrmRoles.Sales);
        var due = DateTimeOffset.Parse("2090-01-01T09:00:00Z"); Guid id;
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<ActivitiesDbContext>();
            var meeting = Activity.Create(new(ActivityType.Meeting, organization, null, null, null, "Synthetic calendar meeting",
                null, due, ActivityPriority.Normal, employee), DateTimeOffset.UtcNow).Value;
            db.Activities.Add(meeting); await db.SaveChangesAsync(Ct); id = meeting.Id;
        }
        var task = new TaskFixture(organization, id); var calendar = new RecordingCalendar();
        await using var host = Host(factory, employee, CrmRoles.Sales, services => services.AddSingleton<IUserCalendar>(calendar));
        using var client = Client(host, CrmRoles.Sales); var initial = await Read(client, task);
        using var firstEdit = await Edit(client, task, Etag(initial), "Synthetic reviewed meeting", due, employee, type: "Meeting");
        firstEdit.StatusCode.ShouldBe(HttpStatusCode.OK);
        var changed = await firstEdit.Content.ReadFromJsonAsync<JsonElement>(Ct); var before = await State(task);
        using var stale = await Edit(client, task, Etag(initial), "Synthetic stale meeting", due, employee, calendar: true, type: "Meeting");
        await Refused(stale, HttpStatusCode.PreconditionFailed, "CONCURRENCY_CONFLICT");
        calendar.Creates.ShouldBe(0); Unchanged(await State(task), before);
        using var reviewed = await Edit(client, task, Etag(changed), "Synthetic calendar meeting", due, employee, calendar: true, type: "Meeting");
        reviewed.StatusCode.ShouldBe(HttpStatusCode.OK); calendar.Creates.ShouldBe(1);
        (await reviewed.Content.ReadFromJsonAsync<JsonElement>(Ct)).GetProperty("inCalendar").GetBoolean().ShouldBeTrue();
    }

    private sealed record TaskFixture(Guid OrganizationId, Guid ActivityId);
    private async Task<TaskFixture> SourceTask(Guid? actor = null)
    {
        var organization = await Organization(factory); var employee = actor ?? await Employee(factory, CrmRoles.Technician);
        await using var host = Host(factory, employee);
        var task = (await Create(host, new(Source(), organization, employee, DateTimeOffset.Parse("2090-01-01T10:30:45.123Z"), ActivityPriority.Normal))).Value;
        return new(organization, task.ActivityId);
    }
    private static HttpClient Client(WebApplicationFactory<Program> host, string role)
    {
        var client = host.CreateClient(); client.DefaultRequestHeaders.Add(TestAuthHandler.RolesHeader, role);
        client.DefaultRequestHeaders.Add(TestAuthHandler.UserHeader, "status-host-" + Guid.NewGuid().ToString("N"));
        client.DefaultRequestHeaders.Add("X-CSRF", "1"); return client;
    }
    private static string Etag(JsonElement activity) => activity.GetProperty("etag").GetString()!;
    private static async Task<JsonElement> Read(HttpClient client, TaskFixture task)
    {
        var page = await client.GetFromJsonAsync<JsonElement>($"/api/v1/activities?organizationId={task.OrganizationId}&activityId={task.ActivityId}", Ct);
        return page.GetProperty("items").EnumerateArray().ShouldHaveSingleItem().Clone();
    }
    private static async Task<HttpResponseMessage> Status(HttpClient client, TaskFixture task, string action, string? etag)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/activities/{task.ActivityId}/{action}");
        if (etag is not null) request.Headers.TryAddWithoutValidation("If-Match", etag);
        return await client.SendAsync(request, Ct);
    }
    private static async Task<HttpResponseMessage> Edit(HttpClient client, TaskFixture task, string etag, string subject,
        DateTimeOffset due, Guid assignee, bool calendar = false, string type = "Task")
    {
        using var request = new HttpRequestMessage(HttpMethod.Put, $"/api/v1/activities/{task.ActivityId}")
        {
            Content = JsonContent.Create(new { type, organizationId = task.OrganizationId, subject, body = (string?)null,
                dueAt = due, priority = "Normal", assigneeId = assignee, addToCalendar = calendar }),
        };
        request.Headers.TryAddWithoutValidation("If-Match", etag); return await client.SendAsync(request, Ct);
    }
    private static async Task Refused(HttpResponseMessage response, HttpStatusCode status, string code)
    {
        response.StatusCode.ShouldBe(status);
        (await response.Content.ReadFromJsonAsync<JsonElement>(Ct)).GetProperty("code").GetString().ShouldBe(code);
    }
    private sealed record TaskState(Guid OrganizationId, ActivityType Type, string Subject, string? Body, ActivityPriority Priority,
        Guid? AssigneeId, DateTimeOffset? DueAt, ActivityStatus Status, DateTimeOffset? CompletedAt, Guid? CompletedBy, bool IsDeleted);
    private sealed record Evidence(TaskState Task, string Etag, SourceTaskIdentity? Source, string? SourceKey, long[] AuditIds, Guid[] OutboxIds);
    private async Task<Evidence> State(TaskFixture task)
    {
        await using var scope = factory.Services.CreateAsyncScope(); var db = scope.ServiceProvider.GetRequiredService<ActivitiesDbContext>();
        var activity = await db.Activities.IgnoreQueryFilters().SingleAsync(a => a.Id == task.ActivityId, Ct);
        var source = await db.SourceTaskLinks.AsNoTracking().SingleOrDefaultAsync(s => s.ActivityId == task.ActivityId, Ct);
        var audits = await db.AuditEntries.AsNoTracking().Where(a => a.EntityType == nameof(Activity) && a.EntityId == task.ActivityId)
            .OrderBy(a => a.Id).Select(a => a.Id).ToArrayAsync(Ct);
        var id = task.ActivityId.ToString();
        var events = await db.OutboxMessages.AsNoTracking().Where(e => e.Type.Contains(nameof(ActivityLogged)) && e.Payload.Contains(id))
            .OrderBy(e => e.Id).Select(e => e.Id).ToArrayAsync(Ct);
        return new(new(activity.OrganizationId, activity.Type, activity.Subject, activity.Body, activity.Priority, activity.AssigneeId,
            activity.DueAt, activity.Status, activity.CompletedAt, activity.CompletedBy, activity.IsDeleted), db.GetETag(activity),
            source?.Source, source?.SourceKey, audits, events);
    }
    private static void Unchanged(Evidence actual, Evidence expected)
    {
        actual.Task.ShouldBe(expected.Task); actual.Etag.ShouldBe(expected.Etag); actual.Source.ShouldBe(expected.Source);
        actual.SourceKey.ShouldBe(expected.SourceKey); actual.AuditIds.ShouldBe(expected.AuditIds); actual.OutboxIds.ShouldBe(expected.OutboxIds);
    }
    private sealed class BothStatusSaves(Guid activityId) : SaveChangesInterceptor
    {
        private int _entered;
        public TaskCompletionSource BothEntered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource Resume { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public override async ValueTask<InterceptionResult<int>> SavingChangesAsync(DbContextEventData eventData,
            InterceptionResult<int> result, CancellationToken cancellationToken = default)
        {
            if (eventData.Context is ActivitiesDbContext db && db.ChangeTracker.Entries<Activity>()
                .Any(entry => entry.Entity.Id == activityId && entry.State == EntityState.Modified))
            {
                if (Interlocked.Increment(ref _entered) == 2) BothEntered.TrySetResult();
                await Resume.Task.WaitAsync(cancellationToken);
            }
            return result;
        }
    }
    private sealed class RecordingCalendar : IUserCalendar
    {
        public bool IsAvailable => true;
        public int Creates { get; private set; }
        public Task<CalendarEventState> CreateAsync(CalendarEventDraft draft, CancellationToken cancellationToken)
        {
            Creates++; return Task.FromResult(new CalendarEventState("synthetic-m20-event", draft.ActivityId, draft.Subject,
                draft.StartsAt, draft.EndsAt, false, "https://example.test/calendar/m20"));
        }
        public Task<CalendarEventState> UpdateAsync(string eventId, CalendarEventDraft draft, CancellationToken cancellationToken) =>
            throw new InvalidOperationException("An unexpected calendar update occurred.");
        public Task CancelAsync(string eventId, CancellationToken cancellationToken) =>
            throw new InvalidOperationException("An unexpected calendar cancellation occurred.");
        public Task<IReadOnlyList<CalendarEventState>> ReadWindowAsync(DateTimeOffset from, DateTimeOffset to, CancellationToken cancellationToken) =>
            throw new InvalidOperationException("An unexpected calendar read occurred.");
    }
}
