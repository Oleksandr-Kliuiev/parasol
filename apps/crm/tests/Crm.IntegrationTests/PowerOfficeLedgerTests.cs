using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crm.Authorization;
using Crm.Billing.Contracts;
using Crm.Billing.Persistence;
using Crm.Integrations.Core;
using Crm.Integrations.Core.Persistence;
using Crm.Integrations.PowerOffice;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using WireMock.RequestBuilders;
using WireMock.ResponseBuilders;
using WireMock.Server;
using static Crm.IntegrationTests.IntegrationTestHelpers;

namespace Crm.IntegrationTests;

[Collection(nameof(PowerOfficeResumeCollection))]
public sealed partial class PowerOfficeLedgerTests(CrmWebFactory factory)
{
    private static readonly DateTimeOffset Changed = DateTimeOffset.Parse("2035-01-01T10:00:00Z");
    private const string Endpoint = "/api/v1/billing/customer-ledger";
    private const string Stream = "customer-ledger-snapshot-v1";

    [Fact]
    public async Task Posted_payment_and_invoice_anchor_are_imported_paged_linked_and_not_double_counted()
    {
        using var po = Provider();
        await using var host = Host(po);
        var (customer, org) = await Customer(host);
        var voucher = Guid.NewGuid();
        var invoiceId = await SeedInvoice(host.Services, customer, org, voucher);
        var anchor = Entry(customer, "OutgoingInvoice") with { VoucherId = voucher, Amount = 1250m, CurrencyAmount = 1250m };
        var payment = Entry(customer, "IncomingOcrGiro") with { MatchId = anchor.MatchId };
        Pages(po, new[] { anchor }, new[] { payment });
        var before = await Counts(host.Services);
        await Run(host.Services);
        await Run(host.Services);
        var json = await Page(host, invoice: invoiceId);
        json.GetProperty("total").GetInt32().ShouldBe(2);
        var paid = json.GetProperty("entries").EnumerateArray().Single(e => e.GetProperty("source").GetProperty("externalId").GetInt64() == payment.Id);
        paid.GetProperty("source").GetProperty("kind").GetString().ShouldBe("Payment");
        paid.GetProperty("source").GetProperty("amount").GetDecimal().ShouldBe(-1250m);
        paid.GetProperty("presentInLatestScan").GetBoolean().ShouldBeTrue();
        var link = paid.GetProperty("invoices").EnumerateArray().ShouldHaveSingleItem();
        link.GetProperty("invoiceId").GetGuid().ShouldBe(invoiceId);
        link.GetProperty("relation").GetString().ShouldBe("MatchGroup");
        link.TryGetProperty("allocatedAmount", out _).ShouldBeFalse();
        (await Counts(host.Services)).ShouldBe(before);
        await using var scope = host.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<BillingDbContext>();
        (await db.CustomerLedgerEntries.CountAsync(e => e.CustomerKey == Key(customer))).ShouldBe(2);
        (await db.CustomerLedgerVersions.CountAsync(v => db.CustomerLedgerEntries.Any(e => e.CustomerKey == Key(customer) && e.Id == v.EntryId))).ShouldBe(2);
        var invoice = await db.Invoices.Include(i => i.Payments).SingleAsync(i => i.Id == invoiceId);
        invoice.Outstanding.ShouldBe(1250m); // The posted operation never overwrites the independent invoice balance snapshot.
        invoice.Payments.ShouldBeEmpty();
        po.LogEntries.ShouldContain(e => e.RequestMessage!.Query != null && e.RequestMessage.Query.ContainsKey("PageNumber") && e.RequestMessage.Query["PageNumber"].Contains("2"));
        foreach (var request in po.LogEntries.Where(e => e.RequestMessage!.Path == "/v2/Customerledger/Statement").Select(e => e.RequestMessage!))
        {
            request.Method.ShouldBe("GET");
            request.Query!["fromDate"].Single().ShouldBe("0001-01-01");
            request.Query["toDate"].Single().ShouldBe("9999-12-31");
            request.Query.ContainsKey("onlyBalancesLessThanAmount").ShouldBeFalse();
            request.Query.ContainsKey("lastChangedDateTimeOffsetGreaterThan").ShouldBeFalse();
            request.Query.ContainsKey("voucherTypes").ShouldBeFalse();
        }
        AssertReadOnly(po);
    }

    [Fact]
    public async Task Many_to_many_match_keeps_credit_writeoff_and_unallocated_payment_distinct()
    {
        using var po = Provider();
        await using var host = Host(po);
        var (customer, org) = await Customer(host);
        var v1 = Guid.NewGuid(); var v2 = Guid.NewGuid(); var creditVoucher = Guid.NewGuid();
        var first = await SeedInvoice(host.Services, customer, org, v1);
        var second = await SeedInvoice(host.Services, customer, org, v2);
        var credit = await SeedInvoice(host.Services, customer, org, creditVoucher, true);
        var a = Entry(customer, "OutgoingInvoice") with { VoucherId = v1, Amount = 1250m, CurrencyAmount = 1250m };
        var b = Entry(customer, "OutgoingInvoice") with { VoucherId = v2, MatchId = a.MatchId, Amount = 1250m, CurrencyAmount = 1250m };
        var c = Entry(customer, "OutgoingCreditNote") with { VoucherId = creditVoucher, MatchId = a.MatchId };
        var p1 = Entry(customer, "BankJournal") with { MatchId = a.MatchId, Amount = -500m, CurrencyAmount = -500m };
        var p2 = Entry(customer, "IncomingOcrGiro") with { MatchId = a.MatchId, Amount = -750m, CurrencyAmount = -750m };
        var writeoff = Entry(customer, "BankJournal") with { MatchId = a.MatchId, IsWriteOff = true };
        var other = Entry(customer, "ManualJournal") with { MatchId = a.MatchId };
        var unallocated = Entry(customer, "BankJournal") with { MatchId = null, Balance = -1250m, InvoiceNo = "10001" };
        Pages(po, new[] { a, b, c, p1, p2, writeoff, other, unallocated });
        await Run(host.Services);
        var entries = (await Page(host, organization: org)).GetProperty("entries").EnumerateArray().ToList();
        entries.Count.ShouldBe(8);
        var payment = entries.Single(e => SourceId(e) == p1.Id);
        payment.GetProperty("invoices").EnumerateArray().Select(i => i.GetProperty("invoiceId").GetGuid()).Order().ShouldBe(new[] { first, second, credit }.Order());
        entries.Count(e => e.GetProperty("source").GetProperty("kind").GetString() == "Payment").ShouldBe(3);
        entries.Single(e => SourceId(e) == writeoff.Id).GetProperty("source").GetProperty("kind").GetString().ShouldBe("WriteOff");
        entries.Single(e => SourceId(e) == other.Id).GetProperty("source").GetProperty("kind").GetString().ShouldBe("Other");
        entries.Single(e => SourceId(e) == unallocated.Id).GetProperty("invoices").GetArrayLength().ShouldBe(0);
        (await Page(host, invoice: first)).GetProperty("total").GetInt32().ShouldBe(7);
    }

    [Theory]
    [InlineData(CrmRoles.ReadOnly, HttpStatusCode.Forbidden)]
    [InlineData(CrmRoles.ServiceLead, HttpStatusCode.Forbidden)]
    [InlineData(CrmRoles.Technician, HttpStatusCode.Forbidden)]
    [InlineData(CrmRoles.Finance, HttpStatusCode.OK)]
    public async Task Ledger_json_requires_both_billing_and_finance_read(string role, HttpStatusCode expected)
    {
        using var po = Provider();
        await using var host = Host(po);
        var source = Entry(null, "BankJournal") with { AdditionalFields = new() { ["PaidFromBankAccount"] = JsonSerializer.SerializeToElement("SYNTHETIC-ACCOUNT") } };
        Pages(po, new[] { source });
        await Run(host.Services);
        var response = await Client(host, role).GetAsync(Endpoint);
        response.StatusCode.ShouldBe(expected);
        if (expected != HttpStatusCode.OK) (await response.Content.ReadAsStringAsync()).ShouldNotContain("SYNTHETIC-ACCOUNT");
    }

    [Fact]
    public async Task Unknown_and_foreign_currency_rows_keep_exact_amounts_and_deterministic_paging()
    {
        using var po = Provider();
        await using var host = Host(po);
        var (customer, org) = await Customer(host);
        var row = Entry(customer, "FutureUnknown") with { Amount = -1250.12345678m, CurrencyAmount = -100.0123456789m, CurrencyCode = "EUR" };
        Pages(po, new[] { row, Entry(customer, "BankJournal"), Entry(customer, "ManualJournal") });
        await Run(host.Services);
        var first = await Page(host, organization: org, limit: 1);
        var next = await Page(host, organization: org, offset: 1, limit: 1);
        first.GetProperty("total").GetInt32().ShouldBe(3);
        SourceId(first.GetProperty("entries")[0]).ShouldNotBe(SourceId(next.GetProperty("entries")[0]));
        var saved = (await Page(host, organization: org)).GetProperty("entries").EnumerateArray().Single(e => SourceId(e) == row.Id).GetProperty("source");
        saved.GetProperty("kind").GetString().ShouldBe("Other");
        saved.GetProperty("amount").GetDecimal().ShouldBe(row.Amount!.Value);
        saved.GetProperty("currencyAmount").GetDecimal().ShouldBe(row.CurrencyAmount!.Value);
        saved.GetProperty("currencyCode").GetString().ShouldBe("EUR");
        (await Client(host, CrmRoles.Finance).GetAsync(Endpoint + "?limit=201")).StatusCode.ShouldBe(HttpStatusCode.BadRequest);
        (await Client(host, CrmRoles.Finance).GetAsync(Endpoint + "?offset=-1")).StatusCode.ShouldBe(HttpStatusCode.BadRequest);
    }

    private WebApplicationFactory<Program> Host(WireMockServer po, bool enabled = true) => factory.WithWebHostBuilder(builder =>
    {
        builder.UseSetting("Integrations:PowerOffice:BaseUrl", po.Url + "/v2/");
        builder.UseSetting("Integrations:PowerOffice:TokenUrl", po.Url + "/OAuth/Token");
        builder.UseSetting("Integrations:PowerOffice:CustomerLedgerSyncEnabled", enabled ? "true" : "false");
        builder.UseSetting("Integrations:PowerOffice:WriteEnabled", "false");
        builder.UseSetting("Integrations:PowerOffice:RetryDelay", "00:00:00.020");
        builder.UseSetting("Integrations:PowerOffice:PageSize", "2");
    });
    private static WireMockServer Provider()
    {
        var po = WireMockServer.Start();
        po.Given(Request.Create().WithPath("/OAuth/Token").UsingPost()).RespondWith(JsonReply(new { access_token = "synthetic-ledger", token_type = "bearer", expires_in = 1200 }));
        return po;
    }
    private static void Pages(WireMockServer po, object[]? first = null, object[]? second = null)
    {
        object[] pages = first is null ? [] : second is null ? [first] : [first, second];
        for (var i = 0; i < pages.Length; i++) po.Given(Request.Create().WithPath("/v2/Customerledger/Statement").UsingGet().WithParam("PageNumber", (i + 1).ToString(CultureInfo.InvariantCulture))).RespondWith(JsonReply(pages[i]));
        po.Given(Request.Create().WithPath("/v2/Customerledger/Statement").UsingGet().WithParam("PageNumber", (pages.Length + 1).ToString(CultureInfo.InvariantCulture))).RespondWith(Response.Create().WithStatusCode(204));
    }
    private static PoCustomerLedgerEntry Entry(long? customer, string type) => new()
    {
        Id = Random.Shared.NextInt64(900000000, 999999999), CustomerId = customer, VoucherId = Guid.NewGuid(), VoucherNo = 91001,
        VoucherType = type, InvoiceNo = "10001", PostingDate = new(2026, 1, 2), VoucherDate = new(2026, 1, 2),
        Amount = -1250m, CurrencyAmount = -1250m, Balance = 0m, CurrencyCode = "NOK",
        MatchId = Random.Shared.NextInt64(900000000, 999999999), CreatedDateTimeOffset = Changed.AddDays(-1), LastChangedDateTimeOffset = Changed,
    };
    private static string Key(long value) => value.ToString(CultureInfo.InvariantCulture);
    private static HttpClient Client(WebApplicationFactory<Program> host, string role = CrmRoles.Admin)
    {
        var client = host.CreateClient();
        client.DefaultRequestHeaders.Add(TestAuthHandler.RolesHeader, role);
        client.DefaultRequestHeaders.Add(TestAuthHandler.UserHeader, "admin");
        client.DefaultRequestHeaders.Add("X-CSRF", "1");
        return client;
    }
    private static async Task<(long Customer, Guid Organization)> Customer(WebApplicationFactory<Program> host, bool linked = true)
    {
        var org = await Client(host).CreateOrganizationAsync(new { name = "Synthetic ledger customer", status = "Customer" });
        var customer = Random.Shared.NextInt64(900000000, 999999999);
        if (linked) await Link(host.Services, customer, org);
        return (customer, org);
    }
    private static async Task Link(IServiceProvider services, long customer, Guid org)
    {
        await using var scope = services.CreateAsyncScope();
        (await scope.ServiceProvider.GetRequiredService<ExternalLinkService>().LinkAsync(EntityTypes.Organization, org, "poweroffice", "Customer", Key(customer), LinkMethod.Manual, null, CancellationToken.None)).IsSuccess.ShouldBeTrue();
    }
    private static async Task<Guid> SeedInvoice(IServiceProvider services, long customer, Guid org, Guid voucher, bool credit = false)
    {
        var amount = credit ? -1250m : 1250m;
        var header = new PoOutgoingInvoice { Id = voucher, CustomerId = customer, InvoiceNo = 10001, VoucherDate = new(2026, 1, 1),
            CurrencyCode = "NOK", NetAmount = amount, NetPostedAmount = amount, TotalAmount = amount, TotalPostedAmount = amount, Balance = amount,
            IsReversed = false, VoucherType = credit ? "OutgoingCreditNote" : "OutgoingInvoice", LastChangedDateTimeOffset = Changed, BalanceLastChangedDateTimeOffset = Changed };
        await using var scope = services.CreateAsyncScope();
        await scope.ServiceProvider.GetRequiredService<IBillingApi>().UpsertInvoicesAsync([PowerOfficeInvoiceMapping.Map(header, []) with { OrganizationId = org }], CancellationToken.None);
        return (await scope.ServiceProvider.GetRequiredService<BillingDbContext>().Invoices.SingleAsync(i => i.System == "poweroffice" && i.ExternalId == voucher)).Id;
    }
    private static async Task Run(IServiceProvider services, CancellationToken ct = default)
    {
        await using var scope = services.CreateAsyncScope();
        await scope.ServiceProvider.GetRequiredService<PowerOfficeLedgerSyncJob>().RunAsync(ct);
    }
    private static async Task<JsonElement> Page(WebApplicationFactory<Program> host, Guid? organization = null, Guid? invoice = null, int offset = 0, int limit = 50)
    {
        var parameters = new List<string> { $"offset={offset}", $"limit={limit}" };
        if (organization is { } org) parameters.Add($"organizationId={org}");
        if (invoice is { } id) parameters.Add($"invoiceId={id}");
        return await (await Client(host, CrmRoles.Finance).GetAsync(Endpoint + "?" + string.Join('&', parameters))).ReadJsonAsync();
    }
    private static long SourceId(JsonElement element) => element.GetProperty("source").GetProperty("externalId").GetInt64();
    private static async Task<(int Bases, int Charges, int Pending, int Movements)> Counts(IServiceProvider services)
    {
        await using var scope = services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<BillingDbContext>();
        return (await db.BillingBases.CountAsync(), await db.Charges.CountAsync(), await db.PendingCharges.CountAsync(), await db.InvoicePayments.CountAsync());
    }
    private static void AssertReadOnly(WireMockServer po) => po.LogEntries.Where(e => e.RequestMessage!.Path!.StartsWith("/v2/", StringComparison.Ordinal)).ShouldAllBe(e => e.RequestMessage!.Method == "GET");
}
