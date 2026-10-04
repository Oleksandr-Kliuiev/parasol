using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crm.Authorization;
using Crm.Integrations.MicrosoftGraph;
using Microsoft.Extensions.DependencyInjection;
using WireMock.RequestBuilders;
using WireMock.ResponseBuilders;

namespace Crm.IntegrationTests;

public class EntraUserSyncTests(CrmWebFactory factory)
{
    private async Task RunSyncAsync()
    {
        await using var scope = factory.Services.CreateAsyncScope();
        await scope.ServiceProvider.GetRequiredService<EntraUserSyncJob>().RunAsync(TestContext.Current.CancellationToken);
    }

    private IResponseBuilder Json(object body) =>
        Response.Create().WithStatusCode(200).WithHeader("Content-Type", "application/json").WithBody(JsonSerializer.Serialize(body));

    [Fact]
    public async Task Directory_changes_update_profiles_and_deactivated_users_lose_access()
    {
        var key = "graph-sync-person";
        var objectId = $"test-{key}";
        var person = factory.ClientAs(CrmRoles.Technician, key);
        (await person.GetAsync("/bff/user")).StatusCode.ShouldBe(HttpStatusCode.OK);

        var graph = factory.Graph;
        var baseUrl = graph.Url + "/graph/v1.0/users/delta";
        graph.Given(Request.Create().WithPath("/graph/v1.0/users/delta").WithParam("$select").UsingGet()).AtPriority(10)
            .RespondWith(Json(new Dictionary<string, object>
            {
                ["value"] = new object[] { new { id = objectId, displayName = "Synced Technician", userPrincipalName = $"{key}@test.local", department = "Drift", accountEnabled = true } },
                ["@odata.nextLink"] = $"{baseUrl}?$skiptoken=page2",
            }));
        graph.Given(Request.Create().WithPath("/graph/v1.0/users/delta").WithParam("$skiptoken", "page2").UsingGet()).AtPriority(1)
            .RespondWith(Json(new Dictionary<string, object>
            {
                ["value"] = new object[] { new { id = "someone-who-never-signed-in", displayName = "Stranger", accountEnabled = true } },
                ["@odata.deltaLink"] = $"{baseUrl}?$deltatoken=t1",
            }));
        graph.Given(Request.Create().WithPath("/graph/v1.0/users/delta").WithParam("$deltatoken", "t1").UsingGet()).AtPriority(1)
            .RespondWith(Json(new Dictionary<string, object>
            {
                ["value"] = new object[] { new Dictionary<string, object> { ["id"] = objectId, ["@removed"] = new { reason = "changed" } } },
                ["@odata.deltaLink"] = $"{baseUrl}?$deltatoken=t2",
            }));

        // First run: full enumeration across two pages
        await RunSyncAsync();

        var admin = factory.ClientAs(CrmRoles.Admin);
        var users = await admin.GetFromJsonAsync<JsonElement>("/api/v1/identity/users?search=Synced%20Technician");
        users.GetProperty("items").EnumerateArray().ShouldHaveSingleItem();
        users.GetProperty("totalCount").GetInt32().ShouldBe(1);
        graph.LogEntries.ShouldContain(e => e.RequestMessage!.Headers!["Authorization"].Contains("Bearer test-graph-token"));

        var runs = await admin.GetFromJsonAsync<JsonElement>("/api/v1/integrations/runs?system=microsoft-graph");
        var first = runs.GetProperty("items").EnumerateArray().First();
        first.GetProperty("status").GetString().ShouldBe("Succeeded");
        first.GetProperty("read").GetInt32().ShouldBe(2);
        first.GetProperty("message").GetString()!.ShouldContain("matched 1");

        // Second run continues from the stored delta link and sees the account removed
        await RunSyncAsync();

        var denied = await person.GetAsync("/api/v1/customers/organizations?limit=1");
        denied.StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
        (await denied.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString().ShouldBe("USER_INACTIVE");
        graph.LogEntries.ShouldContain(e => e.RequestMessage!.Url.Contains("$deltatoken=t1"));
    }

    [Fact]
    public async Task Job_endpoints_require_integration_permission()
    {
        (await factory.ClientAs(CrmRoles.Management).GetAsync("/api/v1/integrations/runs")).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        // Hangfire is disabled in tests, so the job list reports that storage is unavailable.
        (await factory.ClientAs(CrmRoles.Admin).GetAsync("/api/v1/integrations/jobs")).StatusCode.ShouldBe(HttpStatusCode.ServiceUnavailable);
    }
}
