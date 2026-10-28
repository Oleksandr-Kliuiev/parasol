using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Crm.Authorization;
using Crm.Backup.Contracts;
using Crm.Integrations.CloudAlly;
using Crm.Integrations.Core.Actions;
using Crm.Integrations.Core.Persistence;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using WireMock.RequestBuilders;
using WireMock.Server;
using static Crm.IntegrationTests.IntegrationTestHelpers;

namespace Crm.IntegrationTests;

/// <summary>
/// The CloudAlly tests run one after another: a complete read covers every linked organization of the shared database, and the
/// coverage check after it counts a clean check of every gap of its rules it does not find.
/// </summary>
[CollectionDefinition(Name, DisableParallelization = true)]
public sealed class CloudAllyCollection
{
    public const string Name = "cloudally";
}

/// <summary>
/// One entity of a test's CloudAlly world: an address (or a site) with its backup's state. <c>Licensing</c> is Microsoft's licence as
/// CloudAlly words it; an entity that is not in backup is listed among the statuses only with one, as the live account lists it.
/// </summary>
internal sealed record TestEntity(
    string Id, string Name, string? FullName, string Status, DateTimeOffset? Success, DateTimeOffset? Attempt, string? Error = null, string? Licensing = null);

/// <summary>One task of a test's CloudAlly world.</summary>
internal sealed record TestTask(string Id, string AccountId, string Source, string Status, List<TestEntity> Entities);

/// <summary>One account of a test's CloudAlly world and the organization it is linked to (none for an unlinked account).</summary>
internal sealed record TestAccount(string Id, string Name, string Email, string Region, Guid? OrganizationId, List<TestTask> Tasks);

/// <summary>
/// A CRM host of its own talking to a CloudAlly stub of its own (M42), with the action switches of the test. The stub answers the
/// partner API as CloudAlly's reference describes it, from the accounts the test puts in <see cref="Accounts"/>; <see cref="Publish"/>
/// puts the world on the stub again after a test changed it.
/// </summary>
internal sealed class CloudAllyHost(WebApplicationFactory<Program> host, WireMockServer cloudAlly, string user) : IAsyncDisposable
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    public List<TestAccount> Accounts { get; } = [];

    public IServiceProvider Services => host.Services;

    public WireMockServer CloudAlly => cloudAlly;

    public static CloudAllyHost Start(CrmWebFactory factory, bool write = true, bool dryRun = false, string[]? kinds = null)
    {
        var cloudAlly = WireMockServer.Start();
        var host = factory.WithWebHostBuilder(builder =>
        {
            builder.UseSetting("Integrations:CloudAlly:Enabled", "true");
            builder.UseSetting("Integrations:CloudAlly:BaseUrl", cloudAlly.Url + "/");
            builder.UseSetting("Integrations:CloudAlly:ClientId", "test-client");
            builder.UseSetting("Integrations:CloudAlly:ClientSecret", "test-secret");
            builder.UseSetting("Integrations:CloudAlly:Email", "api@parasoll.test");
            builder.UseSetting("Integrations:CloudAlly:Password", "test-password");
            builder.UseSetting("Integrations:CloudAlly:RetryDelay", "00:00:00.020");
            builder.UseSetting("Integrations:CloudAlly:WriteEnabled", write ? "true" : "false");
            builder.UseSetting("Integrations:CloudAlly:DryRun", dryRun ? "true" : "false");
            var enabled = kinds ?? CloudAllyActionKinds.All;
            for (var i = 0; i < enabled.Length; i++)
            {
                builder.UseSetting($"Integrations:CloudAlly:EnabledActions:{i}", enabled[i]);
            }
        });
        cloudAlly.Given(Request.Create().WithPath("/v2/auth/partner").UsingPost())
            .RespondWith(JsonReply(new { accessToken = "test-token", tokenType = "Bearer", expiresIn = 3600, refreshToken = "test-refresh", refreshTokenExpiresIn = 86400 }));
        return new CloudAllyHost(host, cloudAlly, $"backup-{Guid.NewGuid():N}"[..20]);
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

    /// <summary>A new organization linked to a new CloudAlly account of the world, with the given tasks.</summary>
    public async Task<TestAccount> LinkedAccountAsync(string name, params (string Source, string Status, TestEntity[] Entities)[] tasks)
    {
        var admin = Client();
        var organizationId = await admin.CreateOrganizationAsync(new { name = $"{name} {Guid.NewGuid():N}"[..24], status = "Customer" });
        var account = Account(name, organizationId, tasks);
        (await admin.PostAsJsonAsync("/api/v1/integrations/links", new
        {
            system = CloudAllyTypes.System, externalType = CloudAllyTypes.Customer, externalId = account.Id, entityId = organizationId,
        }, Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
        return account;
    }

    /// <summary>A CloudAlly account of the world that no organization is linked to.</summary>
    public TestAccount Account(string name, Guid? organizationId, params (string Source, string Status, TestEntity[] Entities)[] tasks)
    {
        var id = Guid.NewGuid().ToString();
        var account = new TestAccount(id, name, $"admin@{name.ToLowerInvariant().Replace(' ', '-')}.test", "EU", organizationId,
            tasks.Select(t => new TestTask("task-" + Guid.NewGuid().ToString("N")[..10], id, t.Source, t.Status, [.. t.Entities])).ToList());
        Accounts.Add(account);
        return account;
    }

    public static TestEntity Entity(string name, string status = "ACTIVE", double? successHoursAgo = 2, double? attemptHoursAgo = null, string? error = null,
        string? fullName = null, string? licensing = null) =>
        new("ent-" + Guid.NewGuid().ToString("N")[..10], name, fullName, status, successHoursAgo is { } s ? DateTimeOffset.UtcNow.AddHours(-s) : null,
            attemptHoursAgo is { } a ? DateTimeOffset.UtcNow.AddHours(-a) : successHoursAgo is { } same ? DateTimeOffset.UtcNow.AddHours(-same) : null, error,
            licensing);

    /// <summary>Puts the world on the stub: the lists, every task with its entities, and a failing statuses list when asked.</summary>
    public void Publish(bool statusesFail = false)
    {
        var accounts = Accounts.Select(a => new { id = a.Id, name = a.Name, email = a.Email, status = "ACTIVE", region = a.Region }).ToList();
        On("GET", "/v2/resellers/accounts").RespondWith(JsonReply(new { page = 1, totalPages = 1, total = accounts.Count, data = accounts }));
        var tasks = Accounts.SelectMany(a => a.Tasks).Select(t => TaskView(t, entities: false)).ToList();
        On("GET", "/v2/resellers/accounts/backup-tasks").RespondWith(JsonReply(new { page = 1, totalPages = 1, total = tasks.Count, data = tasks }));
        var statuses = Accounts.SelectMany(a => a.Tasks).SelectMany(t => t.Entities.Where(e => e.Status != "NOTACTIVE" || e.Licensing is not null).Select(e => new
        {
            userId = t.AccountId, taskId = t.Id, source = t.Source, entityName = e.Name, lastBackupDate = Compact(e.Success), lastBackupAttemptDate = Compact(e.Attempt),
            size = 1024, msLicensing = e.Licensing ?? "LICENSED",
            backupStatus = new[] { new { subSource = "mail", status = e.Error is null ? "SUCCESS" : "FAILED", error = e.Error, errFAQLink = e.Error is null ? null : "https://support.cloudally.test/faq" } },
        })).ToList();
        On("GET", "/v2/resellers/accounts/backup-statuses").RespondWith(statusesFail
            ? JsonReply(new { status = 502, error = "Bad Gateway" }, 502)
            : JsonReply(new { page = 1, totalPages = 1, total = statuses.Count, nextPageToken = (string?)null, data = statuses }));
        foreach (var account in Accounts)
        {
            foreach (var task in account.Tasks)
            {
                On("GET", $"/v2/resellers/accounts/{account.Id}/backup-tasks/{task.Id}").RespondWith(JsonReply(TaskView(task, entities: true)));
            }
        }
    }

    /// <summary>The stub of one route; a later stub of the same route replaces it (one mapping id per method and path).</summary>
    public IRespondWithAProvider On(string method, string path) =>
        cloudAlly.Given(Request.Create().WithPath(path).UsingMethod(method)).WithGuid(new Guid(SHA256.HashData(Encoding.UTF8.GetBytes($"{method} {path}"))[..16]));

    public async Task SyncAsync()
    {
        await using var scope = host.Services.CreateAsyncScope();
        await scope.ServiceProvider.GetRequiredService<CloudAllyBackupSyncJob>().RunAsync(Ct);
    }

    /// <summary>Stores the world's accounts of one organization straight in the backup module, as a complete read would.</summary>
    public async Task StoreAsync(TestAccount account)
    {
        await using var scope = host.Services.CreateAsyncScope();
        var mapped = new ExternalBackupAccount(account.Id, account.Name, account.Email, "ACTIVE", account.Region, account.Tasks.Select(t =>
            new ExternalBackupTask(t.Id, CloudAllyMapping.ServiceOf(t.Source), t.Source, null, t.Status, false, t.Entities.Max(e => e.Success), null,
                t.Entities.Count, t.Entities.Count, null, t.Entities.Select(e => new ExternalBackupEntity(
                    e.Id, e.Name, e.FullName, "x-" + e.Id, e.Status, false, e.Success, e.Attempt, e.Error, null, null, null)).ToList())).ToList());
        await scope.ServiceProvider.GetRequiredService<IBackupApi>().ApplySnapshotAsync(new BackupSnapshot(
            CloudAllyTypes.System, new Dictionary<Guid, IReadOnlyList<ExternalBackupAccount>> { [account.OrganizationId!.Value] = [mapped] }, true), Ct);
    }

    /// <summary>Preview and command of an action by this host's user; the action's id. A destructive one goes through its own endpoint.</summary>
    public async Task<Guid> AskAsync(string kind, string targetType, string targetId, object parameters, string? reason = null, string? typedName = null)
    {
        var client = Client();
        var body = new { system = CloudAllyTypes.System, kind, targetType, targetId, parameters };
        var preview = await PreviewAsync(kind, targetType, targetId, parameters);
        preview.GetProperty("block").ValueKind.ShouldBe(JsonValueKind.Null, preview.ToString());
        var destructive = preview.GetProperty("level").GetString() == "Destructive";
        var command = await client.PostAsJsonAsync(destructive ? "/api/v1/actions/destructive" : "/api/v1/actions", new
        {
            body.system, body.kind, body.targetType, body.targetId, parameters, previewToken = preview.GetProperty("previewToken").GetString(),
            commandKey = Guid.NewGuid(), reason, typedName,
        }, Ct);
        command.StatusCode.ShouldBe(HttpStatusCode.Accepted, await command.Content.ReadAsStringAsync(Ct));
        return (await command.ReadJsonAsync()).GetProperty("id").GetGuid();
    }

    public async Task<JsonElement> PreviewAsync(string kind, string targetType, string targetId, object parameters)
    {
        var response = await Client().PostAsJsonAsync("/api/v1/actions/preview",
            new { system = CloudAllyTypes.System, kind, targetType, targetId, parameters }, Ct);
        response.StatusCode.ShouldBe(HttpStatusCode.OK, await response.Content.ReadAsStringAsync(Ct));
        return await response.ReadJsonAsync();
    }

    /// <summary>Runs the action's operation once, as the worker loop does; a destructive one first has its hold passed.</summary>
    public async Task<VendorAction> RunAsync(Guid actionId, bool holdPassed = true)
    {
        await using (var scope = host.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
            var operation = (await db.VendorActions.AsNoTracking().SingleAsync(a => a.Id == actionId, Ct)).OutboundOperationId;
            if (holdPassed)
            {
                var past = DateTimeOffset.UtcNow.AddSeconds(-1);
                await db.OutboundOperations.Where(o => o.Id == operation).ExecuteUpdateAsync(s => s.SetProperty(o => o.NextAttemptAt, past), Ct);
            }

            await host.Services.GetRequiredService<VendorActionRunner>().RunOneAsync(operation, Ct);
        }

        await using var read = host.Services.CreateAsyncScope();
        return await read.ServiceProvider.GetRequiredService<IntegrationDbContext>().VendorActions.AsNoTracking().SingleAsync(a => a.Id == actionId, Ct);
    }

    public int Count(string method, string path) =>
        cloudAlly.LogEntries.Count(e => e.RequestMessage!.Method == method && e.RequestMessage.Path == path);

    public JsonElement Posted(string path) =>
        JsonDocument.Parse(cloudAlly.LogEntries.Last(e => e.RequestMessage!.Method == "POST" && e.RequestMessage.Path == path).RequestMessage!.Body!).RootElement;

    public Dictionary<string, string> Headers(string method, string path) =>
        cloudAlly.LogEntries.Last(e => e.RequestMessage!.Method == method && e.RequestMessage.Path == path).RequestMessage!.Headers!
            .ToDictionary(h => h.Key, h => string.Join(",", h.Value), StringComparer.OrdinalIgnoreCase);

    public async ValueTask DisposeAsync()
    {
        await host.DisposeAsync();
        cloudAlly.Dispose();
    }

    /// <summary>The task with its entities as CloudAlly answers its read.</summary>
    public static object View(TestTask task) => TaskView(task, entities: true);

    private static object TaskView(TestTask task, bool entities) => entities
        ? new
        {
            id = task.Id, type = "BACKUP", source = task.Source, userId = task.AccountId, status = task.Status, alias = task.Source,
            numOfEntities = task.Entities.Count, numOfBilledEntities = task.Entities.Count(e => e.Status != "NOTACTIVE"),
            lastBackupDates = new Dictionary<string, long?> { ["mail"] = CompactNumber(task.Entities.Max(e => e.Success)) },
            // Materialized: the view is what CloudAlly answered then, whatever the test changes afterwards.
            entities = task.Entities.Select(e => new { id = e.Id, userId = task.AccountId, taskId = task.Id, entity = e.Name, fullName = e.FullName, status = e.Status, extId = "x-" + e.Id })
                .ToList(),
        }
        : new
        {
            id = task.Id, type = "BACKUP", source = task.Source, userId = task.AccountId, status = task.Status, alias = task.Source,
            numOfEntities = task.Entities.Count, numOfBilledEntities = task.Entities.Count(e => e.Status != "NOTACTIVE"),
            lastBackupDates = new Dictionary<string, long?> { ["mail"] = CompactNumber(task.Entities.Max(e => e.Success)) },
            entities = (object?)null,
        };

    private static string? Compact(DateTimeOffset? at) => at?.UtcDateTime.ToString("yyyyMMddHHmmss", CultureInfo.InvariantCulture);

    private static long? CompactNumber(DateTimeOffset? at) => at is null ? null : long.Parse(Compact(at)!, CultureInfo.InvariantCulture);
}
