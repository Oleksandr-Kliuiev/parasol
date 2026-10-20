using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crm.Authorization;
using Crm.Billing.Contracts;
using Crm.Billing.Domain;
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
public sealed partial class PowerOfficeInvoiceHistoryTests(CrmWebFactory factory)
{
    private static readonly DateTimeOffset Changed = DateTimeOffset.Parse("2031-10-01T10:00:00Z");
    private const string HistoryStream = "invoice-history-v1";

    [Fact]
    public async Task Historical_invoice_and_credit_note_keep_all_lines_exact_customer_and_no_billing_writes()
    {
        using var po = Provider();
        await using var host = Host(po);
        var org = await Admin(host).CreateOrganizationAsync(new { name = "Synthetic historical account", status = "Customer" });
        var customer = Random.Shared.NextInt64(820000000, 829999999);
        await Link(host.Services, customer, org);
        var invoice = Header(customer);
        var credit = Header(customer) with { InvoiceNo = invoice.InvoiceNo + 1, VoucherType = "OutgoingCreditNote", RelatedInvoiceNo = invoice.InvoiceNo,
            NetAmount = -1000m, TotalAmount = -1250m, NetPostedAmount = -1000m, TotalPostedAmount = -1250m, Balance = -1250m };
        Pages(po, "OutgoingInvoices", new[] { invoice, credit });
        Pages(po, Lines(invoice), new[] { Line(), new PoOutgoingInvoiceLine { Id = 72, SortOrder = 1, LineType = "Text", Description = "Synthetic terms" } },
            new[] { Line() with { Id = 73, SortOrder = 2, LineType = "Summary" } });
        Pages(po, Lines(credit), new[] { Line() with { NetAmount = -1000m, VatAmount = -250m, TotalAmount = -1250m,
            NetPostedAmount = -1000m, TotalPostedAmount = -1250m, Quantity = -1m } });
        var before = await FinancialCounts(host.Services);
        await Run(host.Services);
        await Run(host.Services);
        var saved = await Read(host.Services, invoice.Id);
        saved.OrganizationId.ShouldBe(org);
        saved.BasisId.ShouldBeNull();
        saved.History!.Lines.Select(l => l.Id).ShouldBe([71, 72, 73]);
        saved.History.LineCoverage.ShouldBe(InvoiceLineCoverage.Reconciled);
        saved.Payments.ShouldBeEmpty();
        var note = await Read(host.Services, credit.Id);
        note.OrganizationId.ShouldBe(org);
        note.DocumentKind.ShouldBe(InvoiceDocumentKind.CreditNote);
        note.Outstanding.ShouldBe(-1250m);
        note.History!.RelatedInvoiceNo.ShouldBe(invoice.InvoiceNo!.Value.ToString(CultureInfo.InvariantCulture));
        note.History.Lines.Single().Quantity.ShouldBe(-1m);
        saved.Outstanding.ShouldBe(1250m); // RelatedInvoiceNo is not authority to settle the original invoice.
        (await FinancialCounts(host.Services)).ShouldBe(before);
        await using var scope = host.Services.CreateAsyncScope();
        (await scope.ServiceProvider.GetRequiredService<BillingDbContext>().Invoices.CountAsync(i => i.ExternalId == invoice.Id || i.ExternalId == credit.Id)).ShouldBe(2);
        AssertReadOnly(po);
        po.LogEntries.ShouldContain(e => e.RequestMessage!.Path == $"/v2/{Lines(invoice)}" && e.RequestMessage.Query!["PageNumber"].Contains("2"));
    }

    [Fact]
    public async Task Reused_document_number_and_legacy_row_are_preserved_as_distinct_source_identities()
    {
        using var po = Provider();
        await using var host = Host(po);
        var first = Header(null) with { IsReversed = true };
        var second = Header(null) with { InvoiceNo = first.InvoiceNo };
        var legacy = new ExternalInvoice("poweroffice", first.InvoiceNo!.Value.ToString(CultureInfo.InvariantCulture), null, null, null,
            new(2026, 1, 1), null, 1250m, 1250m, InvoiceStatus.Sent, "https://example.invalid/legacy-invoice");
        await using (var scope = host.Services.CreateAsyncScope())
        {
            var api = scope.ServiceProvider.GetRequiredService<IBillingApi>();
            await api.UpsertInvoicesAsync([legacy], CancellationToken.None);
            await api.UpsertInvoicesAsync([legacy with { Outstanding = 1000m }], CancellationToken.None);
        }
        Pages(po, "OutgoingInvoices", new[] { first, second });
        Pages(po, Lines(first), new[] { Line() });
        Pages(po, Lines(second), new[] { Line() });
        await Run(host.Services);
        await Run(host.Services);
        await using var check = host.Services.CreateAsyncScope();
        var db = check.ServiceProvider.GetRequiredService<BillingDbContext>();
        var rows = await db.Invoices.Include(i => i.Payments).Where(i => i.System == "poweroffice" && i.InvoiceNo == legacy.InvoiceNo).ToListAsync();
        rows.Count.ShouldBe(3);
        var old = rows.Single(i => i.ExternalId is null);
        old.Url.ShouldBe(legacy.Url);
        old.Outstanding.ShouldBe(1000m);
        old.Payments.ShouldHaveSingleItem().Amount.ShouldBe(250m);
        rows.Single(i => i.ExternalId == first.Id).Status.ShouldBe(InvoiceStatus.Credited);
        rows.Single(i => i.ExternalId == second.Id).Status.ShouldBe(InvoiceStatus.Sent);
        db.Database.HasPendingModelChanges().ShouldBeFalse();
    }

    [Theory]
    [InlineData(CrmRoles.ReadOnly, HttpStatusCode.Forbidden)]
    [InlineData(CrmRoles.ServiceLead, HttpStatusCode.Forbidden)]
    [InlineData(CrmRoles.Finance, HttpStatusCode.OK)]
    public async Task Raw_history_requires_billing_and_finance_read(string role, HttpStatusCode expected)
    {
        using var po = Provider();
        await using var host = Host(po);
        var invoice = Header(null);
        Pages(po, "OutgoingInvoices", new[] { invoice });
        Pages(po, Lines(invoice), new[] { Line() });
        await Run(host.Services);
        var saved = await Read(host.Services, invoice.Id);
        var client = Client(host, role);
        var response = await client.GetAsync($"/api/v1/billing/invoices/{saved.Id}/history");
        response.StatusCode.ShouldBe(expected);
        if (expected == HttpStatusCode.OK)
        {
            var json = await response.ReadJsonAsync();
            json.GetProperty("history").GetProperty("externalId").GetGuid().ShouldBe(invoice.Id);
            json.GetProperty("history").GetProperty("lines").GetArrayLength().ShouldBe(1);
            json.GetProperty("invoice").GetProperty("documentCurrencyCode").GetString().ShouldBe("NOK");
        }
        else (await response.Content.ReadAsStringAsync()).ShouldNotContain("Synthetic historical line");
    }

    [Fact]
    public async Task Credit_notes_and_reversals_are_not_overdue_and_open_negative_credit_is_visible()
    {
        using var po = Provider();
        await using var host = Host(po);
        var org = await Admin(host).CreateOrganizationAsync(new { name = "Synthetic credits overview", status = "Customer" });
        var customer = Random.Shared.NextInt64(870000000, 879999999);
        await Link(host.Services, customer, org);
        var reversed = Header(customer) with { IsReversed = true };
        var positiveNote = Header(customer) with { VoucherType = "OutgoingCreditNote" };
        var negativeNote = Header(customer) with { VoucherType = "OutgoingCreditNote", NetAmount = -1000m,
            TotalAmount = -1250m, NetPostedAmount = -1000m, TotalPostedAmount = -1250m, Balance = -1250m };
        Pages(po, "OutgoingInvoices", new[] { reversed, positiveNote }, new[] { negativeNote });
        foreach (var source in new[] { reversed, positiveNote, negativeNote }) Pages(po, Lines(source));
        await Run(host.Services);
        var finance = Client(host, CrmRoles.Finance);
        var open = await finance.GetFromJsonAsync<JsonElement>($"/api/v1/billing/invoices?organizationId={org}&openOnly=true");
        open.GetProperty("invoices").GetArrayLength().ShouldBe(3);
        open.GetProperty("overdue").GetDecimal().ShouldBe(0m);
        var overdue = await finance.GetFromJsonAsync<JsonElement>($"/api/v1/billing/invoices?organizationId={org}&overdueOnly=true");
        overdue.GetProperty("invoices").GetArrayLength().ShouldBe(0);
        await using var scope = host.Services.CreateAsyncScope();
        var api = scope.ServiceProvider.GetRequiredService<IBillingApi>();
        (await api.GetOverdueInvoicesAsync(new(2100, 1, 1), CancellationToken.None)).ShouldAllBe(i => i.OrganizationId != org);
    }

    private WebApplicationFactory<Program> Host(WireMockServer po) => factory.WithWebHostBuilder(builder =>
    {
        builder.UseSetting("Integrations:PowerOffice:BaseUrl", po.Url + "/v2/");
        builder.UseSetting("Integrations:PowerOffice:TokenUrl", po.Url + "/OAuth/Token");
        builder.UseSetting("Integrations:PowerOffice:WriteEnabled", "false");
        builder.UseSetting("Integrations:PowerOffice:PageSize", "2");
        builder.UseSetting("Integrations:PowerOffice:RetryDelay", "00:00:00.020");
    });

    private static WireMockServer Provider()
    {
        var po = WireMockServer.Start();
        po.Given(Request.Create().WithPath("/OAuth/Token").UsingPost())
            .RespondWith(JsonReply(new { access_token = "synthetic-history-token", token_type = "bearer", expires_in = 1200 }));
        return po;
    }

    private static PoOutgoingInvoice Header(long? customer) => new()
    {
        Id = Guid.NewGuid(), InvoiceNo = Random.Shared.NextInt64(830000000, 839999999), CustomerId = customer,
        VoucherDate = new(2026, 1, 1), DueDate = new(2026, 1, 15), CurrencyCode = "NOK", NetAmount = 1000m,
        TotalAmount = 1250m, NetPostedAmount = 1000m, TotalPostedAmount = 1250m, Balance = 1250m,
        VoucherType = "OutgoingInvoice", IsReversed = false, LastChangedDateTimeOffset = Changed, BalanceLastChangedDateTimeOffset = Changed,
    };

    private static PoOutgoingInvoiceLine Line() => new()
    {
        Id = 71, SortOrder = 0, LineType = "Normal", Description = "Synthetic historical line", ProductId = 7, ProductCode = "SUPPORT",
        UnitOfMeasureCode = "HUR", Quantity = 1m, ProductUnitPrice = 1000m, VatRate = .25m, NetAmount = 1000m,
        VatAmount = 250m, TotalAmount = 1250m, NetPostedAmount = 1000m, TotalPostedAmount = 1250m,
    };

    private static string Lines(PoOutgoingInvoice header) => $"OutgoingInvoices/{header.Id:D}/Lines";

    private static void Pages(WireMockServer po, string resource, object[]? first = null, object[]? second = null)
    {
        object[] pages = first is null ? [] : second is null ? [first] : [first, second];
        for (var i = 0; i < pages.Length; i++)
            po.Given(Request.Create().WithPath($"/v2/{resource}").UsingGet().WithParam("PageNumber", (i + 1).ToString(CultureInfo.InvariantCulture)))
                .RespondWith(JsonReply(pages[i]));
        po.Given(Request.Create().WithPath($"/v2/{resource}").UsingGet().WithParam("PageNumber", (pages.Length + 1).ToString(CultureInfo.InvariantCulture)))
            .RespondWith(Response.Create().WithStatusCode(204));
    }

    private static HttpClient Admin(WebApplicationFactory<Program> host) => Client(host, CrmRoles.Admin);
    private static HttpClient Client(WebApplicationFactory<Program> host, string role)
    {
        var client = host.CreateClient();
        client.DefaultRequestHeaders.Add(TestAuthHandler.RolesHeader, role);
        client.DefaultRequestHeaders.Add(TestAuthHandler.UserHeader, "admin");
        client.DefaultRequestHeaders.Add("X-CSRF", "1");
        return client;
    }

    private static async Task Run(IServiceProvider services)
    {
        await using var scope = services.CreateAsyncScope();
        await scope.ServiceProvider.GetRequiredService<PowerOfficeInvoiceSyncJob>().RunAsync(CancellationToken.None);
    }

    private static async Task<Invoice> Read(IServiceProvider services, Guid sourceId)
    {
        await using var scope = services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<BillingDbContext>().Invoices.AsNoTracking().Include(i => i.Payments)
            .SingleAsync(i => i.System == "poweroffice" && i.ExternalId == sourceId);
    }

    private static async Task Link(IServiceProvider services, long customer, Guid organization)
    {
        await using var scope = services.CreateAsyncScope();
        (await scope.ServiceProvider.GetRequiredService<ExternalLinkService>().LinkAsync(EntityTypes.Organization, organization, "poweroffice", "Customer",
            customer.ToString(CultureInfo.InvariantCulture), LinkMethod.Manual, null, CancellationToken.None)).IsSuccess.ShouldBeTrue();
    }

    private static async Task<(int Bases, int Charges, int Pending, int Lines)> FinancialCounts(IServiceProvider services)
    {
        await using var scope = services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<BillingDbContext>();
        return (await db.BillingBases.CountAsync(), await db.Charges.CountAsync(), await db.PendingCharges.CountAsync(), await db.BillingLines.CountAsync());
    }

    private static void AssertReadOnly(WireMockServer po) => po.LogEntries
        .Where(e => e.RequestMessage!.Path!.StartsWith("/v2/", StringComparison.Ordinal)).ShouldAllBe(e => e.RequestMessage!.Method == "GET");
}
