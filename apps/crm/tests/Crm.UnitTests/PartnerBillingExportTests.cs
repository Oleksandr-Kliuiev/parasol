using System.Globalization;
using System.IO.Compression;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Crm.Integrations.PartnerCenter;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace Crm.UnitTests;

/// <summary>
/// The partner billing export against real loopback servers (DEV-21, docs/05 §2.4): one stands in for Graph, one for the export
/// storage and one for a foreign host. All three answer every route of the export alike, so only the client keeps the Graph token
/// and the requests away from the wrong one. The answers come in the shape Microsoft documents (the manifest linked from the
/// operation or embedded in it, files as <c>rootDirectory</c> + <c>name</c> + <c>sasToken</c>, gzip JSON Lines with capitalised
/// attributes) and in the shape the client read before (links in <c>resourceLocation</c> and <c>blobUri</c>, plain camelCase lines).
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

    /// <summary>The first file of the billed invoice reconciliation export (v2): amounts as numbers in one line, as text in the next.</summary>
    private const string FirstFile = """
        {"PartnerId":"aaaabbbb-0000-cccc-1111-dddd2222eeee","CustomerId":"csp-1","CustomerName":"Havbris AS","InvoiceNumber":"G000123","ProductId":"CFQ7TTC0LF8Q","SkuId":"0001","SkuName":"Microsoft 365 Business Standard","ChargeType":"cycleCharge","UnitPrice":130,"Quantity":5,"Subtotal":627.5,"TaxTotal":156.88,"Total":784.38,"Currency":"NOK","SubscriptionId":"sub-1","ChargeStartDate":"2026-09-01T00:00:00Z","ChargeEndDate":"2026-09-30T00:00:00Z","EffectiveUnitPrice":125.5,"ProductQualifiers":[]}
        {"PartnerId":"aaaabbbb-0000-cccc-1111-dddd2222eeee","CustomerId":"csp-2","InvoiceNumber":"G000123","ProductId":"CFQ7TTC0LF8R","SkuId":"0002","SkuName":"Microsoft 365 E3","ChargeType":"cycleCharge","UnitPrice":"300.00","Quantity":"2","Subtotal":"600.00","TaxTotal":"150.00","Total":"750.00","Currency":"NOK","SubscriptionId":"sub-2","ChargeStartDate":"2026-09-01T00:00:00Z","ChargeEndDate":"2026-09-30T00:00:00Z","EffectiveUnitPrice":"300.00"}
        """;

    private const string SecondFile = """
        {"PartnerId":"aaaabbbb-0000-cccc-1111-dddd2222eeee","CustomerId":"csp-1","CustomerName":"Havbris AS","InvoiceNumber":"G000123","ProductId":"CFQ7TTC0LH18","SkuId":"0001","SkuName":"Microsoft 365 Business Basic","ChargeType":"new","UnitPrice":60,"Quantity":1,"Subtotal":30,"TaxTotal":7.5,"Total":37.5,"Currency":"NOK","SubscriptionId":"sub-3","ChargeStartDate":"2026-09-16T00:00:00Z","ChargeEndDate":"2026-09-30T00:00:00Z","EffectiveUnitPrice":30}
        """;

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    /// <summary>
    /// The sign-in, Graph, the export storage and a foreign host. A scenario names its links with <c>{graph}</c>, <c>{storage}</c>
    /// and <c>{elsewhere}</c>; the storage server is reached as "localhost", the one storage host the test allows.
    /// </summary>
    private sealed class Stand : IAsyncDisposable
    {
        private string _location = string.Empty;
        private string _operation = string.Empty;
        private string _manifest = string.Empty;

        public LoopbackServer Login { get; private set; } = null!;

        public LoopbackServer Graph { get; private set; } = null!;

        public LoopbackServer Storage { get; private set; } = null!;

        public LoopbackServer Elsewhere { get; private set; } = null!;

        /// <summary>The shape the client read before: the manifest's link in <c>resourceLocation</c>, one <c>blobUri</c> per file.</summary>
        public static Task<Stand> StartAsync(string operation, string manifest, string file) => StartAnsweringAsync(
            operation,
            $$"""{"id":"op-1","status":"succeeded","resourceLocation":"{{manifest}}"}""",
            $$"""{"blobs":[{"blobUri":"{{file}}"}]}""");

        /// <summary>
        /// The export's <paramref name="location"/> (empty: the operation's id in the body instead), the finished
        /// <paramref name="operation"/> and the <paramref name="manifest"/> wherever a link names it, as JSON.
        /// </summary>
        public static async Task<Stand> StartAnsweringAsync(string location, string operation, string manifest)
        {
            var stand = new Stand();
            stand.Login = await LoopbackServer.StartAsync(context => Json(
                context, JsonSerializer.Serialize(new { access_token = Token, token_type = "Bearer", expires_in = "3600" })));
            stand.Graph = await LoopbackServer.StartAsync(stand.RespondAsync);
            stand.Storage = await LoopbackServer.StartAsync(stand.RespondAsync);
            stand.Elsewhere = await LoopbackServer.StartAsync(stand.RespondAsync);
            (stand._location, stand._operation, stand._manifest) = (stand.Fill(location), stand.Fill(operation), stand.Fill(manifest));
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

        private Task RespondAsync(HttpContext context)
        {
            switch (context.Request.Path.Value)
            {
                case "/v1.0/reports/partners/billing/reconciliation/billed/export":
                    context.Response.StatusCode = StatusCodes.Status202Accepted;
                    if (_location.Length == 0)
                    {
                        // No Location: the client builds the operation's path on Graph from the id in the body.
                        return Json(context, """{"id":"op-1"}""");
                    }

                    context.Response.Headers.Location = _location;
                    return Task.CompletedTask;
                case "/" + Operation:
                    return Json(context, _operation);
                case "/" + Manifest or "/export/manifest.json":
                    return Json(context, _manifest);
                case "/export/part-1.json":
                    return context.Response.WriteAsync(Lines);
                case "/export/part-1.json.gz":
                    return GzipAsync(context, FirstFile);
                case "/export/part-2.json.gz":
                    return GzipAsync(context, SecondFile);
                default:
                    context.Response.StatusCode = StatusCodes.Status404NotFound;
                    return Task.CompletedTask;
            }
        }
    }

    private static Task Json(HttpContext context, string body)
    {
        context.Response.ContentType = "application/json";
        return context.Response.WriteAsync(body);
    }

    /// <summary>A file as Azure storage serves the export: gzip bytes, no Content-Encoding.</summary>
    private static async Task GzipAsync(HttpContext context, string text)
    {
        using var buffer = new MemoryStream();
        await using (var gzip = new GZipStream(buffer, CompressionLevel.Fastest, leaveOpen: true))
        {
            await gzip.WriteAsync(Encoding.UTF8.GetBytes(text));
        }

        context.Response.ContentType = "application/octet-stream";
        await context.Response.Body.WriteAsync(buffer.ToArray());
    }

    /// <summary>A finished operation that links its manifest on Graph (Graph v1.0, "Get operation").</summary>
    private static string Linking(string manifest) =>
        $$"""{"@odata.type":"#microsoft.graph.partners.billing.exportSuccessOperation","id":"op-1","status":"succeeded","createdDateTime":"2026-10-05T08:12:53","lastActionDateTime":"2026-10-05T08:37:48.5046691Z","resourceLocation@odata.navigationLink":"{{manifest}}"}""";

    /// <summary>A finished operation that carries its manifest (Partner Center, billed invoice reconciliation API v2).</summary>
    private static string Embedding(string manifest) =>
        $$"""{"@odata.context":"https://graph.microsoft.com/v1.0/$metadata#reports/partners/billing/operations/$entity","@odata.type":"#microsoft.graph.partners.billing.exportSuccessOperation","id":"op-1","createdDateTime":"2026-10-05T21:17:29Z","lastActionDateTime":"2026-10-05T21:18:00.8897902Z","status":"succeeded","resourceLocation":{{manifest}}}""";

    /// <summary>The manifest as Microsoft documents it: the files' directory, its SAS and the files' names.</summary>
    private static string DocumentedManifest(string? rootDirectory = "{storage}export", string? sasToken = Sas, int blobCount = 2)
    {
        var manifest = new JsonObject
        {
            ["id"] = "m-1",
            ["schemaVersion"] = "2",
            ["dataFormat"] = "compressedJSON",
            ["createdDateTime"] = "2026-10-05T06:34:34.87Z",
            ["eTag"] = "RwDrn7fbiTXy6UULE",
            ["partnerTenantId"] = "aaaabbbb-0000-cccc-1111-dddd2222eeee",
            ["partitionType"] = "default",
            ["blobCount"] = blobCount,
            ["blobs"] = new JsonArray(
                new JsonObject { ["name"] = "part-1.json.gz", ["partitionValue"] = "default" },
                new JsonObject { ["name"] = "part-2.json.gz", ["partitionValue"] = "default" }),
        };
        if (rootDirectory is not null)
        {
            manifest["rootDirectory"] = rootDirectory;
        }

        if (sasToken is not null)
        {
            manifest["sasToken"] = sasToken;
        }

        return manifest.ToJsonString();
    }

    [Theory]
    [InlineData("{graph}" + Operation, "{graph}" + Manifest, 3)]
    [InlineData("/" + Operation, "{storage}export/manifest.json?" + Sas, 2)]
    [InlineData("", "{graph}" + Manifest, 3)]
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
    // A line file is never read from Graph, not even with the token Graph would accept.
    [InlineData("{graph}" + Operation, "{graph}" + Manifest, "{graph}export/part-1.json", 3)]
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

    [Theory]
    [InlineData("linked", 3)]
    [InlineData("embedded", 2)]
    public async Task The_documented_export_reads_its_manifest_and_gzip_json_lines_with_capitalised_attributes(string manifestShape, int graphRequests)
    {
        var operation = manifestShape == "linked" ? Linking("{graph}" + Manifest) : Embedding(DocumentedManifest());
        await using var stand = await Stand.StartAnsweringAsync("{graph}" + Operation, operation, DocumentedManifest());
        await using var services = stand.Services();

        var lines = await services.GetRequiredService<IPartnerBillingClient>().GetBilledLinesAsync("G000123", Ct);

        // The offer is ProductId:SkuId, the cost is the Subtotal before tax, and the unit price the effective one.
        lines.Select(l => (l.CspCustomerId, l.SubscriptionId, l.OfferId, l.Quantity, l.UnitPrice, l.Total)).ShouldBe([
            ("csp-1", "sub-1", "CFQ7TTC0LF8Q:0001", 5m, 125.5m, 627.5m),
            ("csp-2", "sub-2", "CFQ7TTC0LF8R:0002", 2m, 300m, 600m),
            ("csp-1", "sub-3", "CFQ7TTC0LH18:0001", 1m, 30m, 30m),
        ]);
        lines.Select(l => l.PeriodStart).ShouldBe([new DateOnly(2026, 9, 1), new DateOnly(2026, 9, 1), new DateOnly(2026, 9, 16)]);
        lines.ShouldAllBe(l => l.InvoiceId == "G000123" && l.PeriodEnd == new DateOnly(2026, 9, 30) && l.Currency == "NOK");
        lines.Select(l => l.OfferName).ShouldBe(["Microsoft 365 Business Standard", "Microsoft 365 E3", "Microsoft 365 Business Basic"]);
        stand.Graph.Requests.Count.ShouldBe(graphRequests);
        stand.Graph.Requests.ShouldAllBe(r => r.Headers.GetValueOrDefault("Authorization") == "Bearer " + Token);
        stand.Storage.Requests.Select(r => r.Path + r.Query).ShouldBe(["/export/part-1.json.gz?" + Sas, "/export/part-2.json.gz?" + Sas]);
        stand.Storage.Requests.ShouldAllBe(r => !r.Headers.ContainsKey("Authorization"));
        stand.Elsewhere.Requests.ShouldBeEmpty();
    }

    [Theory]
    [InlineData("{elsewhere}" + Manifest, "{storage}export", Sas, "outside the configured Graph address", 2)]
    [InlineData("{graph}" + Manifest, "{elsewhere}export", Sas, "outside the configured Graph address", 3)]
    // Without its directory, or with a relative one, a file name would resolve onto Graph and go out with the token.
    [InlineData("{graph}" + Manifest, null, Sas, "a line file outside the export storage", 3)]
    [InlineData("{graph}" + Manifest, "export", Sas, "a line file outside the export storage", 3)]
    [InlineData("{graph}" + Manifest, "{storage}export", null, "a storage link without a SAS signature", 3)]
    public async Task A_documented_manifest_that_points_anywhere_but_the_signed_storage_reads_nothing(
        string manifestLink, string? rootDirectory, string? sasToken, string reason, int graphRequests)
    {
        await using var stand = await Stand.StartAnsweringAsync(
            "{graph}" + Operation, Linking(manifestLink), DocumentedManifest(rootDirectory, sasToken));
        await using var services = stand.Services();

        var refused = await Should.ThrowAsync<PartnerBillingLinkRefusedException>(
            () => services.GetRequiredService<IPartnerBillingClient>().GetBilledLinesAsync("G000123", Ct));

        refused.Message.ShouldContain(reason);
        refused.Message.ShouldNotContain(stand.Elsewhere.Address.Port.ToString(CultureInfo.InvariantCulture));
        refused.Message.ShouldNotContain("sig=");
        stand.Graph.Requests.Count.ShouldBe(graphRequests);
        stand.Graph.Requests.ShouldAllBe(r => r.Headers.GetValueOrDefault("Authorization") == "Bearer " + Token);
        stand.Elsewhere.Requests.ShouldBeEmpty();
        stand.Storage.Requests.ShouldBeEmpty();
    }

    [Fact]
    public async Task One_wrong_file_in_the_manifest_reads_none_of_them()
    {
        var manifest = $$"""{"rootDirectory":"{storage}export","sasToken":"{{Sas}}","blobCount":2,"blobs":[{"name":"part-1.json.gz"},{"blobUri":"{elsewhere}export/part-2.json.gz?{{Sas}}"}]}""";
        await using var stand = await Stand.StartAnsweringAsync("{graph}" + Operation, Embedding(manifest), manifest);
        await using var services = stand.Services();

        await Should.ThrowAsync<PartnerBillingLinkRefusedException>(
            () => services.GetRequiredService<IPartnerBillingClient>().GetBilledLinesAsync("G000123", Ct));

        stand.Storage.Requests.ShouldBeEmpty();
        stand.Elsewhere.Requests.ShouldBeEmpty();
    }

    [Theory]
    [InlineData("""{"rootDirectory":"{storage}export","sasToken":"sig=c2ln"}""", "The billing export's manifest has no list of files.")]
    [InlineData("""{"value":[{"rootDirectory":"{storage}export","sasToken":"sig=c2ln","blobs":[{"name":"part-1.json.gz"}]}]}""", "The billing export's manifest has no list of files.")]
    [InlineData("""{"rootDirectory":"{storage}export","sasToken":"sig=c2ln","blobs":[{"partitionValue":"default"}]}""", "The billing export's manifest names a file without a name.")]
    [InlineData("""{"rootDirectory":"{storage}export","sasToken":"sig=c2ln","blobCount":3,"blobs":[{"name":"part-1.json.gz"},{"name":"part-2.json.gz"}]}""", "The billing export's manifest lists 2 of its 3 files.")]
    [InlineData("""{"rootDirectory":"{storage}export","sasToken":"sig=c2ln","blobCount":"3","blobs":[{"name":"part-1.json.gz"}]}""", "The billing export's manifest lists 1 of its 3 files.")]
    public async Task A_manifest_that_does_not_list_every_file_fails_instead_of_reading_part_of_the_invoice(string manifest, string message)
    {
        await using var stand = await Stand.StartAnsweringAsync("{graph}" + Operation, Embedding(manifest), manifest);
        await using var services = stand.Services();

        var failed = await Should.ThrowAsync<PartnerCenterApiException>(
            () => services.GetRequiredService<IPartnerBillingClient>().GetBilledLinesAsync("G000123", Ct));

        failed.Message.ShouldBe(message);
        stand.Storage.Requests.ShouldBeEmpty();
    }

    [Fact]
    public async Task A_root_directory_that_ends_in_a_slash_and_a_sas_that_starts_with_a_question_mark_still_give_one_address()
    {
        var manifest = DocumentedManifest("{storage}export/", "?" + Sas);
        await using var stand = await Stand.StartAnsweringAsync("{graph}" + Operation, Embedding(manifest), manifest);
        await using var services = stand.Services();

        var lines = await services.GetRequiredService<IPartnerBillingClient>().GetBilledLinesAsync("G000123", Ct);

        lines.Count.ShouldBe(3);
        stand.Storage.Requests.Select(r => r.Path + r.Query).ShouldBe(["/export/part-1.json.gz?" + Sas, "/export/part-2.json.gz?" + Sas]);
    }

    [Theory]
    // Whatever a name looks like, it stays a path under the root directory's host: the storage answers 404 here.
    [InlineData("../part-1.json.gz")]
    [InlineData("{elsewhere}part-1.json.gz")]
    [InlineData("@evil.example/part-1.json.gz")]
    [InlineData("?x=1/part-1.json.gz")]
    public async Task A_file_name_never_leaves_the_storage_host(string name)
    {
        var manifest = $$"""{"rootDirectory":"{storage}export","sasToken":"{{Sas}}","blobCount":1,"blobs":[{"name":"{{name}}"}]}""";
        await using var stand = await Stand.StartAnsweringAsync("{graph}" + Operation, Embedding(manifest), manifest);
        await using var services = stand.Services();

        await Should.ThrowAsync<HttpRequestException>(
            () => services.GetRequiredService<IPartnerBillingClient>().GetBilledLinesAsync("G000123", Ct));

        stand.Storage.Requests.ShouldHaveSingleItem().Headers.ShouldNotContainKey("Authorization");
        stand.Graph.Requests.Count.ShouldBe(2);
        stand.Elsewhere.Requests.ShouldBeEmpty();
    }

    [Fact]
    public async Task A_file_name_with_a_fragment_mark_loses_its_signature_and_is_refused()
    {
        var manifest = $$"""{"rootDirectory":"{storage}export","sasToken":"{{Sas}}","blobCount":1,"blobs":[{"name":"part-1.json.gz#x"}]}""";
        await using var stand = await Stand.StartAnsweringAsync("{graph}" + Operation, Embedding(manifest), manifest);
        await using var services = stand.Services();

        var refused = await Should.ThrowAsync<PartnerBillingLinkRefusedException>(
            () => services.GetRequiredService<IPartnerBillingClient>().GetBilledLinesAsync("G000123", Ct));

        refused.Message.ShouldContain("a storage link without a SAS signature");
        stand.Storage.Requests.ShouldBeEmpty();
    }

    [Fact]
    public async Task A_failed_operation_fails_the_read_and_follows_no_link()
    {
        const string failed = """{"@odata.type":"#microsoft.graph.partners.billing.failedOperation","id":"op-1","status":"failed","createdDateTime":"2026-10-05T08:12:53","lastActionDateTime":"2026-10-05T08:37:48.5046691Z","error":{"message":"No data available","code":"5000"}}""";
        await using var stand = await Stand.StartAnsweringAsync("{graph}" + Operation, failed, DocumentedManifest());
        await using var services = stand.Services();

        await Should.ThrowAsync<PartnerCenterApiException>(
            () => services.GetRequiredService<IPartnerBillingClient>().GetBilledLinesAsync("G000123", Ct));

        stand.Graph.Requests.Count.ShouldBe(2);
        stand.Storage.Requests.ShouldBeEmpty();
    }
}
