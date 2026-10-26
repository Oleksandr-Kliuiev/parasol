using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crm.Integrations.Core;
using Crm.Integrations.Core.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crm.IntegrationTests;

/// <summary>
/// The calls of the "Connect services" wizard (M43) as the tests make them: what the wizard starts from, and the preview and command of a
/// create action, whose target is the CRM organization itself.
/// </summary>
internal static class CustomerCreationCalls
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    public const string Target = "organization";

    /// <summary>The services of a customer, keyed by vendor.</summary>
    public static async Task<Dictionary<string, JsonElement>> ServicesAsync(this HttpClient client, Guid organizationId)
    {
        var response = await client.GetAsync($"/api/v1/integrations/organizations/{organizationId}/services", Ct);
        response.StatusCode.ShouldBe(HttpStatusCode.OK, await response.Content.ReadAsStringAsync(Ct));
        return (await response.ReadJsonAsync()).GetProperty("services").EnumerateArray().ToDictionary(s => s.GetProperty("system").GetString()!, s => s.Clone());
    }

    public static async Task<JsonElement> PreviewCreateAsync(this HttpClient client, string system, string kind, Guid organizationId, object? parameters = null)
    {
        var response = await client.PostAsJsonAsync("/api/v1/actions/preview",
            new { system, kind, targetType = Target, targetId = organizationId.ToString(), parameters = parameters ?? new { } }, Ct);
        response.StatusCode.ShouldBe(HttpStatusCode.OK, await response.Content.ReadAsStringAsync(Ct));
        return await response.ReadJsonAsync();
    }

    /// <summary>Preview and command of a create action; the action's id.</summary>
    public static async Task<Guid> AskCreateAsync(this HttpClient client, string system, string kind, Guid organizationId, object? parameters = null)
    {
        var preview = await client.PreviewCreateAsync(system, kind, organizationId, parameters);
        preview.GetProperty("block").ValueKind.ShouldBe(JsonValueKind.Null, preview.ToString());
        var command = await client.PostAsJsonAsync("/api/v1/actions", new
        {
            system, kind, targetType = Target, targetId = organizationId.ToString(), parameters = parameters ?? new { },
            previewToken = preview.GetProperty("previewToken").GetString(), commandKey = Guid.NewGuid(),
        }, Ct);
        command.StatusCode.ShouldBe(HttpStatusCode.Accepted, await command.Content.ReadAsStringAsync(Ct));
        return (await command.ReadJsonAsync()).GetProperty("id").GetGuid();
    }

    public static string[] EffectCodes(this JsonElement preview) =>
        [.. preview.GetProperty("effects").EnumerateArray().Select(e => e.GetProperty("code").GetString()!)];

    public static string? BlockCode(this JsonElement preview) =>
        preview.GetProperty("block") is { ValueKind: JsonValueKind.Object } block ? block.GetProperty("code").GetString() : null;

    /// <summary>The organization's link in a system, read from the database.</summary>
    public static async Task<ExternalLink?> LinkAsync(IServiceProvider services, Guid organizationId, string system)
    {
        await using var scope = services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<IntegrationDbContext>().ExternalLinks.AsNoTracking()
            .SingleOrDefaultAsync(l => l.EntityType == EntityTypes.Organization && l.EntityId == organizationId && l.System == system, Ct);
    }

    /// <summary>The operation of an action is due now (after the pause of a repeat).</summary>
    public static async Task DueNowAsync(IServiceProvider services, Guid actionId)
    {
        await using var scope = services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
        var operationId = (await db.VendorActions.AsNoTracking().SingleAsync(a => a.Id == actionId, Ct)).OutboundOperationId;
        var past = DateTimeOffset.UtcNow.AddSeconds(-1);
        await db.OutboundOperations.Where(o => o.Id == operationId).ExecuteUpdateAsync(s => s.SetProperty(o => o.NextAttemptAt, past), Ct);
    }
}
