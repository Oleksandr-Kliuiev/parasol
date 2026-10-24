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
/// The view counts the whole Atlas registry and all stored provider evidence, and the tests compare table totals and provider
/// calls before and after a read, so the class runs alone (it also stages concurrent changes as the administrator) and every
/// test starts without the rows those counts read.
/// </summary>
[Collection(DatabaseAdministrationCollection.Name)]
public sealed class LocalReadinessApiTests(CrmWebFactory factory) : IAsyncLifetime
{
    private const string Endpoint = "/api/v1/parasol/local-readiness";
    private const string Workspace = "synthetic-readiness-workspace";
    private readonly string userKey = "readiness-" + Guid.NewGuid().ToString("N");
    private readonly List<Guid> ownedLinks = []; private readonly List<Guid> ownedRecords = []; private readonly List<Guid> ownedOutbound = [];
    private readonly List<(string System, string Job)> ownedSuccesses = [];
    private HttpClient Admin => factory.ClientAs(CrmRoles.Admin, userKey);
    public async ValueTask InitializeAsync()
    {
        // Rows other classes left behind. The collation ignores case, so this also takes differently-cased rows: the view skips
        // them, but they would still collide with the sync-success keys used here.
        await using var scope = factory.Services.CreateAsyncScope(); var db = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
        await db.ExternalLinks.Where(row => row.System == CustomerIdentityContract.System && row.ExternalType == CustomerIdentityContract.ExternalType).ExecuteDeleteAsync();
        await db.ExternalRecords.Where(row => (row.System == CustomerIdentityContract.System && row.ExternalType == CustomerIdentityContract.ExternalType)
            || row.System == "atera").ExecuteDeleteAsync();
        await db.OutboundOperations.Where(row => row.System == "atera").ExecuteDeleteAsync();
        await db.SyncSuccesses.Where(row => row.System == "atera" || row.System == "poweroffice" || row.System == "microsoft-graph").ExecuteDeleteAsync();
    }
    public async ValueTask DisposeAsync()
    {
        await using var scope = factory.Services.CreateAsyncScope(); var db = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
        await db.ExternalLinks.Where(row => ownedLinks.Contains(row.Id)).ExecuteDeleteAsync();
        await db.ExternalRecords.Where(row => ownedRecords.Contains(row.Id)).ExecuteDeleteAsync();
        await db.OutboundOperations.Where(row => ownedOutbound.Contains(row.Id)).ExecuteDeleteAsync();
        foreach (var (system, job) in ownedSuccesses)
            await db.SyncSuccesses.Where(row => row.System == system && row.Job == job).ExecuteDeleteAsync();
    }
    private async Task<Guid> Customer()
    {
        var response = await Admin.PostAsJsonAsync("/api/v1/customers/organizations", new { name = "Synthetic private customer " + Guid.NewGuid().ToString("N"), status = "Customer" });
        response.StatusCode.ShouldBe(HttpStatusCode.Created);
        return (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
    }
    private async Task<(Guid Link, Guid Record)> Mapping(Guid customer, string? issue = null)
    {
        await using var scope = factory.Services.CreateAsyncScope(); var db = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
        var client = "synthetic-client-" + Guid.NewGuid().ToString("N"); var key = CustomerIdentityContract.ExternalId(Workspace, client);
        var link = new ExternalLink { Id = Guid.NewGuid(), System = "Atlas", ExternalType = "Client", ExternalId = issue == "uppercase-key" ? key.ToUpperInvariant() : key,
            EntityType = issue == "wrong-entity" ? "Contact" : "Organization", EntityId = customer, Method = LinkMethod.Manual, LinkedAt = DateTimeOffset.UtcNow };
        var record = new ExternalRecord { Id = Guid.NewGuid(), System = "Atlas", ExternalType = "Client", ExternalId = issue is "uppercase-key" or "uppercase-reference" ? key.ToUpperInvariant() : key,
            DisplayName = "synthetic-private-source-name", Hash = "fixture", Payload = JsonSerializer.Serialize(new AtlasCustomerReference(issue == "foreign-tuple" ? "foreign" : Workspace, client), CustomerIdentityContract.JsonOptions),
            FirstSeenAt = DateTimeOffset.UtcNow, LastSeenAt = DateTimeOffset.UtcNow, IsGone = issue == "gone" };
        if (issue == "oversized") record.Payload += new string(' ', 4100) + "synthetic-private-trailing-value";
        if (issue != "unlinked") { db.ExternalLinks.Add(link); ownedLinks.Add(link.Id); }
        if (issue != "missing-reference") { db.ExternalRecords.Add(record); ownedRecords.Add(record.Id); }
        await db.SaveChangesAsync(); return (link.Id, record.Id);
    }
    private async Task<WebApplicationFactory<Program>> Host(Action<IWebHostBuilder>? configure = null, Func<ILocalMappingSource, ILocalMappingSource>? mappingSource = null)
    {
        var employee = (await Admin.GetFromJsonAsync<JsonElement>("/bff/user")).GetProperty("id").GetGuid();
        return factory.WithWebHostBuilder(builder =>
        {
            builder.UseSetting("Parasol:Atlas:Enabled", "true"); builder.UseSetting("Parasol:Atlas:BaseUrl", "http://127.0.0.1:1/");
            builder.UseSetting($"Parasol:Atlas:Employees:{employee}:WorkspaceId", Workspace);
            builder.UseSetting($"Parasol:Atlas:Employees:{employee}:Token", "synthetic-private-personal-token");
            builder.ConfigureTestServices(services =>
            {
                services.AddHttpClient(AtlasWorkspaceRegistration.ClientName).ConfigurePrimaryHttpMessageHandler(() => new RefuseHttp());
                if (mappingSource is not null) services.AddScoped<ILocalMappingSource>(provider => mappingSource(new LocalReadinessMappingSource(
                    provider.GetRequiredService<IntegrationDbContext>(), provider.GetRequiredService<Crm.Customers.Contracts.ICustomersApi>())));
            });
            configure?.Invoke(builder);
        });
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
    public async Task Technical_employees_receive_only_own_presence_admins_receive_flags_and_history_and_other_roles_are_denied_without_HTTP()
    {
        await using var host = await Host(); using var admin = Client(host); var before = await Writes(host.Services);
        var providerCalls = new[] { factory.Atera.LogEntries.Count, factory.PowerOffice.LogEntries.Count, factory.Graph.LogEntries.Count, factory.PartnerCenter.LogEntries.Count };
        var response = await admin.GetAsync(Endpoint); response.StatusCode.ShouldBe(HttpStatusCode.OK); response.Headers.CacheControl!.NoStore.ShouldBeTrue();
        var view = (await response.Content.ReadFromJsonAsync<LocalReadinessView>())!;
        view.PersonalAtlas!.Status.ShouldBe("PERSONAL_ENTRY_PRESENT"); view.Admin.ShouldNotBeNull(); view.Admin.AuthMode.ShouldBe("ENTRA");
        view.Admin.Atera.Enabled.ShouldBeTrue(); view.Admin.PowerOffice.WriteEnabled.ShouldBeTrue(); view.Admin.MicrosoftGraph.SharePointEnabled.ShouldBeTrue();
        (await Writes(host.Services)).ShouldBe(before);
        (await admin.GetAsync(Endpoint)).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await Writes(host.Services)).ShouldBe(before); // Isolate endpoint reads from legitimate first-sign-in user provisioning.
        foreach (var role in new[] { CrmRoles.Technician, CrmRoles.ServiceLead, CrmRoles.ReadOnly })
        {
            using var technician = Client(host, role); var personal = (await technician.GetFromJsonAsync<LocalReadinessView>(Endpoint))!;
            personal.Admin.ShouldBeNull(); personal.PersonalAtlas!.Status.ShouldBe("PERSONAL_ENTRY_PRESENT");
        }
        using var other = Client(host, CrmRoles.Technician, "other-" + userKey);
        (await other.GetFromJsonAsync<LocalReadinessView>(Endpoint))!.PersonalAtlas!.Status.ShouldBe("PERSONAL_ENTRY_MISSING");
        using var finance = Client(host, CrmRoles.Finance); (await finance.GetAsync(Endpoint)).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        using var sales = Client(host, CrmRoles.Sales); (await sales.GetAsync(Endpoint)).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        using var anonymous = host.CreateClient(); (await anonymous.GetAsync(Endpoint)).StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
        new[] { factory.Atera.LogEntries.Count, factory.PowerOffice.LogEntries.Count, factory.Graph.LogEntries.Count, factory.PartnerCenter.LogEntries.Count }.ShouldBe(providerCalls);
        var body = await response.Content.ReadAsStringAsync();
        foreach (var forbidden in new[] { "synthetic-private", "http:", "https:", "workspaceId", "clientId", "token", "ApiKey", "Certificate", "PauseReason" }) body.ShouldNotContain(forbidden);
    }

    [Theory]
    [InlineData("missing-reference", 0, 1, 0, 0, 0)]
    [InlineData("gone", 0, 0, 1, 0, 0)]
    [InlineData("uppercase-key", 1, 0, 0, 0, 0)]
    [InlineData("wrong-entity", 1, 0, 0, 0, 0)]
    [InlineData("uppercase-reference", 0, 0, 0, 1, 0)]
    [InlineData("foreign-tuple", 0, 0, 0, 1, 0)]
    [InlineData("oversized", 0, 0, 0, 1, 0)]
    [InlineData("deleted-customer", 0, 0, 0, 0, 1)]
    [InlineData("missing-customer", 0, 0, 0, 0, 1)]
    public async Task Real_SQL_mapping_issues_are_classified_without_leaking_payloads(string issue, int invalidIdentity, int missing, int gone, int invalid, int unavailable)
    {
        var customer = issue == "missing-customer" ? Guid.NewGuid() : await Customer(); await Mapping(customer, issue);
        if (issue == "deleted-customer") await factory.AdminSqlAsync($"UPDATE customers.Organizations SET IsDeleted=1 WHERE Id='{customer:D}';");
        await using var host = await Host(); var response = await Client(host).GetAsync(Endpoint);
        var view = (await response.Content.ReadFromJsonAsync<LocalReadinessView>())!; var mapping = view.Admin!.AtlasMappings!;
        view.Status.ShouldBe("LOCAL_SNAPSHOT"); mapping.Status.ShouldBe("CHECKED"); mapping.ReviewStatus.ShouldBe("REQUIRED");
        mapping.Coverage.ShouldBe(new(1, 1, 0, 0)); mapping.Counts.ShouldBe(new(0, invalidIdentity, missing, gone, invalid, unavailable));
        (await response.Content.ReadAsStringAsync()).ShouldNotContain("synthetic-private");
    }

    [Fact]
    public async Task Valid_live_links_and_unlinked_local_references_are_distinct_and_no_source_coverage_is_claimed()
    {
        await Mapping(await Customer()); await Mapping(Guid.NewGuid(), "unlinked");
        await using var host = await Host(); var view = (await Client(host).GetFromJsonAsync<LocalReadinessView>(Endpoint))!;
        view.Status.ShouldBe("LOCAL_SNAPSHOT"); view.Admin!.AtlasMappings!.Status.ShouldBe("CHECKED");
        view.Admin.AtlasMappings.ReviewStatus.ShouldBe("REQUIRED"); view.Admin.AtlasMappings.Coverage.ShouldBe(new(1, 1, 0, 1));
        view.Admin.AtlasMappings.Counts.ShouldBe(new(1, 0, 0, 0, 0, 0)); view.Connectivity.ShouldBe("NOT_CHECKED");
    }

    [Fact]
    public async Task More_than_500_stored_links_are_honestly_incomplete_and_global_duplicate_counts_are_not_sample_counts()
    {
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
            for (var index = 0; index < 501; index++)
            {
                var key = CustomerIdentityContract.ExternalId(Workspace, "cap-" + index);
                var link = new ExternalLink { Id = Guid.NewGuid(), System = "Atlas", ExternalType = "Client", ExternalId = key,
                    EntityType = "Organization", EntityId = Guid.NewGuid(), Method = LinkMethod.Manual, LinkedAt = DateTimeOffset.UtcNow };
                ownedLinks.Add(link.Id); db.ExternalLinks.Add(link);
            }
            await db.SaveChangesAsync();
        }
        await using var host = await Host(); var view = (await Client(host).GetFromJsonAsync<LocalReadinessView>(Endpoint))!;
        view.Status.ShouldBe("PARTIAL"); view.Admin!.AtlasMappings!.Status.ShouldBe("INCOMPLETE");
        view.Admin.AtlasMappings.Coverage.ShouldBe(new(501, 500, 1, 0)); view.Admin.AtlasMappings.Counts.ShouldBe(new(0, 0, 500, 0, 0, 0));
        await using var read = host.Services.CreateAsyncScope(); var snapshot = await read.ServiceProvider.GetRequiredService<ILocalMappingSource>().ReadAsync(default);
        snapshot.Links.Count.ShouldBe(500); snapshot.Links.All(link => link.IdentityMatches == 1 && link.CustomerMatches == 1).ShouldBeTrue();
    }

    [Theory]
    [InlineData("link")]
    [InlineData("reference")]
    [InlineData("customer")]
    public async Task A_real_registry_or_live_customer_change_during_the_read_is_fenced_before_counts_are_published(string change)
    {
        var customer = await Customer(); var ids = await Mapping(customer);
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously); var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var host = await Host(mappingSource: inner => new PauseAfterRead(inner, entered, release));
        using var client = Client(host); var pending = client.GetAsync(Endpoint);
        try
        {
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
            if (change == "link") await factory.AdminSqlAsync($"UPDATE integration.ExternalLinks SET LinkedAt=SYSUTCDATETIME(),EntityId='{Guid.NewGuid():D}' WHERE Id='{ids.Link:D}';");
            if (change == "reference") await factory.AdminSqlAsync($"UPDATE integration.ExternalRecords SET IsGone=1 WHERE Id='{ids.Record:D}';");
            if (change == "customer") await factory.AdminSqlAsync($"UPDATE customers.Organizations SET IsDeleted=1 WHERE Id='{customer:D}';");
        }
        finally { release.TrySetResult(); }
        var view = (await (await pending).Content.ReadFromJsonAsync<LocalReadinessView>())!;
        view.Status.ShouldBe("PARTIAL"); view.Admin!.AtlasMappings!.Status.ShouldBe("CHANGED"); view.Admin.AtlasMappings.Counts.ShouldBeNull(); view.Admin.AtlasMappings.Coverage.ShouldBeNull();
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

    private sealed class RefuseHttp : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
            throw new InvalidOperationException("Local readiness must not call Atlas.");
    }
    private sealed class PauseAfterRead(ILocalMappingSource inner, TaskCompletionSource entered, TaskCompletionSource release) : ILocalMappingSource
    {
        private int calls;
        public async Task<LocalMappingSnapshot> ReadAsync(CancellationToken ct)
        {
            var result = await inner.ReadAsync(ct);
            if (Interlocked.Increment(ref calls) == 1) { entered.TrySetResult(); await release.Task.WaitAsync(ct); }
            return result;
        }
    }
}
