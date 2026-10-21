using System.Net;
using System.Net.Http.Json;
using System.Data.Common;
using System.Text.Json;
using Crm.Authorization;
using Crm.Integrations.Core.Parasol;
using Crm.Integrations.Core.Persistence;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;

namespace Crm.IntegrationTests;

/// <summary>
/// The view counts all stored provider evidence, and the tests compare table totals and provider calls before and after a
/// read, so the class runs alone (it also stages concurrent changes as the administrator) and every test starts without the
/// rows those counts read.
/// </summary>
[Collection(DatabaseAdministrationCollection.Name)]
public sealed class LocalReadinessApiTests(CrmWebFactory factory) : IAsyncLifetime
{
    private const string Endpoint = "/api/v1/parasol/local-readiness";
    private readonly string userKey = "readiness-" + Guid.NewGuid().ToString("N");
    private readonly List<Guid> ownedRecords = []; private readonly List<Guid> ownedOutbound = [];
    private readonly List<(string System, string Job)> ownedSuccesses = [];
    private HttpClient Admin => factory.ClientAs(CrmRoles.Admin, userKey);
    public async ValueTask InitializeAsync()
    {
        // Rows other classes left behind. The collation ignores case, so this also takes differently-cased rows: the view skips
        // them, but they would still collide with the sync-success keys used here.
        await using var scope = factory.Services.CreateAsyncScope(); var db = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
        await db.ExternalRecords.Where(row => row.System == "atera").ExecuteDeleteAsync();
        await db.OutboundOperations.Where(row => row.System == "atera").ExecuteDeleteAsync();
        await db.SyncSuccesses.Where(row => row.System == "atera" || row.System == "poweroffice" || row.System == "microsoft-graph").ExecuteDeleteAsync();
    }
    public async ValueTask DisposeAsync()
    {
        await using var scope = factory.Services.CreateAsyncScope(); var db = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
        await db.ExternalRecords.Where(row => ownedRecords.Contains(row.Id)).ExecuteDeleteAsync();
        await db.OutboundOperations.Where(row => ownedOutbound.Contains(row.Id)).ExecuteDeleteAsync();
        foreach (var (system, job) in ownedSuccesses)
            await db.SyncSuccesses.Where(row => row.System == system && row.Job == job).ExecuteDeleteAsync();
    }
    private async Task<WebApplicationFactory<Program>> Host(Action<IWebHostBuilder>? configure = null)
    {
        // Provision the signed-in administrator first: a first sign-in writes audit rows the read-only checks must not count.
        _ = await Admin.GetFromJsonAsync<JsonElement>("/bff/user");
        return factory.WithWebHostBuilder(builder => configure?.Invoke(builder));
    }
    private HttpClient Client(WebApplicationFactory<Program> host, string role = CrmRoles.Admin, string? key = null)
    {
        var client = host.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false });
        client.DefaultRequestHeaders.Add(TestAuthHandler.RolesHeader, role); client.DefaultRequestHeaders.Add(TestAuthHandler.UserHeader, key ?? userKey);
        client.DefaultRequestHeaders.Add("X-CSRF", "1"); return client;
    }
    private static async Task<(int Records, int Links, int Outbound, int Audit, int Outbox)> Writes(IServiceProvider services)
    {
        await using var scope = services.CreateAsyncScope(); var db = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
        return (await db.ExternalRecords.CountAsync(), await db.ExternalLinks.CountAsync(), await db.OutboundOperations.CountAsync(),
            await db.AuditEntries.CountAsync(), await db.OutboxMessages.CountAsync());
    }

    [Fact]
    public async Task Admins_receive_flags_and_history_and_other_roles_are_denied_without_HTTP()
    {
        await using var host = await Host(); using var admin = Client(host); var before = await Writes(host.Services);
        var providerCalls = new[] { factory.Atera.LogEntries.Count, factory.PowerOffice.LogEntries.Count, factory.Graph.LogEntries.Count, factory.PartnerCenter.LogEntries.Count };
        var response = await admin.GetAsync(Endpoint); response.StatusCode.ShouldBe(HttpStatusCode.OK); response.Headers.CacheControl!.NoStore.ShouldBeTrue();
        var view = (await response.Content.ReadFromJsonAsync<LocalReadinessView>())!;
        view.Admin.ShouldNotBeNull(); view.Admin.AuthMode.ShouldBe("ENTRA"); view.Connectivity.ShouldBe("NOT_CHECKED");
        view.Admin.Atera.Enabled.ShouldBeTrue(); view.Admin.PowerOffice.WriteEnabled.ShouldBeTrue(); view.Admin.MicrosoftGraph.SharePointEnabled.ShouldBeTrue();
        (await Writes(host.Services)).ShouldBe(before);
        (await admin.GetAsync(Endpoint)).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await Writes(host.Services)).ShouldBe(before); // Isolate endpoint reads from legitimate first-sign-in user provisioning.
        foreach (var role in new[] { CrmRoles.Technician, CrmRoles.ServiceLead, CrmRoles.ReadOnly, CrmRoles.Management, CrmRoles.Finance, CrmRoles.Sales })
        {
            using var other = Client(host, role, $"readiness-{role}-" + userKey); (await other.GetAsync(Endpoint)).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        }
        using var anonymous = host.CreateClient(); (await anonymous.GetAsync(Endpoint)).StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
        new[] { factory.Atera.LogEntries.Count, factory.PowerOffice.LogEntries.Count, factory.Graph.LogEntries.Count, factory.PartnerCenter.LogEntries.Count }.ShouldBe(providerCalls);
        var body = await response.Content.ReadAsStringAsync();
        foreach (var forbidden in new[] { "synthetic-private", "http:", "https:", "workspaceId", "clientId", "token", "ApiKey", "Certificate", "PauseReason" }) body.ShouldNotContain(forbidden);
    }

    [Fact]
    public async Task Historical_sync_evidence_excludes_connection_tests_unknown_jobs_and_differently_cased_provider_rows()
    {
        var at = DateTimeOffset.Parse("2026-10-15T10:00:00Z");
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
            foreach (var (system, job, time) in new[] { ("atera", "atera-customers", at), ("atera", "connection-test", at.AddDays(1)),
                ("poweroffice", "unknown-private-job", at.AddDays(1)), ("microsoft-graph", "entra-user-sync", at),
                ("microsoft-graph", "entra-role-sync", at.AddHours(1)), ("ATERA", "atera-agents", at.AddDays(2)) })
            { db.SyncSuccesses.Add(new() { System = system, Job = job, SucceededAt = time }); ownedSuccesses.Add((system, job)); }
            var record = new ExternalRecord { Id = Guid.NewGuid(), System = "ATERA", ExternalType = "Customer", ExternalId = Guid.NewGuid().ToString("N"),
                DisplayName = "synthetic-private", Hash = "fixture", Payload = "{}", FirstSeenAt = at, LastSeenAt = at };
            db.ExternalRecords.Add(record); ownedRecords.Add(record.Id);
            var outbound = new OutboundOperation { Id = Guid.NewGuid(), System = "ATERA", Operation = "private-operation", EntityType = "Organization", EntityId = Guid.NewGuid(),
                IdempotencyKey = Guid.NewGuid().ToString("N"), CreatedAt = at, NextAttemptAt = at, Status = OutboundStatus.Pending };
            db.OutboundOperations.Add(outbound); ownedOutbound.Add(outbound.Id); await db.SaveChangesAsync();
        }
        await using var host = await Host(builder =>
        {
            builder.UseSetting("Integrations:MicrosoftGraph:Enabled", "false"); builder.UseSetting("Integrations:Atera:Enabled", "false");
        });
        var view = (await Client(host).GetFromJsonAsync<LocalReadinessView>(Endpoint))!;
        view.Admin!.Atera.Enabled.ShouldBeFalse(); view.Admin.Atera.Stored!.LastSucceededAt.ShouldBe(at); view.Admin.Atera.Stored.Records.ShouldBe(0); view.Admin.Atera.Stored.PendingOutbound.ShouldBe(0);
        view.Admin.PowerOffice.Stored!.LastSucceededAt.ShouldBeNull(); view.Admin.MicrosoftGraph.Enabled.ShouldBeFalse();
        view.Admin.MicrosoftGraph.Stored.ShouldBe(new(at, at.AddHours(1))); view.Admin.MicrosoftGraph.TeamsEnabled.ShouldBeTrue();
    }

    [Fact]
    public async Task A_sync_insert_after_the_inventory_scan_cannot_make_unlinked_exceed_total_records()
    {
        var recordId = Guid.NewGuid(); ownedRecords.Add(recordId);
        var probe = new AfterInventoryRead(async () =>
        {
            await using var scope = factory.Services.CreateAsyncScope(); var db = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
            db.ExternalRecords.Add(new() { Id = recordId, System = "atera", ExternalType = "Customer", ExternalId = Guid.NewGuid().ToString("N"),
                DisplayName = "synthetic concurrent inventory", Payload = "{}", Hash = "fixture", FirstSeenAt = DateTimeOffset.UtcNow, LastSeenAt = DateTimeOffset.UtcNow });
            await db.SaveChangesAsync();
        });
        await using var host = await Host(builder => builder.ConfigureTestServices(services =>
            services.AddDbContext<IntegrationDbContext>(options => options.AddInterceptors(probe))));
        using var client = Client(host); var first = (await client.GetFromJsonAsync<LocalReadinessView>(Endpoint))!.Admin!.Atera.Stored!;
        probe.InventoryReads.ShouldBe(1); probe.OneInventoryScan.ShouldBeTrue();
        first.Records.ShouldBe(0); first.UnlinkedRecords.ShouldBe(0);
        var current = (await client.GetFromJsonAsync<LocalReadinessView>(Endpoint))!.Admin!.Atera.Stored!;
        probe.InventoryReads.ShouldBe(2); current.Records.ShouldBe(1); current.UnlinkedRecords.ShouldBe(1);
    }

    private sealed class AfterInventoryRead(Func<Task> insert) : DbCommandInterceptor
    {
        private int inserted;
        internal int InventoryReads;
        internal bool OneInventoryScan = true;
        public override async ValueTask<DbDataReader> ReaderExecutedAsync(DbCommand command, CommandExecutedEventData eventData,
            DbDataReader result, CancellationToken cancellationToken = default)
        {
            const string inventory = "[integration].[ExternalRecords]";
            if (command.CommandText.Contains(inventory, StringComparison.Ordinal)
                && command.Parameters.Cast<DbParameter>().Any(parameter => Equals(parameter.Value, "atera")))
            {
                InventoryReads++;
                OneInventoryScan &= command.CommandText.Split(inventory, StringSplitOptions.None).Length == 2
                    && command.CommandText.Contains("GROUP BY", StringComparison.Ordinal);
                if (Interlocked.Exchange(ref inserted, 1) == 0) await insert();
            }
            return result;
        }
    }
}
