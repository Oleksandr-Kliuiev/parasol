using System.Globalization;
using System.Text.Json;
using Crm.Integrations.PartnerCenter;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace Crm.UnitTests;

/// <summary>
/// The partner billing export against real loopback servers (DEV-21, docs/05 §2.4): one stands in for Graph, one for the export
/// storage and one for a foreign host. All three answer every route of the export alike, so only the client keeps the Graph token
/// and the requests away from the wrong one.
/// </summary>
public class PartnerBillingExportTests
{
    private const string Token = "graph-token";
    private const string Sas = "sv=2021-08-06&sr=b&sp=r&sig=c2lnbmF0dXJl%2B%2Fw%3D";
    private const string Operation = "v1.0/reports/partners/billing/operations/op-1";
    private const string Manifest = "v1.0/reports/partners/billing/manifests/m-1";

    private const string Lines = """
        {"customerId":"csp-1","customerName":"Havbris AS","offerId":"CFQ7TTC0LF8Q","subscriptionId":"sub-1","quantity":5,"effectiveUnitPrice":12.5,"totalForCustomer":62.5,"chargeStartDate":"2026-09-01","chargeEndDate":"2026-09-30","currency":"NOK"}
        {"customerId":"csp-2","offerId":"CFQ7TTC0LF8R","quantity":"2","unitPrice":"100.00","chargeStartDate":"2026-09-01","chargeEndDate":"2026-09-30","currency":"NOK"}
        """;

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    /// <summary>
    /// The sign-in, Graph, the export storage and a foreign host. A scenario names its links with <c>{graph}</c>, <c>{storage}</c>
    /// and <c>{elsewhere}</c>; the storage server is reached as "localhost", the one storage host the test allows.
    /// </summary>
    private sealed class Stand : IAsyncDisposable
    {
        private string _operation = string.Empty;
        private string _manifest = string.Empty;
        private string _file = string.Empty;

        public LoopbackServer Login { get; private set; } = null!;

        public LoopbackServer Graph { get; private set; } = null!;

        public LoopbackServer Storage { get; private set; } = null!;

        public LoopbackServer Elsewhere { get; private set; } = null!;

        public static async Task<Stand> StartAsync(string operation, string manifest, string file)
        {
            var stand = new Stand();
            stand.Login = await LoopbackServer.StartAsync(context => Json(context, new { access_token = Token, token_type = "Bearer", expires_in = "3600" }));
            stand.Graph = await LoopbackServer.StartAsync(stand.AnswerAsync);
            stand.Storage = await LoopbackServer.StartAsync(stand.AnswerAsync);
            stand.Elsewhere = await LoopbackServer.StartAsync(stand.AnswerAsync);
            (stand._operation, stand._manifest, stand._file) = (stand.Fill(operation), stand.Fill(manifest), stand.Fill(file));
            return stand;
        }

        public ServiceProvider Services()
        {
            var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Integrations:PartnerCenter:Enabled"] = "true",
                ["Integrations:PartnerCenter:TenantId"] = "11111111-1111-1111-1111-111111111111",
                ["Integrations:PartnerCenter:ClientId"] = "test-client",
                ["Integrations:PartnerCenter:RefreshToken"] = "test-refresh-token",
                ["Integrations:PartnerCenter:BillingReconciliationEnabled"] = "true",
                ["Integrations:PartnerCenter:GraphBaseUrl"] = new Uri(Graph.Address, "v1.0/").ToString(),
                ["Integrations:PartnerCenter:TokenUrl"] = new Uri(Login.Address, "oauth2/token").ToString(),
                ["Integrations:PartnerCenter:BillingStorageHostSuffixes:0"] = "localhost",
            }).Build();
            var services = new ServiceCollection().AddLogging().AddSingleton(TimeProvider.System).AddSingleton<IConfiguration>(configuration);
            services.AddPartnerCenterIntegration(configuration);
            return services.BuildServiceProvider();
        }

        public async ValueTask DisposeAsync()
        {
            await Login.DisposeAsync();
            await Graph.DisposeAsync();
            await Storage.DisposeAsync();
            await Elsewhere.DisposeAsync();
        }

        private string Fill(string link) => link
            .Replace("{graph}", Graph.Address.ToString(), StringComparison.Ordinal)
            .Replace("{storage}", $"http://localhost:{Storage.Address.Port}/", StringComparison.Ordinal)
            .Replace("{elsewhere}", Elsewhere.Address.ToString(), StringComparison.Ordinal);

        private Task AnswerAsync(HttpContext context)
        {
            switch (context.Request.Path.Value)
            {
                case "/v1.0/reports/partners/billing/reconciliation/billed/export":
                    context.Response.StatusCode = StatusCodes.Status202Accepted;
                    context.Response.Headers.Location = _operation;
                    return Task.CompletedTask;
                case "/" + Operation:
                    return Json(context, new { id = "op-1", status = "succeeded", resourceLocation = _manifest });
                case "/" + Manifest or "/export/manifest.json":
                    return Json(context, new { blobs = new[] { new { blobUri = _file } } });
                case "/export/part-1.json":
                    return context.Response.WriteAsync(Lines);
                default:
                    context.Response.StatusCode = StatusCodes.Status404NotFound;
                    return Task.CompletedTask;
            }
        }
    }

    private static Task Json(HttpContext context, object body)
    {
        context.Response.ContentType = "application/json";
        return context.Response.WriteAsync(JsonSerializer.Serialize(body));
    }

    [Theory]
    [InlineData("{graph}" + Operation, "{graph}" + Manifest, 3)]
    [InlineData("/" + Operation, "{storage}export/manifest.json?" + Sas, 2)]
    public async Task The_export_reads_graph_with_the_token_and_storage_with_the_signature_alone(string operation, string manifest, int graphRequests)
    {
        await using var stand = await Stand.StartAsync(operation, manifest, "{storage}export/part-1.json?" + Sas);
        await using var services = stand.Services();

        var lines = await services.GetRequiredService<IPartnerBillingClient>().GetBilledLinesAsync("G000123", Ct);

        lines.Select(l => (l.CspCustomerId, l.OfferId, l.Quantity, l.Total)).ShouldBe([("csp-1", "CFQ7TTC0LF8Q", 5m, 62.5m), ("csp-2", "CFQ7TTC0LF8R", 2m, 200m)]);
        stand.Graph.Requests.Count.ShouldBe(graphRequests);
        stand.Graph.Requests.ShouldAllBe(r => r.Headers.GetValueOrDefault("Authorization") == "Bearer " + Token);
        stand.Storage.Requests.ShouldContain(r => r.Path == "/export/part-1.json" && r.Query == "?" + Sas);
        stand.Storage.Requests.ShouldAllBe(r => !r.Headers.ContainsKey("Authorization"));
        stand.Elsewhere.Requests.ShouldBeEmpty();
    }

    [Theory]
    [InlineData("{elsewhere}" + Operation, "{graph}" + Manifest, "{storage}export/part-1.json?" + Sas, 1)]
    [InlineData("{graph}" + Operation, "{elsewhere}" + Manifest, "{storage}export/part-1.json?" + Sas, 2)]
    [InlineData("{graph}" + Operation, "{graph}" + Manifest, "{elsewhere}export/part-1.json?" + Sas, 3)]
    [InlineData("{graph}" + Operation, "{storage}export/manifest.json", "{storage}export/part-1.json?" + Sas, 2)]
    [InlineData("{graph}" + Operation, "{graph}" + Manifest, "{storage}export/part-1.json", 3)]
    public async Task A_link_to_another_host_or_an_unsigned_storage_file_is_refused_and_nothing_reaches_it(
        string operation, string manifest, string file, int graphRequests)
    {
        await using var stand = await Stand.StartAsync(operation, manifest, file);
        await using var services = stand.Services();

        var refused = await Should.ThrowAsync<PartnerBillingLinkRefusedException>(
            () => services.GetRequiredService<IPartnerBillingClient>().GetBilledLinesAsync("G000123", Ct));

        refused.Message.ShouldStartWith("The partner billing export named ");
        refused.Message.ShouldNotContain(stand.Elsewhere.Address.Port.ToString(CultureInfo.InvariantCulture));
        refused.Message.ShouldNotContain("sig=");
        stand.Graph.Requests.Count.ShouldBe(graphRequests);
        stand.Graph.Requests.ShouldAllBe(r => r.Headers.GetValueOrDefault("Authorization") == "Bearer " + Token);
        stand.Elsewhere.Requests.ShouldBeEmpty();
        stand.Storage.Requests.ShouldBeEmpty();
    }
}
