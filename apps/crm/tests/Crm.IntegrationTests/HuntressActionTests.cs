using System.Globalization;
using System.Net.Http.Json;
using System.Text.Json;
using Crm.Integrations.Core.Actions;
using Crm.Integrations.Huntress;
using Crm.Security.Contracts;
using Crm.Security.Persistence;
using Crm.Service.Contracts;
using Crm.Service.Domain;
using Crm.Service.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using WireMock.RequestBuilders;
using WireMock.ResponseBuilders;
using static Crm.IntegrationTests.IntegrationTestHelpers;

namespace Crm.IntegrationTests;

/// <summary>
/// M41 on SQL Server: every Huntress action goes through the action path of M39.1. The preview comes from the security mirror or the
/// device mirror, the attempt reads Huntress first (skips what is already so, refuses what moved), sends once, and the read after it
/// writes the result into the mirrors; an alert closes only when Huntress shows its record closed. Huntress answers from a stub.
/// </summary>
[Collection(HuntressCollection.Name)]
public sealed class HuntressActionTests(CrmWebFactory factory)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Approving_the_plan_sends_one_bulk_approval_and_the_read_after_it_shows_the_steps_approved()
    {
        await using var host = HuntressHost.Start(factory);
        var (customer, id) = await StoredIncidentAsync(host, "sent", ("assisted", "unapproved"), ("manual", "unapproved"));
        Live(host, customer, id, "sent", ("assisted", "unapproved"), ("manual", "unapproved"));
        host.Huntress.Given(Request.Create().WithPath($"/v1/incident_reports/{id}/remediations/bulk_approval").UsingPost())
            .RespondWith(Response.Create().WithStatusCode(201).WithCallback(_ =>
            {
                Live(host, customer, id, "sent", ("assisted", "approved"), ("manual", "approved"));
                return new WireMock.ResponseMessage { StatusCode = 201 };
            }));

        var preview = await host.PreviewAsync(HuntressActionKinds.Approve, "alert", $"incident:{id}");
        preview.GetProperty("level").GetString().ShouldBe("Standard");
        preview.GetProperty("effects").EnumerateArray().Select(e => e.GetProperty("code").GetString())
            .ShouldBe(["VND_EFFECT_HUNTRESS_APPROVE", "VND_EFFECT_HUNTRESS_APPROVE_ASSISTED", "VND_EFFECT_HUNTRESS_APPROVE_MANUAL"]);
        preview.GetProperty("target").GetProperty("externalCustomerId").GetString().ShouldBe(customer.HuntressOrganizationId.ToString(CultureInfo.InvariantCulture));

        var action = await host.RunActionAsync(await host.AskAsync(HuntressActionKinds.Approve, "alert", $"incident:{id}"));

        (action.Status, action.OutcomeCode).ShouldBe((VendorActionStatus.Succeeded, "VND_SENT"));
        host.Count("POST", $"/v1/incident_reports/{id}/remediations/bulk_approval").ShouldBe(1);
        (await PlanAsync(host, id)).ShouldBe(["approved", "approved"]);
        // Nothing waits for approval now: the action is not offered again.
        (await host.PreviewAsync(HuntressActionKinds.Approve, "alert", $"incident:{id}")).GetProperty("block").GetProperty("code").GetString()
            .ShouldBe("VND_NOTHING_TO_APPROVE");
    }

    [Fact]
    public async Task Sending_the_plan_back_needs_a_reason_and_an_explanation_and_sends_no_personal_details()
    {
        await using var host = HuntressHost.Start(factory);
        var (customer, id) = await StoredIncidentAsync(host, "sent", ("assisted", "unapproved"));
        Live(host, customer, id, "sent", ("assisted", "unapproved"));
        host.On("POST", $"/v1/incident_reports/{id}/remediations/bulk_rejection").RespondWith(Response.Create().WithStatusCode(201));

        (await host.PreviewAsync(HuntressActionKinds.Reject, "alert", $"incident:{id}", new { reason = "other" })).GetProperty("block").GetProperty("code").GetString()
            .ShouldBe("VND_TEXT_REQUIRED");
        (await host.PreviewAsync(HuntressActionKinds.Reject, "alert", $"incident:{id}", new { reason = "guess", comment = "x" })).GetProperty("block").GetProperty("code").GetString()
            .ShouldBe("VND_REASON_INVALID");

        var action = await host.RunActionAsync(await host.AskAsync(HuntressActionKinds.Reject, "alert", $"incident:{id}",
            new { reason = "approved_application", comment = "The tool is our own backup agent.", useful = true }));

        (action.Status, action.OutcomeCode).ShouldBe((VendorActionStatus.Succeeded, "VND_SENT"));
        var body = host.Posted($"/v1/incident_reports/{id}/remediations/bulk_rejection");
        (body.GetProperty("reason").GetString(), body.GetProperty("comment").GetString(), body.GetProperty("useful").GetBoolean())
            .ShouldBe(("approved_application", "The tool is our own backup agent.", true));
        body.TryGetProperty("email", out _).ShouldBeFalse("the key's own user answers for the partner");
        body.TryGetProperty("name", out _).ShouldBeFalse();
    }

    [Fact]
    public async Task Only_a_manual_step_is_marked_and_resolving_waits_for_an_approved_plan_then_closes_the_alert_without_a_confirmation()
    {
        await using var host = HuntressHost.Start(factory);
        var (customer, id) = await StoredIncidentAsync(host, "sent", ("assisted", "approved"), ("manual", "approved"));
        Live(host, customer, id, "sent", ("assisted", "approved"), ("manual", "approved"));
        var manual = id * 10 + 1;
        host.Huntress.Given(Request.Create().WithPath($"/v1/incident_reports/{id}/remediations/{manual}/completion").UsingPost())
            .RespondWith(Response.Create().WithStatusCode(201).WithCallback(_ =>
            {
                Live(host, customer, id, "sent", ("assisted", "approved"), ("manual", "completed"));
                return new WireMock.ResponseMessage { StatusCode = 201 };
            }));

        (await host.PreviewAsync(HuntressActionKinds.Step, "alert", $"incident:{id}", new { remediation = id * 10, completed = true }))
            .GetProperty("block").GetProperty("code").GetString().ShouldBe("VND_STEP_NOT_MANUAL");
        var marked = await host.RunActionAsync(await host.AskAsync(HuntressActionKinds.Step, "alert", $"incident:{id}", new { remediation = manual, completed = true }));
        (marked.Status, marked.OutcomeCode).ShouldBe((VendorActionStatus.Succeeded, "VND_SENT"));
        host.Posted($"/v1/incident_reports/{id}/remediations/{manual}/completion").GetProperty("completed").GetBoolean().ShouldBeTrue();
        (await PlanAsync(host, id)).ShouldBe(["approved", "completed"]);

        host.Huntress.Given(Request.Create().WithPath($"/v1/incident_reports/{id}/resolution").UsingPost())
            .RespondWith(Response.Create().WithStatusCode(201).WithCallback(_ =>
            {
                Live(host, customer, id, "closed", ("assisted", "approved"), ("manual", "completed"));
                return new WireMock.ResponseMessage { StatusCode = 201 };
            }));
        var resolved = await host.RunActionAsync(await host.AskAsync(HuntressActionKinds.Resolve, "alert", $"incident:{id}"));

        (resolved.Status, resolved.OutcomeCode).ShouldBe((VendorActionStatus.Succeeded, "VND_SENT"));
        var alert = await AlertAsync(host, $"incident:{id}");
        (alert.State, alert.SourceClosedAt).ShouldBe((AlertState.Resolved, (DateTimeOffset?)null), "a person resolved it from Parasoll: nothing waits");
    }

    [Fact]
    public async Task Resolving_is_refused_while_a_step_waits_for_approval()
    {
        await using var host = HuntressHost.Start(factory);
        var (_, id) = await StoredIncidentAsync(host, "sent", ("assisted", "unapproved"));
        (await host.PreviewAsync(HuntressActionKinds.Resolve, "alert", $"incident:{id}")).GetProperty("block").GetProperty("code").GetString()
            .ShouldBe("VND_INCIDENT_UNAPPROVED");
    }

    [Fact]
    public async Task A_comment_is_sent_once_and_read_back_into_the_incident()
    {
        await using var host = HuntressHost.Start(factory);
        var (customer, id) = await StoredIncidentAsync(host, "sent", ("assisted", "unapproved"));
        Live(host, customer, id, "sent", ("assisted", "unapproved"));
        host.On("POST", $"/v1/incident_reports/{id}/comments").RespondWith(JsonReply(new
        {
            comment = new { id = 555, body = "Rebuilt the host.", author = "Dev API User", created_at = "2026-10-22T12:00:00Z" },
        }, 201));
        host.List($"/v1/incident_reports/{id}/comments", "comments", [new { id = 555, body = "Rebuilt the host.", author = "Dev API User", created_at = "2026-10-22T12:00:00Z" }]);

        var action = await host.RunActionAsync(await host.AskAsync(HuntressActionKinds.Comment, "alert", $"incident:{id}", new { text = " Rebuilt the host. " }));

        (action.Status, action.Reference).ShouldBe((VendorActionStatus.Succeeded, "555"));
        host.Posted($"/v1/incident_reports/{id}/comments").GetProperty("body").GetString().ShouldBe("Rebuilt the host.");
        var incident = await host.Client().GetFromJsonAsync<JsonElement>($"/api/v1/security/huntress/incidents/{id}", Ct);
        incident.GetProperty("comments").EnumerateArray().ShouldHaveSingleItem().GetProperty("body").GetString().ShouldBe("Rebuilt the host.");
    }

    [Fact]
    public async Task A_comment_on_an_urgent_incident_huntress_closed_by_itself_leaves_its_alert_waiting_for_a_person()
    {
        await using var host = HuntressHost.Start(factory);
        var (customer, id) = await StoredIncidentAsync(host, "sent", ("assisted", "approved"));
        // Huntress closed the urgent incident by itself; the comment's read-back sees it closed.
        Live(host, customer, id, "closed", ("assisted", "approved"));
        host.On("POST", $"/v1/incident_reports/{id}/comments").RespondWith(JsonReply(new
        {
            comment = new { id = 556, body = "Seen.", author = "Dev API User", created_at = "2026-10-22T12:00:00Z" },
        }, 201));

        var action = await host.RunActionAsync(await host.AskAsync(HuntressActionKinds.Comment, "alert", $"incident:{id}", new { text = "Seen." }));

        action.Status.ShouldBe(VendorActionStatus.Succeeded);
        (await AlertAsync(host, $"incident:{id}")).State.ShouldBe(AlertState.Open, "a comment closes nothing: the closing Huntress made waits for a person");
    }

    [Fact]
    public async Task A_close_huntress_accepted_closes_the_urgent_alert_even_when_the_read_after_it_fails()
    {
        await using var host = HuntressHost.Start(factory);
        var (customer, id) = await StoredIncidentAsync(host, "sent", ("assisted", "approved"));
        Live(host, customer, id, "sent", ("assisted", "approved"));
        host.Huntress.Given(Request.Create().WithPath($"/v1/incident_reports/{id}/resolution").UsingPost())
            .RespondWith(Response.Create().WithStatusCode(201).WithCallback(_ =>
            {
                // Huntress accepts the close, then cannot be read.
                host.On("GET", $"/v1/incident_reports/{id}").RespondWith(JsonReply(new { errors = new[] { "Synthetic outage" } }, 503));
                return new WireMock.ResponseMessage { StatusCode = 201 };
            }));

        var resolved = await host.RunActionAsync(await host.AskAsync(HuntressActionKinds.Resolve, "alert", $"incident:{id}"));

        (resolved.Status, resolved.OutcomeCode).ShouldBe((VendorActionStatus.Succeeded, "VND_SENT"));
        var alert = await AlertAsync(host, $"incident:{id}");
        (alert.State, alert.SourceClosedAt).ShouldBe((AlertState.Resolved, (DateTimeOffset?)null), "a person closed it and Huntress accepted: nothing waits for the next read");
    }

    [Fact]
    public async Task A_read_that_began_before_a_persons_close_neither_reopens_the_alert_nor_reopens_the_incident()
    {
        await using var host = HuntressHost.Start(factory);
        var (customer, id) = await StoredIncidentAsync(host, "sent", ("assisted", "approved"));
        var began = DateTimeOffset.UtcNow.AddSeconds(-30);
        await using var scope = host.Services.CreateAsyncScope();
        var security = scope.ServiceProvider.GetRequiredService<ISecurityApi>();
        var service = scope.ServiceProvider.GetRequiredService<IServiceApi>();
        // The person's close: the read after it wrote the incident closed and resolved its alert.
        await security.ApplyIncidentsAsync([Reading(customer, id, "closed")], Ct);
        await service.ResolveAlertAsync(HuntressTypes.System, $"incident:{id}", Ct);

        // A scheduled read that began 30 seconds earlier still has the incident waiting. Every other open Huntress alert is listed too, so
        // this complete read touches nothing else in the shared database.
        await security.ApplyIncidentsAsync([Reading(customer, id, "sent") with { ReadAt = began }], Ct);
        var others = await scope.ServiceProvider.GetRequiredService<ServiceDbContext>().Alerts.AsNoTracking()
            .Where(a => a.System == HuntressTypes.System && a.State != AlertState.Resolved).Select(a => a.ExternalId).ToListAsync(Ct);
        await service.ApplyAlertSnapshotAsync(new AlertSnapshot(HuntressTypes.System, AlertKind.Security,
            [new ExternalAlert($"incident:{id}", customer.OrganizationId, AlertSeverity.Critical, $"HIGH - Incident {id}", null, DateTimeOffset.UtcNow.AddHours(-1),
                customer.HuntressOrganizationId.ToString(CultureInfo.InvariantCulture), ConfirmClose: true)],
            [.. others, $"incident:{id}"], IsComplete: true, ReadStartedAt: began), Ct);

        (await AlertAsync(host, $"incident:{id}")).State.ShouldBe(AlertState.Resolved, "the read knew less than the person's close");
        (await security.GetIncidentAsync(HuntressTypes.System, id, Ct))!.Status.ShouldBe("closed");
    }

    [Fact]
    public async Task A_write_the_request_limit_refuses_every_time_is_not_sent_and_comes_again_later()
    {
        await using var host = HuntressHost.Start(factory);
        var (customer, id) = await StoredIncidentAsync(host, "sent", ("assisted", "unapproved"));
        Live(host, customer, id, "sent", ("assisted", "unapproved"));
        host.On("POST", $"/v1/incident_reports/{id}/comments").RespondWith(JsonReply(new { errors = new[] { "Rate limit exceeded" } }, 429));

        var action = await host.RunActionAsync(await host.AskAsync(HuntressActionKinds.Comment, "alert", $"incident:{id}", new { text = "Busy?" }));

        // Huntress processed nothing: the comment is not uncertain, it is tried again later.
        (action.Status, action.OutcomeCode, action.MayHaveSent).ShouldBe((VendorActionStatus.Queued, "VND_VENDOR_BUSY", false));
        host.Count("POST", $"/v1/incident_reports/{id}/comments").ShouldBeGreaterThan(1, "429 is retried before it counts as busy");
    }

    [Fact]
    public async Task An_access_escalation_is_closed_with_its_answer_for_the_identity_only_and_its_alert_closes()
    {
        await using var host = HuntressHost.Start(factory);
        var customer = await host.CustomerAsync();
        var id = Random.Shared.NextInt64(6_000_000, 6_999_999);
        await using (var scope = host.Services.CreateAsyncScope())
        {
            await scope.ServiceProvider.GetRequiredService<ISecurityApi>().ApplyNoticesAsync([new ExternalNotice(
                HuntressTypes.System, NoticeKind.Escalation, id, customer.OrganizationId, [customer.HuntressOrganizationId], "open", "high",
                "Login from an unexpected country", "Unexpected Country Access", "unexpected_country_access", "RU", [], true,
                DateTimeOffset.UtcNow.AddHours(-1), null, DateTimeOffset.UtcNow.AddHours(-1), null)], Ct);
            await StoreAlertAsync(scope, $"escalation:{id}", customer, AlertSeverity.Critical, confirmClose: false);
        }

        host.On("GET", $"/v1/escalations/{id}").RespondWith(JsonReply(new { escalation = HuntressRecords.Notice(id, customer.HuntressOrganizationId, "open", "unexpected_country_access", "Login") }));
        host.Huntress.Given(Request.Create().WithPath($"/v1/escalations/{id}/resolution").UsingPost())
            .RespondWith(Response.Create().WithStatusCode(201).WithCallback(_ =>
            {
                host.On("GET", $"/v1/escalations/{id}").RespondWith(JsonReply(new { escalation = HuntressRecords.Notice(id, customer.HuntressOrganizationId, "resolved", "unexpected_country_access", "Login") }));
                return new WireMock.ResponseMessage { StatusCode = 201 };
            }));

        (await host.PreviewAsync(HuntressActionKinds.EscalationResolve, "alert", $"escalation:{id}", new { answer = "maybe" })).GetProperty("block").GetProperty("code").GetString()
            .ShouldBe("VND_ANSWER_INVALID");
        var action = await host.RunActionAsync(await host.AskAsync(HuntressActionKinds.EscalationResolve, "alert", $"escalation:{id}", new { answer = "expected" }));

        (action.Status, action.OutcomeCode).ShouldBe((VendorActionStatus.Succeeded, "VND_SENT"));
        var body = host.Posted($"/v1/escalations/{id}/resolution");
        (body.GetProperty("determination").GetString(), body.GetProperty("scope").GetString()).ShouldBe(("expected", "identity"));
        body.TryGetProperty("revoke_and_disable_identities", out _).ShouldBeFalse("Huntress takes the flag only beside \"unauthorized\"");
        (await AlertAsync(host, $"escalation:{id}")).State.ShouldBe(AlertState.Resolved);
    }

    [Fact]
    public async Task Isolating_asks_for_a_reason_sends_it_once_and_the_device_shows_the_isolation_coming()
    {
        await using var host = HuntressHost.Start(factory);
        var (customer, agent) = await StoredAgentAsync(host);
        host.On("GET", $"/v1/agents/{agent}").RespondWith(JsonReply(new { agent = HuntressRecords.Agent(agent, customer.HuntressOrganizationId, $"{customer.Marker}-SRV") }));
        host.Huntress.Given(Request.Create().WithPath($"/v1/agents/{agent}/isolation").UsingPost())
            .RespondWith(Response.Create().WithStatusCode(201).WithCallback(_ =>
            {
                host.On("GET", $"/v1/agents/{agent}").RespondWith(JsonReply(new
                {
                    agent = HuntressRecords.Agent(agent, customer.HuntressOrganizationId, $"{customer.Marker}-SRV", firewall: "Pending Isolation"),
                }));
                return new WireMock.ResponseMessage { StatusCode = 201 };
            }));

        var preview = await host.PreviewAsync(HuntressActionKinds.Isolate, "device", agent.ToString(CultureInfo.InvariantCulture));
        preview.GetProperty("level").GetString().ShouldBe("Disruptive");
        preview.GetProperty("confirmation").GetProperty("reason").GetBoolean().ShouldBeTrue();
        (await host.PreviewAsync(HuntressActionKinds.Release, "device", agent.ToString(CultureInfo.InvariantCulture))).GetProperty("block").GetProperty("code").GetString()
            .ShouldBe("VND_NOT_ISOLATED");

        var action = await host.RunActionAsync(await host.AskAsync(HuntressActionKinds.Isolate, "device", agent.ToString(CultureInfo.InvariantCulture),
            reason: "Ransomware suspected on the server"));

        (action.Status, action.OutcomeCode).ShouldBe((VendorActionStatus.Succeeded, "VND_SENT"));
        var body = host.Posted($"/v1/agents/{agent}/isolation");
        (body.GetProperty("reason").GetString(), body.GetProperty("strict_isolation").GetBoolean()).ShouldBe(("Ransomware suspected on the server", false));
        (await DeviceAsync(host, agent)).Isolation.ShouldBe("Pending Isolation");
        (await host.PreviewAsync(HuntressActionKinds.Isolate, "device", agent.ToString(CultureInfo.InvariantCulture))).GetProperty("block").GetProperty("code").GetString()
            .ShouldBe("VND_ALREADY_ISOLATED");
    }

    [Fact]
    public async Task Removing_the_agent_is_destructive_waits_out_its_hold_and_the_device_is_removed_once_huntress_forgets_it()
    {
        await using var host = HuntressHost.Start(factory);
        var (customer, agent) = await StoredAgentAsync(host);
        var path = $"/v1/agents/{agent}";
        host.On("GET", path).RespondWith(JsonReply(new { agent = HuntressRecords.Agent(agent, customer.HuntressOrganizationId, $"{customer.Marker}-SRV") }));
        host.Huntress.Given(Request.Create().WithPath(path).UsingDelete()).RespondWith(Response.Create().WithStatusCode(204).WithCallback(_ =>
        {
            host.On("GET", path).RespondWith(Response.Create().WithStatusCode(404));
            return new WireMock.ResponseMessage { StatusCode = 204 };
        }));

        var preview = await host.PreviewAsync(HuntressActionKinds.Uninstall, "device", agent.ToString(CultureInfo.InvariantCulture));
        preview.GetProperty("level").GetString().ShouldBe("Destructive");
        var id = await host.AskAsync(HuntressActionKinds.Uninstall, "device", agent.ToString(CultureInfo.InvariantCulture),
            reason: "The machine was given to another customer", typedName: $"{customer.Marker}-SRV");
        (await host.RunActionAsync(id)).Status.ShouldBe(VendorActionStatus.Scheduled, "the hold has not passed");
        host.Count("DELETE", path).ShouldBe(0);
        await host.DueNowAsync(id);

        var action = await host.RunActionAsync(id);
        (action.Status, action.OutcomeCode).ShouldBe((VendorActionStatus.Succeeded, "VND_SENT"));
        host.Count("DELETE", path).ShouldBe(1);
        (await DeviceAsync(host, agent)).RemovedAt.ShouldNotBeNull();
    }

    [Fact]
    public async Task An_agent_that_moved_to_another_organization_is_refused_and_test_mode_sends_nothing()
    {
        await using (var host = HuntressHost.Start(factory))
        {
            var (customer, agent) = await StoredAgentAsync(host);
            host.On("GET", $"/v1/agents/{agent}").RespondWith(JsonReply(new { agent = HuntressRecords.Agent(agent, customer.HuntressOrganizationId + 1, "MOVED") }));
            var action = await host.RunActionAsync(await host.AskAsync(HuntressActionKinds.Isolate, "device", agent.ToString(CultureInfo.InvariantCulture), reason: "Synthetic reason here"));
            (action.Status, action.OutcomeCode).ShouldBe((VendorActionStatus.Rejected, "VND_AGENT_MOVED"));
            host.Count("POST", $"/v1/agents/{agent}/isolation").ShouldBe(0);
        }

        await using (var host = HuntressHost.Start(factory, write: false, dryRun: true))
        {
            var (customer, id) = await StoredIncidentAsync(host, "sent", ("assisted", "unapproved"));
            Live(host, customer, id, "sent", ("assisted", "unapproved"));
            var action = await host.RunActionAsync(await host.AskAsync(HuntressActionKinds.Approve, "alert", $"incident:{id}"));
            (action.Status, action.OutcomeCode).ShouldBe((VendorActionStatus.Simulated, "VND_DRY_RUN"));
            host.Count("POST", $"/v1/incident_reports/{id}/remediations/bulk_approval").ShouldBe(0);
        }
    }

    [Fact]
    public async Task Actions_are_closed_until_switched_on_and_held_to_the_allowed_organizations()
    {
        await using (var host = HuntressHost.Start(factory, kinds: []))
        {
            var (_, id) = await StoredIncidentAsync(host, "sent", ("assisted", "unapproved"));
            (await host.PreviewAsync(HuntressActionKinds.Approve, "alert", $"incident:{id}")).GetProperty("block").GetProperty("code").GetString()
                .ShouldBe("VND_KIND_DISABLED");
        }

        await using (var host = HuntressHost.Start(factory, allowed: ["1"]))
        {
            var (_, id) = await StoredIncidentAsync(host, "sent", ("assisted", "unapproved"));
            (await host.PreviewAsync(HuntressActionKinds.Approve, "alert", $"incident:{id}")).GetProperty("block").GetProperty("code").GetString()
                .ShouldBe("VND_CUSTOMER_NOT_ALLOWED");
        }

        await using (var host = HuntressHost.Start(factory, write: false))
        {
            var (_, id) = await StoredIncidentAsync(host, "sent", ("assisted", "unapproved"));
            (await host.PreviewAsync(HuntressActionKinds.Approve, "alert", $"incident:{id}")).GetProperty("block").GetProperty("code").GetString()
                .ShouldBe("VND_WRITE_DISABLED");
        }
    }

    /// <summary>
    /// A Huntress incident of a new customer, stored straight in the mirrors with its alert: a complete alert read would resolve every
    /// other open Huntress alert of the shared database.
    /// </summary>
    private static async Task<(HuntressCustomer Customer, long Id)> StoredIncidentAsync(HuntressHost host, string status, params (string Type, string Status)[] plan)
    {
        var customer = await host.CustomerAsync();
        var id = Random.Shared.NextInt64(5_000_000, 5_999_999);
        await using var scope = host.Services.CreateAsyncScope();
        await scope.ServiceProvider.GetRequiredService<ISecurityApi>().ApplyIncidentsAsync([new IncidentReading(
            new ExternalIncident(HuntressTypes.System, id, customer.OrganizationId, customer.HuntressOrganizationId, null, null, status, "high",
                $"HIGH - Incident {id}", "Synthetic summary.", null, "windows", ["footholds"], new Dictionary<string, int> { ["footholds"] = 1 },
                DateTimeOffset.UtcNow.AddHours(-1), null, DateTimeOffset.UtcNow.AddHours(-1), DateTimeOffset.UtcNow.AddHours(-1), null),
            plan.Select((step, i) => new ExternalRemediation(id * 10 + i, step.Type, $"Step {i}", null, step.Status, null, null, null)).ToList(),
            [])], Ct);
        await StoreAlertAsync(scope, $"incident:{id}", customer, AlertSeverity.Critical, confirmClose: true);
        return (customer, id);
    }

    private static async Task StoreAlertAsync(AsyncServiceScope scope, string externalId, HuntressCustomer customer, AlertSeverity severity, bool confirmClose)
    {
        var db = scope.ServiceProvider.GetRequiredService<ServiceDbContext>();
        var now = DateTimeOffset.UtcNow;
        db.Alerts.Add(Alert.Open(HuntressTypes.System, AlertKind.Security, new ExternalAlert(
            externalId, customer.OrganizationId, severity, $"Synthetic {externalId}", null, now.AddHours(-1),
            customer.HuntressOrganizationId.ToString(CultureInfo.InvariantCulture), ConfirmClose: confirmClose), null, now));
        await db.SaveChangesAsync(Ct);
    }

    /// <summary>A read of the incident as a reader writes it into the mirror, with no plan or comments.</summary>
    private static IncidentReading Reading(HuntressCustomer customer, long id, string status) => new(
        new ExternalIncident(HuntressTypes.System, id, customer.OrganizationId, customer.HuntressOrganizationId, null, null, status, "high",
            $"HIGH - Incident {id}", "Synthetic summary.", null, "windows", ["footholds"], new Dictionary<string, int> { ["footholds"] = 1 },
            DateTimeOffset.UtcNow.AddHours(-1), null, DateTimeOffset.UtcNow, DateTimeOffset.UtcNow, null),
        null, null);

    /// <summary>What Huntress answers for the incident now: its status and plan, and no comments (a test that wants some stubs them after).</summary>
    private static void Live(HuntressHost host, HuntressCustomer customer, long id, string status, params (string Type, string Status)[] plan)
    {
        host.On("GET", $"/v1/incident_reports/{id}").RespondWith(JsonReply(new
        {
            incident_report = HuntressRecords.Incident(id, customer.HuntressOrganizationId, null, "high", status,
                plan.Select((step, i) => HuntressRecords.Remediation(id * 10 + i, step.Type, step.Status, $"Step {i}")).ToArray()),
        }));
        host.List($"/v1/incident_reports/{id}/comments", "comments", []);
    }

    /// <summary>A current Huntress agent of a new customer in the device mirror.</summary>
    private static async Task<(HuntressCustomer Customer, long Agent)> StoredAgentAsync(HuntressHost host)
    {
        var customer = await host.CustomerAsync();
        var agent = Random.Shared.NextInt64(80_000_000, 89_999_999);
        await using var scope = host.Services.CreateAsyncScope();
        await scope.ServiceProvider.GetRequiredService<IServiceApi>().ReplaceDevicesAsync(customer.OrganizationId, HuntressTypes.System, [
            new(agent.ToString(CultureInfo.InvariantCulture), $"{customer.Marker}-SRV", DeviceType.Server, "Windows Server 2022", true, DateTimeOffset.UtcNow, null,
                AlternateId: customer.HuntressOrganizationId.ToString(CultureInfo.InvariantCulture), Platform: "windows",
                Protection: new DeviceProtectionReading("Healthy", null, null, null, "Disabled")),
        ], Ct);
        return (customer, agent);
    }

    private static async Task<List<string>> PlanAsync(HuntressHost host, long id)
    {
        await using var scope = host.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<SecurityDbContext>();
        var incident = await db.Incidents.AsNoTracking().SingleAsync(i => i.System == HuntressTypes.System && i.ExternalId == id, Ct);
        return await db.Remediations.AsNoTracking().Where(r => r.IncidentId == incident.Id).OrderBy(r => r.ExternalId).Select(r => r.Status).ToListAsync(Ct);
    }

    private static async Task<Alert> AlertAsync(HuntressHost host, string externalId)
    {
        await using var scope = host.Services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<ServiceDbContext>().Alerts.AsNoTracking()
            .SingleAsync(a => a.System == HuntressTypes.System && a.ExternalId == externalId, Ct);
    }

    private static async Task<Device> DeviceAsync(HuntressHost host, long agent)
    {
        await using var scope = host.Services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<ServiceDbContext>().Devices.AsNoTracking()
            .SingleAsync(d => d.System == HuntressTypes.System && d.ExternalId == agent.ToString(CultureInfo.InvariantCulture), Ct);
    }
}
