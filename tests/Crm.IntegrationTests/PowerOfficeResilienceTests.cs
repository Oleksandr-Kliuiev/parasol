using System.Diagnostics;
using System.Net;
using Crm.Integrations.Core;
using Crm.Integrations.Core.Persistence;
using Crm.Integrations.PowerOffice;
using Microsoft.AspNetCore.Hosting;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using WireMock.RequestBuilders;
using WireMock.ResponseBuilders;
using WireMock.Server;
using WireMock.Types;
using static Crm.IntegrationTests.IntegrationTestHelpers;

namespace Crm.IntegrationTests;

/// <summary>
/// The PowerOffice HTTP pipeline and the incremental readers (DEV-19). Each test talks to a PowerOffice stub of its own through
/// a host of its own, so retries, faults and paging never mix with other tests; the cursors live in the shared database, which
/// is why the class runs alone.
/// </summary>
[Collection(DatabaseAdministrationCollection.Name)]
public class PowerOfficeResilienceTests(CrmWebFactory factory)
{
    private static WireMockServer StartPowerOffice()
    {
        var po = WireMockServer.Start();
        po.Given(Request.Create().WithPath("/OAuth/Token").UsingPost())
            .RespondWith(JsonReply(new { access_token = "po-token", token_type = "bearer", expires_in = 1200 }));
        return po;
    }

    private WebApplicationFactoryHost HostFor(WireMockServer po, int requestsPerSecond = 100) => new(factory.WithWebHostBuilder(builder =>
    {
        builder.UseSetting("Integrations:PowerOffice:BaseUrl", po.Url + "/v2/");
        builder.UseSetting("Integrations:PowerOffice:TokenUrl", po.Url + "/OAuth/Token");
        builder.UseSetting("Integrations:PowerOffice:RequestsPerSecond", requestsPerSecond.ToString(System.Globalization.CultureInfo.InvariantCulture));
        builder.UseSetting("Integrations:PowerOffice:RetryDelay", "00:00:00.020");
    }));

    /// <summary>Disposes the derived host with the test.</summary>
    private sealed class WebApplicationFactoryHost(Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactory<Program> host) : IAsyncDisposable
    {
        public IServiceProvider Services => host.Services;

        public IPowerOfficeClient Client => host.Services.GetRequiredService<IPowerOfficeClient>();

        public ValueTask DisposeAsync() => host.DisposeAsync();
    }

    private static PoSalesOrderPost Order() => new(1, DateTimeOffset.UtcNow, "ref-1", null, [new PoSalesOrderLinePost("X", "Line", 1, 100, null, 1)]);

    private static int Count(WireMockServer po, string method, string path) =>
        po.LogEntries.Count(e => e.RequestMessage!.Method == method && e.RequestMessage.Path == path);

    [Fact]
    public async Task A_write_answered_with_503_is_sent_once()
    {
        using var po = StartPowerOffice();
        await using var host = HostFor(po);
        po.Given(Request.Create().WithPath("/v2/SalesOrders").UsingPost()).RespondWith(Response.Create().WithStatusCode(503));

        var error = await Should.ThrowAsync<PowerOfficeApiException>(() => host.Client.CreateSalesOrderAsync(Order(), CancellationToken.None));

        error.Status.ShouldBe(HttpStatusCode.ServiceUnavailable);
        Count(po, "POST", "/v2/SalesOrders").ShouldBe(1);
    }

    [Theory]
    [InlineData(500)]
    [InlineData(502)]
    public async Task A_write_answered_with_another_server_error_is_sent_once(int status)
    {
        using var po = StartPowerOffice();
        await using var host = HostFor(po);
        po.Given(Request.Create().WithPath("/v2/SalesOrders").UsingPost()).RespondWith(Response.Create().WithStatusCode(status));

        await Should.ThrowAsync<PowerOfficeApiException>(() => host.Client.CreateSalesOrderAsync(Order(), CancellationToken.None));

        Count(po, "POST", "/v2/SalesOrders").ShouldBe(1);
    }

    [Fact]
    public async Task A_write_whose_response_is_lost_is_sent_once()
    {
        using var po = StartPowerOffice();
        await using var host = HostFor(po);
        po.Given(Request.Create().WithPath("/v2/SalesOrders").UsingPost()).RespondWith(Response.Create().WithFault(FaultType.EMPTY_RESPONSE));

        // Whatever shape the dropped answer takes (no body, a broken connection), it is no answer and the write is not repeated.
        var error = await Record.ExceptionAsync(() => host.Client.CreateSalesOrderAsync(Order(), CancellationToken.None));

        error.ShouldNotBeNull();
        error.ShouldNotBeOfType<PowerOfficeApiException>();
        Count(po, "POST", "/v2/SalesOrders").ShouldBe(1);
    }

    [Fact]
    public async Task A_write_throttled_with_429_is_repeated_until_it_goes_through()
    {
        using var po = StartPowerOffice();
        await using var host = HostFor(po);
        const string scenario = "throttled-then-created";
        po.Given(Request.Create().WithPath("/v2/SalesOrders").UsingPost()).InScenario(scenario).WillSetStateTo("Second")
            .RespondWith(Response.Create().WithStatusCode(429));
        po.Given(Request.Create().WithPath("/v2/SalesOrders").UsingPost()).InScenario(scenario).WhenStateIs("Second").WillSetStateTo("Third")
            .RespondWith(Response.Create().WithStatusCode(429));
        po.Given(Request.Create().WithPath("/v2/SalesOrders").UsingPost()).InScenario(scenario).WhenStateIs("Third")
            .RespondWith(JsonReply(new { Id = 77, OrderNo = 77, CustomerId = 1 }, 201));

        var created = await host.Client.CreateSalesOrderAsync(Order(), CancellationToken.None);

        created.Number.ShouldBe("77");
        Count(po, "POST", "/v2/SalesOrders").ShouldBe(3);
    }

    [Fact]
    public async Task A_write_that_stays_throttled_fails_after_the_retries_are_used_up()
    {
        using var po = StartPowerOffice();
        await using var host = HostFor(po);
        po.Given(Request.Create().WithPath("/v2/SalesOrders").UsingPost()).RespondWith(Response.Create().WithStatusCode(429));

        var error = await Should.ThrowAsync<PowerOfficeApiException>(() => host.Client.CreateSalesOrderAsync(Order(), CancellationToken.None));

        error.Status.ShouldBe(HttpStatusCode.TooManyRequests);
        Count(po, "POST", "/v2/SalesOrders").ShouldBe(5);
    }

    [Fact]
    public async Task A_read_is_repeated_on_503()
    {
        using var po = StartPowerOffice();
        await using var host = HostFor(po);
        const string scenario = "unavailable-then-empty";
        po.Given(Request.Create().WithPath("/v2/SalesOrders").UsingGet()).InScenario(scenario).WillSetStateTo("Second")
            .RespondWith(Response.Create().WithStatusCode(503));
        po.Given(Request.Create().WithPath("/v2/SalesOrders").UsingGet()).InScenario(scenario).WhenStateIs("Second").WillSetStateTo("Third")
            .RespondWith(Response.Create().WithStatusCode(503));
        po.Given(Request.Create().WithPath("/v2/SalesOrders").UsingGet()).InScenario(scenario).WhenStateIs("Third")
            .RespondWith(Response.Create().WithStatusCode(204));

        (await host.Client.FindSalesOrderAsync("ref-1", CancellationToken.None)).ShouldBeNull();

        Count(po, "GET", "/v2/SalesOrders").ShouldBe(3);
    }

    [Fact]
    public async Task Every_attempt_takes_a_token_from_the_rate_limiter_retries_included()
    {
        using var po = StartPowerOffice();
        // Two requests a second: five attempts cannot be made in less than two seconds if each one needs a token.
        await using var host = HostFor(po, requestsPerSecond: 2);
        po.Given(Request.Create().WithPath("/v2/SalesOrders").UsingPost()).RespondWith(Response.Create().WithStatusCode(429));
        var clock = Stopwatch.StartNew();

        await Should.ThrowAsync<PowerOfficeApiException>(() => host.Client.CreateSalesOrderAsync(Order(), CancellationToken.None));

        Count(po, "POST", "/v2/SalesOrders").ShouldBe(5);
        clock.Elapsed.ShouldBeGreaterThan(TimeSpan.FromSeconds(1.5));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task A_short_page_does_not_end_the_enumeration_only_an_empty_one_does(bool emptyPageIs204)
    {
        using var po = StartPowerOffice();
        await using var host = HostFor(po);
        // The page size is 2 (test configuration), yet the server hands out one record a page.
        object Item(long id) => Product(id, "x", "2036-04-01T10:00:00+00:00");
        po.Given(Request.Create().WithPath("/v2/Products").UsingGet().WithParam("PageNumber", "1")).RespondWith(JsonReply(new[] { Item(1) }));
        po.Given(Request.Create().WithPath("/v2/Products").UsingGet().WithParam("PageNumber", "2")).RespondWith(JsonReply(new[] { Item(2) }));
        po.Given(Request.Create().WithPath("/v2/Products").UsingGet().WithParam("PageNumber", "3"))
            .RespondWith(emptyPageIs204 ? Response.Create().WithStatusCode(204) : JsonReply(Array.Empty<object>()));

        var read = new List<PoProduct>();
        await foreach (var product in host.Client.GetProductsAsync(null, CancellationToken.None))
        {
            read.Add(product);
        }

        read.Select(p => p.Id).ShouldBe([1L, 2L]);
        Count(po, "GET", "/v2/Products").ShouldBe(3);
    }

    private static object Product(long id, string name, string changed) => new { Id = id, Code = $"C{id}", Name = name, IsArchived = false, LastChangedDateTimeOffset = changed };

    private async Task<string?> CursorAsync(WebApplicationFactoryHost host)
    {
        await using var scope = host.Services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<SyncRunner>().GetCursorAsync(PowerOfficeTypes.System, "products", CancellationToken.None);
    }

    private static async Task SetCursorAsync(WebApplicationFactoryHost host, string? value)
    {
        await using var scope = host.Services.CreateAsyncScope();
        await scope.ServiceProvider.GetRequiredService<SyncRunner>().SetCursorAsync(PowerOfficeTypes.System, "products", value, CancellationToken.None);
    }

    private static async Task RunProductJobAsync(WebApplicationFactoryHost host)
    {
        await using var scope = host.Services.CreateAsyncScope();
        await scope.ServiceProvider.GetRequiredService<PowerOfficeProductSyncJob>().RunAsync(CancellationToken.None);
    }

    [Fact]
    public async Task The_cursor_moves_only_after_the_whole_enumeration_and_a_failed_second_page_leaves_it_alone()
    {
        using var po = StartPowerOffice();
        await using var host = HostFor(po);
        var start = DateTimeOffset.Parse("2036-05-01T10:00:00+00:00");
        await SetCursorAsync(host, PowerOfficeCursor.Format(start));
        var first = Random.Shared.NextInt64(7_000_000, 7_900_000);
        po.Given(Request.Create().WithPath("/v2/Products").UsingGet().WithParam("PageNumber", "1"))
            .RespondWith(JsonReply(new[] { Product(first, "A", "2036-05-02T10:00:00+00:00"), Product(first + 1, "B", "2036-05-03T10:00:00+00:00") }));
        po.Given(Request.Create().WithPath("/v2/Products").UsingGet().WithParam("PageNumber", "2")).RespondWith(Response.Create().WithStatusCode(500));

        await Should.ThrowAsync<SyncFailedException>(() => RunProductJobAsync(host));

        // The read started five minutes before the cursor; the second page was tried again (reads are repeated) and still failed.
        PowerOfficeCursor.Parse(await CursorAsync(host)).ShouldBe(start);
        po.LogEntries.First(e => e.RequestMessage!.Path == "/v2/Products").RequestMessage!.Url.ShouldContain("lastChangedDateTimeOffsetGreaterThan=2036-05-01T09");
        Count(po, "GET", "/v2/Products").ShouldBe(1 + 5);

        // PowerOffice recovers: the same read now completes and the cursor moves to the newest change seen.
        po.Reset();
        po.Given(Request.Create().WithPath("/OAuth/Token").UsingPost()).RespondWith(JsonReply(new { access_token = "po-token", token_type = "bearer", expires_in = 1200 }));
        po.Given(Request.Create().WithPath("/v2/Products").UsingGet().WithParam("PageNumber", "1"))
            .RespondWith(JsonReply(new[] { Product(first, "A", "2036-05-02T10:00:00+00:00"), Product(first + 1, "B", "2036-05-03T10:00:00+00:00") }));
        po.Given(Request.Create().WithPath("/v2/Products").UsingGet().WithParam("PageNumber", "2"))
            .RespondWith(JsonReply(new[] { Product(first + 2, "C", "2036-05-04T10:00:00+00:00") }));
        po.Given(Request.Create().WithPath("/v2/Products").UsingGet().WithParam("PageNumber", "3")).RespondWith(Response.Create().WithStatusCode(204));

        await RunProductJobAsync(host);

        PowerOfficeCursor.Parse(await CursorAsync(host)).ShouldBe(DateTimeOffset.Parse("2036-05-04T10:00:00+00:00"));
    }

    [Fact]
    public async Task A_record_inside_the_overlap_is_read_again_and_stored_once()
    {
        using var po = StartPowerOffice();
        await using var host = HostFor(po);
        await SetCursorAsync(host, null);
        var id = Random.Shared.NextInt64(7_000_000, 7_900_000);
        var externalId = id.ToString(System.Globalization.CultureInfo.InvariantCulture);

        void Stub(string name)
        {
            po.ResetMappings();
            po.Given(Request.Create().WithPath("/OAuth/Token").UsingPost()).RespondWith(JsonReply(new { access_token = "po-token", token_type = "bearer", expires_in = 1200 }));
            po.Given(Request.Create().WithPath("/v2/Products").UsingGet().WithParam("PageNumber", "1"))
                .RespondWith(JsonReply(new[] { Product(id, name, "2036-06-01T09:58:00+00:00") }));
            po.Given(Request.Create().WithPath("/v2/Products").UsingGet().WithParam("PageNumber", "2")).RespondWith(Response.Create().WithStatusCode(204));
        }

        async Task<(int Rows, string Name, string Hash)> StoredAsync()
        {
            await using var scope = host.Services.CreateAsyncScope();
            var rows = await scope.ServiceProvider.GetRequiredService<IntegrationDbContext>().ExternalRecords.AsNoTracking()
                .Where(r => r.System == PowerOfficeTypes.System && r.ExternalType == PowerOfficeTypes.Product && r.ExternalId == externalId).ToListAsync();
            return (rows.Count, rows.Single().DisplayName, rows.Single().Hash);
        }

        Stub("Original");
        await RunProductJobAsync(host);
        var stored = await StoredAsync();

        // The cursor is now 09:58, so the next read starts at 09:53 and gets the same record again: nothing is duplicated or changed.
        await RunProductJobAsync(host);
        po.LogEntries.Last(e => e.RequestMessage!.Path == "/v2/Products" && e.RequestMessage.Query!.ContainsKey("lastChangedDateTimeOffsetGreaterThan"))
            .RequestMessage!.Url.ShouldContain("lastChangedDateTimeOffsetGreaterThan=2036-06-01T09");
        (await StoredAsync()).ShouldBe(stored);

        // The same record with new content inside the overlap is updated in place.
        Stub("Renamed");
        await RunProductJobAsync(host);
        var renamed = await StoredAsync();
        renamed.Rows.ShouldBe(1);
        renamed.Name.ShouldContain("Renamed");
        renamed.Hash.ShouldNotBe(stored.Hash);
    }
}
