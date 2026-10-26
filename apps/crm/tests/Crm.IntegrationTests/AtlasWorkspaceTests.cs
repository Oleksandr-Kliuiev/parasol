using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Crm.Authorization;
using Crm.Integrations.Core.Parasol;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using WireMock.RequestBuilders;
using WireMock.ResponseBuilders;
using WireMock.Server;

namespace Crm.IntegrationTests;

public sealed class AtlasWorkspaceTests(CrmWebFactory factory)
{
    private readonly string _key = $"workspace-{Guid.NewGuid():N}";
    private const string Workspace = "synthetic-workspace";
    private const string Token = "synthetic-atlas-token-not-a-secret";
    private static string PathFor(Guid id) => $"/api/v1/parasol/customers/{id}/workspace";
    private HttpClient Admin => factory.ClientAs(CrmRoles.Admin, _key);

    private async Task<(Guid CustomerId, string ClientId)> LinkedCustomer()
    {
        var response = await Admin.PostAsJsonAsync("/api/v1/customers/organizations", TestData.Organization($"Workspace {Guid.NewGuid():N} AS"));
        response.StatusCode.ShouldBe(HttpStatusCode.Created);
        var customerId = (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        var clientId = $"client-{Guid.NewGuid():N}";
        await Link(customerId, clientId);
        return (customerId, clientId);
    }

    private async Task Link(Guid customerId, string clientId)
    {
        var input = new CustomerIdentityImport(new(1, "atlas", Workspace, [new(clientId, "Synthetic")]), [new(clientId, customerId)]);
        var path = "/api/v1/parasol/customer-identities/import";
        var preview = await Admin.PostAsJsonAsync(path, input);
        preview.StatusCode.ShouldBe(HttpStatusCode.OK);
        var hash = (await preview.Content.ReadFromJsonAsync<CustomerIdentityPlan>())!.Sha256;
        (await Admin.PostAsJsonAsync($"{path}?dryRun=false&expectedSha256={hash}", input)).StatusCode.ShouldBe(HttpStatusCode.OK);
    }

    private async Task<WebApplicationFactory<Program>> Host(WireMockServer atlas, string? credentialWorkspace = Workspace, HttpMessageHandler? handler = null)
    {
        var employee = (await Admin.GetFromJsonAsync<JsonElement>("/bff/user")).GetProperty("id").GetGuid();
        return factory.WithWebHostBuilder(builder =>
        {
            builder.UseSetting("Parasol:Atlas:Enabled", "true");
            builder.UseSetting("Parasol:Atlas:BaseUrl", atlas.Url!);
            if (handler is not null)
                builder.ConfigureTestServices(services => services.AddHttpClient(AtlasWorkspaceRegistration.ClientName)
                    .ConfigurePrimaryHttpMessageHandler(() => handler));
            if (credentialWorkspace is not null)
            {
                builder.UseSetting($"Parasol:Atlas:Employees:{employee}:WorkspaceId", credentialWorkspace);
                builder.UseSetting($"Parasol:Atlas:Employees:{employee}:Token", Token);
            }
        });
    }

    private HttpClient Client(WebApplicationFactory<Program> host, string role = CrmRoles.Technician, string? key = null)
    {
        var client = host.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false });
        client.DefaultRequestHeaders.Add(TestAuthHandler.RolesHeader, role);
        client.DefaultRequestHeaders.Add(TestAuthHandler.UserHeader, key ?? _key);
        return client;
    }

    internal static object Context(string clientId, string workspace = Workspace) => JsonSerializer.Deserialize<JsonElement>(
        File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "atlas-context.v1.example.json"))
            .Replace("synthetic-client", clientId, StringComparison.Ordinal).Replace("synthetic-workspace", workspace, StringComparison.Ordinal));

    [Fact]
    public async Task One_BFF_session_reads_only_a_linked_customer_with_its_employees_Atlas_token()
    {
        var (id, clientId) = await LinkedCustomer();
        using var atlas = WireMockServer.Start();
        atlas.Given(Request.Create().WithPath($"/clients/{clientId}/overview").UsingGet().WithHeader("Authorization", $"Bearer {Token}"))
            .RespondWith(Response.Create().WithHeader("Content-Type", "application/json").WithBody(JsonSerializer.Serialize(Context(clientId))));
        await using var host = await Host(atlas);
        using var client = Client(host);
        var response = await client.GetAsync(PathFor(id) + "?workspaceId=other&clientId=other&url=http://example.invalid");
        response.StatusCode.ShouldBe(HttpStatusCode.OK);
        response.Headers.CacheControl!.NoStore.ShouldBeTrue();
        var view = (await response.Content.ReadFromJsonAsync<AtlasWorkspaceView>())!;
        view.Status.ShouldBe("READY"); view.CustomerId.ShouldBe(id);
        view.Summary!.KnownDevices.ShouldBe(2); view.Summary.ActiveObservations.ShouldBe(3);
        view.Summary.Devices[0].Hostname.ShouldBe("SYNTHETIC-LT-01");
        view.Summary.Devices[0].Sources.ShouldBe(["atera", "huntress"]);
        view.Summary.ObservationPage.Items[0].Severity.ShouldBe("CRITICAL");
        view.Summary.ObservationPage.Items[0].Priority.ShouldBe("URGENT");
        view.Summary.ObservationPage.Items[0].Route.ShouldBe("MONITOR");
        view.Summary.ObservationPage.Items[0].DeviceId.ShouldBe("device-one");
        view.Summary.ObservationPage.Items[1].DeviceStatus.ShouldBe("UNRESOLVED");
        view.Summary.ObservationPage.Items[2].DeviceStatus.ShouldBe("UNAVAILABLE");
        view.Summary.Resources[0].Status.ShouldBe("STALE"); view.Summary.Resources[0].Truncated.ShouldBeTrue();
        view.Summary.Resources[1].ReturnedItems.ShouldBeNull();
        var body = await response.Content.ReadAsStringAsync();
        foreach (var excluded in new[] { Token, "private", "workspaceId", "clientId", "connectionId" }) body.ShouldNotContain(excluded);
        atlas.LogEntries.Count.ShouldBe(1);
        atlas.LogEntries.Single().RequestMessage!.Headers!.ContainsKey("Cookie").ShouldBeFalse();

        using var outsider = Client(host, key: "unprovisioned-" + _key);
        (await outsider.GetFromJsonAsync<AtlasWorkspaceView>(PathFor(id)))!.Status.ShouldBe("ACCESS_DENIED");
        atlas.LogEntries.Count.ShouldBe(1);
        using var finance = Client(host, CrmRoles.Finance);
        (await finance.GetAsync(PathFor(id))).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        using var anonymous = host.CreateClient();
        (await anonymous.GetAsync(PathFor(id))).StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
        atlas.LogEntries.Count.ShouldBe(1);
    }

    [Theory]
    [InlineData(401, "ACCESS_DENIED")]
    [InlineData(403, "ACCESS_DENIED")]
    [InlineData(404, "SOURCE_NOT_FOUND")]
    [InlineData(429, "UNAVAILABLE")]
    [InlineData(500, "UNAVAILABLE")]
    [InlineData(302, "UNAVAILABLE")]
    public async Task Source_errors_and_redirects_never_expose_upstream_bodies(int status, string expected)
    {
        var (id, clientId) = await LinkedCustomer();
        using var atlas = WireMockServer.Start();
        atlas.Given(Request.Create().WithPath($"/clients/{clientId}/overview").UsingGet()).RespondWith(
            Response.Create().WithStatusCode(status).WithHeader("Location", atlas.Url + "/must-not-follow")
                .WithBody("synthetic-private-upstream-body"));
        await using var host = await Host(atlas);
        var view = await Client(host).GetFromJsonAsync<AtlasWorkspaceView>(PathFor(id));
        view!.Status.ShouldBe(expected); view.Summary.ShouldBeNull(); atlas.LogEntries.Count.ShouldBe(1);
    }

    [Theory]
    [InlineData("workspace")]
    [InlineData("customer")]
    [InlineData("invalid-json")]
    [InlineData("too-large")]
    [InlineData("negative-count")]
    [InlineData("nested-device")]
    [InlineData("nested-person")]
    [InlineData("nested-link")]
    [InlineData("nested-observation")]
    [InlineData("priority-floor")]
    public async Task Untrusted_or_mismatched_responses_are_rejected(string scenario)
    {
        var (id, clientId) = await LinkedCustomer();
        using var atlas = WireMockServer.Start();
        var body = scenario switch
        {
            "workspace" => JsonSerializer.Serialize(Context(clientId, "other-workspace")),
            "customer" => JsonSerializer.Serialize(Context("other-customer")),
            "invalid-json" => "{}",
            "too-large" => new string('x', 2 * 1024 * 1024 + 1),
            _ => JsonSerializer.Serialize(Context(clientId)).Replace("\"total\":3", "\"total\":-1", StringComparison.Ordinal),
        };
        if (scenario.StartsWith("nested-", StringComparison.Ordinal) || scenario == "priority-floor")
        {
            var node = JsonNode.Parse(JsonSerializer.Serialize(Context(clientId)))!;
            switch (scenario)
            {
                case "nested-device": node["devices"]![0]!["clientId"] = "other-customer"; break;
                case "nested-person": node["people"]![0]!["workspaceId"] = "other-workspace"; break;
                case "nested-link": node["links"]![0]!["clientId"] = "other-customer"; break;
                case "nested-observation": node["observations"]!["items"]![0]!["clientId"] = "other-customer"; break;
                case "priority-floor": node["observations"]!["items"]![0]!["priority"] = "NORMAL"; break;
            }
            body = node.ToJsonString();
        }
        atlas.Given(Request.Create().WithPath($"/clients/{clientId}/overview").UsingGet())
            .RespondWith(Response.Create().WithHeader("Content-Type", "application/json").WithBody(body));
        await using var host = await Host(atlas);
        var view = await Client(host).GetFromJsonAsync<AtlasWorkspaceView>(PathFor(id));
        view!.Status.ShouldBe("INVALID_RESPONSE"); view.Summary.ShouldBeNull();
    }

    [Fact]
    public async Task Revoking_personal_access_does_not_return_previous_devices_or_observations()
    {
        var (id, clientId) = await LinkedCustomer();
        using var atlas = WireMockServer.Start();
        atlas.Given(Request.Create().WithPath($"/clients/{clientId}/overview").UsingGet())
            .RespondWith(Response.Create().WithHeader("Content-Type", "application/json").WithBody(JsonSerializer.Serialize(Context(clientId))));
        await using var host = await Host(atlas); using var client = Client(host);
        var first = (await client.GetFromJsonAsync<AtlasWorkspaceView>(PathFor(id)))!;
        first.Summary!.Devices.Count.ShouldBe(2); first.Summary.ObservationPage.Items.Count.ShouldBe(3);
        atlas.Reset();
        atlas.Given(Request.Create().WithPath($"/clients/{clientId}/overview")).RespondWith(Response.Create().WithStatusCode(403).WithBody("synthetic-private"));
        var response = await client.GetAsync(PathFor(id));
        response.Headers.CacheControl!.NoStore.ShouldBeTrue();
        var denied = (await response.Content.ReadFromJsonAsync<AtlasWorkspaceView>())!;
        denied.Status.ShouldBe("ACCESS_DENIED"); denied.Summary.ShouldBeNull();
        var body = await response.Content.ReadAsStringAsync(); body.ShouldNotContain("SYNTHETIC-LT"); body.ShouldNotContain("synthetic-private");
    }

    [Theory]
    [InlineData("unlink")]
    [InlineData("same-pair")]
    [InlineData("different-pair")]
    [InlineData("unchanged")]
    public async Task Source_read_is_bound_to_the_original_LinkId_and_requires_a_fresh_read_after_relink(string change)
    {
        var (id, clientId) = await LinkedCustomer();
        using var atlas = WireMockServer.Start();
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var resume = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var handler = new DelayedResponse(entered, resume);
        await using var host = await Host(atlas, handler: handler);
        using var client = Client(host);
        var identityPath = $"/api/v1/parasol/customers/{id}/identity";
        var original = (await Admin.GetFromJsonAsync<CustomerIdentityView>(identityPath))!;
        var currentClient = change == "different-pair" ? $"client-{Guid.NewGuid():N}" : clientId;
        var pending = client.GetFromJsonAsync<AtlasWorkspaceView>(PathFor(id));
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        try
        {
            if (change != "unchanged")
            {
                (await Admin.DeleteAsync($"/api/v1/integrations/links/{original.LinkId}")).StatusCode.ShouldBe(HttpStatusCode.NoContent);
                if (change != "unlink") await Link(id, currentClient);
            }
        }
        finally { resume.TrySetResult(); }
        var result = await pending;
        handler.Calls.ShouldBe(1); // No automatic replay against a new mapping.
        if (change == "unchanged")
        {
            result!.Status.ShouldBe("READY"); result.Summary!.KnownDevices.ShouldBe(2);
            return;
        }
        result!.Status.ShouldBe("IDENTITY_CHANGED"); result.Summary.ShouldBeNull();
        JsonSerializer.Serialize(result).ShouldNotContain("SYNTHETIC-LT");
        var freshIdentity = (await Admin.GetFromJsonAsync<CustomerIdentityView>(identityPath))!;
        freshIdentity.LinkId.ShouldNotBe(original.LinkId);
        if (change != "unlink") freshIdentity.Atlas!.ClientId.ShouldBe(currentClient);
        var fresh = (await client.GetFromJsonAsync<AtlasWorkspaceView>(PathFor(id)))!;
        fresh.Status.ShouldBe(change == "unlink" ? "NOT_LINKED" : "READY");
        if (change == "unlink") fresh.Summary.ShouldBeNull();
        else fresh.Summary!.KnownDevices.ShouldBe(2);
        handler.Calls.ShouldBe(change == "unlink" ? 1 : 2);
    }

    private sealed class DelayedResponse(TaskCompletionSource entered, TaskCompletionSource resume) : HttpMessageHandler
    {
        private int calls;
        public int Calls => Volatile.Read(ref calls);
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref calls);
            var clientId = request.RequestUri!.Segments[2].TrimEnd('/');
            entered.TrySetResult();
            await resume.Task.WaitAsync(cancellationToken);
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(JsonSerializer.Serialize(Context(clientId)), System.Text.Encoding.UTF8, "application/json"),
            };
        }
    }

    [Fact]
    public async Task Missing_mapping_configuration_and_cross_workspace_credentials_make_no_source_request()
    {
        var (id, _) = await LinkedCustomer();
        (await Admin.GetFromJsonAsync<AtlasWorkspaceView>(PathFor(id)))!.Status.ShouldBe("NOT_CONFIGURED");
        using var atlas = WireMockServer.Start();
        await using var host = await Host(atlas, "other-workspace");
        (await Client(host).GetFromJsonAsync<AtlasWorkspaceView>(PathFor(id)))!.Status.ShouldBe("ACCESS_DENIED");
        (await Client(host).GetAsync(PathFor(Guid.NewGuid()))).StatusCode.ShouldBe(HttpStatusCode.NotFound);
        var response = await Admin.PostAsJsonAsync("/api/v1/customers/organizations", TestData.Organization($"Unlinked {Guid.NewGuid():N} AS"));
        var unlinked = (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        (await Client(host).GetFromJsonAsync<AtlasWorkspaceView>(PathFor(unlinked)))!.Status.ShouldBe("NOT_LINKED");
        atlas.LogEntries.ShouldBeEmpty();
    }
}
