using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
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

public sealed class AtlasObservationQueueApiTests(CrmWebFactory factory)
{
    private readonly string _key = $"queue-{Guid.NewGuid():N}";
    private const string Workspace = "synthetic-workspace";
    private const string Token = "synthetic-atlas-queue-personal-token";
    private const string SourceCursor = "synthetic_private_atlas_cursor";
    private static string PathFor(Guid id) => $"/api/v1/parasol/customers/{id}/observations";
    private HttpClient Admin => factory.ClientAs(CrmRoles.Admin, _key);

    private async Task<(Guid CustomerId, string ClientId)> LinkedCustomer()
    {
        var response = await Admin.PostAsJsonAsync("/api/v1/customers/organizations", TestData.Organization($"Queue {Guid.NewGuid():N} AS"));
        response.StatusCode.ShouldBe(HttpStatusCode.Created);
        var id = (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        var clientId = $"client-{Guid.NewGuid():N}";
        await Link(id, clientId);
        return (id, clientId);
    }

    private async Task Link(Guid id, string clientId)
    {
        var input = new CustomerIdentityImport(new(1, "atlas", Workspace, [new(clientId, "Synthetic")]), [new(clientId, id)]);
        const string endpoint = "/api/v1/parasol/customer-identities/import";
        var preview = await Admin.PostAsJsonAsync(endpoint, input);
        preview.StatusCode.ShouldBe(HttpStatusCode.OK);
        var hash = (await preview.Content.ReadFromJsonAsync<CustomerIdentityPlan>())!.Sha256;
        (await Admin.PostAsJsonAsync($"{endpoint}?dryRun=false&expectedSha256={hash}", input)).StatusCode.ShouldBe(HttpStatusCode.OK);
    }

    private async Task<WebApplicationFactory<Program>> Host(WireMockServer atlas, HttpMessageHandler? handler = null, string? credentialWorkspace = Workspace)
    {
        var employee = (await Admin.GetFromJsonAsync<JsonElement>("/bff/user")).GetProperty("id").GetGuid();
        return factory.WithWebHostBuilder(builder =>
        {
            builder.UseSetting("Parasol:Atlas:Enabled", "true"); builder.UseSetting("Parasol:Atlas:BaseUrl", atlas.Url!);
            if (credentialWorkspace is not null)
            {
                builder.UseSetting($"Parasol:Atlas:Employees:{employee}:WorkspaceId", credentialWorkspace);
                builder.UseSetting($"Parasol:Atlas:Employees:{employee}:Token", Token);
            }
            if (handler is not null) builder.ConfigureTestServices(services => services.AddHttpClient(AtlasWorkspaceRegistration.ClientName)
                .ConfigurePrimaryHttpMessageHandler(() => handler));
        });
    }

    private HttpClient Client(WebApplicationFactory<Program> host, string role = CrmRoles.Technician, string? key = null)
    {
        var client = host.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false });
        client.DefaultRequestHeaders.Add(TestAuthHandler.RolesHeader, role); client.DefaultRequestHeaders.Add(TestAuthHandler.UserHeader, key ?? _key);
        return client;
    }

    private static JsonNode Context(string clientId) => JsonNode.Parse(JsonSerializer.Serialize(AtlasWorkspaceTests.Context(clientId)))!;
    private static JsonNode Page(string clientId, int size = 25, int total = 30, string? cursor = SourceCursor, string status = "OPEN")
    {
        var page = Context(clientId)["observations"]!.DeepClone(); var row = page["items"]![0]!.DeepClone();
        row["status"] = status;
        page["items"] = new JsonArray(Enumerable.Range(0, size).Select(i => { var item = row.DeepClone(); item["id"] = $"observation-{size}-{i:D3}"; return item; }).ToArray());
        foreach (var severity in AtlasProjectionJson.Severities) page["counts"]![severity] = severity == "CRITICAL" ? total : 0;
        page["total"] = total; page["nextCursor"] = cursor; page["truncated"] = cursor is not null;
        return page;
    }

    private static void AnswerOverview(WireMockServer atlas, string clientId, JsonNode? overview = null) =>
        atlas.Given(Request.Create().WithPath($"/clients/{clientId}/overview").UsingGet().WithHeader("Authorization", $"Bearer {Token}"))
            .RespondWith(Response.Create().WithHeader("Content-Type", "application/json").WithBody((overview ?? Context(clientId)).ToJsonString()));

    private static void AnswerPage(WireMockServer atlas, string clientId, JsonNode page, string? cursor = null, string status = "OPEN,ACKNOWLEDGED", string? deviceId = null)
    {
        var request = Request.Create().WithPath($"/clients/{clientId}/observations").UsingGet().WithHeader("Authorization", $"Bearer {Token}")
            .WithParam("limit", "25").WithParam("severity", "CRITICAL").WithParam("status", status);
        if (cursor is not null) request.WithParam("cursor", cursor);
        if (deviceId is not null) request.WithParam("deviceId", deviceId);
        atlas.Given(request).AtPriority(cursor is null ? 5 : 1)
            .RespondWith(Response.Create().WithHeader("Content-Type", "application/json").WithHeader("Set-Cookie", "synthetic-private=1").WithBody(page.ToJsonString()));
    }

    [Fact]
    public async Task Pages_use_personal_access_fixed_filters_and_an_opaque_continuation_without_writing_source_or_identity()
    {
        var (id, clientId) = await LinkedCustomer(); using var atlas = WireMockServer.Start();
        AnswerOverview(atlas, clientId); AnswerPage(atlas, clientId, Page(clientId)); AnswerPage(atlas, clientId, Page(clientId, 5, 30, null), SourceCursor);
        await using var host = await Host(atlas); using var client = Client(host);
        client.DefaultRequestHeaders.Add("Cookie", "synthetic-browser-session=private");
        var firstResponse = await client.GetAsync(PathFor(id) + "?severity=CRITICAL&status=ACTIVE&limit=999&clientId=other&url=https://example.invalid");
        firstResponse.StatusCode.ShouldBe(HttpStatusCode.OK); firstResponse.Headers.CacheControl!.NoStore.ShouldBeTrue();
        firstResponse.Headers.Contains("Set-Cookie").ShouldBeFalse();
        var first = (await firstResponse.Content.ReadFromJsonAsync<AtlasObservationQueueView>())!;
        first.Status.ShouldBe("READY"); first.Queue!.Items.Count.ShouldBe(25); first.Queue.Total.ShouldBe(30);
        first.Queue.Severity.ShouldBe("CRITICAL"); first.Queue.Status.ShouldBe("ACTIVE"); first.Queue.NextCursor.ShouldNotBeNull();
        first.Queue.Items[0].DeviceId.ShouldBe("device-one"); first.Queue.Devices.Count.ShouldBe(2);
        var body = await firstResponse.Content.ReadAsStringAsync();
        foreach (var excluded in new[] { Token, SourceCursor, "synthetic-private", "workspaceId", "clientId", "connectionId" }) body.ShouldNotContain(excluded);
        var second = (await client.GetFromJsonAsync<AtlasObservationQueueView>(PathFor(id) + $"?severity=CRITICAL&status=ACTIVE&cursor={Uri.EscapeDataString(first.Queue.NextCursor!)}"))!;
        second.Status.ShouldBe("READY"); second.Queue!.Items.Count.ShouldBe(5); second.Queue.Total.ShouldBe(30); second.Queue.NextCursor.ShouldBeNull();
        atlas.LogEntries.Count.ShouldBe(4);
        atlas.LogEntries.All(l => !l.RequestMessage!.Headers!.ContainsKey("Cookie")).ShouldBeTrue();
        atlas.LogEntries.All(l => l.RequestMessage!.Method == "GET").ShouldBeTrue();
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
        (await db.ExternalLinks.CountAsync(l => l.EntityId == id && l.System == "Atlas")).ShouldBe(1);
    }

    [Fact]
    public async Task Invalid_cross_filter_employee_customer_cursors_and_replaced_links_never_call_Atlas()
    {
        var (id, clientId) = await LinkedCustomer(); var (otherId, _) = await LinkedCustomer(); using var atlas = WireMockServer.Start();
        AnswerOverview(atlas, clientId); AnswerPage(atlas, clientId, Page(clientId));
        await using var host = await Host(atlas); using var client = Client(host);
        var cursor = (await client.GetFromJsonAsync<AtlasObservationQueueView>(PathFor(id) + "?severity=CRITICAL"))!.Queue!.NextCursor!;
        var query = $"?severity=CRITICAL&cursor={Uri.EscapeDataString(cursor)}";
        foreach (var path in new[] { PathFor(id) + query.Replace("CRITICAL", "HIGH", StringComparison.Ordinal), PathFor(id) + query + "&status=RESOLVED",
            PathFor(otherId) + query, PathFor(id) + "?severity=CRITICAL&cursor=tampered" })
            (await client.GetFromJsonAsync<AtlasObservationQueueView>(path))!.Status.ShouldBe("INVALID_CURSOR");
        using var outsider = Client(host, key: "other-" + _key);
        (await outsider.GetFromJsonAsync<AtlasObservationQueueView>(PathFor(id) + query))!.Status.ShouldBe("INVALID_CURSOR");
        using (var scope = factory.Services.CreateScope())
        {
            var link = await scope.ServiceProvider.GetRequiredService<IntegrationDbContext>().ExternalLinks.AsNoTracking().SingleAsync(l => l.EntityId == id && l.System == "Atlas");
            (await Admin.DeleteAsync($"/api/v1/integrations/links/{link.Id}")).StatusCode.ShouldBe(HttpStatusCode.NoContent);
        }
        await Link(id, clientId);
        (await client.GetFromJsonAsync<AtlasObservationQueueView>(PathFor(id) + query))!.Status.ShouldBe("IDENTITY_CHANGED");
        atlas.LogEntries.Count.ShouldBe(2);
    }

    [Fact]
    public async Task A_trusted_continuation_after_rebinding_to_another_Atlas_client_invalidates_the_parent_identity_without_source_reads()
    {
        var (id, clientId) = await LinkedCustomer(); using var atlas = WireMockServer.Start();
        AnswerOverview(atlas, clientId); AnswerPage(atlas, clientId, Page(clientId));
        await using var host = await Host(atlas); using var client = Client(host);
        var cursor = (await client.GetFromJsonAsync<AtlasObservationQueueView>(PathFor(id) + "?severity=CRITICAL"))!.Queue!.NextCursor!;
        using (var scope = factory.Services.CreateScope())
        {
            var link = await scope.ServiceProvider.GetRequiredService<IntegrationDbContext>().ExternalLinks.AsNoTracking().SingleAsync(l => l.EntityId == id && l.System == "Atlas");
            (await Admin.DeleteAsync($"/api/v1/integrations/links/{link.Id}")).StatusCode.ShouldBe(HttpStatusCode.NoContent);
        }
        await Link(id, "replacement-" + clientId);
        var view = (await client.GetFromJsonAsync<AtlasObservationQueueView>(PathFor(id) + $"?severity=CRITICAL&cursor={Uri.EscapeDataString(cursor)}"))!;
        view.Status.ShouldBe("IDENTITY_CHANGED"); view.Queue.ShouldBeNull(); atlas.LogEntries.Count.ShouldBe(2);
    }

    [Fact]
    public async Task Terminal_statuses_are_selected_upstream_and_filter_validation_is_strict()
    {
        var (id, clientId) = await LinkedCustomer(); using var atlas = WireMockServer.Start();
        AnswerOverview(atlas, clientId); AnswerPage(atlas, clientId, Page(clientId, 1, 1, null, "RESOLVED"), status: "RESOLVED");
        await using var host = await Host(atlas); using var client = Client(host);
        foreach (var query in new[] { "?severity=urgent", "?status=0", "?severity=HIGH,CRITICAL", "?status=OPEN,SUPPRESSED" })
        {
            var response = await client.GetAsync(PathFor(id) + query);
            response.StatusCode.ShouldBe(HttpStatusCode.BadRequest); response.Headers.CacheControl!.NoStore.ShouldBeTrue();
            (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString().ShouldBe("PARASOL_ATLAS_QUEUE_FILTER_INVALID");
        }
        atlas.LogEntries.ShouldBeEmpty();
        var view = (await client.GetFromJsonAsync<AtlasObservationQueueView>(PathFor(id) + "?severity=CRITICAL&status=RESOLVED"))!;
        view.Status.ShouldBe("READY"); view.Queue!.Items.Single().Status.ShouldBe("RESOLVED"); atlas.LogEntries.Count.ShouldBe(2);
    }

    [Theory]
    [InlineData("nested-scope")][InlineData("selection-counts")][InlineData("selection-status")][InlineData("priority")]
    [InlineData("overview-scope")][InlineData("oversized")][InlineData("wrong-type")]
    public async Task Invalid_source_data_never_returns_any_queue(string scenario)
    {
        var (id, clientId) = await LinkedCustomer(); using var atlas = WireMockServer.Start(); var overview = Context(clientId); var page = Page(clientId, 1, 1, null);
        switch (scenario)
        {
            case "nested-scope": page["items"]![0]!["clientId"] = "other"; break;
            case "selection-counts": page["counts"]!["CRITICAL"] = 0; page["counts"]!["MEDIUM"] = 1; break;
            case "selection-status": page["items"]![0]!["status"] = "RESOLVED"; break;
            case "priority": page["items"]![0]!["priority"] = "NORMAL"; break;
            case "overview-scope": overview["devices"]![0]!["clientId"] = "other"; break;
        }
        AnswerOverview(atlas, clientId, overview);
        atlas.Given(Request.Create().WithPath($"/clients/{clientId}/observations")).RespondWith(Response.Create()
            .WithHeader("Content-Type", scenario == "wrong-type" ? "text/plain" : "application/json")
            .WithBody(scenario == "oversized" ? new string('x', 1_048_577) : page.ToJsonString()));
        await using var host = await Host(atlas); using var client = Client(host);
        var view = (await client.GetFromJsonAsync<AtlasObservationQueueView>(PathFor(id) + "?severity=CRITICAL"))!;
        view.Status.ShouldBe("INVALID_RESPONSE"); view.Queue.ShouldBeNull();
    }

    [Fact]
    public async Task Fixture_mode_does_not_pretend_to_apply_filters_and_revocation_discards_previous_queue_data()
    {
        var (id, clientId) = await LinkedCustomer(); using var atlas = WireMockServer.Start();
        var fixture = Context(clientId); fixture["mode"] = "fixture"; fixture["completeness"] = "COMPLETE_FIXTURE";
        AnswerOverview(atlas, clientId, fixture); await using var host = await Host(atlas); using var client = Client(host);
        var unsupported = (await client.GetFromJsonAsync<AtlasObservationQueueView>(PathFor(id)))!;
        unsupported.Status.ShouldBe("QUEUE_NOT_SUPPORTED"); unsupported.Queue.ShouldBeNull(); atlas.LogEntries.Count.ShouldBe(1);
        atlas.Reset(); AnswerOverview(atlas, clientId); AnswerPage(atlas, clientId, Page(clientId, 1, 1, null));
        (await client.GetFromJsonAsync<AtlasObservationQueueView>(PathFor(id) + "?severity=CRITICAL"))!.Status.ShouldBe("READY");
        atlas.Reset(); AnswerOverview(atlas, clientId);
        atlas.Given(Request.Create().WithPath($"/clients/{clientId}/observations")).RespondWith(Response.Create().WithStatusCode(403).WithBody("synthetic-private"));
        var denied = (await client.GetFromJsonAsync<AtlasObservationQueueView>(PathFor(id) + "?severity=CRITICAL"))!;
        denied.Status.ShouldBe("ACCESS_DENIED"); denied.Queue.ShouldBeNull(); atlas.LogEntries.Count.ShouldBe(2);
    }

    [Theory]
    [InlineData(401, "ACCESS_DENIED")][InlineData(404, "SOURCE_NOT_FOUND")][InlineData(429, "UNAVAILABLE")]
    [InlineData(500, "UNAVAILABLE")][InlineData(302, "UNAVAILABLE")]
    public async Task Queue_source_errors_are_sanitized_with_no_redirect_or_retry(int status, string expected)
    {
        var (id, clientId) = await LinkedCustomer(); using var atlas = WireMockServer.Start(); AnswerOverview(atlas, clientId);
        atlas.Given(Request.Create().WithPath($"/clients/{clientId}/observations")).RespondWith(Response.Create().WithStatusCode(status)
            .WithHeader("Location", atlas.Url + "/must-not-follow").WithBody("synthetic-private-error"));
        await using var host = await Host(atlas); using var client = Client(host);
        var response = await client.GetAsync(PathFor(id));
        response.Headers.CacheControl!.NoStore.ShouldBeTrue();
        var view = (await response.Content.ReadFromJsonAsync<AtlasObservationQueueView>())!;
        view.Status.ShouldBe(expected); view.Queue.ShouldBeNull();
        (await response.Content.ReadAsStringAsync()).ShouldNotContain("synthetic-private"); atlas.LogEntries.Count.ShouldBe(2);
    }

    [Fact]
    public async Task A_rejected_upstream_continuation_is_a_safe_invalid_cursor_result()
    {
        var (id, clientId) = await LinkedCustomer(); using var atlas = WireMockServer.Start();
        AnswerOverview(atlas, clientId); AnswerPage(atlas, clientId, Page(clientId));
        await using var host = await Host(atlas); using var client = Client(host);
        var cursor = (await client.GetFromJsonAsync<AtlasObservationQueueView>(PathFor(id) + "?severity=CRITICAL"))!.Queue!.NextCursor!;
        atlas.Reset(); AnswerOverview(atlas, clientId);
        atlas.Given(Request.Create().WithPath($"/clients/{clientId}/observations")).RespondWith(Response.Create().WithStatusCode(400).WithBody("synthetic-private-error"));
        var view = (await client.GetFromJsonAsync<AtlasObservationQueueView>(PathFor(id) + $"?severity=CRITICAL&cursor={Uri.EscapeDataString(cursor)}"))!;
        view.Status.ShouldBe("INVALID_CURSOR"); view.Queue.ShouldBeNull(); atlas.LogEntries.Count.ShouldBe(2);
    }

    [Fact]
    public async Task The_two_source_reads_share_one_deadline_instead_of_two_independent_ten_second_budgets()
    {
        var (id, clientId) = await LinkedCustomer(); using var atlas = WireMockServer.Start(); using var handler = new SlowReads(clientId);
        await using var host = await Host(atlas, handler); using var client = Client(host);
        var view = (await client.GetFromJsonAsync<AtlasObservationQueueView>(PathFor(id)))!;
        view.Status.ShouldBe("UNAVAILABLE"); view.Queue.ShouldBeNull(); handler.Calls.ShouldBe(2);
        // From the first source read, not from the request: a cold test host spends seconds before it (3 s on a CI runner).
        // One shared deadline ends both 7 s reads at about 10 s; two independent budgets would take 14 s.
        System.Diagnostics.Stopwatch.GetElapsedTime(handler.FirstCallAt).ShouldBeLessThan(TimeSpan.FromSeconds(13));
    }

    [Fact]
    public async Task Session_permission_mapping_configuration_and_employee_workspace_are_required_before_source_reads()
    {
        var (id, _) = await LinkedCustomer(); using var atlas = WireMockServer.Start(); await using var host = await Host(atlas, credentialWorkspace: "other-workspace");
        using var client = Client(host);
        (await client.GetFromJsonAsync<AtlasObservationQueueView>(PathFor(id)))!.Status.ShouldBe("ACCESS_DENIED");
        (await Admin.GetFromJsonAsync<AtlasObservationQueueView>(PathFor(id)))!.Status.ShouldBe("NOT_CONFIGURED");
        (await client.GetAsync(PathFor(Guid.NewGuid()))).StatusCode.ShouldBe(HttpStatusCode.NotFound);
        using var finance = Client(host, CrmRoles.Finance); (await finance.GetAsync(PathFor(id))).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        using var anonymous = host.CreateClient(); (await anonymous.GetAsync(PathFor(id))).StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
        atlas.LogEntries.ShouldBeEmpty();
    }

    [Theory]
    [InlineData(null)]
    [InlineData("device-one")]
    public async Task An_unlink_while_the_page_is_pending_discards_the_whole_queue(string? deviceId)
    {
        var (id, clientId) = await LinkedCustomer(); using var atlas = WireMockServer.Start();
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously); var resume = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var handler = new DelayedPage(clientId, entered, resume);
        await using var host = await Host(atlas, handler); using var client = Client(host);
        var pending = client.GetFromJsonAsync<AtlasObservationQueueView>(PathFor(id) + "?severity=CRITICAL"
            + (deviceId is null ? "" : $"&deviceId={deviceId}"));
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        try
        {
            using var scope = factory.Services.CreateScope();
            var link = await scope.ServiceProvider.GetRequiredService<IntegrationDbContext>().ExternalLinks.AsNoTracking().SingleAsync(l => l.EntityId == id && l.System == "Atlas");
            (await Admin.DeleteAsync($"/api/v1/integrations/links/{link.Id}")).StatusCode.ShouldBe(HttpStatusCode.NoContent);
        }
        finally { resume.TrySetResult(); }
        var view = (await pending)!; view.Status.ShouldBe("IDENTITY_CHANGED"); view.Queue.ShouldBeNull();
    }

    [Fact]
    public async Task A_device_filter_reaches_Atlas_and_remains_bound_across_pages_without_affecting_other_devices()
    {
        var (id, clientId) = await LinkedCustomer(); using var atlas = WireMockServer.Start();
        AnswerOverview(atlas, clientId);
        AnswerPage(atlas, clientId, Page(clientId), deviceId: "device-one");
        AnswerPage(atlas, clientId, Page(clientId, 5, 30, null), SourceCursor, deviceId: "device-one");
        await using var host = await Host(atlas); using var client = Client(host);
        var path = PathFor(id) + "?severity=CRITICAL&deviceId=device-one";
        var first = (await client.GetFromJsonAsync<AtlasObservationQueueView>(path))!;
        first.Status.ShouldBe("READY"); first.Queue!.DeviceId.ShouldBe("device-one"); first.Queue.Total.ShouldBe(30);
        var next = $"&cursor={Uri.EscapeDataString(first.Queue.NextCursor!)}";
        var second = (await client.GetFromJsonAsync<AtlasObservationQueueView>(path + next))!;
        second.Status.ShouldBe("READY"); second.Queue!.DeviceId.ShouldBe("device-one"); second.Queue.Items.Count.ShouldBe(5);
        var reads = atlas.LogEntries.Count;
        foreach (var changed in new[] { path.Replace("device-one", "device-two", StringComparison.Ordinal) + next,
            PathFor(id) + "?severity=CRITICAL" + next })
            (await client.GetFromJsonAsync<AtlasObservationQueueView>(changed))!.Status.ShouldBe("INVALID_CURSOR");
        atlas.LogEntries.Count.ShouldBe(reads); atlas.LogEntries.All(l => l.RequestMessage!.Method == "GET").ShouldBeTrue();
    }

    [Fact]
    public async Task A_missing_device_stops_at_the_registry_and_malformed_or_repeated_device_values_never_call_Atlas()
    {
        var (id, clientId) = await LinkedCustomer(); using var atlas = WireMockServer.Start(); AnswerOverview(atlas, clientId);
        await using var host = await Host(atlas); using var client = Client(host);
        var missing = (await client.GetFromJsonAsync<AtlasObservationQueueView>(PathFor(id) + "?deviceId=other-customer-device"))!;
        missing.Status.ShouldBe("DEVICE_NOT_AVAILABLE"); missing.Queue.ShouldBeNull(); atlas.LogEntries.Count.ShouldBe(1);
        foreach (var query in new[] { "deviceId=", "deviceId=%20", "deviceId=one&deviceId=two", "deviceId=pc%00bad", "deviceId=" + new string('x', 257) })
            (await client.GetAsync(PathFor(id) + "?" + query)).StatusCode.ShouldBe(HttpStatusCode.BadRequest);
        atlas.LogEntries.Count.ShouldBe(1);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("device-two")]
    public async Task A_source_ignoring_the_device_filter_cannot_return_an_unrelated_or_unresolved_page(string? entityId)
    {
        var (id, clientId) = await LinkedCustomer(); using var atlas = WireMockServer.Start(); AnswerOverview(atlas, clientId);
        var page = Page(clientId, 1, 1, null); page["items"]![0]!["entityId"] = entityId;
        AnswerPage(atlas, clientId, page, deviceId: "device-one");
        await using var host = await Host(atlas); using var client = Client(host);
        var result = (await client.GetFromJsonAsync<AtlasObservationQueueView>(PathFor(id) + "?severity=CRITICAL&deviceId=device-one"))!;
        result.Status.ShouldBe("INVALID_RESPONSE"); result.Queue.ShouldBeNull();
    }

    [Fact]
    public async Task Selected_history_keeps_a_stored_entity_without_restoring_its_missing_current_confirmation()
    {
        var (id, clientId) = await LinkedCustomer(); using var atlas = WireMockServer.Start();
        var context = Context(clientId); context["links"] = new JsonArray();
        AnswerOverview(atlas, clientId, context); AnswerPage(atlas, clientId, Page(clientId, 1, 1, null), deviceId: "device-one");
        await using var host = await Host(atlas); using var client = Client(host);
        var result = (await client.GetFromJsonAsync<AtlasObservationQueueView>(PathFor(id) + "?severity=CRITICAL&deviceId=device-one"))!;
        result.Status.ShouldBe("READY"); result.Queue!.DeviceId.ShouldBe("device-one");
        var row = result.Queue.Items.Single(); row.DeviceStatus.ShouldBe("UNAVAILABLE"); row.DeviceId.ShouldBeNull();
    }

    private sealed class DelayedPage(string clientId, TaskCompletionSource entered, TaskCompletionSource resume) : HttpMessageHandler
    {
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var isOverview = request.RequestUri!.AbsolutePath.EndsWith("/overview", StringComparison.Ordinal);
            if (!isOverview) { entered.TrySetResult(); await resume.Task.WaitAsync(cancellationToken); }
            return new(HttpStatusCode.OK) { Content = new StringContent((isOverview ? Context(clientId) : Page(clientId, 1, 1, null)).ToJsonString(), System.Text.Encoding.UTF8, "application/json") };
        }
    }

    private sealed class SlowReads(string clientId) : HttpMessageHandler
    {
        public int Calls { get; private set; }
        public long FirstCallAt { get; private set; }
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            if (Calls++ == 0) FirstCallAt = System.Diagnostics.Stopwatch.GetTimestamp();
            await Task.Delay(TimeSpan.FromSeconds(7), cancellationToken);
            var isOverview = request.RequestUri!.AbsolutePath.EndsWith("/overview", StringComparison.Ordinal);
            return new(HttpStatusCode.OK) { Content = new StringContent((isOverview ? Context(clientId) : Page(clientId, 1, 1, null)).ToJsonString(), System.Text.Encoding.UTF8, "application/json") };
        }
    }
}
