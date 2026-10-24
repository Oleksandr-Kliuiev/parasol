using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crm.Integrations.Core;
using Crm.Integrations.Core.Persistence;
using Crm.Integrations.Huntress;
using Crm.Security.Contracts;
using Crm.Security.Persistence;
using Crm.Service.Contracts;
using Crm.Service.Domain;
using Crm.Service.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using static Crm.IntegrationTests.IntegrationTestHelpers;

namespace Crm.IntegrationTests;

/// <summary>
/// M41 on SQL Server through the Huntress jobs against a stub of Huntress API v1: organizations become mapping records and the linked
/// ones get their usage; agents join the computer's Atera agent in one machine and the coverage rules find what is missing; incidents,
/// escalations and platform actions become Security alerts with their detail in the security module, and an urgent incident Huntress
/// closes waits for a person to confirm it.
/// </summary>
[Collection(HuntressCollection.Name)]
public sealed class HuntressSyncTests(CrmWebFactory factory)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Organizations_are_mapping_records_and_the_linked_ones_get_what_huntress_counts()
    {
        await using var host = HuntressHost.Start(factory);
        var customer = await host.CustomerAsync();
        var unlinked = customer.HuntressOrganizationId + 1;
        host.List("/v1/organizations", "organizations", [
            new { id = customer.HuntressOrganizationId, name = $"{customer.Marker} Huntress", key = "linked", agents_count = 12 },
            new { id = unlinked, name = $"{customer.Marker} Not linked", key = "other", agents_count = 3 },
        ]);
        host.On("GET", $"/v1/organizations/{customer.HuntressOrganizationId}").RespondWith(JsonReply(new
        {
            organization = new
            {
                id = customer.HuntressOrganizationId, name = $"{customer.Marker} Huntress", agents_count = 12,
                actual_usages = new
                {
                    edr = new { billable_agents_count = 11, unresponsive_agents_count = 2, outdated_agents_count = 1, isolated_agents_count = 0 },
                    itdr = new[] { new { billable_identities_count = 20 }, new { billable_identities_count = 5 } },
                    sat = new { learners_count = 9 },
                },
            },
        }));

        await host.RunJobAsync<HuntressOrganizationSyncJob>(job => job.RunAsync(Ct));

        (await host.LatestRunAsync(HuntressOrganizationSyncJob.JobId)).Status.ShouldBe(SyncRunStatus.Succeeded);
        await using (var scope = host.Services.CreateAsyncScope())
        {
            var records = await scope.ServiceProvider.GetRequiredService<IntegrationDbContext>().ExternalRecords.AsNoTracking()
                .Where(r => r.System == HuntressTypes.System && r.ExternalType == HuntressTypes.Organization && r.DisplayName.StartsWith(customer.Marker))
                .Select(r => r.ExternalId).ToListAsync(Ct);
            records.ShouldBe([customer.HuntressOrganizationId.ToString(CultureInfo.InvariantCulture), unlinked.ToString(CultureInfo.InvariantCulture)], ignoreOrder: true);
        }

        host.Count("GET", $"/v1/organizations/{unlinked}").ShouldBe(0, "only a linked organization's usage is read");
        var overview = await host.Client().GetFromJsonAsync<JsonElement>($"/api/v1/security/organizations/{customer.OrganizationId}/overview", Ct);
        var usage = overview.GetProperty("usage").EnumerateArray().ShouldHaveSingleItem();
        (usage.GetProperty("billableAgents").GetInt32(), usage.GetProperty("unresponsiveAgents").GetInt32(), usage.GetProperty("outdatedAgents").GetInt32(),
            usage.GetProperty("isolatedAgents").GetInt32(), usage.GetProperty("billableIdentities").GetInt32(), usage.GetProperty("satLearners").GetInt32(),
            usage.GetProperty("agentsCount").GetInt32()).ShouldBe((11, 2, 1, 0, 25, 9, 12));
        overview.GetProperty("reads").EnumerateArray().Select(r => r.GetProperty("job").GetString())
            .ShouldBe([HuntressOrganizationSyncJob.JobId, HuntressReportSyncJob.JobId]);
    }

    [Fact]
    public async Task An_agent_joins_the_computers_atera_machine_and_the_coverage_rules_find_what_is_missing()
    {
        await using var host = HuntressHost.Start(factory);
        var customer = await host.CustomerAsync();
        var m = customer.Marker;
        await using (var scope = host.Services.CreateAsyncScope())
        {
            // Atera watches two computers of the customer, known for a week.
            await scope.ServiceProvider.GetRequiredService<IServiceApi>().ReplaceDevicesAsync(customer.OrganizationId, "atera", [
                new($"{m}-a-srv", $"{m}-SRV", DeviceType.Server, "Windows Server 2022", true, DateTimeOffset.UtcNow, null, $"SER-{m}", ["00:11:22:33:44:55"]),
                new($"{m}-a-pc", $"{m}-PC", DeviceType.Workstation, "Windows 11 Pro", true, DateTimeOffset.UtcNow, null, $"SER2-{m}"),
            ], Ct);
            await scope.ServiceProvider.GetRequiredService<ServiceDbContext>().Devices.Where(d => d.ExternalId.StartsWith(m))
                .ExecuteUpdateAsync(s => s.SetProperty(d => d.FirstSeenAt, DateTimeOffset.UtcNow.AddDays(-7)), Ct);
        }

        // Huntress watches the server (Defender unhealthy) and a laptop Atera does not know, silent for ten days.
        var serverAgent = Random.Shared.NextInt64(70_000_000, 79_999_999);
        var laptopAgent = serverAgent + 1;
        host.List("/v1/agents", "agents", [
            HuntressRecords.Agent(serverAgent, customer.HuntressOrganizationId, $"{m}-SRV", $"SER-{m}", ["00:11:22:33:44:55"], os: "Windows Server 2022", defender: "Unhealthy"),
            HuntressRecords.Agent(laptopAgent, customer.HuntressOrganizationId, $"{m}-LAPTOP", callback: DateTimeOffset.UtcNow.AddDays(-10)),
        ]);

        await host.RunJobAsync<HuntressAgentSyncJob>(job => job.RunAsync(Ct));

        (await host.LatestRunAsync(HuntressAgentSyncJob.JobId)).Status.ShouldBe(SyncRunStatus.Succeeded);
        await using var read = host.Services.CreateAsyncScope();
        var db = read.ServiceProvider.GetRequiredService<ServiceDbContext>();
        var devices = await db.Devices.AsNoTracking().Where(d => d.OrganizationId == customer.OrganizationId && d.RemovedAt == null).ToListAsync(Ct);
        var server = devices.Where(d => d.MachineName == $"{m}-SRV").ToList();
        server.Select(d => d.System).ShouldBe(["atera", "huntress"], ignoreOrder: true);
        server.Select(d => d.MachineId).Distinct().ShouldHaveSingleItem("serial, MAC and name match: one machine");
        var agent = server.Single(d => d.System == "huntress");
        (agent.Platform, agent.AntivirusStatus, agent.Isolation, agent.AgentVersion, agent.AlternateId)
            .ShouldBe(("windows", "Unhealthy", "Disabled", "0.13.140", customer.HuntressOrganizationId.ToString(CultureInfo.InvariantCulture)));
        (await db.Devices.CountAsync(d => d.OrganizationId == customer.OrganizationId && d.System == "atera" && d.RemovedAt == null, Ct))
            .ShouldBe(2, "Huntress's agents never replace Atera's, which billing counts");

        // The machine's card shows what Huntress says about the server's protection.
        var card = await host.Client().GetFromJsonAsync<JsonElement>($"/api/v1/service/machines/{agent.MachineId}", Ct);
        var protection = card.GetProperty("devices").EnumerateArray().Single(d => d.GetProperty("system").GetString() == "huntress").GetProperty("protection");
        (protection.GetProperty("antivirusStatus").GetString(), protection.GetProperty("isolation").GetString()).ShouldBe(("Unhealthy", "Disabled"));

        // The gaps the read found: the PC without Huntress, the silent laptop, Defender on the server.
        var gaps = await db.Alerts.AsNoTracking().Where(a => a.System == CoverageGaps.System && a.OrganizationId == customer.OrganizationId && a.State != AlertState.Resolved)
            .ToListAsync(Ct);
        gaps.Select(g => (g.Rule, g.DeviceName, g.Severity, g.Kind)).ShouldBe([
            ("huntress.agent-missing", $"{m}-PC", AlertSeverity.Warning, AlertKind.Security),
            ("huntress.agent-silent", $"{m}-LAPTOP", AlertSeverity.Warning, AlertKind.Security),
            ("huntress.defender-off", $"{m}-SRV", AlertSeverity.Critical, AlertKind.Security),
        ], ignoreOrder: true);

        // Atera's own rule finds the laptop Huntress watches without Atera; it is checked after Atera's read, here by the rule alone.
        var missing = read.ServiceProvider.GetServices<ICoverageRule>().Single(r => r.Code == "atera.agent-missing");
        await db.Devices.Where(d => d.ExternalId == laptopAgent.ToString(CultureInfo.InvariantCulture))
            .ExecuteUpdateAsync(s => s.SetProperty(d => d.FirstSeenAt, DateTimeOffset.UtcNow.AddDays(-7)), Ct);
        (await missing.FindAsync(new CoverageCheck(DateTimeOffset.UtcNow, 2, [customer.OrganizationId]), Ct)).ShouldHaveSingleItem().DeviceName.ShouldBe($"{m}-LAPTOP");
    }

    [Fact]
    public async Task Incidents_and_notices_become_security_alerts_and_an_urgent_incident_huntress_closes_waits_for_a_person()
    {
        await using var host = HuntressHost.Start(factory);
        var customer = await host.CustomerAsync();
        var urgent = Random.Shared.NextInt64(1_000_000, 1_999_999);
        var minor = urgent + 1;
        var escalation = Random.Shared.NextInt64(2_000_000, 2_999_999);
        var platformAction = escalation + 1;
        var org = customer.HuntressOrganizationId;
        host.List("/v1/incident_reports", "incident_reports", [
            HuntressRecords.Incident(urgent, org, null, "critical", "sent", HuntressRecords.Remediation(urgent * 10, "assisted", "unapproved"),
                HuntressRecords.Remediation(urgent * 10 + 1, "manual", "unapproved")),
            HuntressRecords.Incident(minor, org, null, "low", "sent"),
        ], ("status", "sent"));
        host.List("/v1/incident_reports", "incident_reports", [], ("status", "auto_remediating"));
        foreach (var id in new[] { urgent, minor })
        {
            host.List($"/v1/incident_reports/{id}/comments", "comments", [new { id = id * 100, body = "Synthetic SOC comment", author = "Huntress SOC", created_at = "2026-10-22T07:05:00Z" }]);
        }

        host.List("/v1/escalations", "escalations", [HuntressRecords.Notice(escalation, org, "open", "unexpected_country_access", "Login from an unexpected country")], ("status", "open"));
        host.List("/v1/escalations", "escalations", [], ("status", "overdue"));
        host.On("GET", $"/v1/escalations/{escalation}").RespondWith(JsonReply(new
        {
            escalation = HuntressRecords.Notice(escalation, org, "open", "unexpected_country_access", "Login from an unexpected country", 999, "SYN-HOST"),
        }));
        host.List("/v1/platform_actions", "platform_actions", [HuntressRecords.Notice(platformAction, org, "open", "platform_integration", "Defender Disabled")], ("status", "open"));
        host.List("/v1/platform_actions", "platform_actions", [], ("status", "overdue"));
        host.On("GET", $"/v1/platform_actions/{platformAction}").RespondWith(JsonReply(new
        {
            platform_action = HuntressRecords.Notice(platformAction, org, "open", "platform_integration", "Defender Disabled"),
        }));

        await host.RunJobAsync<HuntressAlertSyncJob>(job => job.RunAsync(Ct));

        (await host.LatestRunAsync(HuntressAlertSyncJob.JobId)).Status.ShouldBe(SyncRunStatus.Succeeded);
        // The queue names how fresh Huntress's alerts are beside Atera's: Huntress is switched on in this host and read completely.
        var queue = await (await host.Client().GetAsync("/api/v1/service/alerts?limit=1", Ct)).ReadJsonAsync();
        var huntressRead = queue.GetProperty("reads").EnumerateArray().Single(r => r.GetProperty("system").GetString() == "huntress");
        (huntressRead.GetProperty("startedAt").ValueKind, huntressRead.GetProperty("complete").GetBoolean()).ShouldBe((JsonValueKind.String, true));
        var alerts = await AlertsAsync(host, customer);
        alerts.Select(a => (a.ExternalId, a.Severity, a.Kind, a.State)).ShouldBe([
            ($"incident:{urgent}", AlertSeverity.Critical, AlertKind.Security, AlertState.Open),
            ($"incident:{minor}", AlertSeverity.Warning, AlertKind.Security, AlertState.Open),
            ($"escalation:{escalation}", AlertSeverity.Critical, AlertKind.Security, AlertState.Open),
            ($"platform-action:{platformAction}", AlertSeverity.Critical, AlertKind.Security, AlertState.Open),
        ], ignoreOrder: true);
        alerts.Single(a => a.ExternalId == $"incident:{urgent}").Url.ShouldBe($"https://huntress.example.invalid/incidents/{urgent}");

        // The detail is the security module's: the summary, the indicators, the plan and the comments.
        var incident = await host.Client().GetFromJsonAsync<JsonElement>($"/api/v1/security/huntress/incidents/{urgent}", Ct);
        (incident.GetProperty("status").GetString(), incident.GetProperty("isOpen").GetBoolean(), incident.GetProperty("summary").GetString())
            .ShouldBe(("sent", true, "Huntress found a synthetic foothold."));
        incident.GetProperty("remediations").EnumerateArray().Select(r => (r.GetProperty("type").GetString(), r.GetProperty("status").GetString()))
            .ShouldBe([("assisted", "unapproved"), ("manual", "unapproved")]);
        incident.GetProperty("remediations")[0].GetProperty("details")[0].GetProperty("name").GetString().ShouldBe("path");
        incident.GetProperty("comments").EnumerateArray().ShouldHaveSingleItem().GetProperty("author").GetString().ShouldBe("Huntress SOC");
        incident.GetProperty("indicators").EnumerateArray().ShouldHaveSingleItem().GetProperty("count").GetInt32().ShouldBe(1);
        var notice = await host.Client().GetFromJsonAsync<JsonElement>($"/api/v1/security/huntress/escalations/{escalation}", Ct);
        notice.GetProperty("entities").EnumerateArray().ShouldHaveSingleItem().GetProperty("name").GetString().ShouldBe("SYN-HOST");

        // Huntress closes the urgent incident, sends the minor one back to its SOC (a draft) and resolves the escalation.
        host.List("/v1/incident_reports", "incident_reports", [], ("status", "sent"));
        host.On("GET", $"/v1/incident_reports/{urgent}").RespondWith(JsonReply(new { incident_report = HuntressRecords.Incident(urgent, org, null, "critical", "closed") }));
        host.On("GET", $"/v1/incident_reports/{minor}").RespondWith(JsonReply(new { incident_report = HuntressRecords.Incident(minor, org, null, "low", "draft") }));
        host.List("/v1/escalations", "escalations", [], ("status", "open"));
        host.On("GET", $"/v1/escalations/{escalation}").RespondWith(JsonReply(new
        {
            escalation = HuntressRecords.Notice(escalation, org, "resolved", "unexpected_country_access", "Login from an unexpected country"),
        }));

        await host.RunJobAsync<HuntressAlertSyncJob>(job => job.RunAsync(Ct));

        alerts = await AlertsAsync(host, customer);
        var waiting = alerts.Single(a => a.ExternalId == $"incident:{urgent}");
        (waiting.State, waiting.SourceClosedAt is not null).ShouldBe((AlertState.Open, true), "an urgent incident Huntress closed waits for a person");
        alerts.Single(a => a.ExternalId == $"incident:{minor}").State.ShouldBe(AlertState.Open, "a report back at the SOC is still open");
        alerts.Single(a => a.ExternalId == $"escalation:{escalation}").State.ShouldBe(AlertState.Resolved);
        (await host.Client().GetFromJsonAsync<JsonElement>($"/api/v1/security/huntress/incidents/{minor}", Ct)).GetProperty("status").GetString().ShouldBe("draft");

        // A person confirms the closing, with the ETag of the alert as read; the transition says who and what.
        var admin = host.Client();
        var read = await admin.GetFromJsonAsync<JsonElement>($"/api/v1/service/alerts/{waiting.Id}", Ct);
        read.GetProperty("sourceClosedAt").ValueKind.ShouldBe(JsonValueKind.String);
        using (var confirm = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/service/alerts/{waiting.Id}/confirm-closed") { Content = JsonContent.Create(new { }) })
        {
            confirm.Headers.TryAddWithoutValidation("If-Match", read.GetProperty("etag").GetString());
            using var answer = await admin.SendAsync(confirm, Ct);
            answer.StatusCode.ShouldBe(HttpStatusCode.OK, await answer.Content.ReadAsStringAsync(Ct));
            (await answer.ReadJsonAsync()).GetProperty("state").GetString().ShouldBe("Resolved");
        }

        await using var scope = host.Services.CreateAsyncScope();
        (await scope.ServiceProvider.GetRequiredService<ServiceDbContext>().AlertTransitions.AsNoTracking()
            .Where(t => t.AlertId == waiting.Id).Select(t => t.Kind).ToListAsync(Ct)).ShouldBe([AlertTransitionKind.Confirmed]);

        // Nothing waits any more: a second confirmation is refused.
        var again = await admin.GetFromJsonAsync<JsonElement>($"/api/v1/service/alerts/{waiting.Id}", Ct);
        using var twice = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/service/alerts/{waiting.Id}/confirm-closed") { Content = JsonContent.Create(new { }) };
        twice.Headers.TryAddWithoutValidation("If-Match", again.GetProperty("etag").GetString());
        (await admin.SendAsync(twice, Ct)).StatusCode.ShouldBe(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task A_closed_report_of_an_organization_no_longer_linked_is_written_closed_and_not_read_again()
    {
        await using var host = HuntressHost.Start(factory);
        var customer = await host.CustomerAsync();
        var id = Random.Shared.NextInt64(3_000_000, 3_999_999);
        var gone = Random.Shared.NextInt64(40_000_000, 49_999_999);
        // Stored while its Huntress organization was linked; the link is gone now, and Huntress has closed the report.
        await using (var scope = host.Services.CreateAsyncScope())
        {
            await scope.ServiceProvider.GetRequiredService<ISecurityApi>().ApplyIncidentsAsync([new IncidentReading(
                new ExternalIncident(HuntressTypes.System, id, customer.OrganizationId, gone, null, "SYN-PC", "sent", "low", $"LOW - Incident {id}", null, null,
                    "windows", [], new Dictionary<string, int>(), DateTimeOffset.UtcNow.AddHours(-2), null, null, null, null),
                [], [])], Ct);
        }

        foreach (var status in new[] { "sent", "auto_remediating" })
        {
            host.List("/v1/incident_reports", "incident_reports", [], ("status", status));
        }

        foreach (var (path, collection) in new[] { ("/v1/escalations", "escalations"), ("/v1/platform_actions", "platform_actions") })
        {
            host.List(path, collection, [], ("status", "open"));
            host.List(path, collection, [], ("status", "overdue"));
        }

        host.On("GET", $"/v1/incident_reports/{id}").RespondWith(JsonReply(new { incident_report = HuntressRecords.Incident(id, gone, null, "low", "closed") }));

        await host.RunJobAsync<HuntressAlertSyncJob>(job => job.RunAsync(Ct));
        await host.RunJobAsync<HuntressAlertSyncJob>(job => job.RunAsync(Ct));

        await using var read = host.Services.CreateAsyncScope();
        var incident = await read.ServiceProvider.GetRequiredService<SecurityDbContext>().Incidents.AsNoTracking()
            .SingleAsync(i => i.System == HuntressTypes.System && i.ExternalId == id, Ct);
        (incident.Status, incident.OrganizationId, incident.DeviceName).ShouldBe(("closed", customer.OrganizationId, "SYN-PC"), "kept under the customer it was stored for");
        host.Count("GET", $"/v1/incident_reports/{id}").ShouldBe(1, "a report written closed is not read again by id on the next run");
    }

    [Fact]
    public async Task A_list_that_cannot_be_read_changes_nothing()
    {
        await using var host = HuntressHost.Start(factory);
        var customer = await host.CustomerAsync();
        var id = Random.Shared.NextInt64(3_000_000, 3_999_999);
        host.List("/v1/incident_reports", "incident_reports", [HuntressRecords.Incident(id, customer.HuntressOrganizationId, null, "high", "sent")], ("status", "sent"));
        host.List("/v1/incident_reports", "incident_reports", [], ("status", "auto_remediating"));
        host.List($"/v1/incident_reports/{id}/comments", "comments", []);
        foreach (var (path, collection) in new[] { ("/v1/escalations", "escalations"), ("/v1/platform_actions", "platform_actions") })
        {
            host.List(path, collection, [], ("status", "open"));
            host.List(path, collection, [], ("status", "overdue"));
        }

        await host.RunJobAsync<HuntressAlertSyncJob>(job => job.RunAsync(Ct));
        (await AlertsAsync(host, customer)).ShouldHaveSingleItem().State.ShouldBe(AlertState.Open);

        // The incident leaves Huntress's open list, but the escalations cannot be read: the run fails before anything is stored.
        host.List("/v1/incident_reports", "incident_reports", [], ("status", "sent"));
        host.On("GET", $"/v1/incident_reports/{id}").RespondWith(JsonReply(new { incident_report = HuntressRecords.Incident(id, customer.HuntressOrganizationId, null, "high", "closed") }));
        host.On("GET", "/v1/escalations", ("status", "open")).RespondWith(JsonReply(new { errors = new[] { "Synthetic outage" } }, 503));

        await Should.ThrowAsync<SyncFailedException>(() => host.RunJobAsync<HuntressAlertSyncJob>(job => job.RunAsync(Ct)));
        (await host.LatestRunAsync(HuntressAlertSyncJob.JobId)).Status.ShouldBe(SyncRunStatus.Failed);
        var alert = (await AlertsAsync(host, customer)).ShouldHaveSingleItem();
        (alert.State, alert.SourceClosedAt).ShouldBe((AlertState.Open, (DateTimeOffset?)null), "a failed read closes nothing");
        await using var scope = host.Services.CreateAsyncScope();
        (await scope.ServiceProvider.GetRequiredService<SecurityDbContext>().Incidents.AsNoTracking()
            .SingleAsync(i => i.System == HuntressTypes.System && i.ExternalId == id, Ct)).Status.ShouldBe("sent");
    }

    [Fact]
    public async Task Monthly_reports_of_a_linked_organization_are_kept_read_only()
    {
        await using var host = HuntressHost.Start(factory);
        var customer = await host.CustomerAsync();
        var report = Random.Shared.NextInt64(4_000_000, 4_999_999);
        host.On("GET", "/v1/reports", ("type", "monthly_summary")).RespondWith(JsonReply(new
        {
            reports = new object[]
            {
                new { id = report, organization_id = customer.HuntressOrganizationId, type = "monthly_summary", period = "2026-09-01...2026-09-30",
                    agents_count = 12, incidents_reported = 3, incidents_resolved = 2, signals_detected = 41, url = "https://huntress.example.invalid/report.pdf" },
                new { id = report + 1, organization_id = customer.HuntressOrganizationId + 99, type = "monthly_summary", period = "2026-09-01...2026-09-30" },
            },
            pagination = new { next_page_token = (string?)null },
        }));

        await host.RunJobAsync<HuntressReportSyncJob>(job => job.RunAsync(Ct));

        var overview = await host.Client().GetFromJsonAsync<JsonElement>($"/api/v1/security/organizations/{customer.OrganizationId}/overview", Ct);
        var stored = overview.GetProperty("reports").EnumerateArray().ShouldHaveSingleItem();
        (stored.GetProperty("periodStart").GetString(), stored.GetProperty("incidentsReported").GetInt32(), stored.GetProperty("url").GetString())
            .ShouldBe(("2026-09-01", 3, "https://huntress.example.invalid/report.pdf"));
        overview.GetProperty("reportsTotal").GetInt32().ShouldBe(1);
        var call = host.Huntress.LogEntries.Single(e => e.RequestMessage!.Path == "/v1/reports").RequestMessage!;
        call.Query!["period_min"][0].ShouldMatch(@"^\d{4}-\d{2}-01$");
    }

    private static async Task<List<Alert>> AlertsAsync(HuntressHost host, HuntressCustomer customer)
    {
        await using var scope = host.Services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<ServiceDbContext>().Alerts.AsNoTracking()
            .Where(a => a.System == HuntressTypes.System && a.OrganizationId == customer.OrganizationId).ToListAsync(Ct);
    }
}
