using System.Net;
using System.Net.Http.Json;
using System.Security.Claims;
using System.Text.Json;
using Crm.Authorization;
using Crm.Integrations.Core.Parasol;
using Crm.Integrations.Core.Persistence;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using WireMock.RequestBuilders;
using WireMock.ResponseBuilders;
using WireMock.Server;

namespace Crm.IntegrationTests;

public sealed class AtlasIdentityApiTests(CrmWebFactory factory)
{
    private const string Endpoint = "/api/v1/parasol/customer-identities/atlas-export";
    private const string Token = "synthetic-directory-employee-one";
    private readonly string _key = $"directory-{Guid.NewGuid():N}";
    private readonly string _workspace = $"workspace-{Guid.NewGuid():N}";

    private async Task<WebApplicationFactory<Program>> Host(WireMockServer atlas, bool stale = false, int limit = 10)
    {
        using var first = factory.ClientAs(CrmRoles.Admin, _key);
        using var second = factory.ClientAs(CrmRoles.Admin, _key + "-two");
        var employee = (await first.GetFromJsonAsync<JsonElement>("/bff/user")).GetProperty("id").GetGuid();
        var other = (await second.GetFromJsonAsync<JsonElement>("/bff/user")).GetProperty("id").GetGuid();
        return factory.WithWebHostBuilder(builder =>
        {
            builder.UseSetting("Parasol:Atlas:Enabled", "true");
            builder.UseSetting("Parasol:Atlas:BaseUrl", atlas.Url!);
            builder.UseSetting($"Parasol:Atlas:Employees:{employee}:WorkspaceId", _workspace);
            builder.UseSetting($"Parasol:Atlas:Employees:{employee}:Token", Token);
            builder.UseSetting($"Parasol:Atlas:Employees:{other}:WorkspaceId", _workspace);
            builder.UseSetting($"Parasol:Atlas:Employees:{other}:Token", Token + "-two");
            builder.UseSetting("RateLimits:ExportsPerHour", limit.ToString(System.Globalization.CultureInfo.InvariantCulture));
            if (stale) builder.ConfigureTestServices(services => services.AddTransient<IClaimsTransformation, OldAuthentication>());
        });
    }

    private HttpClient Client(WebApplicationFactory<Program> host, string role = CrmRoles.Admin, string? key = null)
    {
        var client = host.CreateClient(new() { AllowAutoRedirect = false });
        client.DefaultRequestHeaders.Add(TestAuthHandler.RolesHeader, role);
        client.DefaultRequestHeaders.Add(TestAuthHandler.UserHeader, key ?? _key);
        return client;
    }

    private void Answer(WireMockServer atlas, string token, string clientId) => atlas
        .Given(Request.Create().WithPath("/clients/identity-export").UsingGet().WithHeader("Authorization", $"Bearer {token}"))
        .RespondWith(Response.Create().WithHeader("Content-Type", "application/json").WithHeader("Set-Cookie", "synthetic-private=not-forwarded")
            .WithBody(JsonSerializer.Serialize(new { schemaVersion = 1, source = "atlas", workspaceId = _workspace, clients = new[] { new { clientId, name = "Synthetic client" } } })));

    [Fact]
    public async Task BFF_reads_each_employees_own_directory_without_writing_customer_links_or_forwarding_credentials()
    {
        using var atlas = WireMockServer.Start();
        Answer(atlas, Token, "first"); Answer(atlas, Token + "-two", "second");
        await using var host = await Host(atlas);
        using var first = Client(host); first.DefaultRequestHeaders.Add("Cookie", "synthetic-bff-cookie=private");
        using var second = Client(host, key: _key + "-two");
        var response = await first.GetAsync(Endpoint + "?url=https://elsewhere.invalid&workspaceId=foreign&token=browser-value");
        response.StatusCode.ShouldBe(HttpStatusCode.OK); response.Headers.CacheControl!.NoStore.ShouldBeTrue();
        var firstView = (await response.Content.ReadFromJsonAsync<AtlasIdentityExportView>())!;
        firstView.Status.ShouldBe("READY"); firstView.Snapshot!.Clients.Single().ClientId.ShouldBe("first");
        firstView.Snapshot.WorkspaceId.ShouldBe(_workspace); firstView.RetrievedAt.ShouldNotBeNull();
        (await response.Content.ReadAsStringAsync()).ShouldNotContain(Token);
        response.Headers.Contains("Set-Cookie").ShouldBeFalse();
        var secondView = (await second.GetFromJsonAsync<AtlasIdentityExportView>(Endpoint))!;
        secondView.Snapshot!.Clients.Single().ClientId.ShouldBe("second");
        atlas.LogEntries.Count.ShouldBe(2);
        foreach (var entry in atlas.LogEntries)
        {
            entry.RequestMessage!.Headers!.ContainsKey("Cookie").ShouldBeFalse();
            entry.RequestMessage.Query?.Count.ShouldBe(0);
        }
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
        var keys = new[] { "first", "second" }.Select(id => CustomerIdentityContract.ExternalId(_workspace, id)).ToArray();
        (await db.ExternalRecords.AnyAsync(r => r.System == "Atlas" && keys.Contains(r.ExternalId))).ShouldBeFalse();
        (await db.ExternalLinks.AnyAsync(l => l.System == "Atlas" && keys.Contains(l.ExternalId))).ShouldBeFalse();
    }

    [Fact]
    public async Task Anonymous_insufficient_roles_and_missing_employee_credentials_do_not_reach_Atlas()
    {
        using var atlas = WireMockServer.Start(); await using var host = await Host(atlas);
        using var anonymous = host.CreateClient(new() { AllowAutoRedirect = false });
        (await anonymous.GetAsync(Endpoint)).StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
        foreach (var role in new[] { CrmRoles.Technician, CrmRoles.Finance, CrmRoles.ReadOnly })
        {
            using var denied = Client(host, role);
            (await denied.GetAsync(Endpoint)).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        }
        using var unmapped = Client(host, key: _key + "-unmapped");
        (await unmapped.GetFromJsonAsync<AtlasIdentityExportView>(Endpoint))!.Status.ShouldBe("ACCESS_DENIED");
        using var disabled = factory.ClientAs(CrmRoles.Admin, _key);
        (await disabled.GetFromJsonAsync<AtlasIdentityExportView>(Endpoint))!.Status.ShouldBe("NOT_CONFIGURED");
        atlas.LogEntries.ShouldBeEmpty();
    }

    [Fact]
    public async Task A_directory_export_requires_fresh_interactive_authentication_even_though_it_is_a_GET()
    {
        using var atlas = WireMockServer.Start(); await using var host = await Host(atlas, stale: true);
        using var client = Client(host);
        var response = await client.GetAsync(Endpoint);
        response.StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString().ShouldBe("AUTH_REVERIFY_REQUIRED");
        atlas.LogEntries.ShouldBeEmpty();
    }

    [Fact]
    public async Task Redirects_are_not_followed_and_upstream_secrets_are_not_returned()
    {
        using var atlas = WireMockServer.Start();
        atlas.Given(Request.Create().WithPath("/clients/identity-export")).RespondWith(Response.Create().WithStatusCode(302)
            .WithHeader("Location", atlas.Url + "/must-not-follow").WithBody("synthetic-private-body"));
        await using var host = await Host(atlas); using var client = Client(host);
        var response = await client.GetAsync(Endpoint);
        response.StatusCode.ShouldBe(HttpStatusCode.OK);
        var view = (await response.Content.ReadFromJsonAsync<AtlasIdentityExportView>())!;
        view.Status.ShouldBe("UNAVAILABLE"); view.Snapshot.ShouldBeNull();
        (await response.Content.ReadAsStringAsync()).ShouldNotContain("synthetic-private");
        atlas.LogEntries.Count.ShouldBe(1);
    }

    [Fact]
    public async Task Revoked_source_access_removes_the_directory_on_the_next_read()
    {
        using var atlas = WireMockServer.Start(); Answer(atlas, Token, "first");
        await using var host = await Host(atlas); using var client = Client(host);
        (await client.GetFromJsonAsync<AtlasIdentityExportView>(Endpoint))!.Status.ShouldBe("READY");
        atlas.Reset();
        atlas.Given(Request.Create().WithPath("/clients/identity-export")).RespondWith(Response.Create().WithStatusCode(403).WithBody("synthetic-private"));
        var denied = (await client.GetFromJsonAsync<AtlasIdentityExportView>(Endpoint))!;
        denied.Status.ShouldBe("ACCESS_DENIED"); denied.Snapshot.ShouldBeNull(); denied.RetrievedAt.ShouldBeNull();
    }

    [Fact]
    public async Task The_existing_export_rate_limit_also_bounds_Atlas_requests()
    {
        using var atlas = WireMockServer.Start(); Answer(atlas, Token, "first");
        await using var host = await Host(atlas, limit: 1); using var client = Client(host);
        (await client.GetAsync(Endpoint)).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await client.GetAsync(Endpoint)).StatusCode.ShouldBe(HttpStatusCode.TooManyRequests);
        atlas.LogEntries.Count.ShouldBe(1);
    }

    private sealed class OldAuthentication : IClaimsTransformation
    {
        public Task<ClaimsPrincipal> TransformAsync(ClaimsPrincipal principal)
        {
            var copy = principal.Clone(); var identity = (ClaimsIdentity)copy.Identity!;
            foreach (var claim in identity.FindAll(PermissionAuthorization.AuthTimeClaim).ToArray()) identity.RemoveClaim(claim);
            identity.AddClaim(new(PermissionAuthorization.AuthTimeClaim, "1"));
            return Task.FromResult(copy);
        }
    }
}
