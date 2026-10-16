using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crm.Authorization;
using Crm.Infrastructure.Persistence;
using Crm.Integrations.Core;
using Crm.Integrations.Core.Persistence;
using Crm.SharedKernel.Domain;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Operations;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using static Crm.IntegrationTests.IntegrationTestHelpers;

namespace Crm.IntegrationTests;

public sealed class MonitoringApiTests(CrmWebFactory factory)
{
    private const string Url = "/api/v1/integrations/monitoring";
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task AC02_failed_partial_skipped_and_connection_tests_do_not_advance_freshness_but_quiet_success_does()
    {
        var system = $"monitor-{Guid.NewGuid():N}";
        var time = new ManualTimeProvider(DateTimeOffset.UtcNow.AddDays(-2));
        await using var scope = factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
        var runner = new SyncRunner(db, time, NullLogger<SyncRunner>.Instance);
        var reader = new IntegrationMonitoringReader(db, [], new ConfigurationBuilder().AddInMemoryCollection(
            new Dictionary<string, string?> { ["Monitoring:FreshnessMinutes"] = "15" }).Build(), time);
        await runner.RunAsync(system, "tickets", (_, _) => Task.CompletedTask, Ct, TimeSpan.FromHours(1));
        var succeeded = time.GetUtcNow();
        time.Advance(TimeSpan.FromMinutes(20));
        await Should.ThrowAsync<SyncFailedException>(() => runner.RunAsync(system, "tickets", (_, _) =>
            throw new InvalidOperationException("Private amount 947321.87 NOK"), Ct));
        var stale = (await reader.ReadAsync(Ct)).Systems.Single(s => s.System == system);
        stale.LastSucceededAt.ShouldBe(succeeded);
        stale.Freshness.ShouldBe("Stale");
        await runner.RunAsync(system, "tickets", (p, _) => { p.Failed = 1; return Task.CompletedTask; }, Ct);
        await runner.RunAsync(system, "connection-test", (_, _) => Task.CompletedTask, Ct);
        (await reader.ReadAsync(Ct)).Systems.Count(s => s.System == system).ShouldBe(1);
        // Starting or skipping another attempt must not declare the previous failure recovered.
        time.Advance(TimeSpan.FromSeconds(1));
        var running = new SyncRun { Id = SequentialId.New(), System = system, Job = "tickets", StartedAt = time.GetUtcNow(), Status = SyncRunStatus.Running };
        db.SyncRuns.Add(running);
        await db.SaveChangesAsync(Ct);
        (await reader.ReadAsync(Ct)).Exceptions.ShouldContain(e => e.Source == system && e.Kind == "SyncFailed");
        running.Status = SyncRunStatus.Skipped;
        await db.SaveChangesAsync(Ct);
        (await reader.ReadAsync(Ct)).Exceptions.ShouldContain(e => e.Source == system && e.Kind == "SyncFailed");
        db.IntegrationSwitches.Add(new IntegrationSwitch { System = system, IsPaused = true });
        await db.SaveChangesAsync(Ct);
        await runner.RunAsync(system, "tickets", (_, _) => throw new InvalidOperationException("must be skipped"), Ct);
        var paused = (await reader.ReadAsync(Ct)).Systems.Single(s => s.System == system);
        paused.LastSucceededAt.ShouldBe(succeeded);
        paused.Freshness.ShouldBe("Paused");
        await db.IntegrationSwitches.Where(s => s.System == system).ExecuteDeleteAsync(Ct);
        // Quiet success may be omitted from the run log, but its checkpoint must still advance.
        await runner.RunAsync(system, "tickets", (_, _) => Task.CompletedTask, Ct, TimeSpan.FromHours(1));
        await db.SyncRuns.Where(r => r.System == system).ExecuteDeleteAsync(Ct);
        var fresh = (await reader.ReadAsync(Ct)).Systems.Single(s => s.System == system);
        fresh.Freshness.ShouldBe("Fresh");
        fresh.LastSucceededAt.ShouldBe(time.GetUtcNow());
        (await reader.ReadAsync(Ct)).Exceptions.ShouldNotContain(e => e.Source == system);
    }

    [Fact]
    public async Task AC01_signal_has_runbook_optimistic_triage_and_audit_and_disappears_when_recovered()
    {
        var system = $"triage-{Guid.NewGuid():N}";
        var key = $"sync-stale:{system}:tickets";
        await SeedFailureAsync(system);
        var admin = factory.ClientAs(CrmRoles.Admin, $"triage-{Guid.NewGuid():N}");
        var who = await admin.GetFromJsonAsync<JsonElement>("/bff/user", Ct);
        var owner = who.GetProperty("id").GetGuid();
        var snapshot = await admin.GetFromJsonAsync<IntegrationMonitoringSnapshot>(Url, Ct);
        var signal = snapshot!.Exceptions.Single(e => e.Key == key);
        signal.Runbook.ShouldBe("docs/runbooks/15-monitoring.md");
        signal.Triage.Etag.ShouldBe("\"new\"");
        var body = new { key, ownerId = owner, status = "InProgress", comment = "Investigating the synthetic fault" };
        (await admin.PutAsJsonAsync(Url + "/triage", body, Ct)).StatusCode.ShouldBe((HttpStatusCode)428);
        var saved = await admin.PutWithETagAsync(Url + "/triage", body, signal.Triage.Etag);
        saved.StatusCode.ShouldBe(HttpStatusCode.OK);
        saved.Headers.ETag!.Tag.ShouldNotBe(signal.Triage.Etag);
        (await admin.PutWithETagAsync(Url + "/triage", body, signal.Triage.Etag)).StatusCode.ShouldBe(HttpStatusCode.PreconditionFailed);
        var tracked = await admin.GetFromJsonAsync<ExceptionTriageItem>(Url + "/triage?key=" + Uri.EscapeDataString(key), Ct);
        tracked!.OwnerId.ShouldBe(owner);
        tracked.Comment.ShouldBe(body.comment);
        var premature = await admin.PutWithETagAsync(Url + "/triage", body with { status = "Resolved" }, tracked.Etag);
        premature.StatusCode.ShouldBe(HttpStatusCode.BadRequest);
        await using var scope = factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
        var triageId = await db.ExceptionTriages.Where(t => t.Key == key).Select(t => t.Id).SingleAsync(Ct);
        (await db.AuditEntries.CountAsync(a => a.EntityId == triageId && a.EntityType == nameof(ExceptionTriage), Ct)).ShouldBe(1);
        await scope.ServiceProvider.GetRequiredService<SyncRunner>().RunAsync(system, "tickets", (_, _) => Task.CompletedTask, Ct);
        snapshot = await admin.GetFromJsonAsync<IntegrationMonitoringSnapshot>(Url, Ct);
        var recovered = snapshot!.Exceptions.Single(e => e.Key == key);
        recovered.Active.ShouldBeFalse();
        recovered.Triage.Comment.ShouldBe(body.comment);
        var resolved = await admin.PutWithETagAsync(Url + "/triage", body with { status = "Resolved", comment = "Confirmed recovery; closing the review" }, recovered.Triage.Etag);
        resolved.StatusCode.ShouldBe(HttpStatusCode.OK);
        (await admin.GetFromJsonAsync<IntegrationMonitoringSnapshot>(Url, Ct))!.Exceptions.ShouldNotContain(e => e.Key == key);
        // A recurrence cannot inherit the old closed status and disappear from an Open/InProgress view.
        await db.SyncSuccesses.Where(s => s.System == system).ExecuteDeleteAsync(Ct);
        var recurred = (await admin.GetFromJsonAsync<IntegrationMonitoringSnapshot>(Url, Ct))!.Exceptions.Single(e => e.Key == key);
        recurred.Active.ShouldBeTrue();
        recurred.Triage.Status.ShouldBe("Open");
    }

    [Fact]
    public async Task AC03_unauthorized_roles_cannot_read_diagnostics_and_legacy_messages_are_sanitized()
    {
        var system = $"private-{Guid.NewGuid():N}";
        await SeedFailureAsync(system, "947321.87 NOK private person");
        var admin = factory.ClientAs(CrmRoles.Admin);
        foreach (var path in new[] { Url, "/api/v1/integrations/runs?system=" + system, "/api/v1/integrations/outbound?system=" + system })
        {
            var text = await admin.GetStringAsync(path, Ct);
            text.ShouldNotContain("947321.87");
            text.ShouldNotContain("private person");
            (await factory.ClientAs(CrmRoles.Technician).GetAsync(path, Ct)).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        }
        var noCsrf = factory.ClientAs(CrmRoles.Admin, csrf: false);
        (await noCsrf.PostAsJsonAsync(Url + "/outbound/retry", new { ids = new[] { Guid.NewGuid() }, expected = 1, reason = "synthetic retry" }, Ct))
            .StatusCode.ShouldBe(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task AC03_financial_case_notes_are_filtered_server_side_even_for_an_operator_without_finance_permission()
    {
        var key = "billing:synthetic-" + Guid.NewGuid().ToString("N");
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
            db.ExceptionTriages.Add(new ExceptionTriage { Id = SequentialId.New(), Key = key, Category = "Financial", Source = "billing", Kind = "Unbilled",
                RequiredPermission = Permissions.FinanceRead, Comment = "947321.87 NOK private financial note", UpdatedAt = DateTimeOffset.UtcNow });
            await db.SaveChangesAsync(Ct);
        }
        await using var host = factory.WithWebHostBuilder(builder => builder.ConfigureTestServices(services =>
        {
            services.AddScoped<ICurrentUser, RestrictedOperator>();
            services.AddSingleton<IOperationalSignalSource>(new SyntheticFinancialSignal(key));
        }));
        var client = host.CreateClient();
        client.DefaultRequestHeaders.Add(TestAuthHandler.RolesHeader, CrmRoles.Admin);
        client.DefaultRequestHeaders.Add(TestAuthHandler.UserHeader, "restricted-monitor");
        var response = await client.GetAsync(Url, Ct);
        response.StatusCode.ShouldBe(HttpStatusCode.OK);
        var body = await response.Content.ReadAsStringAsync(Ct);
        body.ShouldNotContain(key);
        body.ShouldNotContain("947321.87");
        (await client.GetAsync(Url + "/triage?key=" + Uri.EscapeDataString(key), Ct)).StatusCode.ShouldBe(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task AC04_outbound_bulk_checks_every_item_and_only_one_simultaneous_click_is_applied()
    {
        var id = SequentialId.New();
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
            db.OutboundOperations.Add(new OutboundOperation { Id = id, IdempotencyKey = id.ToString(), System = "monitor-probe", Operation = "synthetic",
                EntityType = "Organization", EntityId = Guid.NewGuid(), CreatedAt = DateTimeOffset.UtcNow, Status = OutboundStatus.DeadLetter });
            await db.SaveChangesAsync(Ct);
        }
        var admin = factory.ClientAs(CrmRoles.Admin);
        var original = await OutboundAsync(admin, id);
        var etag = original.GetProperty("etag").GetString()!;
        var stale = await admin.PostAsJsonAsync(Url + "/outbound/retry", new
        {
            messages = new[] { new { id, etag }, new { id = Guid.NewGuid(), etag } }, expected = 2, reason = "Resolved synthetic outage",
        }, Ct);
        stale.StatusCode.ShouldBe(HttpStatusCode.Conflict);
        var rejected = await stale.Content.ReadFromJsonAsync<JsonElement>(Ct);
        rejected.GetProperty("items").GetArrayLength().ShouldBe(2);
        var request = new { messages = new[] { new { id, etag } }, expected = 1, reason = "Resolved synthetic outage" };
        var responses = await Task.WhenAll(admin.PostAsJsonAsync(Url + "/outbound/retry", request, Ct), admin.PostAsJsonAsync(Url + "/outbound/retry", request, Ct));
        responses.Count(r => r.StatusCode == HttpStatusCode.Accepted).ShouldBe(1);
        responses.Count(r => r.StatusCode == HttpStatusCode.Conflict).ShouldBe(1);
        await using var verify = factory.Services.CreateAsyncScope();
        var check = verify.ServiceProvider.GetRequiredService<IntegrationDbContext>();
        (await check.AuditEntries.CountAsync(a => a.EntityType == nameof(OutboundOperation) && a.EntityId == id && a.Action == AuditActions.Replay, Ct)).ShouldBe(1);
        (await check.OutboundOperations.FindAsync([id], Ct))!.Status.ShouldBe(OutboundStatus.Pending);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task AC03_connection_polling_redacts_legacy_and_new_provider_messages(bool throwError)
    {
        const string secret = "947321.87 NOK private person";
        var system = "connection-" + Guid.NewGuid().ToString("N");
        var failedId = SequentialId.New();
        var succeededId = SequentialId.New();
        var pendingId = SequentialId.New();
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
            foreach (var (id, status) in new[] { (failedId, SyncRunStatus.Failed), (succeededId, SyncRunStatus.Succeeded), (pendingId, SyncRunStatus.Running) })
                db.SyncRuns.Add(new SyncRun { Id = id, System = system, Job = "connection-test", StartedAt = DateTimeOffset.UtcNow,
                    Status = status, Message = secret });
            await db.SaveChangesAsync(Ct);
            var handler = new IntegrationConnectionTestHandler([new UnsafeConnectionAdapter(system, secret, throwError)], db,
                TimeProvider.System, NullLogger<IntegrationConnectionTestHandler>.Instance);
            await handler.HandleAsync(new IntegrationConnectionTestRequested(system, pendingId), Ct);
            (await db.SyncRuns.SingleAsync(r => r.Id == pendingId, Ct)).Message!.ShouldNotContain(secret);
        }
        await using var host = factory.WithWebHostBuilder(builder => builder.ConfigureTestServices(services => services.AddScoped<ICurrentUser, RestrictedOperator>()));
        var admin = host.CreateClient();
        admin.DefaultRequestHeaders.Add(TestAuthHandler.RolesHeader, CrmRoles.Admin);
        admin.DefaultRequestHeaders.Add(TestAuthHandler.UserHeader, "restricted-connection-monitor");
        foreach (var id in new[] { failedId, succeededId, pendingId })
        {
            var response = await admin.GetAsync($"/api/v1/integrations/{system}/test/{id}", Ct);
            response.StatusCode.ShouldBe(HttpStatusCode.OK);
            var payload = await response.Content.ReadAsStringAsync(Ct);
            payload.ShouldNotContain("947321.87");
            payload.ShouldNotContain("private person");
        }
    }

    [Fact]
    public async Task AC04_confirmation_cannot_be_reused_when_a_retried_operation_fails_again()
    {
        var id = SequentialId.New();
        var finished = DateTimeOffset.UtcNow.AddMinutes(-10);
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
            db.OutboundOperations.Add(new OutboundOperation { Id = id, IdempotencyKey = id.ToString(), System = "retry-generation", Operation = "synthetic",
                EntityType = "Organization", EntityId = Guid.NewGuid(), CreatedAt = finished, NextAttemptAt = finished,
                CompletedAt = finished, Attempts = 1, Status = OutboundStatus.Failed });
            await db.SaveChangesAsync(Ct);
        }
        var admin = factory.ClientAs(CrmRoles.Admin);
        var etag = (await OutboundAsync(admin, id)).GetProperty("etag").GetString()!;
        (await admin.PostAsJsonAsync(Url + "/outbound/retry", new { ids = new[] { id }, expected = 1, reason = "Resolved synthetic outage" }, Ct))
            .StatusCode.ShouldBe(HttpStatusCode.BadRequest);
        var body = new { messages = new[] { new { id, etag } }, expected = 1, reason = "Resolved synthetic outage" };
        (await admin.PostAsJsonAsync(Url + "/outbound/retry", body, Ct)).StatusCode.ShouldBe(HttpStatusCode.Accepted);
        // A fast worker returns to the same terminal status and attempt count before the browser repeats its original request.
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
            await db.OutboundOperations.Where(o => o.Id == id).ExecuteUpdateAsync(s => s.SetProperty(o => o.Status, OutboundStatus.Failed)
                .SetProperty(o => o.Attempts, 1).SetProperty(o => o.CompletedAt, (DateTimeOffset?)DateTimeOffset.UtcNow), Ct);
        }
        var again = await admin.PostAsJsonAsync(Url + "/outbound/retry", body, Ct);
        again.StatusCode.ShouldBe(HttpStatusCode.Conflict);
        (await again.Content.ReadFromJsonAsync<JsonElement>(Ct)).GetProperty("items")[0].GetProperty("status").GetString().ShouldBe("Stale");
        var retryPath = $"/api/v1/integrations/outbound/{id}/retry";
        (await admin.PostAsJsonAsync(retryPath, new { reason = "Resolved synthetic outage" }, Ct)).StatusCode.ShouldBe((HttpStatusCode)428);
        using var single = new HttpRequestMessage(HttpMethod.Post, retryPath) { Content = JsonContent.Create(new { reason = "Resolved synthetic outage" }) };
        single.Headers.TryAddWithoutValidation("If-Match", etag);
        (await admin.SendAsync(single, Ct)).StatusCode.ShouldBe(HttpStatusCode.PreconditionFailed);
        var freshEtag = (await OutboundAsync(admin, id)).GetProperty("etag").GetString()!;
        freshEtag.ShouldNotBe(etag);
        (await admin.PostAsJsonAsync(Url + "/outbound/retry", new { messages = new[] { new { id, etag = freshEtag } }, expected = 1,
            reason = "Investigated the second failure" }, Ct)).StatusCode.ShouldBe(HttpStatusCode.Accepted);
        await using var verify = factory.Services.CreateAsyncScope();
        (await verify.ServiceProvider.GetRequiredService<IntegrationDbContext>().AuditEntries.CountAsync(a => a.EntityType == nameof(OutboundOperation) &&
            a.EntityId == id && a.Action == AuditActions.Replay, Ct)).ShouldBe(2);
    }

    private static async Task<JsonElement> OutboundAsync(HttpClient client, Guid id)
    {
        // Test data has a stable unique ID; page until found without assuming a shared database's ordering.
        string? cursor = null;
        do
        {
            var result = await client.GetFromJsonAsync<JsonElement>("/api/v1/integrations/outbound?limit=200" +
                (cursor is null ? "" : "&cursor=" + Uri.EscapeDataString(cursor)), Ct);
            foreach (var item in result.GetProperty("items").EnumerateArray())
                if (item.GetProperty("id").GetGuid() == id) return item;
            cursor = result.GetProperty("nextCursor").GetString();
        } while (cursor is not null);
        throw new InvalidOperationException("The seeded operation is missing.");
    }

    private sealed class UnsafeConnectionAdapter(string system, string message, bool throwError) : IIntegrationAdapter
    {
        public string System => system;
        public bool IsEnabled => true;
        public IReadOnlyList<ExternalTypeDescriptor> RecordTypes => [];
        public string? CreateOrganizationOperation => null;
        public Crm.Customers.Contracts.ExternalOrganizationData? ToOrganizationData(ExternalRecord record) => null;
        public Crm.Customers.Contracts.ExternalContactData? ToContactData(ExternalRecord record) => null;
        public Task<ConnectionTestResult> TestConnectionAsync(CancellationToken cancellationToken) =>
            throwError ? throw new InvalidOperationException(message) : Task.FromResult(new ConnectionTestResult(false, message));
    }

    [Fact]
    public async Task AC06_failed_system_does_not_block_independent_sync_or_CRM_readiness()
    {
        var failedSystem = $"degraded-{Guid.NewGuid():N}";
        await SeedFailureAsync(failedSystem);
        var working = $"healthy-{Guid.NewGuid():N}";
        await using (var scope = factory.Services.CreateAsyncScope())
            await scope.ServiceProvider.GetRequiredService<SyncRunner>().RunAsync(working, "tickets", (_, _) => Task.CompletedTask, Ct);
        var admin = factory.ClientAs(CrmRoles.Admin);
        var state = await admin.GetFromJsonAsync<IntegrationMonitoringSnapshot>(Url, Ct);
        state!.Systems.Single(s => s.System == working).Freshness.ShouldBe("Fresh");
        state.Exceptions.ShouldContain(e => e.Source == failedSystem);
        (await admin.GetAsync("/health/ready", Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await admin.GetAsync("/api/v1/customers/organizations?limit=1", Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
    }

    private async Task SeedFailureAsync(string system, string? message = null)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
        db.SyncRuns.Add(new SyncRun { Id = SequentialId.New(), System = system, Job = "tickets", StartedAt = DateTimeOffset.UtcNow.AddMinutes(-3),
            FinishedAt = DateTimeOffset.UtcNow.AddMinutes(-2), Status = SyncRunStatus.Failed, Message = message });
        await db.SaveChangesAsync(Ct);
    }

    private sealed class RestrictedOperator : ICurrentUser
    {
        public Guid? UserId => null;
        public string DisplayName => "Synthetic operator";
        public bool IsAuthenticated => true;
        public bool HasPermission(string permission) => permission is Permissions.IntegrationsManage or Permissions.UsersRead;
    }

    private sealed class SyntheticFinancialSignal(string key) : IOperationalSignalSource
    {
        public Task<IReadOnlyList<OperationalSignal>> ReadAsync(CancellationToken cancellationToken) => Task.FromResult<IReadOnlyList<OperationalSignal>>(
            [new(key, "Financial", "billing", "Unbilled", null, 1, "ReviewOverdueCharges", "docs/runbooks/15-monitoring.md", Permissions.FinanceRead)]);
    }
}
