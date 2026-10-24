using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crm.Authorization;
using Crm.Integrations.Core.Parasol;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using WireMock.RequestBuilders;
using WireMock.ResponseBuilders;
using WireMock.Server;

namespace Crm.IntegrationTests;

public sealed class AtlasM365ApiTests(CrmWebFactory factory)
{
    private readonly string key = $"m365-{Guid.NewGuid():N}";
    private HttpClient Admin => factory.ClientAs(CrmRoles.Admin, key);
    private const string Token = "synthetic-m365-read-token-not-a-secret";
    private const string Workspace = "synthetic-workspace";
    private readonly string clientId = $"synthetic-client-{Guid.NewGuid():N}";
    private static string PathFor(Guid id) => $"/api/v1/parasol/customers/{id}/m365";
    private string Body => File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "atlas-overview.v1.example.json")).Replace("synthetic-client", clientId, StringComparison.Ordinal);

    private async Task<Guid> Customer(bool linked = true)
    {
        var response = await Admin.PostAsJsonAsync("/api/v1/customers/organizations", TestData.Organization($"M365 {Guid.NewGuid():N} AS"));
        response.StatusCode.ShouldBe(HttpStatusCode.Created);
        var id = (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        if (linked) await Link(id);
        return id;
    }

    private async Task Link(Guid id, string? selectedClient = null)
    {
        var sourceClient = selectedClient ?? clientId;
        var input = new CustomerIdentityImport(new(1, "atlas", Workspace, [new(sourceClient, "Synthetic")]), [new(sourceClient, id)]);
        const string path = "/api/v1/parasol/customer-identities/import";
        var preview = await Admin.PostAsJsonAsync(path, input); preview.StatusCode.ShouldBe(HttpStatusCode.OK);
        var hash = (await preview.Content.ReadFromJsonAsync<CustomerIdentityPlan>())!.Sha256;
        (await Admin.PostAsJsonAsync($"{path}?dryRun=false&expectedSha256={hash}", input)).StatusCode.ShouldBe(HttpStatusCode.OK);
    }

    private async Task<WebApplicationFactory<Program>> Host(WireMockServer source, HttpMessageHandler? handler = null)
    {
        var employee = (await Admin.GetFromJsonAsync<JsonElement>("/bff/user")).GetProperty("id").GetGuid();
        return factory.WithWebHostBuilder(builder =>
        {
            builder.UseSetting("Parasol:Atlas:Enabled", "true"); builder.UseSetting("Parasol:Atlas:BaseUrl", source.Url!);
            builder.UseSetting($"Parasol:Atlas:Employees:{employee}:WorkspaceId", Workspace);
            builder.UseSetting($"Parasol:Atlas:Employees:{employee}:Token", Token);
            if (handler is not null) builder.ConfigureTestServices(services => services.AddHttpClient("Parasol.Atlas").ConfigurePrimaryHttpMessageHandler(() => handler));
        });
    }

    private HttpClient Client(WebApplicationFactory<Program> host, string role = CrmRoles.Technician, string? employee = null)
    {
        var client = host.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false });
        client.DefaultRequestHeaders.Add(TestAuthHandler.RolesHeader, role); client.DefaultRequestHeaders.Add(TestAuthHandler.UserHeader, employee ?? key);
        return client;
    }

    [Fact]
    public async Task Reads_only_the_current_customers_metadata_with_the_employees_credential_and_no_private_source_fields()
    {
        var id = await Customer(); using var source = WireMockServer.Start();
        source.Given(Request.Create().WithPath($"/clients/{clientId}/m365/overview").UsingGet().WithHeader("Authorization", $"Bearer {Token}"))
            .RespondWith(Response.Create().WithHeader("Content-Type", "application/json").WithBody(Body));
        await using var host = await Host(source); using var client = Client(host);
        var response = await client.GetAsync(PathFor(id) + "?clientId=foreign&connectionId=foreign&url=http://example.invalid");
        response.StatusCode.ShouldBe(HttpStatusCode.OK); response.Headers.CacheControl!.NoStore.ShouldBeTrue();
        var view = (await response.Content.ReadFromJsonAsync<AtlasM365View>())!;
        view.CustomerId.ShouldBe(id); view.Status.ShouldBe("READY"); view.Summary!.Connections[0].Directory[0].Count.ShouldBe(14);
        view.Summary.Connections[0].SignIns.Gaps.Count.ShouldBe(2);
        var text = await response.Content.ReadAsStringAsync();
        foreach (var hidden in new[] { Token, "workspaceId", "clientId", "tenantId", "secretRef", "userPrincipalName", "dto" }) text.ShouldNotContain(hidden);
        source.LogEntries.Count.ShouldBe(1); (source.LogEntries.Single().RequestMessage!.Query?.Count ?? 0).ShouldBe(0);
        using var finance = Client(host, CrmRoles.Finance); (await finance.GetAsync(PathFor(id))).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        using var anonymous = host.CreateClient(); (await anonymous.GetAsync(PathFor(id))).StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
        using var outsider = Client(host, employee: "unconfigured-" + key);
        (await outsider.GetFromJsonAsync<AtlasM365View>(PathFor(id)))!.Status.ShouldBe("ACCESS_DENIED"); source.LogEntries.Count.ShouldBe(1);
    }

    [Theory]
    [InlineData(401, "ACCESS_DENIED")]
    [InlineData(403, "ACCESS_DENIED")]
    [InlineData(404, "NOT_SUPPORTED")]
    [InlineData(429, "UNAVAILABLE")]
    [InlineData(500, "UNAVAILABLE")]
    [InlineData(302, "UNAVAILABLE")]
    public async Task Does_not_expose_upstream_errors_redirect_or_retry(int status, string expected)
    {
        var id = await Customer(); using var source = WireMockServer.Start();
        source.Given(Request.Create().WithPath($"/clients/{clientId}/m365/overview")).RespondWith(Response.Create().WithStatusCode(status)
            .WithHeader("Location", source.Url + "/private").WithBody("synthetic-private-error"));
        await using var host = await Host(source);
        var response = await Client(host).GetAsync(PathFor(id)); var view = (await response.Content.ReadFromJsonAsync<AtlasM365View>())!;
        view.Status.ShouldBe(expected); view.Summary.ShouldBeNull();
        (await response.Content.ReadAsStringAsync()).ShouldNotContain("private"); source.LogEntries.Count.ShouldBe(1);
    }

    [Theory]
    [InlineData("foreign")]
    [InlineData("extra")]
    [InlineData("oversized")]
    public async Task Invalid_scope_private_extra_fields_or_oversize_discard_the_entire_view(string change)
    {
        var id = await Customer(); using var source = WireMockServer.Start();
        var body = change == "foreign" ? Body.Replace("synthetic-workspace", "foreign", StringComparison.Ordinal)
            : change == "extra" ? Body.Replace("\"mode\": \"db\",", "\"mode\": \"db\", \"tenantId\": \"synthetic-private\",", StringComparison.Ordinal)
            : new string('x', 131_073);
        source.Given(Request.Create().WithPath($"/clients/{clientId}/m365/overview")).RespondWith(Response.Create().WithHeader("Content-Type", "application/json").WithBody(body));
        await using var host = await Host(source);
        var view = (await Client(host).GetFromJsonAsync<AtlasM365View>(PathFor(id)))!;
        view.Status.ShouldBe("INVALID_RESPONSE"); view.Summary.ShouldBeNull(); source.LogEntries.Count.ShouldBe(1);
    }

    [Fact]
    public async Task Unlinked_customer_does_not_contact_Atlas()
    {
        var id = await Customer(linked: false); using var source = WireMockServer.Start(); await using var host = await Host(source);
        (await Client(host).GetFromJsonAsync<AtlasM365View>(PathFor(id)))!.Status.ShouldBe("NOT_LINKED"); source.LogEntries.ShouldBeEmpty();
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Replacement_of_the_link_during_the_read_discards_metadata_even_for_the_same_pair(bool samePair)
    {
        var id = await Customer(); using var source = WireMockServer.Start();
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var handler = new Delayed(entered, release, Body); await using var host = await Host(source, handler);
        var original = (await Admin.GetFromJsonAsync<CustomerIdentityView>($"/api/v1/parasol/customers/{id}/identity"))!;
        var pending = Client(host).GetFromJsonAsync<AtlasM365View>(PathFor(id));
        try
        {
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
            (await Admin.DeleteAsync($"/api/v1/integrations/links/{original.LinkId}")).StatusCode.ShouldBe(HttpStatusCode.NoContent);
            await Link(id, samePair ? clientId : clientId + "-replacement");
        }
        finally { release.TrySetResult(); }
        var view = (await pending)!; view.Status.ShouldBe("IDENTITY_CHANGED"); view.Summary.ShouldBeNull();
        handler.Calls.ShouldBe(1);
    }

    private sealed class Delayed(TaskCompletionSource entered, TaskCompletionSource release, string body) : HttpMessageHandler
    {
        private int calls;
        internal int Calls => Volatile.Read(ref calls);
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref calls); entered.TrySetResult(); await release.Task.WaitAsync(cancellationToken);
            return new(HttpStatusCode.OK) { Content = new StringContent(body, System.Text.Encoding.UTF8, "application/json") };
        }
    }
}
