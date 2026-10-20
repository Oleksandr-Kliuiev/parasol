using System.Net;
using System.Text;
using System.Text.Json;
using Crm.Authorization;
using Crm.Integrations.Core.Parasol;
using Crm.SharedKernel.Application;
using Microsoft.Extensions.Options;

namespace Crm.UnitTests;

public sealed class AtlasIdentityReaderTests
{
    private static readonly Guid Employee = Guid.Parse("11111111-1111-4111-8111-111111111111");
    private const string Token = "synthetic-employee-atlas-token";
    private static readonly string Fixture = File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "atlas-export.v1.example.json"));
    private static AtlasWorkspaceOptions Config() => new()
    {
        Enabled = true, BaseUrl = "https://atlas.example.invalid/",
        Employees = new() { [Employee.ToString()] = new() { WorkspaceId = "demo-vardahei", Token = Token } },
    };
    private static HttpResponseMessage Json(string body) => new(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
    private static AtlasIdentityReader Reader(Factory factory, AtlasWorkspaceOptions? config = null, ICurrentUser? user = null)
    {
        var options = Options.Create(config ?? Config());
        return new(user ?? new EmployeeUser(Employee), options, new(options, factory), TimeProvider.System);
    }

    [Fact]
    public async Task Reads_the_shared_contract_with_only_the_employees_credential_and_returns_a_timestamp()
    {
        var factory = new Factory((request, _) =>
        {
            request.Method.ShouldBe(HttpMethod.Get);
            request.RequestUri!.AbsoluteUri.ShouldBe("https://atlas.example.invalid/clients/identity-export");
            request.Headers.Authorization!.ToString().ShouldBe($"Bearer {Token}");
            request.Headers.Contains("Cookie").ShouldBeFalse();
            return Task.FromResult(Json(Fixture));
        });
        var before = DateTimeOffset.UtcNow;
        var result = await Reader(factory).ReadAsync(default);
        result.IsSuccess.ShouldBeTrue(); result.Value.Status.ShouldBe("READY");
        result.Value.Snapshot!.Clients.Single().ClientId.ShouldBe("demo-gasta");
        result.Value.RetrievedAt!.Value.ShouldBeGreaterThanOrEqualTo(before);
        JsonSerializer.Serialize(result.Value).ShouldNotContain(Token);
        factory.Calls.ShouldBe(1);
    }

    [Theory]
    [InlineData("disabled", "NOT_CONFIGURED")]
    [InlineData("no-credential", "ACCESS_DENIED")]
    public async Task Missing_configuration_never_calls_the_source(string scenario, string expected)
    {
        var factory = new Factory((_, _) => throw new InvalidOperationException());
        var config = Config();
        if (scenario == "disabled") config.Enabled = false; else config.Employees.Clear();
        var view = (await Reader(factory, config).ReadAsync(default)).Value;
        view.Status.ShouldBe(expected); view.Snapshot.ShouldBeNull(); view.RetrievedAt.ShouldBeNull(); factory.Calls.ShouldBe(0);
    }

    [Theory]
    [InlineData(false, true)]
    [InlineData(true, false)]
    [InlineData(false, false)]
    public async Task Both_permissions_and_an_employee_identity_are_required_even_outside_HTTP(bool manage, bool read)
    {
        var factory = new Factory((_, _) => throw new InvalidOperationException());
        (await Reader(factory, user: new EmployeeUser(Employee, manage, read)).ReadAsync(default)).Error!.Code.ShouldBe("PARASOL_ATLAS_FORBIDDEN");
        (await Reader(factory, user: new EmployeeUser(null)).ReadAsync(default)).IsSuccess.ShouldBeFalse();
        factory.Calls.ShouldBe(0);
    }

    [Fact]
    public async Task An_empty_visible_directory_is_a_successful_empty_snapshot()
    {
        var body = """{"schemaVersion":1,"source":"atlas","workspaceId":"demo-vardahei","clients":[]}""";
        var factory = new Factory((_, _) => Task.FromResult(Json(body)));
        var view = (await Reader(factory).ReadAsync(default)).Value;
        view.Status.ShouldBe("READY"); view.Snapshot!.Clients.ShouldBeEmpty();
    }

    public static IEnumerable<object[]> InvalidResponses()
    {
        const string valid = """{"schemaVersion":1,"source":"atlas","workspaceId":"demo-vardahei","clients":[{"clientId":"one","name":"Synthetic"}]}""";
        foreach (var body in new[] {
            "null", "[]", "{}", "{broken", valid.Replace("demo-vardahei", "foreign"), valid.Replace("\"schemaVersion\":1", "\"schemaVersion\":2"),
            valid.Replace("\"source\":\"atlas\"", "\"source\":\"crm\""), valid.Replace("\"Synthetic\"", "\" \""), valid.Replace("\"one\"", "\"../bad\""),
            valid.Replace("\"clients\":", "\"secret\":\"synthetic-private\",\"clients\":"),
            valid.Replace("\"name\":", "\"token\":\"synthetic-private\",\"name\":"),
            valid.Replace("\"source\":", "\"source\":\"atlas\",\"source\":"),
            valid.Replace("\"name\":", "\"name\":\"Synthetic\",\"name\":"),
            valid.Replace("\"source\":", "\"Source\":"),
            """{"schemaVersion":1,"source":"atlas","workspaceId":"demo-vardahei","clients":null}""",
            JsonSerializer.Serialize(new { schemaVersion = 1, source = "atlas", workspaceId = "demo-vardahei", clients = new[] { new { clientId = "one", name = "One" }, new { clientId = "one", name = "Duplicate" } } }),
            JsonSerializer.Serialize(new { schemaVersion = 1, source = "atlas", workspaceId = "demo-vardahei", clients = Enumerable.Range(0, 1001).Select(i => new { clientId = $"c-{i}", name = "Synthetic" }) }),
        }) yield return [body];
    }

    [Theory]
    [MemberData(nameof(InvalidResponses))]
    public async Task Rejects_the_entire_untrusted_list_without_leaking_payloads(string body)
    {
        var factory = new Factory((_, _) => Task.FromResult(Json(body)));
        var view = (await Reader(factory).ReadAsync(default)).Value;
        view.Status.ShouldBe("INVALID_RESPONSE"); view.Snapshot.ShouldBeNull(); view.RetrievedAt.ShouldBeNull();
        JsonSerializer.Serialize(view).ShouldNotContain("synthetic-private");
    }

    [Theory]
    [InlineData(401, "ACCESS_DENIED")]
    [InlineData(403, "ACCESS_DENIED")]
    [InlineData(404, "SOURCE_NOT_FOUND")]
    [InlineData(302, "UNAVAILABLE")]
    [InlineData(429, "UNAVAILABLE")]
    [InlineData(503, "UNAVAILABLE")]
    public async Task Error_responses_never_disclose_bodies_or_retry(int status, string expected)
    {
        var factory = new Factory((_, _) => Task.FromResult(new HttpResponseMessage((HttpStatusCode)status) { Content = new StringContent("synthetic-private") }));
        var view = (await Reader(factory).ReadAsync(default)).Value;
        view.Status.ShouldBe(expected); view.Snapshot.ShouldBeNull(); factory.Calls.ShouldBe(1);
    }

    [Theory]
    [InlineData("declared-size")]
    [InlineData("streamed-size")]
    [InlineData("content-type")]
    [InlineData("depth")]
    public async Task Transport_rejects_large_or_wrong_content_before_exposing_it(string scenario)
    {
        var factory = new Factory((_, _) =>
        {
            var response = Json(scenario == "depth" ? new string('[', 33) + "0" + new string(']', 33) : Fixture);
            if (scenario == "declared-size") response.Content.Headers.ContentLength = 1_048_577;
            if (scenario == "content-type") response.Content.Headers.ContentType!.MediaType = "text/plain";
            if (scenario == "streamed-size")
            {
                response.Content.Dispose();
                // Valid JSON padded with whitespace: only the byte limit, not JSON/contract validation, rejects it.
                response.Content = new StreamContent(new UnseekableStream(Encoding.UTF8.GetBytes(Fixture + new string(' ', 1_048_577))));
                response.Content.Headers.ContentType = new("application/json");
                response.Content.Headers.ContentLength.ShouldBeNull();
            }
            return Task.FromResult(response);
        });
        var config = Config();
        using var result = await new AtlasReadClient(Options.Create(config), factory).IdentityExportAsync(config.Employees[Employee.ToString()], default);
        result.Status.ShouldBe("INVALID_RESPONSE"); result.Document.ShouldBeNull();
    }

    [Fact]
    public async Task Source_IO_failure_is_sanitized_and_caller_cancellation_propagates()
    {
        var failed = new Factory((_, _) => throw new IOException("synthetic-private"));
        (await Reader(failed).ReadAsync(default)).Value.Status.ShouldBe("UNAVAILABLE");
        using var cancelled = new CancellationTokenSource();
        var factory = new Factory(async (_, ct) => { cancelled.Cancel(); await Task.Delay(Timeout.Infinite, ct); return Json(Fixture); });
        await Should.ThrowAsync<OperationCanceledException>(async () => await Reader(factory).ReadAsync(cancelled.Token));
    }

    [Fact]
    public async Task A_stalled_read_expires_within_the_bridge_timeout_without_retry()
    {
        var factory = new Factory(async (_, ct) => { await Task.Delay(Timeout.Infinite, ct); return Json(Fixture); });
        var view = (await Reader(factory).ReadAsync(default).WaitAsync(TimeSpan.FromSeconds(20))).Value;
        view.Status.ShouldBe("UNAVAILABLE"); view.Snapshot.ShouldBeNull(); factory.Calls.ShouldBe(1);
    }

    private sealed class EmployeeUser(Guid? id, bool manage = true, bool read = true) : ICurrentUser
    {
        public Guid? UserId => id;
        public string DisplayName => "Synthetic employee";
        public bool IsAuthenticated => id is not null;
        public bool HasPermission(string permission) => permission == Permissions.IntegrationsManage ? manage : permission == Permissions.ParasolAtlasRead && read;
    }
    private sealed class UnseekableStream(byte[] bytes) : MemoryStream(bytes) { public override bool CanSeek => false; }
    private sealed class Handler(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> reply) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) => reply(request, cancellationToken);
    }
    private sealed class Factory(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> reply) : IHttpClientFactory
    {
        public int Calls { get; private set; }
        public HttpClient CreateClient(string name) => new(new Handler((request, ct) => { Calls++; return reply(request, ct); })) { Timeout = Timeout.InfiniteTimeSpan };
    }
}
