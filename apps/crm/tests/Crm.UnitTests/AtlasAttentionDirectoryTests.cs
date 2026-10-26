using System.Net;
using System.Text;
using Crm.Integrations.Core.Parasol;
using Microsoft.Extensions.Options;
using static Crm.UnitTests.AtlasAttentionTestSupport;

namespace Crm.UnitTests;

public sealed class AtlasAttentionDirectoryTests
{
    private const string Token = "synthetic-attention-personal-token";
    private const string Valid = """{"schemaVersion":1,"source":"atlas","workspaceId":"synthetic-workspace","clients":[{"clientId":"client-0","name":"Synthetic source name"}]}""";

    private static AtlasWorkspaceOptions Config() => new()
    {
        Enabled = true, BaseUrl = "https://synthetic.invalid/",
        Employees = new() { [Employee.ToString("D")] = new() { WorkspaceId = "synthetic-workspace", Token = Token } },
    };
    private static AtlasAttentionDirectory Reader(Factory factory, AtlasWorkspaceOptions? config = null, User? user = null)
    {
        var options = Options.Create(config ?? Config());
        return new(user ?? new User(Employee), options, new(options, factory));
    }
    private static HttpResponseMessage Json(string body) => new(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") };

    [Fact]
    public async Task A_technical_employee_reads_its_personal_directory_without_the_administrative_export_permission()
    {
        var user = new User(Employee); user.HasPermission(Crm.Authorization.Permissions.IntegrationsManage).ShouldBeFalse();
        var factory = new Factory((request, _) =>
        {
            request.Method.ShouldBe(HttpMethod.Get); request.RequestUri!.AbsolutePath.ShouldBe("/clients/identity-export");
            request.Headers.Authorization!.ToString().ShouldBe("Bearer " + Token); request.Headers.Contains("Cookie").ShouldBeFalse();
            return Task.FromResult(Json(Valid));
        });
        var result = await Reader(factory, user: user).ReadAsync(default);
        result.Status.ShouldBe("READY"); result.Snapshot!.Clients.Single().ClientId.ShouldBe("client-0"); factory.Calls.ShouldBe(1);
    }

    [Theory]
    [InlineData("disabled", "NOT_CONFIGURED")]
    [InlineData("missing-employee", "ACCESS_DENIED")]
    [InlineData("missing-customer-permission", "ACCESS_DENIED")]
    public async Task Missing_personal_configuration_or_permissions_never_read_the_directory(string scenario, string expected)
    {
        var factory = new Factory((_, _) => throw new InvalidOperationException()); var config = Config();
        if (scenario == "disabled") config.Enabled = false;
        if (scenario == "missing-employee") config.Employees.Clear();
        var view = await Reader(factory, config, new User(Employee, customers: scenario != "missing-customer-permission")).ReadAsync(default);
        view.Status.ShouldBe(expected); view.Snapshot.ShouldBeNull(); factory.Calls.ShouldBe(0);
    }

    [Theory]
    [InlineData("foreign-workspace")]
    [InlineData("duplicate-member")]
    [InlineData("extra-member")]
    [InlineData("duplicate-client")]
    [InlineData("wrong-case")]
    public async Task The_untrusted_personal_directory_is_closed_and_workspace_bound(string scenario)
    {
        var body = scenario switch
        {
            "foreign-workspace" => Valid.Replace("synthetic-workspace", "foreign-workspace"),
            "duplicate-member" => Valid.Replace("\"name\":", "\"name\":\"private\",\"name\":"),
            "extra-member" => Valid.Replace("\"name\":", "\"token\":\"private\",\"name\":"),
            "duplicate-client" => Valid.Replace("\"clients\":[", "\"clients\":[{\"clientId\":\"client-0\",\"name\":\"Duplicate\"},"),
            _ => Valid.Replace("\"workspaceId\":", "\"WorkspaceId\":"),
        };
        var factory = new Factory((_, _) => Task.FromResult(Json(body)));
        var result = await Reader(factory).ReadAsync(default);
        result.Status.ShouldBe("INVALID_RESPONSE"); result.Snapshot.ShouldBeNull(); factory.Calls.ShouldBe(1);
    }

    [Theory]
    [InlineData(401, "ACCESS_DENIED")]
    [InlineData(403, "ACCESS_DENIED")]
    [InlineData(404, "UNAVAILABLE")]
    [InlineData(302, "UNAVAILABLE")]
    [InlineData(503, "UNAVAILABLE")]
    public async Task Upstream_errors_are_fixed_and_never_retried(int status, string expected)
    {
        var factory = new Factory((_, _) => Task.FromResult(new HttpResponseMessage((HttpStatusCode)status) { Content = new StringContent("private-upstream-body") }));
        var result = await Reader(factory).ReadAsync(default);
        result.Status.ShouldBe(expected); result.Snapshot.ShouldBeNull(); factory.Calls.ShouldBe(1);
    }

    private sealed class Handler(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> reply) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) => reply(request, cancellationToken);
    }
    private sealed class Factory(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> reply) : IHttpClientFactory
    {
        internal int Calls;
        public HttpClient CreateClient(string name) => new(new Handler((request, ct) => { Calls++; return reply(request, ct); }));
    }
}
