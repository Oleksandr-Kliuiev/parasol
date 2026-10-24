using System.Collections.Concurrent;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Crm.Authorization;
using Crm.Integrations.Core.Actions;
using Crm.Integrations.Core.Persistence;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crm.IntegrationTests;

/// <summary>What the test vendor does with the next attempt of an action on a target.</summary>
internal enum TestVendorAnswer
{
    Done,
    AlreadyDone,
    Refused,
    NoAnswer,
    Later,
}

/// <summary>
/// A vendor of the tests only (M39.1): its switches, a scripted answer per target and a log of what reached it. Kinds: <c>thing.set</c>
/// (standard, not repeatable), <c>thing.pause</c> (disruptive, repeatable) and <c>thing.delete</c> (destructive).
/// </summary>
internal sealed class TestVendor : IVendorActionGate
{
    public const string Name = "testvendor";
    public const string TargetType = "thing";
    public const string Customer = "c-1";

    public string System => Name;

    public VendorActionSwitches Switches { get; set; } =
        new(true, true, true, false, [], ["thing.set", "thing.pause", "thing.delete"]);

    public ConcurrentDictionary<string, ConcurrentQueue<TestVendorAnswer>> Script { get; } = new();

    /// <summary>Every attempt that reached the vendor: kind, target, whether it was simulated.</summary>
    public ConcurrentQueue<(string Kind, string Target, bool Simulated)> Calls { get; } = new();

    public VendorActionSwitches Read() => Switches;

    public void Answer(string target, params TestVendorAnswer[] answers) => Script[target] = new ConcurrentQueue<TestVendorAnswer>(answers);

    public TestVendorAnswer Next(string target) =>
        Script.TryGetValue(target, out var queue) && queue.TryDequeue(out var answer) ? answer : TestVendorAnswer.Done;
}

internal sealed class TestThingHandler(TestVendor vendor, string kind, VendorActionLevel level, bool repeatable) : IVendorActionHandler
{
    public string System => TestVendor.Name;
    public string Kind => kind;
    public string TargetType => TestVendor.TargetType;
    public VendorActionLevel Level => level;
    public string Permission => Permissions.ServiceWrite;
    public string ReadPermission => Permissions.ServiceRead;
    public bool IsRepeatable => repeatable;

    public Task<VendorActionPlan> PlanAsync(VendorActionRequest request, CancellationToken cancellationToken)
    {
        if (request.TargetId.StartsWith("missing", StringComparison.Ordinal))
        {
            return Task.FromResult(VendorActionPlan.NotFound);
        }

        var target = new VendorActionTarget(TestVendor.TargetType, request.TargetId, $"Thing {request.TargetId}", null, null, TestVendor.Customer, null);
        if (!request.Parameters.TryGetProperty("value", out var value) || value.ValueKind != JsonValueKind.String || value.GetString()!.Trim().Length == 0)
        {
            return Task.FromResult(VendorActionPlan.Blocked(target, "VND_TEST_VALUE", "Give a value."));
        }

        var text = value.GetString()!.Trim();
        return Task.FromResult(new VendorActionPlan(target,
            [new VendorActionEffect("VND_EFFECT_TEST", new Dictionary<string, string?> { ["value"] = text })], null,
            VendorActionRules.Canonical(new Dictionary<string, object?> { ["value"] = text })));
    }

    public Task<VendorActionResult> ExecuteAsync(VendorActionContext context, CancellationToken cancellationToken)
    {
        var answer = vendor.Next(context.Action.TargetId);
        vendor.Calls.Enqueue((kind, context.Action.TargetId, context.Simulate));
        if (answer == TestVendorAnswer.AlreadyDone)
        {
            return Task.FromResult(VendorActionResult.Skipped("VND_ALREADY_DONE", "The vendor already shows it."));
        }

        if (context.Simulate)
        {
            return Task.FromResult(VendorActionResult.Simulated("VND_DRY_RUN", "Nothing was sent: DryRun."));
        }

        return answer switch
        {
            TestVendorAnswer.Refused => Task.FromResult(VendorActionResult.Failed("VND_VENDOR_REFUSED", "The vendor refused it (400).")),
            TestVendorAnswer.NoAnswer => throw new HttpRequestException("The connection was closed."),
            TestVendorAnswer.Later => Task.FromResult(VendorActionResult.Later("VND_VENDOR_BUSY", "The vendor was busy; nothing was sent.")),
            _ => Task.FromResult(VendorActionResult.Succeeded("VND_SENT", "Sent.", $"ref-{context.Action.TargetId}")),
        };
    }
}

/// <summary>A CRM host whose action registry also knows the test vendor; the clients send the test sign-in headers.</summary>
internal sealed class VendorActionHost(WebApplicationFactory<Program> host, TestVendor vendor) : IAsyncDisposable
{
    public TestVendor Vendor => vendor;

    public IServiceProvider Services => host.Services;

    public static VendorActionHost Start(CrmWebFactory factory)
    {
        var vendor = new TestVendor();
        var host = factory.WithWebHostBuilder(builder => builder.ConfigureTestServices(services =>
        {
            services.AddSingleton(vendor);
            services.AddSingleton<IVendorActionGate>(vendor);
            services.AddScoped<IVendorActionHandler>(_ => new TestThingHandler(vendor, "thing.set", VendorActionLevel.Standard, repeatable: false));
            services.AddScoped<IVendorActionHandler>(_ => new TestThingHandler(vendor, "thing.pause", VendorActionLevel.Disruptive, repeatable: true));
            services.AddScoped<IVendorActionHandler>(_ => new TestThingHandler(vendor, "thing.delete", VendorActionLevel.Destructive, repeatable: false));
        }));
        return new VendorActionHost(host, vendor);
    }

    public HttpClient Client(string role = CrmRoles.Admin, string? user = null)
    {
        var client = host.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false });
        client.DefaultRequestHeaders.Add(TestAuthHandler.RolesHeader, role);
        client.DefaultRequestHeaders.Add(TestAuthHandler.UserHeader, user ?? $"actions-{role.ToLowerInvariant()}");
        client.DefaultRequestHeaders.Add("X-CSRF", "1");
        client.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        return client;
    }

    public async Task<VendorAction> ActionAsync(Guid id)
    {
        await using var scope = host.Services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<IntegrationDbContext>().VendorActions.AsNoTracking().SingleAsync(a => a.Id == id);
    }

    public async Task<OutboundOperation> OperationAsync(Guid actionId)
    {
        await using var scope = host.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
        var action = await db.VendorActions.AsNoTracking().SingleAsync(a => a.Id == actionId);
        return await db.OutboundOperations.AsNoTracking().SingleAsync(o => o.Id == action.OutboundOperationId);
    }

    /// <summary>Runs this action's operation only: other test classes' actions in the shared database are never touched.</summary>
    public async Task<bool> RunAsync(Guid actionId) =>
        await host.Services.GetRequiredService<VendorActionRunner>().RunOneAsync((await OperationAsync(actionId)).Id, CancellationToken.None);

    /// <summary>Makes the operation due now, as if its pause or hold had passed.</summary>
    public async Task DueNowAsync(Guid actionId)
    {
        await using var scope = host.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
        var operationId = (await db.VendorActions.AsNoTracking().SingleAsync(a => a.Id == actionId)).OutboundOperationId;
        var past = DateTimeOffset.UtcNow.AddSeconds(-1);
        await db.OutboundOperations.Where(o => o.Id == operationId).ExecuteUpdateAsync(s => s.SetProperty(o => o.NextAttemptAt, past));
    }

    public async ValueTask DisposeAsync() => await host.DisposeAsync();
}

internal static class VendorActionCalls
{
    public static object Body(string kind, string target, object parameters) =>
        new { system = TestVendor.Name, kind, targetType = TestVendor.TargetType, targetId = target, parameters };

    public static async Task<JsonElement> PreviewAsync(this HttpClient client, string kind, string target, object parameters)
    {
        var response = await client.PostAsJsonAsync("/api/v1/actions/preview", Body(kind, target, parameters), TestContext.Current.CancellationToken);
        response.EnsureSuccessStatusCode();
        return await response.ReadJsonAsync();
    }

    public static Task<HttpResponseMessage> CommandAsync(
        this HttpClient client, string? token, string kind, string target, object parameters, Guid? key = null, string? reason = null, string? typedName = null,
        bool destructive = false) =>
        client.PostAsJsonAsync(destructive ? "/api/v1/actions/destructive" : "/api/v1/actions", new
        {
            previewToken = token, system = TestVendor.Name, kind, targetType = TestVendor.TargetType, targetId = target, parameters,
            commandKey = key ?? Guid.NewGuid(), reason, typedName,
        }, TestContext.Current.CancellationToken);

    /// <summary>Preview and command in one go; the answer's action id.</summary>
    public static async Task<Guid> AskAsync(this HttpClient client, string kind, string target, string value = "on", string? reason = null, string? typedName = null)
    {
        var preview = await client.PreviewAsync(kind, target, new { value });
        var response = await client.CommandAsync(preview.GetProperty("previewToken").GetString(), kind, target, new { value }, reason: reason, typedName: typedName,
            destructive: kind == "thing.delete");
        response.StatusCode.ShouldBe(System.Net.HttpStatusCode.Accepted, await response.Content.ReadAsStringAsync());
        return (await response.ReadJsonAsync()).GetProperty("id").GetGuid();
    }

    public static string Target() => $"t-{Guid.NewGuid():N}"[..14];
}
