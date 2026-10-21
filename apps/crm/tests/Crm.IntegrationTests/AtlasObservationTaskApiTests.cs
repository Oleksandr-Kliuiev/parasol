using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using Crm.Authorization;
using Crm.Integrations.Core.Parasol;
using Crm.Integrations.Core.Persistence;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using WireMock.RequestBuilders;
using WireMock.ResponseBuilders;
using WireMock.Server;

namespace Crm.IntegrationTests;

public sealed class AtlasObservationTaskApiTests(CrmWebFactory factory)
{
    private readonly string _key = $"handoff-{Guid.NewGuid():N}";
    private const string Workspace = "synthetic-workspace";
    private const string Token = "synthetic-atlas-task-personal-token";
    private const string ObservationId = "observation-off-first-page";
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { Converters = { new JsonStringEnumConverter() } };
    private HttpClient Admin => factory.ClientAs(CrmRoles.Admin, _key);
    private static string PathFor(Guid customer, string suffix) => $"/api/v1/parasol/customers/{customer}/observations/{ObservationId}/{suffix}";

    private async Task<(Guid Customer, string Client, Guid Employee)> LinkedCustomer()
    {
        var response = await Admin.PostAsJsonAsync("/api/v1/customers/organizations", TestData.Organization($"Handoff {Guid.NewGuid():N} AS"));
        response.StatusCode.ShouldBe(HttpStatusCode.Created);
        var customer = (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        var client = $"client-{Guid.NewGuid():N}";
        var input = new CustomerIdentityImport(new(1, "atlas", Workspace, [new(client, "Synthetic")]), [new(client, customer)]);
        const string endpoint = "/api/v1/parasol/customer-identities/import";
        var preview = await Admin.PostAsJsonAsync(endpoint, input);
        var hash = (await preview.Content.ReadFromJsonAsync<CustomerIdentityPlan>())!.Sha256;
        (await Admin.PostAsJsonAsync($"{endpoint}?dryRun=false&expectedSha256={hash}", input)).StatusCode.ShouldBe(HttpStatusCode.OK);
        var employee = (await Admin.GetFromJsonAsync<JsonElement>("/bff/user")).GetProperty("id").GetGuid();
        return (customer, client, employee);
    }

    private static JsonNode Context(string client) => JsonNode.Parse(JsonSerializer.Serialize(AtlasWorkspaceTests.Context(client)))!;
    private static JsonNode Observation(string client, string status = "OPEN")
    {
        var row = Context(client)["observations"]!["items"]![0]!.DeepClone();
        row["id"] = ObservationId; row["status"] = status; row["summary"] = "Synthetic confidential source summary";
        row["payload"] = new JsonObject { ["secret"] = "synthetic-excluded-payload" };
        return row;
    }
    private static void Answer(WireMockServer atlas, string client, JsonNode? row = null)
    {
        atlas.Given(Request.Create().WithPath($"/clients/{client}/overview").UsingGet().WithHeader("Authorization", $"Bearer {Token}"))
            .RespondWith(Response.Create().WithHeader("Content-Type", "application/json").WithBody(Context(client).ToJsonString()));
        atlas.Given(Request.Create().WithPath($"/clients/{client}/observations/{ObservationId}").UsingGet().WithHeader("Authorization", $"Bearer {Token}")).AtPriority(5)
            .RespondWith(Response.Create().WithHeader("Content-Type", "application/json").WithBody((row ?? Observation(client)).ToJsonString()));
    }
    private WebApplicationFactory<Program> Host(WireMockServer atlas, Guid employee, Guid? secondEmployee = null) => factory.WithWebHostBuilder(builder =>
    {
        builder.UseSetting("Parasol:Atlas:Enabled", "true"); builder.UseSetting("Parasol:Atlas:BaseUrl", atlas.Url!);
        builder.UseSetting($"Parasol:Atlas:Employees:{employee}:WorkspaceId", Workspace);
        builder.UseSetting($"Parasol:Atlas:Employees:{employee}:Token", Token);
        if (secondEmployee is { } other)
        {
            builder.UseSetting($"Parasol:Atlas:Employees:{other}:WorkspaceId", Workspace);
            builder.UseSetting($"Parasol:Atlas:Employees:{other}:Token", Token + "-other");
        }
    });
    private HttpClient Client(WebApplicationFactory<Program> host, string role = CrmRoles.Technician, string? key = null, bool csrf = true)
    {
        var client = host.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false });
        client.DefaultRequestHeaders.Add(TestAuthHandler.RolesHeader, role); client.DefaultRequestHeaders.Add(TestAuthHandler.UserHeader, key ?? _key);
        if (csrf) client.DefaultRequestHeaders.Add("X-CSRF", "1");
        return client;
    }
    private static async Task<AtlasObservationTaskPreview> Preview(HttpClient client, Guid customer)
    {
        var response = await client.GetAsync(PathFor(customer, "task-preview"));
        response.StatusCode.ShouldBe(HttpStatusCode.OK); response.Headers.CacheControl!.NoStore.ShouldBeTrue();
        return (await response.Content.ReadFromJsonAsync<AtlasObservationTaskPreview>(Json))!;
    }

    [Fact]
    public async Task Exact_personal_source_creates_one_assigned_private_task_visible_in_CRM_and_replay_preserves_completion()
    {
        var (customer, sourceClient, employee) = await LinkedCustomer(); using var atlas = WireMockServer.Start(); Answer(atlas, sourceClient);
        await using var host = Host(atlas, employee); using var client = Client(host);
        var preview = await Preview(client, customer);
        preview.Status.ShouldBe("READY"); preview.CanCreate.ShouldBeTrue(); preview.Task.ShouldBeNull();
        preview.Observation!.Id.ShouldBe(ObservationId); preview.Mode.ShouldBe("db"); preview.Sha256!.Length.ShouldBe(64);
        var input = new AtlasObservationTaskRequest(employee, DateTimeOffset.UtcNow.AddDays(2), preview.Sha256);
        var response = await client.PostAsJsonAsync(PathFor(customer, "task"), input);
        response.StatusCode.ShouldBe(HttpStatusCode.OK); response.Headers.CacheControl!.NoStore.ShouldBeTrue();
        var outcome = (await response.Content.ReadFromJsonAsync<AtlasObservationTaskOutcome>(Json))!;
        outcome.Status.ShouldBe("CREATED"); outcome.Task.Created.ShouldBeTrue(); outcome.Task.AssigneeId.ShouldBe(employee);
        var rows = await client.GetFromJsonAsync<JsonElement>($"/api/v1/activities?organizationId={customer}&mine=true");
        var task = rows.GetProperty("items").EnumerateArray().Single(a => a.GetProperty("id").GetGuid() == outcome.Task.ActivityId);
        task.GetProperty("subject").GetString().ShouldBe("Review technical observation"); task.GetProperty("body").ValueKind.ShouldBe(JsonValueKind.Null);
        task.GetProperty("hasTechnicalSource").GetBoolean().ShouldBeTrue(); task.GetProperty("priority").GetString().ShouldBe("High");
        var technical = await client.GetFromJsonAsync<AtlasObservationTaskPreview>($"/api/v1/parasol/activities/{outcome.Task.ActivityId}/atlas-observation", Json);
        technical!.Observation!.Summary.ShouldBe("Synthetic confidential source summary"); technical.CanCreate.ShouldBeFalse();
        (await client.PostWithETagAsync($"/api/v1/activities/{outcome.Task.ActivityId}/complete", new { }, task.GetProperty("etag").GetString()!))
            .StatusCode.ShouldBe(HttpStatusCode.OK);
        atlas.Reset(); Answer(atlas, sourceClient, Observation(sourceClient, "RESOLVED"));
        var replay = await client.PostAsJsonAsync(PathFor(customer, "task"), input with { DueAt = null });
        replay.StatusCode.ShouldBe(HttpStatusCode.OK);
        var existing = (await replay.Content.ReadFromJsonAsync<AtlasObservationTaskOutcome>(Json))!;
        existing.Status.ShouldBe("EXISTING"); existing.Task.Created.ShouldBeFalse(); existing.Task.ActivityId.ShouldBe(outcome.Task.ActivityId);
        existing.Task.Status.ShouldBe(Crm.Activities.Contracts.ActivityStatus.Done); existing.Task.DueAt.ShouldBe(outcome.Task.DueAt);
        atlas.LogEntries.All(l => l.RequestMessage!.Method == "GET").ShouldBeTrue();
        var serialized = JsonSerializer.Serialize(preview, CustomerIdentityContract.JsonOptions);
        foreach (var excluded in new[] { Token, "workspaceId", "clientId", "synthetic-excluded-payload" }) serialized.ShouldNotContain(excluded);
        // Broad Activities readers get the generic task, never the personal Atlas source.
        using var finance = Client(host, CrmRoles.Finance);
        (await finance.GetAsync($"/api/v1/parasol/activities/{outcome.Task.ActivityId}/atlas-observation")).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        var financeBody = await (await finance.GetAsync($"/api/v1/activities?organizationId={customer}")).Content.ReadAsStringAsync();
        financeBody.ShouldNotContain("confidential"); financeBody.ShouldNotContain("device-one"); financeBody.ShouldNotContain(ObservationId);
    }

    [Fact]
    public async Task Changed_source_and_terminal_source_require_new_review_and_never_create_work()
    {
        var (customer, sourceClient, employee) = await LinkedCustomer(); using var atlas = WireMockServer.Start(); Answer(atlas, sourceClient);
        await using var host = Host(atlas, employee); using var client = Client(host);
        var preview = await Preview(client, customer); var input = new AtlasObservationTaskRequest(employee, null, preview.Sha256!);
        var changed = Observation(sourceClient); changed["summary"] = "Changed after review";
        atlas.Reset(); Answer(atlas, sourceClient, changed);
        var mismatch = await client.PostAsJsonAsync(PathFor(customer, "task"), input);
        mismatch.StatusCode.ShouldBe(HttpStatusCode.Conflict);
        (await mismatch.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString().ShouldBe("PARASOL_TASK_SOURCE_CHANGED");
        atlas.Reset(); Answer(atlas, sourceClient, Observation(sourceClient, "SUPPRESSED"));
        var terminal = await Preview(client, customer); terminal.CanCreate.ShouldBeFalse();
        var refused = await client.PostAsJsonAsync(PathFor(customer, "task"), input with { ExpectedSha256 = terminal.Sha256! });
        refused.StatusCode.ShouldBe(HttpStatusCode.Conflict);
        (await refused.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString().ShouldBe("PARASOL_TASK_SOURCE_TERMINAL");
        var rows = await client.GetFromJsonAsync<JsonElement>($"/api/v1/activities?organizationId={customer}"); rows.GetProperty("items").GetArrayLength().ShouldBe(0);
    }

    [Fact]
    public async Task A_new_employee_cannot_reuse_another_employees_review_even_when_both_can_read_the_same_observation()
    {
        var (customer, sourceClient, employee) = await LinkedCustomer(); using var atlas = WireMockServer.Start(); Answer(atlas, sourceClient);
        var key = "second-" + _key; using var otherAdmin = factory.ClientAs(CrmRoles.Technician, key);
        var other = (await otherAdmin.GetFromJsonAsync<JsonElement>("/bff/user")).GetProperty("id").GetGuid();
        atlas.Given(Request.Create().WithPath($"/clients/{sourceClient}/overview").UsingGet().WithHeader("Authorization", $"Bearer {Token}-other"))
            .RespondWith(Response.Create().WithHeader("Content-Type", "application/json").WithBody(Context(sourceClient).ToJsonString()));
        atlas.Given(Request.Create().WithPath($"/clients/{sourceClient}/observations/{ObservationId}").UsingGet().WithHeader("Authorization", $"Bearer {Token}-other"))
            .RespondWith(Response.Create().WithHeader("Content-Type", "application/json").WithBody(Observation(sourceClient).ToJsonString()));
        await using var host = Host(atlas, employee, other); using var first = Client(host); using var second = Client(host, key: key);
        var reviewed = await Preview(first, customer); var personal = await Preview(second, customer);
        personal.Status.ShouldBe("READY"); personal.Sha256.ShouldNotBe(reviewed.Sha256);
        var wrongReview = await second.PostAsJsonAsync(PathFor(customer, "task"), new AtlasObservationTaskRequest(other, null, reviewed.Sha256!));
        wrongReview.StatusCode.ShouldBe(HttpStatusCode.Conflict);
        (await wrongReview.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString().ShouldBe("PARASOL_TASK_SOURCE_CHANGED");
        var ownReview = await second.PostAsJsonAsync(PathFor(customer, "task"), new AtlasObservationTaskRequest(other, null, personal.Sha256!));
        ownReview.StatusCode.ShouldBe(HttpStatusCode.OK);
    }

    [Theory]
    [InlineData("wrong-row")][InlineData("wrong-scope")][InlineData("invalid-priority")][InlineData("source-denied")][InlineData("source-missing")]
    public async Task Invalid_or_revoked_exact_reads_fail_closed_without_creating_work(string scenario)
    {
        var (customer, sourceClient, employee) = await LinkedCustomer(); using var atlas = WireMockServer.Start();
        var row = Observation(sourceClient);
        switch (scenario)
        {
            case "wrong-row": row["id"] = "different"; break;
            case "wrong-scope": row["workspaceId"] = "other"; break;
            case "invalid-priority": row["priority"] = "NORMAL"; break;
        }
        Answer(atlas, sourceClient, row);
        if (scenario.StartsWith("source-", StringComparison.Ordinal)) atlas.Given(Request.Create().WithPath($"/clients/{sourceClient}/observations/{ObservationId}"))
            .AtPriority(1).RespondWith(Response.Create().WithStatusCode(scenario == "source-denied" ? 403 : 404).WithBody("synthetic-secret-error"));
        await using var host = Host(atlas, employee); using var client = Client(host);
        var preview = await Preview(client, customer);
        preview.Status.ShouldBe(scenario == "source-denied" ? "ACCESS_DENIED" : scenario == "source-missing" ? "OBSERVATION_NOT_FOUND" : "INVALID_RESPONSE");
        preview.Observation.ShouldBeNull(); preview.Devices.ShouldBeNull(); preview.Sha256.ShouldBeNull(); preview.CanCreate.ShouldBeFalse();
        (await client.PostAsJsonAsync(PathFor(customer, "task"), new AtlasObservationTaskRequest(employee, null, new string('a', 64))))
            .StatusCode.ShouldBe(HttpStatusCode.Conflict);
    }

    [Fact]
    public async Task Roles_csrf_closed_request_and_each_employees_personal_credential_are_required()
    {
        var (customer, sourceClient, employee) = await LinkedCustomer(); using var atlas = WireMockServer.Start(); Answer(atlas, sourceClient);
        await using var host = Host(atlas, employee); using var client = Client(host);
        var input = new AtlasObservationTaskRequest(employee, null, new string('a', 64));
        foreach (var role in new[] { CrmRoles.Finance, CrmRoles.Sales })
        {
            using var unauthorized = Client(host, role);
            (await unauthorized.GetAsync(PathFor(customer, "task-preview"))).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
            (await unauthorized.PostAsJsonAsync(PathFor(customer, "task"), input)).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        }
        using var readOnly = Client(host, CrmRoles.ReadOnly);
        (await Preview(readOnly, customer)).CanCreate.ShouldBeFalse();
        (await readOnly.PostAsJsonAsync(PathFor(customer, "task"), input)).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        using var outsider = Client(host, key: "unconfigured-" + _key);
        (await Preview(outsider, customer)).Status.ShouldBe("ACCESS_DENIED");
        using var noCsrf = Client(host, csrf: false);
        (await noCsrf.PostAsJsonAsync(PathFor(customer, "task"), input)).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        (await client.PostAsJsonAsync(PathFor(customer, "task"), new { input.AssigneeId, input.DueAt, input.ExpectedSha256, summary = "Never accept source text" }))
            .StatusCode.ShouldBe(HttpStatusCode.BadRequest);
        atlas.LogEntries.Count.ShouldBe(2); // The read-only personal preview alone called Atlas.
    }

    [Fact]
    public async Task Removed_mapping_blocks_creation_and_old_activity_source_without_reusing_credentials()
    {
        var (customer, sourceClient, employee) = await LinkedCustomer(); using var atlas = WireMockServer.Start(); Answer(atlas, sourceClient);
        await using var host = Host(atlas, employee); using var client = Client(host);
        var preview = await Preview(client, customer); var input = new AtlasObservationTaskRequest(employee, null, preview.Sha256!);
        var created = (await (await client.PostAsJsonAsync(PathFor(customer, "task"), input)).Content.ReadFromJsonAsync<AtlasObservationTaskOutcome>(Json))!;
        using (var scope = factory.Services.CreateScope())
        {
            var link = await scope.ServiceProvider.GetRequiredService<IntegrationDbContext>().ExternalLinks.AsNoTracking().SingleAsync(l => l.EntityId == customer && l.System == "Atlas");
            (await Admin.DeleteAsync($"/api/v1/integrations/links/{link.Id}")).StatusCode.ShouldBe(HttpStatusCode.NoContent);
        }
        atlas.Reset();
        (await Preview(client, customer)).Status.ShouldBe("NOT_LINKED");
        (await client.PostAsJsonAsync(PathFor(customer, "task"), input)).StatusCode.ShouldBe(HttpStatusCode.Conflict);
        var old = await client.GetFromJsonAsync<AtlasObservationTaskPreview>($"/api/v1/parasol/activities/{created.Task.ActivityId}/atlas-observation", Json);
        old!.Status.ShouldBe("IDENTITY_CHANGED"); old.Observation.ShouldBeNull(); atlas.LogEntries.ShouldBeEmpty();
    }

    [Fact]
    public async Task Identity_read_guard_blocks_unlink_until_the_owning_task_callback_finishes()
    {
        var (customer, _, _) = await LinkedCustomer();
        using var scope = factory.Services.CreateScope();
        var identities = scope.ServiceProvider.GetRequiredService<CustomerIdentityService>();
        var identity = (await identities.GetAsync(customer, default)).Value;
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var resume = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var guarded = scope.ServiceProvider.GetRequiredService<CustomerIdentityGuard>().WithCurrentAsync(identity, async ct =>
        {
            entered.TrySetResult(); await resume.Task.WaitAsync(ct); return Crm.SharedKernel.Results.Result<bool>.Success(true);
        }, default);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var unlink = Admin.DeleteAsync($"/api/v1/integrations/links/{identity.LinkId}");
        try { (await Task.WhenAny(unlink, Task.Delay(250))).ShouldNotBe(unlink); }
        finally { resume.TrySetResult(); }
        (await guarded).IsSuccess.ShouldBeTrue(); (await unlink).StatusCode.ShouldBe(HttpStatusCode.NoContent);
        var called = false;
        var stale = await scope.ServiceProvider.GetRequiredService<CustomerIdentityGuard>().WithCurrentAsync(identity, _ =>
        {
            called = true; return Task.FromResult(Crm.SharedKernel.Results.Result<bool>.Success(true));
        }, default);
        stale.Error!.Code.ShouldBe("PARASOL_TASK_IDENTITY_CHANGED"); called.ShouldBeFalse();
    }

    private static string LookupPath(Guid customer, string ids) => $"/api/v1/parasol/customers/{customer}/observation-tasks?ids={ids}";

    [Fact]
    public async Task A_visible_page_reads_the_tasks_its_observations_already_have_for_this_customer_only_and_without_an_Atlas_read()
    {
        var (customer, sourceClient, employee) = await LinkedCustomer(); using var atlas = WireMockServer.Start(); Answer(atlas, sourceClient);
        await using var host = Host(atlas, employee); using var client = Client(host);
        var preview = await Preview(client, customer);
        var created = await client.PostAsJsonAsync(PathFor(customer, "task"), new AtlasObservationTaskRequest(employee, DateTimeOffset.UtcNow.AddDays(1), preview.Sha256!));
        var task = (await created.Content.ReadFromJsonAsync<AtlasObservationTaskOutcome>(Json))!.Task;
        var atlasReads = atlas.LogEntries.Count;
        var response = await client.GetAsync(LookupPath(customer, $"{ObservationId},observation-without-task"));
        response.StatusCode.ShouldBe(HttpStatusCode.OK); response.Headers.CacheControl!.NoStore.ShouldBeTrue();
        var lookup = (await response.Content.ReadFromJsonAsync<AtlasObservationTaskLookup>(Json))!;
        lookup.Status.ShouldBe("READY");
        var item = lookup.Items.ShouldHaveSingleItem();
        item.ObservationId.ShouldBe(ObservationId); item.Task.ActivityId.ShouldBe(task.ActivityId); item.Task.AssigneeId.ShouldBe(employee);
        item.Task.Status.ShouldBe(Crm.Activities.Contracts.ActivityStatus.Open); item.Task.DueAt.ShouldBe(task.DueAt);
        item.AssigneeName.ShouldNotBeNullOrWhiteSpace();
        atlas.LogEntries.Count.ShouldBe(atlasReads, "The lookup answers from CRM tasks; it never reads Atlas.");
        var body = await response.Content.ReadAsStringAsync();
        foreach (var excluded in new[] { Token, "workspaceId", "clientId", sourceClient, "confidential" }) body.ShouldNotContain(excluded);
        // Another customer's mapping never finds this task, even for the same observation identifier.
        var (other, _, _) = await LinkedCustomer();
        (await client.GetFromJsonAsync<AtlasObservationTaskLookup>(LookupPath(other, ObservationId), Json))!.Items.ShouldBeEmpty();
    }

    [Fact]
    public async Task An_unmapped_customer_says_so_and_the_lookup_needs_both_Atlas_and_activity_read_access()
    {
        var response = await Admin.PostAsJsonAsync("/api/v1/customers/organizations", TestData.Organization($"Unmapped {Guid.NewGuid():N} AS"));
        var customer = (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        var lookup = await Admin.GetFromJsonAsync<AtlasObservationTaskLookup>(LookupPath(customer, ObservationId), Json);
        lookup!.Status.ShouldBe("NOT_LINKED"); lookup.Items.ShouldBeEmpty();
        using var finance = factory.ClientAs(CrmRoles.Finance, _key + "-finance");
        (await finance.GetAsync(LookupPath(customer, ObservationId))).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
    }

    [Theory]
    [InlineData("")]
    [InlineData("a/b")]
    [InlineData("a%3Fother=1")]
    [InlineData("many")]
    public async Task The_lookup_takes_only_a_page_of_Atlas_identifiers(string ids)
    {
        var (customer, _, _) = await LinkedCustomer();
        var list = ids == "many" ? string.Join(',', Enumerable.Range(0, 51).Select(i => $"observation-{i}")) : ids;
        var response = await Admin.GetAsync(LookupPath(customer, list));
        response.StatusCode.ShouldBe(HttpStatusCode.BadRequest);
        (await response.Content.ReadAsStringAsync()).ShouldContain("PARASOL_TASK_LOOKUP_INVALID");
    }
}
