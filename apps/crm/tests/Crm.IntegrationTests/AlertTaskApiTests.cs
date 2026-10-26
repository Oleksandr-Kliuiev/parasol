using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crm.Activities.Contracts;
using Crm.Activities.Domain;
using Crm.Activities.Persistence;
using Crm.Authorization;
using Crm.Service.Contracts;
using Crm.Service.Domain;
using Crm.Service.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crm.IntegrationTests;

/// <summary>
/// M38 on SQL Server: an alert of the Service mirror becomes one task through the HTTP API: preview, create (first writer wins), the
/// batch lookup of a page and the task's source read again. In the Atera collection: another class's complete Atera alert read
/// would resolve these alerts while a test runs.
/// </summary>
[Collection(AteraCollection.Name)]
public sealed class AlertTaskApiTests(CrmWebFactory factory)
{
    private const string Tasks = "/api/v1/activities/source-tasks";
    private static readonly DateTimeOffset At = new(2026, 10, 20, 6, 0, 0, TimeSpan.Zero);

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task An_open_alert_becomes_one_task_and_a_repeat_or_a_colleague_gets_that_task()
    {
        var (organizationId, marker) = await CustomerAsync();
        var alert = await AlertAsync(organizationId, marker, "disk");
        var (first, firstId) = await EmployeeAsync(CrmRoles.Technician);
        var (colleague, colleagueId) = await EmployeeAsync(CrmRoles.ServiceLead);

        using var previewResponse = await first.GetAsync($"{Tasks}/preview?alertId={alert.Id}", Ct);
        previewResponse.StatusCode.ShouldBe(HttpStatusCode.OK);
        previewResponse.Headers.CacheControl!.NoStore.ShouldBeTrue();
        var preview = await previewResponse.ReadJsonAsync();
        var source = preview.GetProperty("alert");
        (source.GetProperty("id").GetGuid(), source.GetProperty("organizationName").GetString(), source.GetProperty("severity").GetString(),
            source.GetProperty("state").GetString(), source.GetProperty("deviceName").GetString())
            .ShouldBe((alert.Id, $"{marker} Drift AS", "Critical", "Open", "SRV-01"));
        (preview.GetProperty("subject").GetString(), preview.GetProperty("priority").GetString(), preview.GetProperty("canCreate").GetBoolean())
            .ShouldBe((alert.Title, "High", true));
        preview.GetProperty("task").ValueKind.ShouldBe(JsonValueKind.Null);
        var fingerprint = preview.GetProperty("fingerprint").GetString()!;
        fingerprint.ShouldMatch("^[0-9a-f]{64}$");

        var due = DateTimeOffset.Parse("2026-10-22T14:00:00Z", CultureInfo.InvariantCulture);
        var created = await CreateAsync(first, alert.Id, firstId, $"{marker} free disk space on SRV-01", fingerprint, due);
        created.GetProperty("status").GetString().ShouldBe("CREATED");
        var task = created.GetProperty("task");
        var taskId = task.GetProperty("id").GetGuid();
        (task.GetProperty("subject").GetString(), task.GetProperty("status").GetString(), task.GetProperty("assignee").GetProperty("id").GetGuid(),
            task.GetProperty("dueAt").GetDateTimeOffset(), task.GetProperty("isAvailable").GetBoolean())
            .ShouldBe(($"{marker} free disk space on SRV-01", "Open", firstId, due, true));

        // A repeat of the same request and a colleague's later try both get the first writer's task, unchanged.
        (await CreateAsync(first, alert.Id, firstId, $"{marker} free disk space on SRV-01", fingerprint, due)).GetProperty("status").GetString().ShouldBe("EXISTING");
        var theirs = await CreateAsync(colleague, alert.Id, colleagueId, $"{marker} another subject", fingerprint, null);
        theirs.GetProperty("status").GetString().ShouldBe("EXISTING");
        (theirs.GetProperty("task").GetProperty("id").GetGuid(), theirs.GetProperty("task").GetProperty("assignee").GetProperty("id").GetGuid())
            .ShouldBe((taskId, firstId));

        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<ActivitiesDbContext>();
            var stored = await db.Activities.AsNoTracking().SingleAsync(a => a.Id == taskId, Ct);
            (stored.Type, stored.OrganizationId, stored.Priority, stored.Body, stored.AssigneeId).ShouldBe(
                (ActivityType.Task, organizationId, ActivityPriority.High, null, (Guid?)firstId));
            var receipt = await db.SourceTaskLinks.AsNoTracking().SingleAsync(l => l.ActivityId == taskId, Ct);
            receipt.Source.ShouldBe(new("atera", "alert", alert.ExternalCustomerId!, alert.ExternalId, "Task"));
            receipt.SourceKey.ShouldBe(SourceTaskIdentityRules.Key(receipt.Source));
            (await db.SourceTaskLinks.CountAsync(l => l.SourceKey == receipt.SourceKey, Ct)).ShouldBe(1);
        }

        var again = await (await first.GetAsync($"{Tasks}/preview?alertId={alert.Id}", Ct)).ReadJsonAsync();
        (again.GetProperty("task").GetProperty("id").GetGuid(), again.GetProperty("canCreate").GetBoolean()).ShouldBe((taskId, false));

        // One batch for a page: the alert with a task, one without, and an id that is no alert.
        var other = await AlertAsync(organizationId, marker, "backup", AlertSeverity.Warning);
        using var lookupResponse = await colleague.PostAsJsonAsync($"{Tasks}/lookup", new { alertIds = new[] { alert.Id, other.Id, Guid.NewGuid() } }, Ct);
        lookupResponse.StatusCode.ShouldBe(HttpStatusCode.OK);
        var link = (await lookupResponse.ReadJsonAsync()).GetProperty("items").EnumerateArray().ShouldHaveSingleItem();
        (link.GetProperty("alertId").GetGuid(), link.GetProperty("task").GetProperty("id").GetGuid(), link.GetProperty("task").GetProperty("subject").GetString())
            .ShouldBe((alert.Id, taskId, $"{marker} free disk space on SRV-01"));
        link.GetProperty("task").GetProperty("assignee").GetProperty("name").GetString().ShouldNotBeNullOrWhiteSpace("the row names who has it");

        var sourceRead = await (await colleague.GetAsync($"/api/v1/activities/{taskId}/source", Ct)).ReadJsonAsync();
        (sourceRead.GetProperty("task").GetProperty("id").GetGuid(), sourceRead.GetProperty("alert").GetProperty("id").GetGuid(),
            sourceRead.GetProperty("alert").GetProperty("title").GetString()).ShouldBe((taskId, alert.Id, alert.Title));

        var timeline = await first.GetFromJsonAsync<JsonElement>($"/api/v1/activities?organizationId={organizationId}&activityId={taskId}", Ct);
        timeline.GetProperty("items").EnumerateArray().ShouldHaveSingleItem().GetProperty("hasTechnicalSource").GetBoolean().ShouldBeTrue();
    }

    [Fact]
    public async Task A_changed_or_resolved_alert_is_read_again_before_any_task_is_made()
    {
        var (organizationId, marker) = await CustomerAsync();
        var alert = await AlertAsync(organizationId, marker, "changed");
        var (employee, employeeId) = await EmployeeAsync(CrmRoles.Technician);
        var fingerprint = (await (await employee.GetAsync($"{Tasks}/preview?alertId={alert.Id}", Ct)).ReadJsonAsync()).GetProperty("fingerprint").GetString()!;

        await ObserveAsync(alert.Id, title: $"{marker} disk full now");
        using (var stale = await PostAsync(employee, alert.Id, employeeId, $"{marker} task", fingerprint))
        {
            await RefusedAsync(stale, HttpStatusCode.Conflict, "ACT_SOURCE_ALERT_CHANGED");
        }

        var fresh = await (await employee.GetAsync($"{Tasks}/preview?alertId={alert.Id}", Ct)).ReadJsonAsync();
        fresh.GetProperty("fingerprint").GetString().ShouldNotBe(fingerprint);
        fresh.GetProperty("subject").GetString().ShouldBe($"{marker} disk full now");

        await ResolveAsync(alert.Id);
        var resolved = await (await employee.GetAsync($"{Tasks}/preview?alertId={alert.Id}", Ct)).ReadJsonAsync();
        (resolved.GetProperty("alert").GetProperty("state").GetString(), resolved.GetProperty("canCreate").GetBoolean()).ShouldBe(("Resolved", false));
        using (var closed = await PostAsync(employee, alert.Id, employeeId, $"{marker} task", resolved.GetProperty("fingerprint").GetString()!))
        {
            await RefusedAsync(closed, HttpStatusCode.Conflict, "ACT_SOURCE_ALERT_RESOLVED");
        }

        (await (await employee.PostAsJsonAsync($"{Tasks}/lookup", new { alertIds = new[] { alert.Id } }, Ct)).ReadJsonAsync())
            .GetProperty("items").GetArrayLength().ShouldBe(0, "nothing was made");

        // A warning makes a task of normal priority.
        var warning = await AlertAsync(organizationId, marker, "warning", AlertSeverity.Warning);
        var warningPreview = await (await employee.GetAsync($"{Tasks}/preview?alertId={warning.Id}", Ct)).ReadJsonAsync();
        warningPreview.GetProperty("priority").GetString().ShouldBe("Normal");
        var made = await CreateAsync(employee, warning.Id, employeeId, $"{marker} warning task", warningPreview.GetProperty("fingerprint").GetString()!, null);
        await using var scope = factory.Services.CreateAsyncScope();
        (await scope.ServiceProvider.GetRequiredService<ActivitiesDbContext>().Activities.AsNoTracking()
            .SingleAsync(a => a.Id == made.GetProperty("task").GetProperty("id").GetGuid(), Ct)).Priority.ShouldBe(ActivityPriority.Normal);
    }

    [Fact]
    public async Task Requests_are_checked_before_anything_is_read_or_written()
    {
        var (organizationId, marker) = await CustomerAsync();
        var alert = await AlertAsync(organizationId, marker, "checked");
        var (employee, employeeId) = await EmployeeAsync(CrmRoles.Technician);
        var fingerprint = (await (await employee.GetAsync($"{Tasks}/preview?alertId={alert.Id}", Ct)).ReadJsonAsync()).GetProperty("fingerprint").GetString()!;

        using (var unknownField = await employee.PostAsJsonAsync(Tasks, new
        {
            alertId = alert.Id, assigneeId = employeeId, dueAt = (DateTimeOffset?)null, subject = "x", expectedFingerprint = fingerprint, priority = "Low",
        }, Ct))
        {
            unknownField.StatusCode.ShouldBe(HttpStatusCode.BadRequest);
        }

        foreach (var (subject, print) in new[] { (new string('x', 257), fingerprint), ("  ", fingerprint), ("Line\nbreak", fingerprint), ("Fine", "ABC") })
        {
            using var invalid = await PostAsync(employee, alert.Id, employeeId, subject, print);
            invalid.StatusCode.ShouldBe(HttpStatusCode.BadRequest);
            (await invalid.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe("VALIDATION_FAILED");
        }

        using (var tooMany = await employee.PostAsJsonAsync($"{Tasks}/lookup", new { alertIds = Enumerable.Range(0, 51).Select(_ => Guid.NewGuid()) }, Ct))
        {
            tooMany.StatusCode.ShouldBe(HttpStatusCode.BadRequest);
        }

        using (var none = await employee.PostAsJsonAsync($"{Tasks}/lookup", new { alertIds = Array.Empty<Guid>() }, Ct))
        {
            none.StatusCode.ShouldBe(HttpStatusCode.BadRequest);
        }

        await RefusedAsync(await employee.GetAsync($"{Tasks}/preview?alertId={Guid.NewGuid()}", Ct), HttpStatusCode.NotFound, "ACT_SOURCE_ALERT_NOT_FOUND");
        var foreign = await AlertAsync(organizationId, marker, "foreign", system: $"m38-{marker}");
        await RefusedAsync(await employee.GetAsync($"{Tasks}/preview?alertId={foreign.Id}", Ct), HttpStatusCode.NotFound, "ACT_SOURCE_UNSUPPORTED");

        // A reader sees the preview but may not assign; a caller without the roles reaches nothing.
        var (reader, readerId) = await EmployeeAsync(CrmRoles.ReadOnly);
        var read = await (await reader.GetAsync($"{Tasks}/preview?alertId={alert.Id}", Ct)).ReadJsonAsync();
        read.GetProperty("canCreate").GetBoolean().ShouldBeFalse();
        (await PostAsync(reader, alert.Id, readerId, $"{marker} task", fingerprint)).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        using var nobody = factory.ClientAs("Crm.Unknown", "m38-nobody");
        (await nobody.GetAsync($"{Tasks}/preview?alertId={alert.Id}", Ct)).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        (await nobody.PostAsJsonAsync($"{Tasks}/lookup", new { alertIds = new[] { alert.Id } }, Ct)).StatusCode.ShouldBe(HttpStatusCode.Forbidden);

        // An assignee who cannot work on tasks is refused, and nothing is stored.
        await RefusedAsync(await PostAsync(employee, alert.Id, readerId, $"{marker} task", fingerprint), HttpStatusCode.BadRequest, "ACT_SOURCE_TASK_ASSIGNEE_INVALID");
        (await (await employee.PostAsJsonAsync($"{Tasks}/lookup", new { alertIds = new[] { alert.Id } }, Ct)).ReadJsonAsync())
            .GetProperty("items").GetArrayLength().ShouldBe(0);
    }

    [Fact]
    public async Task The_source_of_a_task_is_the_alert_as_stored_now_and_only_while_it_is_the_same_customers()
    {
        var (organizationId, marker) = await CustomerAsync();
        var alert = await AlertAsync(organizationId, marker, "source");
        var (employee, employeeId) = await EmployeeAsync(CrmRoles.Technician);
        var preview = await (await employee.GetAsync($"{Tasks}/preview?alertId={alert.Id}", Ct)).ReadJsonAsync();
        var taskId = (await CreateAsync(employee, alert.Id, employeeId, alert.Title, preview.GetProperty("fingerprint").GetString()!, null))
            .GetProperty("task").GetProperty("id").GetGuid();

        await ResolveAsync(alert.Id);
        var resolved = await (await employee.GetAsync($"/api/v1/activities/{taskId}/source", Ct)).ReadJsonAsync();
        resolved.GetProperty("alert").GetProperty("state").GetString().ShouldBe("Resolved");

        // The source now reports the alert under another of its customers: it is no longer this task's alert.
        await ObserveAsync(alert.Id, externalCustomerId: alert.ExternalCustomerId + "0");
        var moved = await (await employee.GetAsync($"/api/v1/activities/{taskId}/source", Ct)).ReadJsonAsync();
        (moved.GetProperty("task").GetProperty("id").GetGuid(), moved.GetProperty("alert").ValueKind).ShouldBe((taskId, JsonValueKind.Null));

        await RefusedAsync(await employee.GetAsync($"/api/v1/activities/{Guid.NewGuid()}/source", Ct), HttpStatusCode.NotFound, "ACT_SOURCE_TASK_NOT_FOUND");
    }

    [Fact]
    public async Task A_receipt_of_the_retired_workspace_offers_no_source_and_still_blocks_nothing_else()
    {
        var (organizationId, marker) = await CustomerAsync();
        var (employee, employeeId) = await EmployeeAsync(CrmRoles.Technician);
        Guid taskId;
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<ActivitiesDbContext>();
            var task = Activity.Create(new(ActivityType.Task, organizationId, null, null, null, "Review technical observation", null, null,
                ActivityPriority.Normal, employeeId), DateTimeOffset.UtcNow).Value;
            db.Activities.Add(task);
            // A receipt of a system the CRM no longer reads, shaped as the retired workspace wrote them (M12), kept as history.
            db.SourceTaskLinks.Add(new SourceTaskLink
            {
                SourceKey = Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(marker))),
                ActivityId = task.Id, System = "retired-workspace", SourceKind = "synthetic-workspace", ExternalCustomerId = "synthetic-client",
                ExternalId = $"observation-{marker}", TargetKind = "Task", CreatedAt = DateTimeOffset.UtcNow, CreatedBy = employeeId,
            });
            await db.SaveChangesAsync(Ct);
            taskId = task.Id;
        }

        var row = (await employee.GetFromJsonAsync<JsonElement>($"/api/v1/activities?organizationId={organizationId}&activityId={taskId}", Ct))
            .GetProperty("items").EnumerateArray().ShouldHaveSingleItem();
        row.GetProperty("hasTechnicalSource").GetBoolean().ShouldBeFalse();
        await RefusedAsync(await employee.GetAsync($"/api/v1/activities/{taskId}/source", Ct), HttpStatusCode.NotFound, "ACT_SOURCE_UNSUPPORTED");
        // The task itself works as any other: it can be done.
        (await employee.PostWithETagAsync($"/api/v1/activities/{taskId}/complete", new { }, row.GetProperty("etag").GetString()!))
            .StatusCode.ShouldBe(HttpStatusCode.OK);
    }

    private async Task<(Guid OrganizationId, string Marker)> CustomerAsync()
    {
        var marker = $"T{Guid.NewGuid():N}"[..10];
        var organizationId = await factory.ClientAs(CrmRoles.Admin).CreateOrganizationAsync(new { name = $"{marker} Drift AS", status = "Customer" });
        return (organizationId, marker);
    }

    private async Task<(HttpClient Client, Guid Id)> EmployeeAsync(string role)
    {
        var client = factory.ClientAs(role, "m38-alert-task-" + Guid.NewGuid().ToString("N"));
        return (client, (await client.GetFromJsonAsync<JsonElement>("/bff/user", Ct)).GetProperty("id").GetGuid());
    }

    /// <summary>An alert stored as the Atera read stores it, without a snapshot: a complete read would resolve other classes' alerts.</summary>
    private async Task<Alert> AlertAsync(Guid organizationId, string marker, string name, AlertSeverity severity = AlertSeverity.Critical,
        string system = "atera")
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ServiceDbContext>();
        // The source's customer id of the test's customer: the marker's digits are its own, so no other test shares it.
        var customerId = "9" + new string([.. marker.Where(char.IsAsciiDigit)]);
        var alert = Alert.Open(system, AlertKind.Monitoring, new ExternalAlert($"{marker}-{name}", organizationId, severity,
            $"{marker} {name} needs attention", "SRV-01", At, customerId), null, DateTimeOffset.UtcNow);
        db.Alerts.Add(alert);
        await db.SaveChangesAsync(Ct);
        return alert;
    }

    private async Task ObserveAsync(Guid alertId, string? title = null, string? externalCustomerId = null)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ServiceDbContext>();
        var alert = await db.Alerts.SingleAsync(a => a.Id == alertId, Ct);
        alert.Observe(alert.Kind, new ExternalAlert(alert.ExternalId, alert.OrganizationId, alert.Severity, title ?? alert.Title, alert.DeviceName,
            alert.CreatedAtSource, externalCustomerId ?? alert.ExternalCustomerId, alert.Url), alert.DeviceId, DateTimeOffset.UtcNow);
        await db.SaveChangesAsync(Ct);
    }

    private async Task ResolveAsync(Guid alertId)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ServiceDbContext>();
        (await db.Alerts.SingleAsync(a => a.Id == alertId, Ct)).Resolve(DateTimeOffset.UtcNow);
        await db.SaveChangesAsync(Ct);
    }

    private static Task<HttpResponseMessage> PostAsync(HttpClient client, Guid alertId, Guid assigneeId, string subject, string fingerprint,
        DateTimeOffset? dueAt = null) =>
        client.PostAsJsonAsync(Tasks, new { alertId, assigneeId, dueAt, subject, expectedFingerprint = fingerprint }, Ct);

    private static async Task<JsonElement> CreateAsync(HttpClient client, Guid alertId, Guid assigneeId, string subject, string fingerprint,
        DateTimeOffset? dueAt)
    {
        using var response = await PostAsync(client, alertId, assigneeId, subject, fingerprint, dueAt);
        response.StatusCode.ShouldBe(HttpStatusCode.OK, await response.Content.ReadAsStringAsync(Ct));
        return await response.ReadJsonAsync();
    }

    private static async Task RefusedAsync(HttpResponseMessage response, HttpStatusCode status, string code)
    {
        using (response)
        {
            response.StatusCode.ShouldBe(status, await response.Content.ReadAsStringAsync(Ct));
            (await response.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe(code);
        }
    }
}
