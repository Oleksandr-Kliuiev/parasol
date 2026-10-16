using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crm.Authorization;
using Crm.Integrations.Core.Parasol;
using Crm.Integrations.Core.Persistence;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
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
        var input = new CustomerIdentityImport(new(1, "atlas", Workspace, [new(clientId, "Synthetic")]), [new(clientId, customerId)]);
        var path = "/api/v1/parasol/customer-identities/import";
        var preview = await Admin.PostAsJsonAsync(path, input);
        preview.StatusCode.ShouldBe(HttpStatusCode.OK);
        var hash = (await preview.Content.ReadFromJsonAsync<CustomerIdentityPlan>())!.Sha256;
        (await Admin.PostAsJsonAsync($"{path}?dryRun=false&expectedSha256={hash}", input)).StatusCode.ShouldBe(HttpStatusCode.OK);
        return (customerId, clientId);
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

    internal static object Context(string clientId, string workspace = Workspace) => new
    {
        contractVersion = "ClientContextV1", workspaceId = workspace, clientId, mode = "db", completeness = "PARTIAL",
        generatedAt = "2026-10-16T10:00:00Z", clientName = "Synthetic private customer name",
        devices = new[] { new { name = "private-device" } }, people = new[] { new { email = "synthetic-private@example.invalid" } },
        observations = new { total = 3, counts = new { INFO = 0, LOW = 0, MEDIUM = 1, HIGH = 1, CRITICAL = 1 } },
        resources = new object[]
        {
            new { source = "atera", resourceType = "agent", status = "STALE", asOf = "2026-10-15T10:00:00Z", lastSuccessAt = "2026-10-15T10:00:00Z", items = new[] { new { secret = "synthetic-private-payload" } }, truncated = true },
            new { source = "huntress", resourceType = "incident", status = "MISSING", asOf = (string?)null, lastSuccessAt = (string?)null, items = (object?)null, truncated = false },
        },
    };

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
        view.Summary!.KnownDevices.ShouldBe(1); view.Summary.ActiveObservations.ShouldBe(3);
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
        atlas.Given(Request.Create().WithPath($"/clients/{clientId}/overview").UsingGet())
            .RespondWith(Response.Create().WithHeader("Content-Type", "application/json").WithBody(body));
        await using var host = await Host(atlas);
        var view = await Client(host).GetFromJsonAsync<AtlasWorkspaceView>(PathFor(id));
        view!.Status.ShouldBe("INVALID_RESPONSE"); view.Summary.ShouldBeNull();
    }

    [Fact]
    public async Task Unlinking_while_Atlas_is_answering_discards_the_old_customer_snapshot()
    {
        var (id, clientId) = await LinkedCustomer();
        using var atlas = WireMockServer.Start();
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var resume = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var handler = new DelayedResponse(entered, resume, clientId);
        await using var host = await Host(atlas, handler: handler);
        using var client = Client(host);
        var pending = client.GetFromJsonAsync<AtlasWorkspaceView>(PathFor(id));
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        try
        {
            using var scope = factory.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
            var link = await db.ExternalLinks.AsNoTracking().SingleAsync(l => l.System == "Atlas" && l.EntityId == id);
            (await Admin.DeleteAsync($"/api/v1/integrations/links/{link.Id}")).StatusCode.ShouldBe(HttpStatusCode.NoContent);
        }
        finally { resume.TrySetResult(); }
        var result = await pending;
        result!.Status.ShouldBe("IDENTITY_CHANGED"); result.Summary.ShouldBeNull();
    }

    private sealed class DelayedResponse(TaskCompletionSource entered, TaskCompletionSource resume, string clientId) : HttpMessageHandler
    {
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
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
