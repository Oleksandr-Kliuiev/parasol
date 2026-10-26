using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Crm.Authorization;
using Crm.Integrations.Core;
using Crm.Integrations.Core.Actions;
using Crm.Integrations.Core.Persistence;
using Crm.Integrations.Huntress;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using WireMock.RequestBuilders;
using WireMock.Server;
using static Crm.IntegrationTests.IntegrationTestHelpers;

namespace Crm.IntegrationTests;

/// <summary>
/// The Huntress tests share one collection: a complete read of Huntress's alerts resolves every other open Huntress alert of the shared
/// database, and a read of the agents replaces the devices of every linked Huntress organization, so no two may run at once.
/// </summary>
[CollectionDefinition(HuntressCollection.Name, DisableParallelization = true)]
public sealed class HuntressCollection
{
    public const string Name = "huntress";
}

/// <summary>A customer of the tests: its CRM organization and the Huntress organization linked to it.</summary>
internal sealed record HuntressCustomer(Guid OrganizationId, long HuntressOrganizationId, string Marker);

/// <summary>
/// A CRM host of its own talking to a Huntress stub of its own (M41), with the switches of the test, so stubs, counts and faults never
/// mix with other tests. The clients sign in as one user per host.
/// </summary>
internal sealed class HuntressHost(WebApplicationFactory<Program> host, WireMockServer huntress, string user) : IAsyncDisposable
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    public IServiceProvider Services => host.Services;

    public WireMockServer Huntress => huntress;

    public static HuntressHost Start(CrmWebFactory factory, bool write = true, bool dryRun = false, string[]? kinds = null, string[]? allowed = null)
    {
        var huntress = WireMockServer.Start();
        var host = factory.WithWebHostBuilder(builder =>
        {
            builder.UseSetting("Integrations:Huntress:Enabled", "true");
            builder.UseSetting("Integrations:Huntress:ApiKey", "test-huntress-key");
            builder.UseSetting("Integrations:Huntress:ApiSecret", "test-huntress-secret");
            builder.UseSetting("Integrations:Huntress:BaseUrl", huntress.Url + "/v1/");
            builder.UseSetting("Integrations:Huntress:RetryDelay", "00:00:00.020");
            builder.UseSetting("Integrations:Huntress:IncidentUrlTemplate", "https://huntress.example.invalid/incidents/{0}");
            builder.UseSetting("Integrations:Huntress:WriteEnabled", write ? "true" : "false");
            builder.UseSetting("Integrations:Huntress:DryRun", dryRun ? "true" : "false");
            var enabled = kinds ?? HuntressActionKinds.All;
            for (var i = 0; i < enabled.Length; i++)
            {
                builder.UseSetting($"Integrations:Huntress:EnabledActions:{i}", enabled[i]);
            }

            for (var i = 0; i < (allowed ?? []).Length; i++)
            {
                builder.UseSetting($"Integrations:Huntress:WriteAllowedCustomerIds:{i}", allowed![i]);
            }
        });
        return new HuntressHost(host, huntress, $"huntress-{Guid.NewGuid():N}"[..20]);
    }

    public HttpClient Client(string role = CrmRoles.Admin)
    {
        var client = host.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false });
        client.DefaultRequestHeaders.Add(TestAuthHandler.RolesHeader, role);
        client.DefaultRequestHeaders.Add(TestAuthHandler.UserHeader, user);
        client.DefaultRequestHeaders.Add("X-CSRF", "1");
        client.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        return client;
    }

    /// <summary>A new CRM organization linked to a new Huntress organization, as a person links them on the mapping screen.</summary>
    public async Task<HuntressCustomer> CustomerAsync()
    {
        var marker = $"HU{Guid.NewGuid():N}"[..10].ToUpperInvariant();
        var admin = Client();
        var organizationId = await admin.CreateOrganizationAsync(new { name = $"{marker} Vern AS", status = "Customer" });
        var huntressId = Random.Shared.NextInt64(30_000_000, 39_999_999);
        (await admin.PostAsJsonAsync("/api/v1/integrations/links", new
        {
            system = HuntressTypes.System, externalType = HuntressTypes.Organization, externalId = huntressId.ToString(CultureInfo.InvariantCulture), entityId = organizationId,
        }, Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
        return new HuntressCustomer(organizationId, huntressId, marker);
    }

    /// <summary>The stub of one route; a later stub of the same route replaces it (one mapping id per method, path and query).</summary>
    public IRespondWithAProvider On(string method, string path, params (string Name, string Value)[] query)
    {
        var request = Request.Create().WithPath(path).UsingMethod(method);
        foreach (var (name, value) in query)
        {
            request = request.WithParam(name, value);
        }

        var key = $"{method} {path} {string.Join('&', query.Select(q => $"{q.Name}={q.Value}"))}";
        return huntress.Given(request).WithGuid(new Guid(SHA256.HashData(Encoding.UTF8.GetBytes(key))[..16]));
    }

    /// <summary>A list Huntress answers in one page.</summary>
    public void List(string path, string collection, IEnumerable<object> items, params (string Name, string Value)[] query) =>
        On("GET", path, query).RespondWith(JsonReply(new Dictionary<string, object?>
        {
            [collection] = items.ToList(),
            ["pagination"] = new Dictionary<string, object?> { ["next_page_token"] = null, ["next_page_url"] = null },
        }));

    public async Task RunJobAsync<TJob>(Func<TJob, Task> run)
        where TJob : notnull
    {
        await using var scope = host.Services.CreateAsyncScope();
        await run(scope.ServiceProvider.GetRequiredService<TJob>());
    }

    public async Task<SyncRun> LatestRunAsync(string job)
    {
        await using var scope = host.Services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<IntegrationDbContext>().SyncRuns.AsNoTracking()
            .Where(r => r.System == HuntressTypes.System && r.Job == job).OrderByDescending(r => r.StartedAt).FirstAsync(Ct);
    }

    public async Task<JsonElement> PreviewAsync(string kind, string targetType, string targetId, object? parameters = null)
    {
        var response = await Client().PostAsJsonAsync("/api/v1/actions/preview",
            new { system = HuntressTypes.System, kind, targetType, targetId, parameters = parameters ?? new { } }, Ct);
        response.StatusCode.ShouldBe(HttpStatusCode.OK, await response.Content.ReadAsStringAsync(Ct));
        return await response.ReadJsonAsync();
    }

    /// <summary>Preview and command of an action by this host's user; the action's id.</summary>
    public async Task<Guid> AskAsync(string kind, string targetType, string targetId, object? parameters = null, string? reason = null, string? typedName = null)
    {
        var preview = await PreviewAsync(kind, targetType, targetId, parameters);
        preview.GetProperty("block").ValueKind.ShouldBe(JsonValueKind.Null, preview.ToString());
        var destructive = preview.GetProperty("level").GetString() == "Destructive";
        var command = await Client().PostAsJsonAsync(destructive ? "/api/v1/actions/destructive" : "/api/v1/actions", new
        {
            system = HuntressTypes.System, kind, targetType, targetId, parameters = parameters ?? new { },
            previewToken = preview.GetProperty("previewToken").GetString(), commandKey = Guid.NewGuid(), reason, typedName,
        }, Ct);
        command.StatusCode.ShouldBe(HttpStatusCode.Accepted, await command.Content.ReadAsStringAsync(Ct));
        return (await command.ReadJsonAsync()).GetProperty("id").GetGuid();
    }

    public async Task<VendorAction> RunActionAsync(Guid actionId)
    {
        await using (var scope = host.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
            var operation = (await db.VendorActions.AsNoTracking().SingleAsync(a => a.Id == actionId, Ct)).OutboundOperationId;
            await host.Services.GetRequiredService<VendorActionRunner>().RunOneAsync(operation, Ct);
        }

        await using var read = host.Services.CreateAsyncScope();
        return await read.ServiceProvider.GetRequiredService<IntegrationDbContext>().VendorActions.AsNoTracking().SingleAsync(a => a.Id == actionId, Ct);
    }

    /// <summary>The hold of a destructive action has passed: its operation is due now.</summary>
    public async Task DueNowAsync(Guid actionId)
    {
        await using var scope = host.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
        var operationId = (await db.VendorActions.AsNoTracking().SingleAsync(a => a.Id == actionId, Ct)).OutboundOperationId;
        var past = DateTimeOffset.UtcNow.AddSeconds(-1);
        await db.OutboundOperations.Where(o => o.Id == operationId).ExecuteUpdateAsync(s => s.SetProperty(o => o.NextAttemptAt, past), Ct);
    }

    public int Count(string method, string path) =>
        huntress.LogEntries.Count(e => e.RequestMessage!.Method == method && e.RequestMessage.Path == path);

    public JsonElement Posted(string path) =>
        JsonDocument.Parse(huntress.LogEntries.Last(e => e.RequestMessage!.Method == "POST" && e.RequestMessage.Path == path).RequestMessage!.Body!).RootElement;

    public async ValueTask DisposeAsync()
    {
        await host.DisposeAsync();
        huntress.Dispose();
    }
}

/// <summary>Huntress's records as its API writes them (snake case), for the stubs of the tests. Synthetic data only.</summary>
internal static class HuntressRecords
{
    public static Dictionary<string, object?> Agent(long id, long organizationId, string hostname, string? serial = null, string[]? macs = null,
        string platform = "windows", string os = "Windows 11 Pro", string version = "0.13.140", DateTimeOffset? callback = null,
        string? defender = "Healthy", string? firewall = "Disabled") => new()
    {
        ["id"] = id, ["organization_id"] = organizationId, ["account_id"] = 1, ["hostname"] = hostname, ["platform"] = platform, ["os"] = os,
        ["version"] = version, ["serial_number"] = serial, ["mac_addresses"] = macs ?? [], ["ipv4_address"] = "10.0.0.10",
        ["external_ip"] = "198.51.100.10", ["last_callback_at"] = (callback ?? DateTimeOffset.UtcNow).ToString("O", CultureInfo.InvariantCulture),
        ["last_survey_at"] = DateTimeOffset.UtcNow.AddHours(-1).ToString("O", CultureInfo.InvariantCulture), ["defender_status"] = defender,
        ["defender_substatus"] = defender == "Unhealthy" ? "Real-time protection off" : "Up to date", ["defender_policy_status"] = "Compliant",
        ["firewall_status"] = firewall, ["created_at"] = "2026-03-01T08:00:00Z",
    };

    public static Dictionary<string, object?> Remediation(long id, string type, string status, string action = "Delete file") => new()
    {
        ["id"] = id, ["type"] = type, ["action"] = action, ["status"] = status,
        ["parameters"] = new[] { new Dictionary<string, object?> { ["name"] = "path", ["description"] = $"C:\\Synthetic\\{id}.exe" } },
        ["approved_at"] = status == "unapproved" ? null : "2026-10-22T08:00:00Z", ["completed_at"] = status == "completed" ? "2026-10-22T09:00:00Z" : null,
    };

    public static Dictionary<string, object?> Incident(long id, long organizationId, long? agentId, string severity, string status, params Dictionary<string, object?>[] plan) => new()
    {
        ["id"] = id, ["organization_id"] = organizationId, ["agent_id"] = agentId, ["account_id"] = 1, ["severity"] = severity, ["status"] = status,
        ["subject"] = $"{severity.ToUpperInvariant()} - Incident {id}", ["summary"] = "Huntress found a synthetic foothold.", ["body"] = "Synthetic details.",
        ["platform"] = "windows", ["indicator_types"] = new[] { "footholds" }, ["indicator_counts"] = new Dictionary<string, int> { ["footholds"] = 1 },
        ["sent_at"] = "2026-10-22T07:00:00Z", ["status_updated_at"] = "2026-10-22T07:00:00Z", ["updated_at"] = "2026-10-22T07:00:00Z",
        ["closed_at"] = status == "closed" ? "2026-10-22T10:00:00Z" : null,
        ["remediations"] = new Dictionary<string, object?> { ["total_count"] = plan.Length, ["has_more"] = false, ["items"] = plan },
    };

    public static Dictionary<string, object?> Notice(long id, long organizationId, string status, string typeCode, string subject, long? agentId = null, string? hostname = null) => new()
    {
        ["id"] = id, ["organizations"] = new[] { new Dictionary<string, object?> { ["id"] = organizationId, ["name"] = "Synthetic" } }, ["status"] = status,
        ["severity"] = "high", ["subject"] = subject, ["type"] = "Synthetic type", ["type_code"] = typeCode, ["created_at"] = "2026-10-22T06:00:00Z",
        ["updated_at"] = "2026-10-22T06:00:00Z", ["resolved_at"] = status == "resolved" ? "2026-10-22T11:00:00Z" : null,
        ["entities"] = agentId is { } agent
            ? new Dictionary<string, object?>
            {
                ["total_count"] = 1, ["has_more"] = false,
                ["items"] = new[] { new Dictionary<string, object?> { ["id"] = agent, ["type"] = "Agent", ["details"] = new Dictionary<string, object?> { ["hostname"] = hostname } } },
            }
            : null,
    };
}
