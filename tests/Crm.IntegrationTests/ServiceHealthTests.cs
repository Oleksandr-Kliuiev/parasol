using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crm.Authorization;
using Crm.Customers.Persistence;
using Crm.Infrastructure.DependencyInjection;
using Crm.Infrastructure.Health;
using Crm.Infrastructure.Outbox;
using Crm.Infrastructure.Persistence;
using Crm.Integrations.Core;
using Crm.Integrations.Core.Persistence;
using Crm.SharedKernel.Domain;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crm.IntegrationTests;

/// <summary>An event whose handler holds the outbox loop until the test lets it go (DEV-06-AC04).</summary>
public sealed record WedgeEvent(Guid Id) : DomainEvent;

internal sealed class WedgeHandler : IDomainEventHandler<WedgeEvent>
{
    public static readonly SemaphoreSlim Gate = new(0);

    public async Task HandleAsync(WedgeEvent domainEvent, CancellationToken cancellationToken) =>
        await Gate.WaitAsync(TimeSpan.FromSeconds(60), cancellationToken);
}

/// <summary>
/// Readiness, liveness and the worker's heartbeat (DEV-06): a second instance of the application talks to SQL Server
/// through a proxy the test takes down and brings back, or runs the outbox loop with short limits. In the administration
/// collection: the timings must not compete with the parallel suite, and the loop works the shared outbox.
/// </summary>
[Collection(DatabaseAdministrationCollection.Name)]
public class ServiceHealthTests(CrmWebFactory factory)
{
    private static HttpClient Admin(WebApplicationFactory<Program> host, string user = "health-admin")
    {
        var client = host.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false });
        client.DefaultRequestHeaders.Add(TestAuthHandler.RolesHeader, CrmRoles.Admin);
        client.DefaultRequestHeaders.Add(TestAuthHandler.UserHeader, user);
        client.DefaultRequestHeaders.Add("X-CSRF", "1");
        return client;
    }

    private static async Task<HttpResponseMessage> EventuallyAsync(Func<Task<HttpResponseMessage>> request, HttpStatusCode expected, TimeSpan within)
    {
        var deadline = DateTime.UtcNow + within;
        HttpResponseMessage response;
        do
        {
            response = await request();
            if (response.StatusCode == expected)
            {
                return response;
            }

            await Task.Delay(250);
        }
        while (DateTime.UtcNow < deadline);

        return response;
    }

    [Fact]
    public async Task AC01_AC02_without_the_database_live_stays_up_ready_fails_quickly_and_recovers_when_it_is_back()
    {
        var (host, port) = factory.SqlEndpoint;
        using var proxy = new TcpToggleProxy(host, port);
        var throughProxy = new SqlConnectionStringBuilder(factory.RuntimeConnectionString) { DataSource = $"127.0.0.1,{proxy.Port}" }.ConnectionString;
        await using var web = factory.WithWebHostBuilder(b => b.UseSetting("ConnectionStrings:crm", throughProxy));
        var client = web.CreateClient();

        var ready = await client.GetAsync("/health/ready");
        ready.StatusCode.ShouldBe(HttpStatusCode.OK, await ready.Content.ReadAsStringAsync());
        (await ready.Content.ReadAsStringAsync()).ShouldBe("Healthy");

        proxy.Down();
        var watch = Stopwatch.StartNew();
        var unready = await client.GetAsync("/health/ready");
        watch.Stop();
        unready.StatusCode.ShouldBe(HttpStatusCode.ServiceUnavailable);
        // The probe answer says nothing about the server, the login or the error.
        (await unready.Content.ReadAsStringAsync()).ShouldBe("Unhealthy");
        watch.Elapsed.ShouldBeLessThan(TimeSpan.FromSeconds(6));
        var live = await client.GetAsync("/health/live");
        live.StatusCode.ShouldBe(HttpStatusCode.OK);
        (await live.Content.ReadAsStringAsync()).ShouldBe("Healthy");

        // Back without anyone recreating anything: the next probes find the database again.
        proxy.Up();
        var recovered = await EventuallyAsync(() => client.GetAsync("/health/ready"), HttpStatusCode.OK, TimeSpan.FromSeconds(20));
        recovered.StatusCode.ShouldBe(HttpStatusCode.OK);
        (await Admin(web).GetAsync("/api/v1/customers/organizations?limit=1")).StatusCode.ShouldBe(HttpStatusCode.OK);
    }

    [Fact]
    public async Task AC03_with_Atera_and_PowerOffice_down_the_CRM_still_creates_and_reads_its_records()
    {
        await using var web = factory.WithWebHostBuilder(b =>
        {
            // Nothing listens on port 9: every call to the providers fails at once.
            b.UseSetting("Integrations:PowerOffice:BaseUrl", "http://127.0.0.1:9/v2/");
            b.UseSetting("Integrations:PowerOffice:TokenUrl", "http://127.0.0.1:9/OAuth/Token");
            b.UseSetting("Integrations:Atera:BaseUrl", "http://127.0.0.1:9/api/v3/");
            b.UseSetting("Integrations:PartnerCenter:BaseUrl", "http://127.0.0.1:9/");
        });
        var admin = Admin(web, "health-crud");
        var marker = $"H{Guid.NewGuid():N}"[..10];

        var organizationId = await admin.CreateOrganizationAsync(TestData.Organization($"{marker} Uavhengig AS", status: "Customer"));
        (await admin.PostAsJsonAsync($"/api/v1/customers/organizations/{organizationId}/contacts", new
        {
            firstName = "Kari", lastName = marker, email = $"kari@{marker.ToLowerInvariant()}.no", roles = Array.Empty<string>(), isPrimary = true,
        })).EnsureSuccessStatusCode();

        // The worker side meets the dead providers: its handlers and the outbound queue fail and record it.
        var outbox = ActivatorUtilities.CreateInstance<OutboxProcessor>(web.Services);
        foreach (var context in web.Services.GetRequiredService<ModuleDbContextRegistry>().Contexts)
        {
            for (var i = 0; i < 20 && await outbox.ProcessContextAsync(context, CancellationToken.None) > 0; i++)
            {
            }
        }

        await web.Services.GetRequiredService<OutboundProcessorJob>().RunAsync(CancellationToken.None);

        // The CRM itself carries on: ready, and its records are read and written.
        (await web.CreateClient().GetAsync("/health/ready")).StatusCode.ShouldBe(HttpStatusCode.OK);
        var found = await admin.GetFromJsonAsync<JsonElement>($"/api/v1/customers/organizations?search={marker}");
        found.GetProperty("items").EnumerateArray().ShouldHaveSingleItem().GetProperty("id").GetGuid().ShouldBe(organizationId);
        await admin.CreateOrganizationAsync(TestData.Organization($"{marker} Neste AS"));
    }

    [Fact]
    public async Task AC04_a_worker_whose_processing_stops_keeps_answering_but_its_heartbeat_expires_and_liveness_fails()
    {
        await using var worker = factory.WithWebHostBuilder(b =>
        {
            b.UseSetting("Worker:Health:HeartbeatStaleAfter", "00:00:02");
            b.UseSetting("Worker:Health:LoopStaleAfter", "00:00:03");
            b.UseSetting("Worker:Health:HeartbeatInterval", "00:00:00");
            b.ConfigureTestServices(services =>
            {
                services.AddOutboxProcessing();
                services.AddScoped<IDomainEventHandler<WedgeEvent>, WedgeHandler>();
            });
        });
        var client = worker.CreateClient();
        var admin = Admin(worker, "health-worker");

        // Running: the loop finishes rounds and beats.
        (await EventuallyAsync(() => client.GetAsync("/health/live"), HttpStatusCode.OK, TimeSpan.FromSeconds(10))).StatusCode.ShouldBe(HttpStatusCode.OK);
        var fresh = await OutboxBeatAsync(admin, stale: false, within: TimeSpan.FromSeconds(15));
        fresh.GetProperty("stale").GetBoolean().ShouldBeFalse();

        // An event whose handler never returns wedges the loop.
        await using (var scope = worker.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<CustomersDbContext>();
            db.OutboxMessages.Add(OutboxMessage.For(new WedgeEvent(Guid.NewGuid()), DateTimeOffset.UtcNow, "dev06-wedge"));
            await db.SaveChangesAsync();
        }

        try
        {
            // The process still answers HTTP, but liveness fails and the stored heartbeat expires.
            var dead = await EventuallyAsync(() => client.GetAsync("/health/live"), HttpStatusCode.ServiceUnavailable, TimeSpan.FromSeconds(30));
            dead.StatusCode.ShouldBe(HttpStatusCode.ServiceUnavailable);
            (await dead.Content.ReadAsStringAsync()).ShouldBe("Unhealthy");
            var stale = await OutboxBeatAsync(admin, stale: true, within: TimeSpan.FromSeconds(15));
            stale.GetProperty("ageSeconds").GetInt32().ShouldBeGreaterThanOrEqualTo(2);
            var details = await admin.GetFromJsonAsync<JsonElement>("/health/details");
            details.GetProperty("status").GetString().ShouldBeOneOf("Degraded", "Unhealthy");
        }
        finally
        {
            WedgeHandler.Gate.Release();
        }

        // Let go, the loop recovers on its own.
        (await EventuallyAsync(() => client.GetAsync("/health/live"), HttpStatusCode.OK, TimeSpan.FromSeconds(20))).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await OutboxBeatAsync(admin, stale: false, within: TimeSpan.FromSeconds(15))).GetProperty("stale").GetBoolean().ShouldBeFalse();
    }

    private static async Task<JsonElement> OutboxBeatAsync(HttpClient admin, bool stale, TimeSpan within)
    {
        var deadline = DateTime.UtcNow + within;
        JsonElement beat = default;
        while (DateTime.UtcNow < deadline)
        {
            var details = await admin.GetFromJsonAsync<JsonElement>("/health/details");
            var outbox = details.GetProperty("worker").GetProperty("components").EnumerateArray()
                .Where(c => c.GetProperty("component").GetString() == OutboxProcessor.HeartbeatComponent)
                .ToList();
            if (outbox.Count > 0)
            {
                beat = outbox[0];
                if (beat.GetProperty("stale").GetBoolean() == stale)
                {
                    return beat;
                }
            }

            await Task.Delay(250);
        }

        return beat.ValueKind == JsonValueKind.Undefined ? throw new ShouldAssertException("no outbox heartbeat") : beat;
    }

    [Fact]
    public async Task AC05_an_empty_database_is_not_ready_until_it_is_migrated_and_then_starts_cleanly()
    {
        var name = $"crm_empty_{Guid.NewGuid():N}"[..24];
        await factory.AdminSqlAsync($"CREATE DATABASE [{name}];");
        var connection = new SqlConnectionStringBuilder(factory.AdminConnectionString) { InitialCatalog = name }.ConnectionString;
        try
        {
            // The schema check: an empty database answers, but this build's migrations are missing.
            await using (var unmigrated = factory.WithWebHostBuilder(b => b.UseSetting("ConnectionStrings:crm", connection)))
            {
                var response = await unmigrated.CreateClient().GetAsync("/health/ready");
                response.StatusCode.ShouldBe(HttpStatusCode.ServiceUnavailable);
                (await response.Content.ReadAsStringAsync()).ShouldBe("Unhealthy");
            }

            // Migrations and startup on the empty database.
            await using (var migrated = factory.WithWebHostBuilder(b =>
                   {
                       b.UseSetting("ConnectionStrings:crm", connection);
                       b.UseSetting("Database:MigrateOnStartup", "true");
                   }))
            {
                var client = migrated.CreateClient();
                var ready = await client.GetAsync("/health/ready");
                ready.StatusCode.ShouldBe(HttpStatusCode.OK);
                (await ready.Content.ReadAsStringAsync()).ShouldBe("Healthy");
            }
        }
        finally
        {
            SqlConnection.ClearAllPools();
            await factory.AdminSqlAsync($"ALTER DATABASE [{name}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [{name}];");
        }
    }

    [Fact]
    public async Task AC05_details_are_for_administrators_and_name_no_server_login_or_error()
    {
        (await factory.AnonymousClient().GetAsync("/health/details")).StatusCode.ShouldBeOneOf(HttpStatusCode.Unauthorized, HttpStatusCode.Redirect);
        (await factory.ClientAs(CrmRoles.Sales, userKey: "health-sales").GetAsync("/health/details")).StatusCode.ShouldBe(HttpStatusCode.Forbidden);

        var response = await factory.ClientAs(CrmRoles.Admin, userKey: "health-admin").GetAsync("/health/details");
        response.StatusCode.ShouldBe(HttpStatusCode.OK);
        var text = await response.Content.ReadAsStringAsync();
        var details = JsonDocument.Parse(text).RootElement;
        details.GetProperty("checks").EnumerateArray().ShouldContain(c => c.GetProperty("name").GetString() == "database" && c.GetProperty("status").GetString() == "Healthy");
        var (host, port) = factory.SqlEndpoint;
        foreach (var secret in new[] { "Password", "User Id", "crm_worker_test", $"{host},{port}", "Exception", "SqlClient" })
        {
            text.ShouldNotContain(secret, Case.Insensitive);
        }

        // The heartbeat a worker stores is read back with its age.
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            await scope.ServiceProvider.GetRequiredService<IWorkerHeartbeat>().BeatAsync(WorkerHeartbeatJob.Component, "test beat", CancellationToken.None);
        }

        var after = await factory.ClientAs(CrmRoles.Admin, userKey: "health-admin").GetFromJsonAsync<JsonElement>("/health/details");
        after.GetProperty("worker").GetProperty("components").EnumerateArray()
            .ShouldContain(c => c.GetProperty("component").GetString() == WorkerHeartbeatJob.Component && !c.GetProperty("stale").GetBoolean());
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            (await scope.ServiceProvider.GetRequiredService<IntegrationDbContext>().WorkerHeartbeats.CountAsync(h => h.Component == WorkerHeartbeatJob.Component))
                .ShouldBeGreaterThanOrEqualTo(1);
        }
    }
}
