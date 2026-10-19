using System.Net;
using System.Net.Http.Json;
using System.Text;
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

public sealed class AtlasAttentionApiTests(CrmWebFactory factory)
{
    private const string Endpoint = "/api/v1/parasol/my-day/atlas-attention";
    private const string Workspace = "synthetic-workspace";
    private const string Token = "synthetic-attention-personal-token";
    private readonly string key = $"attention-{Guid.NewGuid():N}";
    private HttpClient Admin => factory.ClientAs(CrmRoles.Admin, key);

    private async Task<Guid> Customer(string? name = null)
    {
        var response = await Admin.PostAsJsonAsync("/api/v1/customers/organizations", new { name = name ?? $"Attention {Guid.NewGuid():N} AS", status = "Customer" });
        response.StatusCode.ShouldBe(HttpStatusCode.Created);
        return (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
    }
    private async Task Link(Guid customer, string client, string workspace = Workspace)
    {
        var input = new CustomerIdentityImport(new(1, "atlas", workspace, [new(client, "Synthetic source name")]), [new(client, customer)]);
        const string path = "/api/v1/parasol/customer-identities/import";
        var preview = await Admin.PostAsJsonAsync(path, input); preview.StatusCode.ShouldBe(HttpStatusCode.OK);
        var sha = (await preview.Content.ReadFromJsonAsync<CustomerIdentityPlan>())!.Sha256;
        (await Admin.PostAsJsonAsync($"{path}?dryRun=false&expectedSha256={sha}", input)).StatusCode.ShouldBe(HttpStatusCode.OK);
    }
    private async Task<Guid> LinkId(Guid customer) => (await Admin.GetFromJsonAsync<CustomerIdentityView>($"/api/v1/parasol/customers/{customer}/identity"))!.LinkId!.Value;
    private static string SourceClient() => "client-" + Guid.NewGuid().ToString("N");
    private static string Directory(params string[] clients) => JsonSerializer.Serialize(new AtlasIdentitySnapshot(1, "atlas", Workspace,
        clients.Select(client => new AtlasIdentityClient(client, "Untrusted source display name")).ToArray()), CustomerIdentityContract.JsonOptions);
    private static string Context(string client) => JsonSerializer.Serialize(AtlasWorkspaceTests.Context(client));
    private static HttpResponseMessage Json(string body) => new(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
    private static void DirectoryResponse(WireMockServer atlas, string body, string token = Token) => atlas.Given(Request.Create()
        .WithPath("/clients/identity-export").UsingGet().WithHeader("Authorization", "Bearer " + token))
        .RespondWith(Response.Create().WithHeader("Content-Type", "application/json").WithBody(body));
    private static void Overview(WireMockServer atlas, string client) => atlas.Given(Request.Create().WithPath($"/clients/{client}/overview").UsingGet())
        .RespondWith(Response.Create().WithHeader("Content-Type", "application/json").WithBody(Context(client)));

    private async Task<WebApplicationFactory<Program>> Host(WireMockServer atlas, HttpMessageHandler? handler = null,
        (Guid Employee, string Token)? second = null, Func<IServiceScopeFactory, IAtlasAttentionWorkspaces>? workspaces = null)
    {
        var employee = (await Admin.GetFromJsonAsync<JsonElement>("/bff/user")).GetProperty("id").GetGuid();
        return factory.WithWebHostBuilder(builder =>
        {
            builder.UseSetting("Parasol:Atlas:Enabled", "true"); builder.UseSetting("Parasol:Atlas:BaseUrl", atlas.Url!);
            builder.UseSetting($"Parasol:Atlas:Employees:{employee}:WorkspaceId", Workspace);
            builder.UseSetting($"Parasol:Atlas:Employees:{employee}:Token", Token);
            if (second is { } other)
            {
                builder.UseSetting($"Parasol:Atlas:Employees:{other.Employee}:WorkspaceId", Workspace);
                builder.UseSetting($"Parasol:Atlas:Employees:{other.Employee}:Token", other.Token);
            }
            builder.ConfigureTestServices(services =>
            {
                if (handler is not null) services.AddHttpClient(AtlasWorkspaceRegistration.ClientName).ConfigurePrimaryHttpMessageHandler(() => handler);
                if (workspaces is not null) services.AddScoped<IAtlasAttentionWorkspaces>(provider => workspaces(provider.GetRequiredService<IServiceScopeFactory>()));
            });
        });
    }
    private HttpClient Client(WebApplicationFactory<Program> host, string role = CrmRoles.Technician, string? userKey = null)
    {
        var client = host.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false });
        client.DefaultRequestHeaders.Add(TestAuthHandler.RolesHeader, role); client.DefaultRequestHeaders.Add(TestAuthHandler.UserHeader, userKey ?? key);
        client.DefaultRequestHeaders.Add("X-CSRF", "1"); return client;
    }

    [Fact]
    public async Task Nonadministrators_read_only_their_personal_directory_intersection_and_current_CRM_names()
    {
        var first = SourceClient(); var second = SourceClient(); var unmapped = SourceClient(); var collision = SourceClient();
        var one = await Customer("Current CRM name " + key); var two = await Customer(); var foreign = await Customer();
        await Link(one, first); await Link(two, second); await Link(foreign, collision, "foreign-workspace");
        var otherKey = "other-" + key;
        var otherEmployee = (await factory.ClientAs(CrmRoles.Technician, otherKey).GetFromJsonAsync<JsonElement>("/bff/user")).GetProperty("id").GetGuid();
        const string otherToken = "synthetic-attention-other-personal-token";
        using var atlas = WireMockServer.Start(); DirectoryResponse(atlas, Directory(first, unmapped, collision)); DirectoryResponse(atlas, Directory(second), otherToken);
        Overview(atlas, first); Overview(atlas, second);
        await using var host = await Host(atlas, second: (otherEmployee, otherToken)); using var client = Client(host);
        var response = await client.GetAsync(Endpoint + "?employeeId=ignored&accountManagerId=ignored&limit=10000");
        response.StatusCode.ShouldBe(HttpStatusCode.OK); response.Headers.CacheControl!.NoStore.ShouldBeTrue();
        var view = (await response.Content.ReadFromJsonAsync<AtlasAttentionView>())!;
        view.Status.ShouldBe("PARTIAL"); view.Coverage.ShouldBe(new(3, 1, 1, 1, 1, 0, 0, 2, 0, false, false));
        var row = view.Customers!.Single(); row.CustomerId.ShouldBe(one); row.CustomerName.ShouldBe("Current CRM name " + key);
        row.Preview.Count.ShouldBe(2); row.Preview[0].Severity.ShouldBe("CRITICAL"); row.Devices.Single().Id.ShouldBe("device-one");
        row.Resources!.Any(resource => resource.Status == "STALE").ShouldBeTrue();
        var body = await response.Content.ReadAsStringAsync();
        foreach (var forbidden in new[] { Token, first, second, collision, "Untrusted source display", "private", "connectionId", "workspaceId" }) body.ShouldNotContain(forbidden);
        (await client.GetAsync("/api/v1/parasol/customer-identities/atlas-export")).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        using var other = Client(host, userKey: otherKey);
        (await other.GetFromJsonAsync<AtlasAttentionView>(Endpoint))!.Customers!.Single().CustomerId.ShouldBe(two);
        atlas.LogEntries.Count.ShouldBe(4); atlas.LogEntries.All(entry => entry.RequestMessage!.Method == "GET").ShouldBeTrue();
        atlas.LogEntries.All(entry => !entry.RequestMessage!.Headers!.ContainsKey("Cookie")).ShouldBeTrue();
        using var finance = Client(host, CrmRoles.Finance); (await finance.GetAsync(Endpoint)).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        using var outsider = Client(host, userKey: "outsider-" + key); (await outsider.GetFromJsonAsync<AtlasAttentionView>(Endpoint))!.Status.ShouldBe("ACCESS_DENIED");
        using var anonymous = host.CreateClient(); (await anonymous.GetAsync(Endpoint)).StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
        atlas.LogEntries.Count.ShouldBe(4);
    }

    [Theory]
    [InlineData("oversized-prefix")]
    [InlineData("foreign-tuple")]
    [InlineData("uppercase-key")]
    [InlineData("deleted-customer")]
    public async Task Invalid_stored_mapping_is_a_coverage_issue_and_never_causes_an_overview_read(string scenario)
    {
        var customer = await Customer(); var source = SourceClient(); await Link(customer, source);
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
            var externalId = CustomerIdentityContract.ExternalId(Workspace, source);
            var record = await db.ExternalRecords.SingleAsync(row => row.System == "Atlas" && row.ExternalType == "Client" && row.ExternalId == externalId);
            if (scenario == "uppercase-key")
            {
                var link = await db.ExternalLinks.SingleAsync(row => row.System == "Atlas" && row.ExternalType == "Client" && row.ExternalId == externalId);
                db.Entry(link).Property(row => row.ExternalId).CurrentValue = externalId.ToUpperInvariant();
                db.Entry(record).Property(row => row.ExternalId).CurrentValue = externalId.ToUpperInvariant();
            }
            record.Payload = JsonSerializer.Serialize(new AtlasCustomerReference(scenario == "foreign-tuple" ? "foreign-workspace" : Workspace, source), CustomerIdentityContract.JsonOptions)
                + (scenario == "oversized-prefix" ? new string(' ', 4100) + "synthetic-private-trailing-junk" : "");
            await db.SaveChangesAsync();
        }
        if (scenario == "deleted-customer")
            await factory.AdminSqlAsync($"UPDATE customers.Organizations SET IsDeleted=1 WHERE Id='{customer:D}';");
        using var atlas = WireMockServer.Start(); DirectoryResponse(atlas, Directory(source)); Overview(atlas, source);
        await using var host = await Host(atlas); var view = (await Client(host).GetFromJsonAsync<AtlasAttentionView>(Endpoint))!;
        view.Status.ShouldBe("PARTIAL"); view.Coverage.ShouldBe(new(1, 0, 0, 0, 0, 0, 0, 0, 1, false, false)); view.Customers.ShouldBeEmpty();
        view.Totals.ShouldBe(new(0, 0, 0));
        atlas.LogEntries.Count.ShouldBe(1); JsonSerializer.Serialize(view).ShouldNotContain("synthetic-private");
    }

    [Theory]
    [InlineData(503, "PARTIAL")]
    [InlineData(403, "ACCESS_DENIED")]
    public async Task An_unavailable_customer_is_partial_but_source_denial_clears_the_whole_personal_aggregate(int status, string expected)
    {
        var first = SourceClient(); var second = SourceClient(); var one = await Customer(); var two = await Customer();
        await Link(one, first); await Link(two, second);
        using var atlas = WireMockServer.Start(); DirectoryResponse(atlas, Directory(first, second)); Overview(atlas, first);
        atlas.Given(Request.Create().WithPath($"/clients/{second}/overview").UsingGet()).RespondWith(Response.Create().WithStatusCode(status).WithBody("synthetic-private-provider-body"));
        await using var host = await Host(atlas); var response = await Client(host).GetAsync(Endpoint);
        var view = (await response.Content.ReadFromJsonAsync<AtlasAttentionView>())!; view.Status.ShouldBe(expected);
        if (status == 403)
        {
            view.Customers.ShouldBeNull(); view.Totals.ShouldBeNull(); view.Coverage!.ReadyCustomers.ShouldBeInRange(0, 1);
            view.Coverage.FailedCustomers.ShouldBe(2 - view.Coverage.ReadyCustomers); view.Coverage.TimedOut.ShouldBeFalse();
            atlas.LogEntries.Count.ShouldBeInRange(2, 3); // Cancellation can prevent the other overview from starting.
        }
        else
        {
            view.Coverage!.ReadyCustomers.ShouldBe(1); view.Coverage.FailedCustomers.ShouldBe(1);
            view.Customers!.Single(row => row.CustomerId == two).Status.ShouldBe("UNAVAILABLE"); view.Totals!.Critical.ShouldBe(1); atlas.LogEntries.Count.ShouldBe(3);
        }
        (await response.Content.ReadAsStringAsync()).ShouldNotContain("synthetic-private");
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Unlink_rebind_or_replaced_same_pair_LinkId_during_source_read_discards_all_technical_fields(bool samePair)
    {
        var customer = await Customer(); var source = SourceClient(); await Link(customer, source); var original = await LinkId(customer);
        using var atlas = WireMockServer.Start(); var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously); var calls = 0;
        using var handler = new Handler(async (request, ct) =>
        {
            Interlocked.Increment(ref calls);
            if (request.RequestUri!.AbsolutePath == "/clients/identity-export") return Json(Directory(source));
            entered.TrySetResult(); await release.Task.WaitAsync(ct); return Json(Context(source));
        });
        await using var host = await Host(atlas, handler); using var client = Client(host); var pending = client.GetAsync(Endpoint);
        try
        {
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
            (await Admin.DeleteAsync($"/api/v1/integrations/links/{original}")).StatusCode.ShouldBe(HttpStatusCode.NoContent);
            await Link(samePair ? customer : await Customer(), source);
        }
        finally { release.TrySetResult(); }
        var view = (await (await pending).Content.ReadFromJsonAsync<AtlasAttentionView>())!;
        view.Status.ShouldBe("PARTIAL"); var row = view.Customers!.Single(); row.Status.ShouldBe("IDENTITY_CHANGED");
        row.Preview.ShouldBeEmpty(); row.Devices.ShouldBeEmpty(); row.Resources.ShouldBeNull(); row.ActiveObservations.ShouldBeNull();
        view.Totals.ShouldBe(new(0, 0, 0)); calls.ShouldBe(2);
        if (samePair) (await LinkId(customer)).ShouldNotBe(original);
    }

    [Fact]
    public async Task Final_publication_checks_the_LinkId_of_a_customer_that_finished_before_a_later_customer()
    {
        var one = await Customer("A " + key); var two = await Customer("B " + key); var first = SourceClient(); var second = SourceClient();
        await Link(one, first); await Link(two, second); var original = await LinkId(one);
        using var atlas = WireMockServer.Start(); DirectoryResponse(atlas, Directory(first, second)); Overview(atlas, first); Overview(atlas, second);
        var completed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously); var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var host = await Host(atlas, workspaces: scopes => new ObservedWorkspaces(new AtlasAttentionWorkspaces(scopes), one, completed, release));
        using var client = Client(host); var pending = client.GetAsync(Endpoint);
        try
        {
            await completed.Task.WaitAsync(TimeSpan.FromSeconds(10));
            (await Admin.DeleteAsync($"/api/v1/integrations/links/{original}")).StatusCode.ShouldBe(HttpStatusCode.NoContent);
            await Link(one, first);
        }
        finally { release.TrySetResult(); }
        var view = (await (await pending).Content.ReadFromJsonAsync<AtlasAttentionView>())!;
        view.Status.ShouldBe("PARTIAL"); view.Coverage!.ReadyCustomers.ShouldBe(1);
        view.Customers!.Single(row => row.CustomerId == one).Status.ShouldBe("IDENTITY_CHANGED");
        view.Customers!.Single(row => row.CustomerId == two).Status.ShouldBe("READY"); view.Totals!.Critical.ShouldBe(1);
    }

    private sealed class Handler(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> reply) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) => reply(request, cancellationToken);
    }
    private sealed class ObservedWorkspaces(IAtlasAttentionWorkspaces inner, Guid first, TaskCompletionSource completed, TaskCompletionSource release) : IAtlasAttentionWorkspaces
    {
        public async Task<AtlasWorkspaceView> ReadAsync(AtlasAttentionBinding binding, CancellationToken ct)
        {
            var result = await inner.ReadAsync(binding, ct);
            if (binding.CustomerId == first) completed.TrySetResult(); else await release.Task.WaitAsync(ct);
            return result;
        }
    }
}
