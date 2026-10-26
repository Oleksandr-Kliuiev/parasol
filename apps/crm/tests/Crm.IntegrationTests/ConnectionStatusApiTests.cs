using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crm.Authorization;
using Crm.Integrations.Core;
using Crm.Integrations.Core.Persistence;
using Crm.Integrations.Core.Readiness;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace Crm.IntegrationTests;

/// <summary>
/// M38: the connections page reads the CRM's own integration state. The seeded state belongs to synthetic systems of this test
/// alone (a catalog of its own), the heartbeats to instances of its own; the class runs alone because it compares table totals
/// and provider calls before and after a read.
/// </summary>
[Collection(DatabaseAdministrationCollection.Name)]
public sealed class ConnectionStatusApiTests(CrmWebFactory factory) : IAsyncLifetime
{
    private const string Endpoint = "/api/v1/integrations/connections";
    private static CancellationToken Ct => TestContext.Current.CancellationToken;
    private readonly string userKey = "connections-" + Guid.NewGuid().ToString("N");
    private readonly string run = Guid.NewGuid().ToString("N")[..8];
    private readonly List<Guid> ownedOutbound = [];
    private string Read => $"conn-read-{run}";
    private string Held => $"conn-held-{run}";
    private string Off => $"conn-off-{run}";
    private string Instance => $"connections-{run}";

    public ValueTask InitializeAsync() => ValueTask.CompletedTask;

    public async ValueTask DisposeAsync()
    {
        await using var scope = factory.Services.CreateAsyncScope(); var db = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
        string[] systems = [Read, Held, Off];
        await db.SyncRuns.Where(row => systems.Contains(row.System)).ExecuteDeleteAsync(Ct);
        await db.SyncSuccesses.Where(row => systems.Contains(row.System)).ExecuteDeleteAsync(Ct);
        await db.IntegrationSwitches.Where(row => systems.Contains(row.System)).ExecuteDeleteAsync(Ct);
        await db.OutboundOperations.Where(row => ownedOutbound.Contains(row.Id)).ExecuteDeleteAsync(Ct);
        await db.WorkerHeartbeats.Where(row => row.Instance == Instance).ExecuteDeleteAsync(Ct);
        await db.WebhookStates.Where(row => systems.Contains(row.System)).ExecuteDeleteAsync(Ct);
        await db.EarlyReadRequests.Where(row => systems.Contains(row.System)).ExecuteDeleteAsync(Ct);
    }

    private async Task<WebApplicationFactory<Program>> Host(Action<IWebHostBuilder>? configure = null)
    {
        // Provision the signed-in administrator first: a first sign-in writes audit rows the read-only checks must not count.
        _ = await factory.ClientAs(CrmRoles.Admin, userKey).GetFromJsonAsync<JsonElement>("/bff/user", Ct);
        return factory.WithWebHostBuilder(builder => configure?.Invoke(builder));
    }

    private HttpClient Client(WebApplicationFactory<Program> host, string role = CrmRoles.Admin, string? key = null)
    {
        var client = host.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false });
        client.DefaultRequestHeaders.Add(TestAuthHandler.RolesHeader, role); client.DefaultRequestHeaders.Add(TestAuthHandler.UserHeader, key ?? userKey);
        client.DefaultRequestHeaders.Add("X-CSRF", "1"); return client;
    }

    private static async Task<(int Runs, int Successes, int Beats, int Outbound, int Audit, int Outbox)> Writes(IServiceProvider services)
    {
        await using var scope = services.CreateAsyncScope(); var db = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
        return (await db.SyncRuns.CountAsync(Ct), await db.SyncSuccesses.CountAsync(Ct), await db.WorkerHeartbeats.CountAsync(Ct),
            await db.OutboundOperations.CountAsync(Ct), await db.AuditEntries.CountAsync(Ct), await db.OutboxMessages.CountAsync(Ct));
    }

    [Fact]
    public async Task Administrators_get_every_configured_integration_and_job_without_a_provider_call_a_write_or_a_secret()
    {
        await using var host = await Host(); using var admin = Client(host); var before = await Writes(host.Services);
        var providerCalls = new[] { factory.Atera.LogEntries.Count, factory.PowerOffice.LogEntries.Count, factory.Graph.LogEntries.Count,
            factory.PartnerCenter.LogEntries.Count, factory.Brreg.LogEntries.Count };

        var response = await admin.GetAsync(Endpoint, Ct);

        response.StatusCode.ShouldBe(HttpStatusCode.OK); response.Headers.CacheControl!.NoStore.ShouldBeTrue();
        var view = (await response.Content.ReadFromJsonAsync<ConnectionStatusView>(Ct))!;
        view.Status.ShouldBeOneOf("Ready", "Gaps");
        view.Integrations.Select(i => i.System).ShouldBe(["atera", "huntress", "poweroffice", "cloudally", "partnercenter", "microsoft-graph", "brreg"]);
        var integrations = view.Integrations.ToDictionary(i => i.System);
        var atera = integrations["atera"];
        (atera.Enabled, atera.WriteEnabled).ShouldBe((true, (bool?)false));
        atera.State!.Jobs.Select(j => j.Job).ShouldBe(
            ["atera-customers", "atera-contacts", "atera-tickets", "atera-tickets-recent", "atera-work-hours", "atera-agents", "atera-patches", "atera-alerts",
                "atera-ticket-conversations"]);
        // M41: Huntress is switched off in this host; its jobs are named all the same, switched off.
        var huntress = integrations["huntress"];
        (huntress.Enabled, huntress.WriteEnabled).ShouldBe((false, (bool?)false));
        huntress.State!.Jobs.Select(j => j.Job).ShouldBe(["huntress-organizations", "huntress-agents", "huntress-alerts", "huntress-reports", "huntress-report-files"]);
        huntress.State.Jobs.ShouldAllBe(job => job.Freshness == "Disabled");
        integrations["poweroffice"].WriteEnabled.ShouldBe(true);
        // M42: CloudAlly is listed with its three reads, switched off in this installation.
        var cloudAlly = integrations["cloudally"];
        (cloudAlly.Enabled, cloudAlly.WriteEnabled).ShouldBe((false, (bool?)false));
        cloudAlly.State!.Jobs.Select(j => (j.Job, j.Freshness)).ShouldBe([("cloudally-accounts", "Disabled"), ("cloudally-backups", "Disabled"), ("cloudally-bills", "Disabled")]);
        integrations["partnercenter"].State!.Jobs.Select(j => j.Job).ShouldBe(["partnercenter-customers", "partnercenter-subscriptions", "partnercenter-licenses"]);
        integrations["microsoft-graph"].State!.Jobs.Select(j => j.Job).ShouldBe(["entra-user-sync", "entra-role-sync"]);
        integrations["brreg"].WriteEnabled.ShouldBeNull();
        // Each job is late after its own schedule (or its specification limit), none after the general day: alerts read twice an
        // hour are late after an hour, not up to date for a day.
        view.Integrations.SelectMany(i => i.State!.Jobs).ToDictionary(j => j.Job, j => j.ThresholdMinutes).ShouldBe(new Dictionary<string, int>
        {
            ["atera-customers"] = 60, ["atera-contacts"] = 105, ["atera-tickets"] = 15, ["atera-tickets-recent"] = 15, ["atera-work-hours"] = 60,
            ["atera-agents"] = 2175, ["atera-patches"] = 2175, ["atera-alerts"] = 60, ["atera-ticket-conversations"] = 22,
            ["huntress-organizations"] = 105, ["huntress-agents"] = 105, ["huntress-alerts"] = 22, ["huntress-reports"] = 2175, ["huntress-report-files"] = 2175,
            ["poweroffice-customers"] = 37, ["poweroffice-contact-persons"] = 60, ["poweroffice-products"] = 2175, ["poweroffice-invoices"] = 90,
            ["cloudally-accounts"] = 105, ["cloudally-backups"] = 195, ["cloudally-bills"] = 2175,
            ["partnercenter-customers"] = 2175, ["partnercenter-subscriptions"] = 375, ["partnercenter-licenses"] = 2175,
            ["entra-user-sync"] = 105, ["entra-role-sync"] = 18, ["brreg-registry-check"] = 2175,
        }, ignoreOrder: true);
        view.Worker!.Components.Select(c => c.Component).ShouldBe(["outbox", "jobs", "actions", "early-reads"]);
        // M44: Atera and Huntress have webhooks, switched off in this installation; the others have none.
        integrations["atera"].Webhook!.Enabled.ShouldBeFalse();
        integrations["huntress"].Webhook!.Enabled.ShouldBeFalse();
        view.Integrations.Where(i => i.System is not ("atera" or "huntress")).ShouldAllBe(i => i.Webhook == null);
        (await Writes(host.Services)).ShouldBe(before);
        new[] { factory.Atera.LogEntries.Count, factory.PowerOffice.LogEntries.Count, factory.Graph.LogEntries.Count,
            factory.PartnerCenter.LogEntries.Count, factory.Brreg.LogEntries.Count }.ShouldBe(providerCalls);
        var body = await response.Content.ReadAsStringAsync(Ct);
        foreach (var secret in new[] { "test-atera-key", "test-secret", "test-refresh-token", "test-client-key", "http:", "https:", "ApiKey", "Certificate", "whsec_" })
            body.ShouldNotContain(secret);
    }

    [Fact]
    public async Task Other_roles_are_refused_and_a_signed_out_request_is_unauthorized()
    {
        await using var host = await Host();
        foreach (var role in new[] { CrmRoles.Technician, CrmRoles.ServiceLead, CrmRoles.ReadOnly, CrmRoles.Management, CrmRoles.Finance, CrmRoles.Sales })
        {
            // The user key becomes the object id (64 characters at most).
            using var other = Client(host, role, $"conn-{role["Crm.".Length..]}-{run}");
            (await other.GetAsync(Endpoint, Ct)).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        }

        using var anonymous = host.CreateClient(); (await anonymous.GetAsync(Endpoint, Ct)).StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task A_switched_off_integration_shows_its_jobs_switched_off_and_leaves_no_gap()
    {
        await using var host = await Host(builder => builder.UseSetting("Integrations:Atera:Enabled", "false"));
        var view = (await Client(host).GetFromJsonAsync<ConnectionStatusView>(Endpoint, Ct))!;
        var atera = view.Integrations.Single(i => i.System == "atera");
        atera.Enabled.ShouldBeFalse();
        atera.State!.Jobs.ShouldAllBe(job => job.Freshness == "Disabled");
        view.Gaps.ShouldNotContain(gap => gap.System == "atera");
    }

    [Fact]
    public async Task What_a_webhook_did_is_read_from_its_saved_state_and_a_refusal_keeps_the_page_green()
    {
        var now = DateTimeOffset.UtcNow;
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
            db.SyncSuccesses.Add(new SyncSuccess { System = Read, Job = "fresh", SucceededAt = now.AddMinutes(-5) });
            db.WebhookStates.Add(new Crm.Integrations.Core.Webhooks.WebhookState
            {
                System = Read, LastReceivedAt = now.AddMinutes(-4), LastEventType = "ticket", Received = 9, LastRefusedAt = now.AddMinutes(-1),
                LastRefusal = "BadSignature",
            });
            db.EarlyReadRequests.AddRange(
                new Crm.Integrations.Core.Webhooks.EarlyReadRequest { System = Read, Job = "fresh", RequestedAt = now.AddMinutes(-4), TriggeredAt = now.AddMinutes(-3) },
                new Crm.Integrations.Core.Webhooks.EarlyReadRequest { System = Read, Job = "other", RequestedAt = now.AddMinutes(-9), TriggeredAt = now.AddMinutes(-8) });
            foreach (var component in new[] { "outbox", "jobs", "actions", "early-reads" })
            {
                db.WorkerHeartbeats.Add(new WorkerHeartbeat { Component = component, Instance = Instance, BeatAt = now });
            }

            await db.SaveChangesAsync(Ct);
        }

        var catalog = new TestCatalog([new(Read, true, null, ["fresh"], WebhookEnabled: true), new(Off, false, null, ["off"])]);
        await using var host = await Host(builder => builder.ConfigureTestServices(services => services.Replace(ServiceDescriptor.Singleton<IConnectionCatalog>(catalog))));
        var view = (await Client(host).GetFromJsonAsync<ConnectionStatusView>(Endpoint, Ct))!;

        view.Status.ShouldBe("Ready");
        var webhook = view.Integrations.Single(i => i.System == Read).Webhook!;
        (webhook.Enabled, webhook.LastEventType, webhook.Received, webhook.LastRefusal).ShouldBe((true, "ticket", 9L, "BadSignature"));
        webhook.LastReceivedAt!.Value.ShouldBe(now.AddMinutes(-4), TimeSpan.FromSeconds(1));
        webhook.LastRefusedAt!.Value.ShouldBe(now.AddMinutes(-1), TimeSpan.FromSeconds(1));
        // The latest read a webhook started, of any of the system's jobs.
        webhook.LastEarlyReadAt!.Value.ShouldBe(now.AddMinutes(-3), TimeSpan.FromSeconds(1));
        view.Integrations.Single(i => i.System == Off).Webhook.ShouldBeNull();
    }

    [Fact]
    public async Task The_saved_runs_pauses_queue_and_heartbeats_decide_the_gaps()
    {
        var now = DateTimeOffset.UtcNow;
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
            db.SyncSuccesses.AddRange(
                new SyncSuccess { System = Read, Job = "fresh", SucceededAt = now.AddMinutes(-5) },
                new SyncSuccess { System = Read, Job = "stale", SucceededAt = now.AddDays(-3) },
                new SyncSuccess { System = Read, Job = "failed", SucceededAt = now.AddMinutes(-20) },
                new SyncSuccess { System = Read, Job = "recovered", SucceededAt = now.AddMinutes(-2) },
                new SyncSuccess { System = Held, Job = "held", SucceededAt = now.AddDays(-3) });
            db.SyncRuns.AddRange(
                Run(Read, "failed", now.AddMinutes(-4), SyncRunStatus.Failed),
                Run(Read, "recovered", now.AddMinutes(-30), SyncRunStatus.Failed),
                Run(Read, "recovered", now.AddMinutes(-3), SyncRunStatus.Succeeded));
            db.IntegrationSwitches.Add(new IntegrationSwitch { System = Held, IsPaused = true, Reason = "synthetic incident", PausedAt = now, PausedBy = "test" });
            var outbound = new OutboundOperation { Id = Guid.NewGuid(), System = Read, Operation = "synthetic-operation", EntityType = "Organization",
                EntityId = Guid.NewGuid(), IdempotencyKey = Guid.NewGuid().ToString("N"), CreatedAt = now, NextAttemptAt = now, Status = OutboundStatus.Failed };
            db.OutboundOperations.Add(outbound); ownedOutbound.Add(outbound.Id);
            db.WorkerHeartbeats.AddRange(
                new WorkerHeartbeat { Component = "outbox", Instance = Instance, BeatAt = now },
                new WorkerHeartbeat { Component = "jobs", Instance = Instance, BeatAt = now },
                new WorkerHeartbeat { Component = "actions", Instance = Instance, BeatAt = now },
                new WorkerHeartbeat { Component = "early-reads", Instance = Instance, BeatAt = now });
            await db.SaveChangesAsync(Ct);
        }

        var catalog = new TestCatalog([
            new(Read, true, true, ["fresh", "stale", "never", "failed", "recovered"]),
            new(Held, true, null, ["held"]),
            new(Off, false, null, ["off"]),
        ]);
        await using var host = await Host(builder => builder.ConfigureTestServices(services => services.Replace(ServiceDescriptor.Singleton<IConnectionCatalog>(catalog))));
        var view = (await Client(host).GetFromJsonAsync<ConnectionStatusView>(Endpoint, Ct))!;

        view.Status.ShouldBe("Gaps");
        view.Gaps.ShouldBe(
        [
            new ConnectionGap("Stale", Read, "stale"), new ConnectionGap("Never", Read, "never"), new ConnectionGap("Failed", Read, "failed"),
            new ConnectionGap("OutboundFailed", Read, Count: 1), new ConnectionGap("Paused", Held),
        ]);
        var read = view.Integrations.Single(i => i.System == Read).State!;
        read.FailedOutbound.ShouldBe(1);
        read.Jobs.Select(j => (j.Job, j.Freshness)).ShouldBe([("fresh", "Fresh"), ("stale", "Stale"), ("never", "Never"), ("failed", "Fresh"), ("recovered", "Fresh")]);
        read.Jobs.Single(j => j.Job == "failed").LastFailedAt.ShouldNotBeNull();
        read.Jobs.Single(j => j.Job == "recovered").LastFailedAt.ShouldNotBeNull();
        read.Jobs.Single(j => j.Job == "fresh").AgeMinutes!.Value.ShouldBeInRange(4, 6);
        view.Integrations.Single(i => i.System == Held).State!.Paused.ShouldBeTrue();
        view.Integrations.Single(i => i.System == Off).State!.Jobs.Single().Freshness.ShouldBe("Disabled");
        // The newest beat of each part decides, whatever older instances left behind.
        view.Worker!.Components.ShouldAllBe(c => c.State == "Current");
    }

    private static SyncRun Run(string system, string job, DateTimeOffset at, SyncRunStatus status) =>
        new() { Id = Guid.NewGuid(), System = system, Job = job, StartedAt = at, FinishedAt = at.AddSeconds(5), Status = status, Message = "synthetic" };

    private sealed class TestCatalog(IReadOnlyList<ConnectionDefinition> connections) : IConnectionCatalog
    {
        public IReadOnlyList<ConnectionDefinition> Read() => connections;
    }
}
