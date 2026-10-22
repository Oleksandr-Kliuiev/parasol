using System.Net;
using System.Text;
using System.Text.Json;
using Crm.Integrations.Huntress;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Crm.UnitTests;

/// <summary>
/// M41: the Huntress client reads Huntress API v1 as its own reference describes it — snake-case fields, lists of
/// <c>{ plural, pagination }</c> paged by <c>page_token</c>, singles wrapped by their name — and loses nothing quietly: the previous page
/// is read again, an item it cannot read fails the whole list, a token named twice ends the read. Every request is signed with Basic
/// key and secret; the reads keep to a budget of 45 requests in any window Huntress counts. Synthetic data only.
/// </summary>
public sealed class HuntressClientTests
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public void The_account_and_the_organizations_are_read_and_an_organization_without_an_id_is_not()
    {
        var f = Fixture();
        HuntressClient.ReadAccount(f.GetProperty("account").GetProperty("account"))
            .ShouldBe(new HuntressAccount(4401, "Vardahei Test", "vardahei-test", "enabled"));

        var organizations = f.GetProperty("organizations").GetProperty("organizations");
        var fjord = HuntressClient.ReadOrganization(organizations[0])!;
        (fjord.Id, fjord.Name, fjord.Key, fjord.AgentsCount, fjord.IncidentReportsCount, fjord.BillableIdentityCount, fjord.SatLearnerCount, fjord.LogSourcesCount)
            .ShouldBe((4410L, "Fjord IT AS", "fjord-it", (int?)3, (int?)2, (int?)12, (int?)9, (int?)1));
        (fjord.CreatedAt, fjord.UpdatedAt).ShouldBe((DateTimeOffset.Parse("2026-01-05T08:00:00Z"), (DateTimeOffset?)DateTimeOffset.Parse("2026-10-20T08:00:00Z")));
        HuntressClient.ReadOrganization(organizations[1])!.Name.ShouldBe("#4411", "an organization without a name is named by its id");
        HuntressClient.ReadOrganization(organizations[2]).ShouldBeNull("an organization without an id cannot be linked");
    }

    [Fact]
    public void Usage_is_read_from_actual_usages_as_an_object_or_as_text_with_the_organization_counts_behind_it()
    {
        var f = Fixture();
        HuntressClient.ReadUsage(f.GetProperty("organization").GetProperty("organization"))
            .ShouldBe(new HuntressUsage(4410, 42, 2, 1, 0, 150, 25, 5), "identities summed over the identity providers");

        // The reference types actual_usages as a string with an object as its example: a string holding JSON is read the same way.
        HuntressClient.ReadUsage(f.GetProperty("organizationUsageAsText").GetProperty("organization"))
            .ShouldBe(new HuntressUsage(4411, 3, 1, 0, 1, 7, 3, 2), "what the usage leaves out comes from the organization's own counts");

        HuntressClient.ReadUsage(Json("""{ "id": 5, "billable_identity_count": 4, "actual_usages": "not json" }"""))
            .ShouldBe(new HuntressUsage(5, null, null, null, null, 4, null, null), "no usage is no figure, never a zero");
        HuntressClient.ReadUsage(Json("""{ "name": "No id" }""")).ShouldBeNull();
    }

    [Fact]
    public void An_agent_is_read_with_its_keys_its_defender_and_isolation_and_every_address_once()
    {
        var agents = Fixture().GetProperty("agents");
        var server = HuntressClient.ReadAgent(agents[0])!;
        (server.Id, server.OrganizationId, server.Hostname, server.Platform, server.Os, server.Version, server.LastCallbackAt)
            .ShouldBe((4420L, 4410L, "SRV-01", "windows", "Windows Server 2022 Standard", "0.13.140", (DateTimeOffset?)DateTimeOffset.Parse("2026-10-22T07:55:00Z")),
                "the platform is kept in lower case");
        (server.SerialNumber, server.ExternalIp, server.DomainName, server.OsBuildVersion, server.EdrVersion)
            .ShouldBe(("VMW-4C4C4544-0042", "198.51.100.10", "FJORD", "20348", "0.3.20"));
        server.MacAddresses.ShouldBe(["00:15:5d:01:02:03", "00:15:5d:0a:0b:0c"], "a MAC address in another case is the same address");
        server.Ipv4Addresses.ShouldBe(["10.0.0.10", "172.27.240.1"], "the primary address first, each once");
        (server.DefenderStatus, server.DefenderSubstatus, server.DefenderPolicyStatus, server.LastSurveyAt, server.FirewallStatus)
            .ShouldBe(("Unhealthy", "Real-time protection off", "Compliant", (DateTimeOffset?)DateTimeOffset.Parse("2026-10-22T05:00:00Z"), "Disabled"));
        server.Tags.ShouldBe(["Production"]);
        server.CreatedAt.ShouldBe(DateTimeOffset.Parse("2026-03-01T08:00:00Z"));

        var mac = HuntressClient.ReadAgent(agents[1])!;
        (mac.Platform, mac.FirewallStatus, mac.DefenderStatus).ShouldBe(("darwin", "Isolated", (string?)null));
        mac.MacAddresses.ShouldBeEmpty();
        mac.Ipv4Addresses.ShouldBeEmpty();

        HuntressClient.ReadAgent(agents[2]).ShouldBeNull("an agent without its organization cannot be placed with a customer");
        HuntressClient.ReadAgent(Json("""{ "organization_id": 4410, "hostname": "NO-ID" }""")).ShouldBeNull();
        HuntressClient.ReadAgent(Json("""{ "id": 9, "organization_id": 4410 }"""))!.Hostname.ShouldBe("#9", "an agent without a host name is named by its id");
    }

    [Fact]
    public void An_incident_report_is_read_with_its_plan_its_indicators_and_its_words_in_lower_case()
    {
        var f = Fixture();
        var incident = HuntressClient.ReadIncident(f.GetProperty("incidentReport"))!;
        (incident.Id, incident.OrganizationId, incident.AgentId, incident.Status, incident.Severity, incident.Platform)
            .ShouldBe((4430L, 4410L, (long?)4420, "sent", "high", "windows"));
        (incident.Subject, incident.Summary, incident.Body).ShouldBe(("HIGH - Incident on SRV-01 (Fjord IT AS)", "Huntress detected a malicious scheduled task on this host.", "<Content>"));
        incident.IndicatorTypes.ShouldBe(["footholds", "process_detections"]);
        incident.IndicatorCounts.ShouldBe(new Dictionary<string, int> { ["footholds"] = 1, ["process_detections"] = 2, ["monitored_files"] = 0 },
            "a count that is no number is left out");
        (incident.SentAt, incident.StatusUpdatedAt, incident.UpdatedAt, incident.ClosedAt).ShouldBe((
            (DateTimeOffset?)DateTimeOffset.Parse("2026-10-22T06:00:00Z"), (DateTimeOffset?)DateTimeOffset.Parse("2026-10-22T06:00:00Z"),
            (DateTimeOffset?)DateTimeOffset.Parse("2026-10-22T06:30:00Z"), (DateTimeOffset?)null));

        incident.AllRemediations.ShouldBeTrue();
        incident.Remediations.Select(r => r.Id).ShouldBe([4440L, 4441L], "the plan in Huntress's order of ids");
        var approved = incident.Remediations[0];
        (approved.Type, approved.Action, approved.Status, approved.ApprovedBy, approved.Parameters)
            .ShouldBe(("assisted", "Remove Scheduled Task", "approved", "Tor Tekniker", "synthetic_task"));
        var manual = incident.Remediations[1];
        (manual.Type, manual.Status, manual.ApprovedAt).ShouldBe(("manual", "unapproved", (DateTimeOffset?)null));
        JsonDocument.Parse(manual.Parameters!).RootElement[0].GetProperty("description").GetString()
            .ShouldBe("c:\\windows\\system32\\tasks\\synthetic_task", "a list of details is kept as Huntress wrote it");

        var more = HuntressClient.ReadIncident(f.GetProperty("incidentReportWithMore"))!;
        (more.Status, more.Severity, more.AllRemediations).ShouldBe(("auto_remediating", "low", false), "no severity reads as low; has_more asks for the whole plan");
        more.Remediations.ShouldHaveSingleItem().ApprovedBy.ShouldBe("only@vardahei.example.invalid", "a person without a name is named by address");
    }

    [Fact]
    public void An_incident_report_huntress_cannot_place_is_not_read_and_a_step_without_an_id_fails_it()
    {
        HuntressClient.ReadIncident(Json("""{ "id": 1, "status": "sent" }""")).ShouldBeNull("no organization");
        HuntressClient.ReadIncident(Json("""{ "id": 1, "organization_id": 2 }""")).ShouldBeNull("no status");
        HuntressClient.ReadIncident(Json("""{ "organization_id": 2, "status": "sent" }""")).ShouldBeNull("no id");
        HuntressClient.ReadIncident(Json("""{ "id": 1, "organization_id": 2, "status": "sent", "remediations": [{ "id": 5 }] }"""))!
            .Remediations.ShouldHaveSingleItem().Id.ShouldBe(5, "a bare list of remediations is read too");
        Should.Throw<JsonException>(() =>
            HuntressClient.ReadIncident(Json("""{ "id": 1, "organization_id": 2, "status": "sent", "remediations": { "items": [{ "action": "No id" }] } }""")));
    }

    [Fact]
    public void Remediations_and_comments_are_read_with_their_defaults()
    {
        var f = Fixture();
        var steps = f.GetProperty("remediations").GetProperty("remediations");
        var containment = HuntressClient.ReadRemediation(steps[0])!;
        (containment.Id, containment.Type, containment.Action, containment.Parameters, containment.Status, containment.CompletedAt)
            .ShouldBe((4451L, "containment", "Isolate Host", "PC-17", "completed", (DateTimeOffset?)DateTimeOffset.Parse("2026-10-22T06:40:00Z")));
        var bare = HuntressClient.ReadRemediation(steps[1])!;
        (bare.Type, bare.Status, bare.Action, bare.Parameters, bare.ApprovedBy).ShouldBe(("manual", "unapproved", (string?)null, (string?)null, (string?)null));
        HuntressClient.ReadRemediation(Json("""{ "type": "manual" }""")).ShouldBeNull();

        var comments = f.GetProperty("comments").GetProperty("comments");
        HuntressClient.ReadComment(comments[0]).ShouldBe(new HuntressComment(4460, "We have already rebuilt this host.", "Tor Tekniker",
            DateTimeOffset.Parse("2026-10-22T07:00:00Z"), DateTimeOffset.Parse("2026-10-22T07:05:00Z")));
        HuntressClient.ReadComment(comments[1])!.Body.ShouldBe(string.Empty, "a comment without text keeps its place");
        HuntressClient.ReadComment(comments[2]).ShouldBeNull("a comment without its time cannot be ordered");
    }

    [Fact]
    public void An_escalation_is_read_with_its_organizations_and_the_names_of_what_it_is_about()
    {
        var f = Fixture();
        var escalation = HuntressClient.ReadNotice(HuntressNoticeKind.Escalation, f.GetProperty("escalation").GetProperty("escalation"))!;
        (escalation.Kind, escalation.Id, escalation.Status, escalation.Severity, escalation.Subject)
            .ShouldBe((HuntressNoticeKind.Escalation, 4470L, "overdue", "critical", "Unexpected login from US"));
        (escalation.Type, escalation.TypeCode, escalation.Subtype, escalation.ResolvedAt)
            .ShouldBe(("Unexpected Country Access", "unexpected_country_access", "US", (DateTimeOffset?)null));
        escalation.OrganizationIds.ShouldBe([4410L, 4411L], "organizations as { id, name } objects and as bare ids");
        (escalation.CreatedAt, escalation.UpdatedAt).ShouldBe((DateTimeOffset.Parse("2026-10-21T18:20:34Z"), (DateTimeOffset?)DateTimeOffset.Parse("2026-10-22T06:00:00Z")));
        escalation.Entities.ShouldBe([
            new HuntressEntity("Agent", "4420", "SRV-01"),
            new HuntressEntity("Identity", "id-1", "Kari Test"),
            new HuntressEntity("Identity", "id-2", "ola@fjord.example.invalid"),
            new HuntressEntity("Mailbox", "mb-1", "Postmottak"),
        ], "a host by its name, a person by display name before address before user name, else the entity's own name");
        escalation.AllEntities.ShouldBeFalse("Huntress has more than it gave");

        var action = HuntressClient.ReadNotice(HuntressNoticeKind.PlatformAction, f.GetProperty("platformAction").GetProperty("platform_action"))!;
        (action.Kind, action.Status, action.Severity, action.TypeCode, action.AllEntities)
            .ShouldBe((HuntressNoticeKind.PlatformAction, "open", "high", "managed_antivirus", true));
        action.CreatedAt.ShouldBe(DateTimeOffset.Parse("2026-10-22T06:00:00Z"), "without a creation time the last change stands in");
        action.Entities.ShouldBe([new HuntressEntity("Agent", "4420", "SRV-01")]);

        var listed = HuntressClient.ReadNotice(HuntressNoticeKind.Escalation, Json("""{ "id": 3, "status": "open", "organizations": [] }"""))!;
        (listed.Entities, listed.Severity, listed.Subject).ShouldBe(((IReadOnlyList<HuntressEntity>?)null, "low", "#3"), "a list item names no entities: null, not none");
        HuntressClient.ReadNotice(HuntressNoticeKind.Escalation, Json("""{ "id": 3 }""")).ShouldBeNull("no status");
    }

    [Fact]
    public void A_report_is_read_with_its_period_its_figures_and_the_link_to_its_pdf()
    {
        var report = HuntressClient.ReadReport(Fixture().GetProperty("report"))!;
        (report.Id, report.OrganizationId, report.Type, report.PeriodStart, report.PeriodEnd)
            .ShouldBe((4490L, 4410L, "monthly_summary", (DateOnly?)new DateOnly(2026, 9, 1), (DateOnly?)new DateOnly(2026, 9, 30)));
        (report.Url, report.AgentsCount, report.IncidentsReported, report.IncidentsResolved).ShouldBe((
            "https://huntress.example.invalid/reports/4490.pdf?disposition=download", (int?)3, (int?)2, (int?)1));
        (report.SignalsDetected, report.SignalsInvestigated, report.EventsAnalyzed).ShouldBe(((long?)120, (long?)118, (long?)9876543210));

        var odd = HuntressClient.ReadReport(Json("""{ "id": 1, "organization_id": 2, "period": "last month" }"""))!;
        (odd.PeriodStart, odd.PeriodEnd, odd.Type).ShouldBe(((DateOnly?)null, (DateOnly?)null, "monthly_summary"));
        HuntressClient.ReadReport(Json("""{ "id": 1, "period": "2026-09-01...2026-09-30" }""")).ShouldBeNull("no organization");
    }

    [Fact]
    public async Task A_list_is_read_by_token_the_previous_page_again_and_every_agent_once()
    {
        // Page 1 is read; then agent 1 leaves the list, so agent 3 moves from page 2 onto page 1 before page 2 is read.
        var firstPages = 0;
        await using var huntress = await Loopback.StartAsync(request => request.Path == "/v1/agents"
            ? request.Query("page_token") switch
            {
                null => ++firstPages == 1 ? Agents("t2", 1, 2) : Agents(null, 2, 3),
                "t2" => Agents(null, 4, 5),
                _ => (404, "{}"),
            }
            : (404, "{}"));
        using var services = Providers(huntress.Address, pageSize: 2);

        var ids = new List<long>();
        await foreach (var agent in services.GetRequiredService<IHuntressClient>().GetAgentsAsync(null, Ct))
        {
            ids.Add(agent.Id);
        }

        ids.Order().ToList().ShouldBe([1L, 2L, 3L, 4L, 5L], "the agent that moved up is caught, and each is yielded once");
        huntress.Requests.Select(r => r.Query("page_token")).ShouldBe([null, "t2", null], "page 1, page 2, page 1 again");
        huntress.Requests.ShouldAllBe(r => r.Query("limit") == "2");
    }

    [Fact]
    public async Task A_token_named_twice_ends_the_read_with_an_error_instead_of_reading_for_ever()
    {
        await using var huntress = await Loopback.StartAsync(_ => Agents("same", 1));
        using var services = Providers(huntress.Address);

        var refused = await Should.ThrowAsync<HuntressApiException>(async () =>
        {
            await foreach (var _ in services.GetRequiredService<IHuntressClient>().GetAgentsAsync(null, Ct))
            {
            }
        });

        refused.Message.ShouldContain("named the same next page twice");
    }

    [Fact]
    public async Task An_agent_that_cannot_be_read_fails_the_whole_read()
    {
        await using var huntress = await Loopback.StartAsync(_ =>
            (200, """{ "agents": [{ "id": 1, "organization_id": 10, "hostname": "PC-1" }, { "id": 2, "hostname": "NO-ORG" }], "pagination": {} }"""));
        using var services = Providers(huntress.Address);

        await Should.ThrowAsync<HuntressApiException>(async () =>
        {
            await foreach (var _ in services.GetRequiredService<IHuntressClient>().GetAgentsAsync(null, Ct))
            {
            }
        });

        await Should.ThrowAsync<HuntressApiException>(async () =>
        {
            await foreach (var _ in services.GetRequiredService<IHuntressClient>().GetOrganizationsAsync(Ct))
            {
            }
        }, "a list without its array is no empty list");
    }

    [Fact]
    public async Task A_record_huntress_does_not_know_is_null_and_isolation_answers_are_read_wrapped_or_bare()
    {
        await using var huntress = await Loopback.StartAsync(request => (request.Method, request.Path) switch
        {
            ("POST", "/v1/agents/4420/isolation") => (201, """{ "agent": { "id": 4420, "organization_id": 4410, "hostname": "SRV-01", "firewall_status": "Pending Isolation" } }"""),
            // The reference answers a release with the agent itself, not wrapped.
            ("DELETE", "/v1/agents/4420/isolation") => (200, """{ "id": 4420, "organization_id": 4410, "hostname": "SRV-01", "firewall_status": "Pending Release" }"""),
            _ => (404, """{ "errors": ["Not found"] }"""),
        });
        using var services = Providers(huntress.Address);
        var client = services.GetRequiredService<IHuntressActionClient>();

        (await client.GetAgentAsync(99, Ct)).ShouldBeNull();
        (await client.GetIncidentAsync(98, Ct)).ShouldBeNull();
        (await client.GetNoticeAsync(HuntressNoticeKind.Escalation, 97, Ct)).ShouldBeNull();
        (await client.GetUsageAsync(96, Ct)).ShouldBeNull();

        (await client.IsolateAgentAsync(4420, "Ransomware suspected on SRV-01", Ct))!.FirewallStatus.ShouldBe("Pending Isolation");
        var posted = JsonDocument.Parse(huntress.Requests.Single(r => r.Method == "POST").Body).RootElement;
        (posted.GetProperty("reason").GetString(), posted.GetProperty("strict_isolation").GetBoolean()).ShouldBe(("Ransomware suspected on SRV-01", false));
        (await client.ReleaseAgentAsync(4420, Ct))!.FirewallStatus.ShouldBe("Pending Release");
    }

    [Fact]
    public async Task Lists_are_asked_with_their_filters_and_writes_carry_what_the_reference_names()
    {
        await using var huntress = await Loopback.StartAsync(request => request.Path switch
        {
            "/v1/incident_reports" => (200, """{ "incident_reports": [], "pagination": {} }"""),
            "/v1/platform_actions" => (200, """{ "platform_actions": [], "pagination": {} }"""),
            "/v1/reports" => (200, """{ "reports": [], "pagination": {} }"""),
            "/v1/agents" => (200, """{ "agents": [], "pagination": {} }"""),
            "/v1/incident_reports/4430/comments" when request.Method == "POST" => (201, """{ "comment": { "id": 9, "body": "Noted", "created_at": "2026-10-22T08:00:00Z" } }"""),
            _ => (201, string.Empty),
        });
        using var services = Providers(huntress.Address);
        var client = services.GetRequiredService<IHuntressClient>();

        await foreach (var _ in client.GetIncidentsAsync("auto_remediating", Ct))
        {
        }

        await foreach (var _ in client.GetNoticesAsync(HuntressNoticeKind.PlatformAction, "overdue", Ct))
        {
        }

        await foreach (var _ in client.GetReportsAsync(new DateOnly(2025, 9, 1), Ct))
        {
        }

        await foreach (var _ in client.GetAgentsAsync(4410, Ct))
        {
        }

        huntress.Requests.Select(r => (r.Path, r.QueryString)).ShouldBe([
            ("/v1/incident_reports", "?limit=500&status=auto_remediating"),
            ("/v1/platform_actions", "?limit=500&status=overdue"),
            ("/v1/reports", "?limit=500&type=monthly_summary&period_min=2025-09-01"),
            ("/v1/agents", "?limit=500&organization_id=4410"),
        ]);

        await client.RejectRemediationsAsync(4430, new HuntressRejection("Known admin tool", true, "approved_application"), Ct);
        var rejection = JsonDocument.Parse(huntress.Requests[^1].Body).RootElement;
        (huntress.Requests[^1].Path, rejection.GetProperty("comment").GetString(), rejection.GetProperty("useful").GetBoolean(),
                rejection.GetProperty("reason").GetString())
            .ShouldBe(("/v1/incident_reports/4430/remediations/bulk_rejection", "Known admin tool", true, "approved_application"));
        rejection.TryGetProperty("name", out _).ShouldBeFalse("the person's name is left to the user the key belongs to");
        rejection.TryGetProperty("email", out _).ShouldBeFalse();

        await client.SetRemediationCompletionAsync(4430, 4441, completed: false, Ct);
        (huntress.Requests[^1].Path, JsonDocument.Parse(huntress.Requests[^1].Body).RootElement.GetProperty("completed").GetBoolean())
            .ShouldBe(("/v1/incident_reports/4430/remediations/4441/completion", false));

        (await client.CreateCommentAsync(4430, "Noted", Ct))!.Id.ShouldBe(9);
        JsonDocument.Parse(huntress.Requests[^1].Body).RootElement.GetProperty("body").GetString().ShouldBe("Noted");
    }

    [Fact]
    public async Task An_escalation_answer_is_for_the_identity_only_and_never_revokes_or_disables_it()
    {
        await using var huntress = await Loopback.StartAsync(_ => (201, """{ "escalation": { "id": 4470, "status": "resolved" }, "resolution_method": "direct" }"""));
        using var services = Providers(huntress.Address);
        var client = services.GetRequiredService<IHuntressActionClient>();

        await client.ResolveEscalationAsync(4470, HuntressEscalationAnswer.Close, Ct);
        JsonDocument.Parse(huntress.Requests[^1].Body).RootElement.EnumerateObject().ShouldBeEmpty("a plain resolution carries no determination");

        await client.ResolveEscalationAsync(4470, new HuntressEscalationAnswer("unauthorized"), Ct);
        var answer = JsonDocument.Parse(huntress.Requests[^1].Body).RootElement;
        (huntress.Requests[^1].Path, answer.GetProperty("determination").GetString(), answer.GetProperty("scope").GetString(),
                answer.GetProperty("revoke_and_disable_identities").GetBoolean())
            .ShouldBe(("/v1/escalations/4470/resolution", "unauthorized", "identity", false));
    }

    [Fact]
    public async Task Every_request_is_signed_with_basic_authentication_of_the_trimmed_key_and_secret()
    {
        await using var huntress = await Loopback.StartAsync(_ => (200, """{ "account": { "id": 4401, "name": "Vardahei Test" } }"""));
        using var services = Providers(huntress.Address, key: " huntress-key ", secret: " huntress-secret ");

        (await services.GetRequiredService<IHuntressClient>().GetAccountAsync(Ct)).Id.ShouldBe(4401);

        huntress.Requests.ShouldHaveSingleItem().Headers["Authorization"]
            .ShouldBe("Basic " + Convert.ToBase64String(Encoding.UTF8.GetBytes("huntress-key:huntress-secret")));
    }

    [Theory]
    [InlineData("GET", 429, true)]
    [InlineData("POST", 429, true)]
    [InlineData("DELETE", 429, true)]
    [InlineData("GET", 500, true)]
    [InlineData("HEAD", 503, true)]
    [InlineData("POST", 500, false)]
    [InlineData("DELETE", 503, false)]
    [InlineData("GET", 404, false)]
    [InlineData("POST", 409, false)]
    public void Throttling_is_repeated_for_any_method_and_server_errors_only_for_reads(string method, int status, bool retried) =>
        HuntressModule.ShouldRetry(new HttpMethod(method), (HttpStatusCode)status, null).ShouldBe(retried);

    [Fact]
    public void A_dropped_connection_or_a_timeout_repeats_a_read_but_never_a_write()
    {
        HuntressModule.ShouldRetry(HttpMethod.Get, null, new HttpRequestException("reset")).ShouldBeTrue();
        HuntressModule.ShouldRetry(HttpMethod.Get, null, new Polly.Timeout.TimeoutRejectedException()).ShouldBeTrue();
        HuntressModule.ShouldRetry(HttpMethod.Post, null, new HttpRequestException("reset")).ShouldBeFalse("the write may have reached Huntress");
        HuntressModule.ShouldRetry(HttpMethod.Delete, null, new TimeoutException()).ShouldBeFalse();
    }

    [Fact]
    public void The_read_budget_takes_45_requests_in_a_window_longer_than_huntress_s_minute_and_refuses_the_46th()
    {
        HuntressModule.Window.ShouldBe(TimeSpan.FromSeconds(70), "a request leaves the window only once its segment is a full minute old");
        using var limiter = HuntressModule.Limiter(45);
        for (var i = 0; i < 45; i++)
        {
            using var lease = limiter.AttemptAcquire();
            lease.IsAcquired.ShouldBeTrue($"request {i + 1} of the window");
        }

        using var refused = limiter.AttemptAcquire();
        refused.IsAcquired.ShouldBeFalse("the 46th waits for the window to move");

        using var single = HuntressModule.Limiter(0);
        using var one = single.AttemptAcquire();
        one.IsAcquired.ShouldBeTrue("a budget below one still lets one request through");
    }

    [Theory]
    [InlineData("http://api.huntress.example.invalid/v1/", "45", "15")]
    [InlineData("https://api.huntress.io/v1/", "50", "15")]
    [InlineData("https://api.huntress.io/v1/", "60", "0")]
    [InlineData("https://api.huntress.io/v1/", "0", "15")]
    public void A_plain_http_address_or_budgets_above_huntress_s_sixty_fail_at_start(string baseUrl, string reads, string actions)
    {
        using var services = Providers(new Uri("http://127.0.0.1:1/"), settings: new()
        {
            ["Integrations:Huntress:BaseUrl"] = baseUrl,
            ["Integrations:Huntress:ReadRequestsPerMinute"] = reads,
            ["Integrations:Huntress:ActionRequestsPerMinute"] = actions,
        });

        Should.Throw<OptionsValidationException>(() => services.GetRequiredService<IOptions<HuntressOptions>>().Value);
    }

    [Fact]
    public void The_defaults_are_valid_off_and_closed()
    {
        var configuration = new ConfigurationBuilder().Build();
        using var services = new ServiceCollection().AddLogging().AddSingleton(TimeProvider.System).AddSingleton<IConfiguration>(configuration)
            .AddHuntressIntegration(configuration).BuildServiceProvider();
        var options = services.GetRequiredService<IOptions<HuntressOptions>>().Value;
        (options.BaseUrl, options.ReadRequestsPerMinute, options.ActionRequestsPerMinute, options.PageSize)
            .ShouldBe((new Uri("https://api.huntress.io/v1/"), 45, 15, 500));
        (options.Enabled, options.IsConfigured, options.WriteEnabled, options.DryRun).ShouldBe((false, false, false, false));
        options.EnabledActions.ShouldBeEmpty("every kind of action is off until it is listed");
        options.WriteAllowedCustomerIds.ShouldBeEmpty();
        (options.IncidentUrlTemplate, options.EscalationUrlTemplate, options.PlatformActionUrlTemplate, options.AgentUrlTemplate)
            .ShouldBe(((string?)null, (string?)null, (string?)null, (string?)null), "Huntress's direct links are not confirmed, so none is guessed");
        new HuntressOptions { Enabled = true, ApiKey = "key" }.IsConfigured.ShouldBeFalse("the secret is needed too");
    }

    private static JsonElement Fixture() =>
        JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "providers", "huntress.json"))).RootElement.Clone();

    private static JsonElement Json(string json) => JsonDocument.Parse(json).RootElement.Clone();

    private static (int Status, string Body) Agents(string? next, params long[] ids) => (200, JsonSerializer.Serialize(new
    {
        agents = ids.Select(id => new { id, organization_id = 4410, hostname = $"PC-{id}" }),
        pagination = new { next_page_token = next },
    }));

    private static ServiceProvider Providers(Uri address, string key = "huntress-key", string secret = "huntress-secret", int pageSize = 500,
        Dictionary<string, string?>? settings = null)
    {
        var values = new Dictionary<string, string?>
        {
            ["Integrations:Huntress:Enabled"] = "true",
            ["Integrations:Huntress:ApiKey"] = key,
            ["Integrations:Huntress:ApiSecret"] = secret,
            ["Integrations:Huntress:BaseUrl"] = new Uri(address, "v1/").ToString(),
            ["Integrations:Huntress:PageSize"] = pageSize.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ["Integrations:Huntress:RetryDelay"] = "00:00:00.010",
        };
        foreach (var (name, value) in settings ?? [])
        {
            values[name] = value;
        }

        var configuration = new ConfigurationBuilder().AddInMemoryCollection(values).Build();
        var services = new ServiceCollection().AddLogging().AddSingleton(TimeProvider.System).AddSingleton<IConfiguration>(configuration);
        services.AddHuntressIntegration(configuration);
        return services.BuildServiceProvider();
    }

    /// <summary>One request as the loopback server received it.</summary>
    private sealed record Received(string Method, string Path, string QueryString, Dictionary<string, string> Headers, string Body)
    {
        public string? Query(string name) =>
            QueryString.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries).Select(pair => pair.Split('=', 2))
                .Where(pair => pair[0] == name).Select(pair => Uri.UnescapeDataString(pair[1])).FirstOrDefault();
    }

    /// <summary>A plain HTTP server on a free loopback port that answers as Huntress would and records what reaches it.</summary>
    private sealed class Loopback : IAsyncDisposable
    {
        private readonly WebApplication _app;
        private readonly List<Received> _requests = [];

        private Loopback(WebApplication app) => _app = app;

        public Uri Address { get; private set; } = null!;

        public List<Received> Requests
        {
            get { lock (_requests) return _requests.ToList(); }
        }

        public static async Task<Loopback> StartAsync(Func<Received, (int Status, string Body)> answer)
        {
            var builder = WebApplication.CreateSlimBuilder();
            builder.WebHost.UseUrls("http://127.0.0.1:0");
            builder.Logging.ClearProviders();
            var server = new Loopback(builder.Build());
            server._app.Run(async context =>
            {
                using var reader = new StreamReader(context.Request.Body);
                var received = new Received(
                    context.Request.Method,
                    context.Request.Path.Value ?? string.Empty,
                    context.Request.QueryString.Value ?? string.Empty,
                    context.Request.Headers.ToDictionary(h => h.Key, h => h.Value.ToString(), StringComparer.OrdinalIgnoreCase),
                    await reader.ReadToEndAsync());
                lock (server._requests)
                {
                    server._requests.Add(received);
                }

                var (status, body) = answer(received);
                context.Response.StatusCode = status;
                if (body.Length > 0)
                {
                    context.Response.ContentType = "application/json";
                    await context.Response.WriteAsync(body);
                }
            });
            await server._app.StartAsync();
            var bound = server._app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single();
            server.Address = new Uri(bound.TrimEnd('/') + "/");
            return server;
        }

        public async ValueTask DisposeAsync()
        {
            await _app.StopAsync();
            await _app.DisposeAsync();
        }
    }
}
