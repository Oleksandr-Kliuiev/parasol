using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crm.Integrations.Atera;
using Crm.Integrations.Core.Actions;
using Crm.Integrations.Core.Persistence;
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
/// M40 on SQL Server: an Atera alert is resolved (<c>PUT alerts/{id}</c>) or deleted (<c>DELETE alerts/{id}</c>, destructive, held a
/// minute) through the action path; the attempt reads the alert first, refuses one that moved to another customer, skips one that is
/// already so, and the read of the alert after the change is what resolves it in the CRM. Atera answers from a stub of the test.
/// </summary>
[Collection(AteraCollection.Name)]
public sealed class AteraAlertActionTests(CrmWebFactory factory)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Resolving_puts_the_alert_once_and_the_read_after_it_resolves_it_in_the_crm()
    {
        await using var host = AteraTicketHost.Start(factory, kinds: AteraAlertKinds.All);
        var alert = await StoredAlertAsync(host);
        // Atera has the alert open until the CRM resolves it, then archived.
        host.Atera.Given(Request.Create().WithPath(Path(alert)).UsingGet()).InScenario(alert.Id).WillSetStateTo("open")
            .RespondWith(JsonReply(Live(alert, archived: false)));
        host.Atera.Given(Request.Create().WithPath(Path(alert)).UsingGet()).InScenario(alert.Id).WhenStateIs("open")
            .RespondWith(JsonReply(Live(alert, archived: false)));
        host.Atera.Given(Request.Create().WithPath(Path(alert)).UsingPut()).InScenario(alert.Id).WhenStateIs("open").WillSetStateTo("resolved")
            .RespondWith(Response.Create().WithStatusCode(204));
        host.Atera.Given(Request.Create().WithPath(Path(alert)).UsingGet()).InScenario(alert.Id).WhenStateIs("resolved")
            .RespondWith(JsonReply(Live(alert, archived: true)));

        var preview = await PreviewAsync(host, AteraAlertKinds.Resolve, alert);
        preview.GetProperty("level").GetString().ShouldBe("Standard");
        preview.GetProperty("target").GetProperty("name").GetString().ShouldBe(alert.Title);
        preview.GetProperty("effects").EnumerateArray().Select(e => e.GetProperty("code").GetString())
            .ShouldBe(["VND_EFFECT_ALERT_RESOLVE", "VND_EFFECT_ALERT_CONFIRM"]);

        var action = await host.RunAsync(await AskAsync(host, AteraAlertKinds.Resolve, alert, preview));
        (action.Status, action.OutcomeCode).ShouldBe((VendorActionStatus.Succeeded, "VND_SENT"));
        host.Count("PUT", Path(alert)).ShouldBe(1);
        (await StateAsync(host, alert)).ShouldBe(AlertState.Resolved, "the read after the change confirmed it");
    }

    [Fact]
    public async Task An_alert_atera_already_archived_is_skipped_and_resolved_in_the_crm()
    {
        await using var host = AteraTicketHost.Start(factory, kinds: AteraAlertKinds.All);
        var alert = await StoredAlertAsync(host);
        host.On("GET", Path(alert)).RespondWith(JsonReply(Live(alert, archived: true)));

        var action = await host.RunAsync(await AskAsync(host, AteraAlertKinds.Resolve, alert));

        (action.Status, action.OutcomeCode).ShouldBe((VendorActionStatus.Skipped, "VND_ALREADY_DONE"));
        host.Count("PUT", Path(alert)).ShouldBe(0);
        (await StateAsync(host, alert)).ShouldBe(AlertState.Resolved);
        (await PreviewAsync(host, AteraAlertKinds.Resolve, alert)).GetProperty("block").GetProperty("code").GetString()
            .ShouldBe("VND_ALERT_RESOLVED", "a resolved alert is not resolved again");
    }

    [Fact]
    public async Task Deleting_is_destructive_waits_out_its_hold_and_a_deleted_alert_is_resolved_in_the_crm()
    {
        await using var host = AteraTicketHost.Start(factory, kinds: AteraAlertKinds.All);
        var alert = await StoredAlertAsync(host);
        host.Atera.Given(Request.Create().WithPath(Path(alert)).UsingGet()).InScenario(alert.Id).WillSetStateTo("open")
            .RespondWith(JsonReply(Live(alert, archived: false)));
        host.Atera.Given(Request.Create().WithPath(Path(alert)).UsingGet()).InScenario(alert.Id).WhenStateIs("open")
            .RespondWith(JsonReply(Live(alert, archived: false)));
        host.Atera.Given(Request.Create().WithPath(Path(alert)).UsingDelete()).InScenario(alert.Id).WhenStateIs("open").WillSetStateTo("deleted")
            .RespondWith(Response.Create().WithStatusCode(204));
        host.Atera.Given(Request.Create().WithPath(Path(alert)).UsingGet()).InScenario(alert.Id).WhenStateIs("deleted")
            .RespondWith(Response.Create().WithStatusCode(404));

        var preview = await PreviewAsync(host, AteraAlertKinds.Delete, alert);
        preview.GetProperty("level").GetString().ShouldBe("Destructive");
        var confirmation = preview.GetProperty("confirmation");
        (confirmation.GetProperty("typedName").GetBoolean(), confirmation.GetProperty("freshSignIn").GetBoolean(), confirmation.GetProperty("holdSeconds").GetInt32())
            .ShouldBe((true, true, 60));

        var id = await AskAsync(host, AteraAlertKinds.Delete, alert, preview, reason: "The customer replaced the disk already", typedName: alert.Title);
        (await host.RunAsync(id)).Status.ShouldBe(VendorActionStatus.Scheduled, "the hold has not passed");
        host.Count("DELETE", Path(alert)).ShouldBe(0);
        await DueNowAsync(host, id);

        var action = await host.RunAsync(id);
        (action.Status, action.OutcomeCode).ShouldBe((VendorActionStatus.Succeeded, "VND_SENT"));
        host.Count("DELETE", Path(alert)).ShouldBe(1);
        (await StateAsync(host, alert)).ShouldBe(AlertState.Resolved);
    }

    [Fact]
    public async Task An_alert_that_belongs_to_another_customer_now_is_refused_and_nothing_is_sent()
    {
        await using var host = AteraTicketHost.Start(factory, kinds: AteraAlertKinds.All);
        var alert = await StoredAlertAsync(host);
        host.On("GET", Path(alert)).RespondWith(JsonReply(Live(alert, archived: false) with { CustomerID = alert.CustomerId + 1 }));

        var action = await host.RunAsync(await AskAsync(host, AteraAlertKinds.Resolve, alert));

        (action.Status, action.OutcomeCode).ShouldBe((VendorActionStatus.Rejected, "VND_ALERT_MOVED"));
        host.Count("PUT", Path(alert)).ShouldBe(0);
        (await StateAsync(host, alert)).ShouldBe(AlertState.Open);
    }

    [Fact]
    public async Task In_test_mode_atera_is_read_and_nothing_is_sent()
    {
        await using var host = AteraTicketHost.Start(factory, write: false, dryRun: true, kinds: AteraAlertKinds.All);
        var alert = await StoredAlertAsync(host);
        host.On("GET", Path(alert)).RespondWith(JsonReply(Live(alert, archived: false)));

        var action = await host.RunAsync(await AskAsync(host, AteraAlertKinds.Resolve, alert));

        (action.Status, action.OutcomeCode).ShouldBe((VendorActionStatus.Simulated, "VND_DRY_RUN"));
        host.Count("GET", Path(alert)).ShouldBe(1);
        host.Count("PUT", Path(alert)).ShouldBe(0);
        (await StateAsync(host, alert)).ShouldBe(AlertState.Open);
    }

    private sealed record TestAlert(string Id, long CustomerId, Guid OrganizationId, string Title);

    private sealed record LiveAlert(long AlertID, long CustomerID, string Title, string Severity, string Created, bool Archived);

    private static LiveAlert Live(TestAlert alert, bool archived) =>
        new(long.Parse(alert.Id, CultureInfo.InvariantCulture), alert.CustomerId, alert.Title, "Critical", "2026-10-22T06:00:00Z", archived);

    private static string Path(TestAlert alert) => $"/api/v3/alerts/{alert.Id}";

    /// <summary>
    /// An open Atera alert of a new customer, stored straight in the mirror: a complete alert snapshot would resolve every other open
    /// Atera alert of the shared database.
    /// </summary>
    private static async Task<TestAlert> StoredAlertAsync(AteraTicketHost host)
    {
        var organizationId = await host.Client().CreateOrganizationAsync(new { name = $"Varsel {Guid.NewGuid():N}"[..20], status = "Customer" });
        var alert = new TestAlert(
            TestData.AteraId().ToString(CultureInfo.InvariantCulture), TestData.AteraId(),
            organizationId, $"Disk almost full {Guid.NewGuid():N}"[..28]);
        await using var scope = host.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ServiceDbContext>();
        var now = DateTimeOffset.UtcNow;
        db.Alerts.Add(Alert.Open(AteraTypes.System, AlertKind.Monitoring, new ExternalAlert(
            alert.Id, organizationId, AlertSeverity.Critical, alert.Title, "SRV-01", now.AddHours(-1), alert.CustomerId.ToString(CultureInfo.InvariantCulture)), null, now));
        await db.SaveChangesAsync(Ct);
        return alert;
    }

    private static async Task<JsonElement> PreviewAsync(AteraTicketHost host, string kind, TestAlert alert)
    {
        var response = await host.Client().PostAsJsonAsync("/api/v1/actions/preview", Body(kind, alert, new { }), Ct);
        response.StatusCode.ShouldBe(HttpStatusCode.OK, await response.Content.ReadAsStringAsync(Ct));
        return await response.ReadJsonAsync();
    }

    private static async Task<Guid> AskAsync(
        AteraTicketHost host, string kind, TestAlert alert, JsonElement? preview = null, string? reason = null, string? typedName = null)
    {
        var shown = preview ?? await PreviewAsync(host, kind, alert);
        shown.GetProperty("block").ValueKind.ShouldBe(JsonValueKind.Null, shown.ToString());
        var command = await host.Client().PostAsJsonAsync(kind == AteraAlertKinds.Delete ? "/api/v1/actions/destructive" : "/api/v1/actions", new
        {
            system = "atera", kind, targetType = AteraAlertKinds.TargetType, targetId = alert.Id, parameters = new { },
            previewToken = shown.GetProperty("previewToken").GetString(), commandKey = Guid.NewGuid(), reason, typedName,
        }, Ct);
        command.StatusCode.ShouldBe(HttpStatusCode.Accepted, await command.Content.ReadAsStringAsync(Ct));
        return (await command.ReadJsonAsync()).GetProperty("id").GetGuid();
    }

    private static object Body(string kind, TestAlert alert, object parameters) =>
        new { system = "atera", kind, targetType = AteraAlertKinds.TargetType, targetId = alert.Id, parameters };

    private static async Task<AlertState> StateAsync(AteraTicketHost host, TestAlert alert)
    {
        await using var scope = host.Services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<ServiceDbContext>().Alerts.AsNoTracking()
            .Where(a => a.System == AteraTypes.System && a.ExternalId == alert.Id).Select(a => a.State).SingleAsync(Ct);
    }

    /// <summary>The hold of a destructive action has passed: its operation is due now.</summary>
    private static async Task DueNowAsync(AteraTicketHost host, Guid actionId)
    {
        await using var scope = host.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
        var operationId = (await db.VendorActions.AsNoTracking().SingleAsync(a => a.Id == actionId, Ct)).OutboundOperationId;
        var past = DateTimeOffset.UtcNow.AddSeconds(-1);
        await db.OutboundOperations.Where(o => o.Id == operationId).ExecuteUpdateAsync(s => s.SetProperty(o => o.NextAttemptAt, past), Ct);
    }
}
