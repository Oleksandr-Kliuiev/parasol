using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crm.Authorization;
using static Crm.IntegrationTests.IntegrationTestHelpers;

namespace Crm.IntegrationTests;

public class ProjectsApiTests(CrmWebFactory factory)
{
    private const string Projects = "/api/v1/projects";

    private static readonly DateOnly Today = DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, TimeZoneInfo.FindSystemTimeZoneById("Europe/Oslo")).DateTime);

    [Fact]
    public async Task A_project_runs_through_phases_and_a_completed_phase_reaches_the_next_billing_run()
    {
        var sales = factory.ClientAs(CrmRoles.Sales, userKey: "project-sales");
        var finance = factory.ClientAs(CrmRoles.Finance, userKey: "project-finance");
        var marker = $"P{Guid.NewGuid():N}"[..10];
        var organizationId = await sales.CreateOrganizationAsync(new { name = $"{marker} Prosjekt AS", orgNumber = TestData.OrgNumber(), status = "Customer" });

        var created = await sales.PostAsJsonAsync(Projects, new
        {
            organizationId,
            name = $"{marker} M365 migration",
            type = "M365Migration",
            billingModel = "PerPhase",
            startDate = Today.AddDays(-10).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
            endDate = (string?)null,
            budgetHours = 120m,
            budgetAmount = 180_000m,
        });
        created.StatusCode.ShouldBe(HttpStatusCode.Created);
        var project = await created.ReadJsonAsync();
        var projectId = project.GetProperty("id").GetGuid();
        project.GetProperty("number").GetString()!.ShouldStartWith("P-");
        project.GetProperty("status").GetString().ShouldBe("Planned");

        var withPhase = await (await sales.PostAsJsonAsync($"{Projects}/{projectId}/phases", new
        {
            name = "Pilot",
            plannedStart = Today.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
            plannedEnd = (string?)null,
            plannedHours = 40m,
            fee = 40_000m,
            billOnCompletion = true,
            productId = (Guid?)null,
        })).ReadJsonAsync();
        var phaseId = withPhase.GetProperty("phases").EnumerateArray().Single().GetProperty("id").GetGuid();

        var withTask = await (await sales.PostAsJsonAsync($"{Projects}/{projectId}/phases/{phaseId}/tasks", new
        {
            title = "Migrate mailboxes",
            assigneeId = (Guid?)null,
            dueDate = (string?)null,
            estimatedHours = 8m,
            notes = (string?)null,
            status = (string?)null,
        })).ReadJsonAsync();
        var taskId = withTask.GetProperty("phases").EnumerateArray().Single()
            .GetProperty("tasks").EnumerateArray().Single().GetProperty("id").GetGuid();
        withTask.GetProperty("progress").GetProperty("openTasks").GetInt32().ShouldBe(1);

        // An open task blocks the phase; that is what keeps the fee from being invoiced too early.
        var tooEarly = await sales.PostAsJsonAsync($"{Projects}/{projectId}/phases/{phaseId}/status", new { status = "Completed" });
        tooEarly.StatusCode.ShouldBe(HttpStatusCode.Conflict);
        (await tooEarly.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe("PRJ_OPEN_TASKS");

        (await sales.PutAsJsonAsync($"{Projects}/{projectId}/tasks/{taskId}", new
        {
            title = "Migrate mailboxes",
            assigneeId = (Guid?)null,
            dueDate = (string?)null,
            estimatedHours = 8m,
            notes = (string?)null,
            status = "Done",
        })).StatusCode.ShouldBe(HttpStatusCode.OK);

        var completed = await (await sales.PostAsJsonAsync($"{Projects}/{projectId}/phases/{phaseId}/status", new { status = "Completed" })).ReadJsonAsync();
        completed.GetProperty("phases").EnumerateArray().Single().GetProperty("completedOn").GetString()
            .ShouldBe(Today.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture));
        completed.GetProperty("progress").GetProperty("phaseFeesCompleted").GetDecimal().ShouldBe(40_000m);

        await factory.ProcessEventsAsync();

        // The fee waits in the queue and a run puts it on the customer's basis (docs/02 §4.10). A run owns its period
        // alone, so every test picks a month of its own.
        var period = new DateOnly(2028, 3, 1);
        var runId = (await (await finance.PostAsJsonAsync("/api/v1/billing/runs", new { year = period.Year, month = period.Month, notes = marker })).ReadJsonAsync())
            .GetProperty("id").GetGuid();
        (await finance.RunCommandAsync(runId, "collect")).StatusCode.ShouldBe(HttpStatusCode.OK);
        // The first open run that collects the fee holds it; in the shared database that may be another test's run (ADR-013).
        var detail = await factory.QueuedChargeBasisAsync(finance, runId, c => c.SourceType == "project-phase" && c.SourceLineId == phaseId);
        detail.GetProperty("organization").GetProperty("id").GetGuid().ShouldBe(organizationId);
        var line = detail.GetProperty("lines").EnumerateArray().Single(l => l.GetProperty("group").GetString() == "OneOff");
        line.GetProperty("description").GetString()!.ShouldContain("Pilot");
        line.GetProperty("lineTotal").GetDecimal().ShouldBe(40_000m);

        // A technician sees a project once on its team (DEV-09), and may look at it but not change it.
        var technician = factory.ClientAs(CrmRoles.Technician, userKey: "project-technician");
        (await technician.GetAsync($"{Projects}/{projectId}")).StatusCode.ShouldBe(HttpStatusCode.NotFound);
        (await sales.PostAsJsonAsync($"{Projects}/{projectId}/members", new { userId = await technician.UserIdAsync() })).StatusCode
            .ShouldBe(HttpStatusCode.OK);
        (await technician.GetAsync($"{Projects}/{projectId}")).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await technician.PostAsJsonAsync($"{Projects}/{projectId}/phases", new
        {
            name = "Rollout", plannedStart = (string?)null, plannedEnd = (string?)null, plannedHours = 0m, fee = 0m,
            billOnCompletion = false, productId = (Guid?)null,
        })).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task Hours_booked_on_a_project_show_up_as_plan_against_actual()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "project-admin");
        var lead = factory.ClientAs(CrmRoles.ServiceLead, userKey: "project-lead");
        var marker = $"H{Guid.NewGuid():N}"[..10];
        var organizationId = await admin.CreateOrganizationAsync(new { name = $"{marker} Timer AS", status = "Customer" });

        var projectId = (await (await lead.PostAsJsonAsync(Projects, new
        {
            organizationId,
            name = $"{marker} PowerOffice",
            type = "PowerOfficeImplementation",
            billingModel = "TimeAndMaterial",
            startDate = Today.AddDays(-5).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
            budgetHours = 10m,
            budgetAmount = 0m,
        })).ReadJsonAsync()).GetProperty("id").GetGuid();

        var entry = await lead.PostAsJsonAsync("/api/v1/time/entries", new
        {
            organizationId,
            workDate = Today.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
            hours = 6m,
            workType = "Onsite",
            billable = true,
            onsite = true,
            afterHours = false,
            description = $"{marker} workshop",
            projectId,
        });
        entry.StatusCode.ShouldBe(HttpStatusCode.Created);
        (await entry.ReadJsonAsync()).GetProperty("projectName").GetString().ShouldBe($"{marker} PowerOffice");

        var project = await lead.GetFromJsonAsync<JsonElement>($"{Projects}/{projectId}");
        project.GetProperty("progress").GetProperty("hours").GetDecimal().ShouldBe(6m);
        project.GetProperty("progress").GetProperty("billableHours").GetDecimal().ShouldBe(6m);
        project.GetProperty("progress").GetProperty("budgetHours").GetDecimal().ShouldBe(10m);

        var list = await lead.GetFromJsonAsync<JsonElement>($"{Projects}?search={marker}");
        list.GetProperty("items").EnumerateArray().Single().GetProperty("hours").GetDecimal().ShouldBe(6m);
    }

    [Fact]
    public async Task A_role_that_cannot_see_the_money_cannot_overwrite_it()
    {
        // Crm.ServiceLead edits projects but has no finance.read: the budget and the phase fee are hidden from it, so an edit
        // (the SPA used to send 0) or a crafted request must leave the stored values alone (F-G3-01).
        var sales = factory.ClientAs(CrmRoles.Sales, userKey: "project-sales");
        var finance = factory.ClientAs(CrmRoles.Finance, userKey: "project-finance");
        var lead = factory.ClientAs(CrmRoles.ServiceLead, userKey: "project-lead");
        var marker = $"B{Guid.NewGuid():N}"[..10];
        var organizationId = await sales.CreateOrganizationAsync(new { name = $"{marker} Budsjett AS", orgNumber = TestData.OrgNumber(), status = "Customer" });
        var start = Today.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

        object Body(decimal budget, string name) => new
        {
            organizationId, name, type = "M365Migration", billingModel = "PerPhase", startDate = start, endDate = (string?)null,
            budgetHours = 10m, budgetAmount = budget,
        };

        var created = await (await sales.PostAsJsonAsync(Projects, Body(90_000m, $"{marker} Prosjekt"))).ReadJsonAsync();
        var projectId = created.GetProperty("id").GetGuid();
        var withPhase = await (await sales.PostAsJsonAsync($"{Projects}/{projectId}/phases", new
        {
            name = "Pilot", plannedStart = start, plannedEnd = (string?)null, plannedHours = 5m, fee = 12_000m, billOnCompletion = true, productId = (Guid?)null,
        })).ReadJsonAsync();
        var phaseId = withPhase.GetProperty("phases").EnumerateArray().Single().GetProperty("id").GetGuid();

        // Edit as the lead, once as the SPA now does (keys omitted) and once as a crafted request with explicit zeros.
        var etag = (await lead.GetAsync($"{Projects}/{projectId}")).Headers.ETag!.Tag;
        var omitted = await lead.PutWithETagAsync($"{Projects}/{projectId}",
            new { organizationId, name = $"{marker} Renamed", type = "M365Migration", billingModel = "PerPhase", startDate = start, budgetHours = 11m }, etag);
        omitted.StatusCode.ShouldBe(HttpStatusCode.OK);
        etag = omitted.Headers.ETag!.Tag;
        (await lead.PutWithETagAsync($"{Projects}/{projectId}", Body(0m, $"{marker} Renamed again"), etag)).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await lead.PutAsJsonAsync($"{Projects}/{projectId}/phases/{phaseId}", new
        {
            name = "Pilot 2", plannedStart = start, plannedEnd = (string?)null, plannedHours = 6m, fee = 0m, billOnCompletion = false, productId = (Guid?)null,
        })).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await lead.PostAsJsonAsync($"{Projects}/{projectId}/phases", new
        {
            name = "Hidden fee", plannedStart = start, plannedEnd = (string?)null, plannedHours = 1m, fee = 99_000m, billOnCompletion = true, productId = (Guid?)null,
        })).StatusCode.ShouldBe(HttpStatusCode.OK);

        var seen = await finance.GetFromJsonAsync<JsonElement>($"{Projects}/{projectId}");
        seen.GetProperty("name").GetString().ShouldBe($"{marker} Renamed again");
        seen.GetProperty("progress").GetProperty("budgetAmount").GetDecimal().ShouldBe(90_000m);
        var phases = seen.GetProperty("phases").EnumerateArray().ToList();
        var pilot = phases.Single(p => p.GetProperty("id").GetGuid() == phaseId);
        pilot.GetProperty("name").GetString().ShouldBe("Pilot 2");
        pilot.GetProperty("fee").GetDecimal().ShouldBe(12_000m);
        pilot.GetProperty("billOnCompletion").GetBoolean().ShouldBeTrue();
        var added = phases.Single(p => p.GetProperty("name").GetString() == "Hidden fee");
        added.GetProperty("fee").GetDecimal().ShouldBe(0m);
        added.GetProperty("billOnCompletion").GetBoolean().ShouldBeFalse();

        // A project created by the lead has no budget it could have chosen.
        var leadCreated = await (await lead.PostAsJsonAsync(Projects, Body(55_000m, $"{marker} Lead"))).ReadJsonAsync();
        (await finance.GetFromJsonAsync<JsonElement>($"{Projects}/{leadCreated.GetProperty("id").GetGuid()}"))
            .GetProperty("progress").GetProperty("budgetAmount").GetDecimal().ShouldBe(0m);
    }
}
