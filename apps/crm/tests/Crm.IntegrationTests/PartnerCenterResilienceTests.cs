using System.Net;
using System.Net.Http.Json;
using Crm.Authorization;
using Crm.Integrations.Core;
using Crm.Integrations.Core.Persistence;
using Crm.Integrations.PartnerCenter;
using Microsoft.AspNetCore.Hosting;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using WireMock.RequestBuilders;
using WireMock.ResponseBuilders;
using WireMock.Server;
using static Crm.IntegrationTests.IntegrationTestHelpers;

namespace Crm.IntegrationTests;

/// <summary>
/// Partner Center paging, limits and timeouts (DEV-19). Each test talks to a Partner Center stub of its own through a host of its
/// own. The live contract (continuation headers, the GDAP answers) is confirmed against the sandbox in EXT-03.
/// </summary>
[Collection(AteraCollection.Name)]
public class PartnerCenterResilienceTests(CrmWebFactory factory)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private sealed class TestHost(Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactory<Program> host, WireMockServer pc) : IAsyncDisposable
    {
        public IServiceProvider Services => host.Services;

        public WireMockServer PartnerCenter => pc;

        public async ValueTask DisposeAsync()
        {
            await host.DisposeAsync();
            pc.Dispose();
        }
    }

    private TestHost Host(string requestTimeout = "00:00:30")
    {
        var pc = WireMockServer.Start();
        pc.Given(Request.Create().WithPath("/oauth2/token").UsingPost())
            .RespondWith(JsonReply(new { access_token = "pc-token", token_type = "Bearer", expires_in = "3600" }));
        var host = factory.WithWebHostBuilder(builder =>
        {
            builder.UseSetting("Integrations:PartnerCenter:BaseUrl", pc.Url + "/");
            builder.UseSetting("Integrations:PartnerCenter:TokenUrl", pc.Url + "/oauth2/token");
            builder.UseSetting("Integrations:PartnerCenter:RetryDelay", "00:00:00.020");
            builder.UseSetting("Integrations:PartnerCenter:RequestTimeout", requestTimeout);
        });
        return new TestHost(host, pc);
    }

    private static PcCustomer Customer(string id) => new(id, $"Customer {id}", null, null, null);

    private static object Subscription(string id) => new { id, offerId = "CFQ7TTC0LF8Q", quantity = 5, status = "active" };

    private static int Count(WireMockServer pc, string path) => pc.LogEntries.Count(e => e.RequestMessage!.Path == path);

    [Fact]
    public async Task Subscriptions_follow_the_continuation_token_to_the_last_page()
    {
        await using var host = Host();
        var pc = host.PartnerCenter;
        pc.Given(Request.Create().WithPath("/v1/customers/c1/subscriptions").UsingGet().WithHeader("MS-ContinuationToken", "t2")).AtPriority(1)
            .RespondWith(JsonReply(new { items = new[] { Subscription("sub-3") } }));
        pc.Given(Request.Create().WithPath("/v1/customers/c1/subscriptions").UsingGet().WithHeader("MS-ContinuationToken", "t1")).AtPriority(1)
            .RespondWith(JsonReply(new { items = new[] { Subscription("sub-2") }, links = new { next = new { headers = new[] { new { key = "MS-ContinuationToken", value = "t2" } } } } }));
        pc.Given(Request.Create().WithPath("/v1/customers/c1/subscriptions").UsingGet()).AtPriority(5)
            .RespondWith(JsonReply(new { items = new[] { Subscription("sub-1") }, continuationToken = "t1" }));

        await using var scope = host.Services.CreateAsyncScope();
        var subscriptions = await scope.ServiceProvider.GetRequiredService<IPartnerCenterClient>().GetSubscriptionsAsync(Customer("c1"), Ct);

        subscriptions.Select(s => s.SubscriptionId).ShouldBe(["sub-1", "sub-2", "sub-3"]);
        Count(pc, "/v1/customers/c1/subscriptions").ShouldBe(3);
    }

    [Fact]
    public async Task Invoices_follow_the_continuation_token_and_come_back_newest_first()
    {
        await using var host = Host();
        var pc = host.PartnerCenter;
        pc.Given(Request.Create().WithPath("/v1/invoices").UsingGet().WithHeader("MS-ContinuationToken", "n2")).AtPriority(1)
            .RespondWith(JsonReply(new { items = new[] { new { id = "G3", invoiceDate = "2026-09-05T00:00:00Z", totalCharges = 3 } } }));
        pc.Given(Request.Create().WithPath("/v1/invoices").UsingGet()).AtPriority(5)
            .RespondWith(Response.Create().WithStatusCode(200).WithHeader("Content-Type", "application/json").WithHeader("MS-ContinuationToken", "n2")
                .WithBody("""{"items":[{"id":"G1","invoiceDate":"2026-07-05T00:00:00Z","totalCharges":1},{"id":"G2","invoiceDate":"2026-08-05T00:00:00Z","totalCharges":2}]}"""));

        await using var scope = host.Services.CreateAsyncScope();
        var invoices = await scope.ServiceProvider.GetRequiredService<IPartnerCenterClient>().GetInvoicesAsync(Ct);

        invoices.Select(i => i.Id).ShouldBe(["G3", "G2", "G1"]);
    }

    [Fact]
    public async Task A_list_that_never_ends_fails_explicitly_instead_of_being_cut_off_silently()
    {
        await using var host = Host();
        var pc = host.PartnerCenter;
        var served = 0;
        pc.Given(Request.Create().WithPath("/v1/customers").UsingGet()).RespondWith(Response.Create().WithCallback(_ =>
        {
            var page = Interlocked.Increment(ref served);
            return new WireMock.ResponseMessage
            {
                StatusCode = 200,
                Headers = new Dictionary<string, WireMock.Types.WireMockList<string>> { ["Content-Type"] = new("application/json") },
                BodyData = new WireMock.Util.BodyData
                {
                    DetectedBodyType = WireMock.Types.BodyType.String,
                    BodyAsString = System.Text.Json.JsonSerializer.Serialize(new { items = Array.Empty<object>(), continuationToken = $"page-{page}" }),
                },
            };
        }));

        await using var scope = host.Services.CreateAsyncScope();
        var client = scope.ServiceProvider.GetRequiredService<IPartnerCenterClient>();
        var error = await Should.ThrowAsync<PartnerCenterApiException>(async () =>
        {
            await foreach (var _ in client.GetCustomersAsync(Ct))
            {
            }
        });

        error.Message.ShouldContain("1000 pages");
        served.ShouldBe(1000);
    }

    [Fact]
    public async Task A_repeated_continuation_token_fails_the_read()
    {
        await using var host = Host();
        host.PartnerCenter.Given(Request.Create().WithPath("/v1/customers/c1/subscriptions").UsingGet())
            .RespondWith(JsonReply(new { items = new[] { Subscription("sub-1") }, continuationToken = "same" }));

        await using var scope = host.Services.CreateAsyncScope();
        var error = await Should.ThrowAsync<PartnerCenterApiException>(
            () => scope.ServiceProvider.GetRequiredService<IPartnerCenterClient>().GetSubscriptionsAsync(Customer("c1"), Ct));

        error.Message.ShouldContain("continuation token");
    }

    [Theory]
    [InlineData(401)]
    [InlineData(403)]
    [InlineData(404)]
    public async Task A_tenant_that_cannot_be_read_is_a_limitation_not_an_empty_list(int status)
    {
        await using var host = Host();
        host.PartnerCenter.Given(Request.Create().WithPath("/v1/customers/c1/subscribedskus").UsingGet()).RespondWith(Response.Create().WithStatusCode(status));

        await using var scope = host.Services.CreateAsyncScope();
        var reading = await scope.ServiceProvider.GetRequiredService<IPartnerCenterClient>().GetSubscribedSkusAsync(Customer("c1"), Ct);

        reading.Limitation.ShouldNotBeNull().ShouldContain(status.ToString(System.Globalization.CultureInfo.InvariantCulture));
        reading.Skus.ShouldBeEmpty();
    }

    [Fact]
    public async Task The_licence_sync_names_tenants_it_could_not_read_and_does_not_count_as_a_complete_success()
    {
        await using var host = Host();
        var pc = host.PartnerCenter;
        var admin = factory.ClientAs(CrmRoles.Admin);
        var marker = Guid.NewGuid().ToString("N")[..8];
        string readable = $"ok-{marker}", blocked = $"gdap-{marker}";
        foreach (var customer in new[] { readable, blocked })
        {
            var organizationId = await admin.CreateOrganizationAsync(new { name = $"PC {customer} AS", status = "Customer" });
            (await admin.PostAsJsonAsync("/api/v1/integrations/links", new
            {
                system = "partnercenter", externalType = "Customer", externalId = customer, entityId = organizationId,
            }, Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
        }

        pc.Given(Request.Create().WithPath("/v1/customers").UsingGet()).RespondWith(JsonReply(new
        {
            items = new object[]
            {
                new { id = readable, companyProfile = new { companyName = "Readable" } },
                new { id = blocked, companyProfile = new { companyName = "Blocked" } },
            },
        }));
        pc.Given(Request.Create().WithPath($"/v1/customers/{readable}/subscribedskus").UsingGet()).RespondWith(JsonReply(new
        {
            items = new[] { new { skuId = $"sku-{marker}", skuPartNumber = "SPE_E3", prepaidUnits = new { enabled = 25 }, consumedUnits = 21 } },
        }));
        pc.Given(Request.Create().WithPath($"/v1/customers/{blocked}/subscribedskus").UsingGet()).RespondWith(Response.Create().WithStatusCode(403));

        var startedAt = DateTimeOffset.UtcNow;
        await using (var scope = host.Services.CreateAsyncScope())
        {
            await scope.ServiceProvider.GetRequiredService<PartnerCenterLicenseSyncJob>().RunAsync(Ct);
        }

        await using var check = host.Services.CreateAsyncScope();
        var run = await check.ServiceProvider.GetRequiredService<IntegrationDbContext>().SyncRuns.AsNoTracking()
            .SingleAsync(r => r.System == "partnercenter" && r.Job == PartnerCenterLicenseSyncJob.JobId && r.StartedAt >= startedAt, Ct);
        run.Status.ShouldBe(SyncRunStatus.Succeeded);
        // The readable tenant is stored; the blocked one is a failure of the pass (freshness does not advance) and is named.
        run.Failed.ShouldBe(1);
        run.Changed.ShouldBe(1);
        run.Message!.ShouldContain($"{blocked}: no access to the tenant");
        run.Message!.ShouldNotContain(readable);
    }

    [Fact]
    public async Task A_throttled_read_is_repeated_and_a_response_slower_than_the_attempt_limit_fails()
    {
        await using var host = Host(requestTimeout: "00:00:00.300");
        var pc = host.PartnerCenter;
        pc.Given(Request.Create().WithPath("/v1/customers/c1/subscriptions").UsingGet()).InScenario("throttle").WillSetStateTo("again")
            .RespondWith(Response.Create().WithStatusCode(429));
        pc.Given(Request.Create().WithPath("/v1/customers/c1/subscriptions").UsingGet()).InScenario("throttle").WhenStateIs("again")
            .RespondWith(JsonReply(new { items = new[] { Subscription("sub-1") } }));
        pc.Given(Request.Create().WithPath("/v1/customers/slow/subscriptions").UsingGet())
            .RespondWith(Response.Create().WithStatusCode(200).WithDelay(TimeSpan.FromSeconds(10)).WithBody("{}"));

        await using var scope = host.Services.CreateAsyncScope();
        var client = scope.ServiceProvider.GetRequiredService<IPartnerCenterClient>();
        (await client.GetSubscriptionsAsync(Customer("c1"), Ct)).ShouldHaveSingleItem();

        var watch = System.Diagnostics.Stopwatch.StartNew();
        await Should.ThrowAsync<Exception>(() => client.GetSubscriptionsAsync(Customer("slow"), Ct));
        watch.Stop();
        // One try and four repeats, each cut off at the 0.3 s attempt limit: about 1.5 s, far from the 10 s the stub would take.
        watch.Elapsed.ShouldBeGreaterThan(TimeSpan.FromSeconds(1.2));
        watch.Elapsed.ShouldBeLessThan(TimeSpan.FromSeconds(6));
    }
}
