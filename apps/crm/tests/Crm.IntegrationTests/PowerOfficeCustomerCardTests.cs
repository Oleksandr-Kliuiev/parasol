using System.Net;
using Crm.Authorization;
using Crm.Billing.Contracts;
using Crm.Billing.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using static Crm.IntegrationTests.IntegrationTestHelpers;

namespace Crm.IntegrationTests;

public sealed partial class PowerOfficePdfTests
{
    [Fact]
    public async Task Customer_card_history_pdf_list_and_download_reject_a_different_or_relinked_customer()
    {
        using var po = Provider(); await using var host = Host(po);
        var admin = Client(host, CrmRoles.Admin);
        var first = await admin.CreateOrganizationAsync(new { name = "Synthetic card first", status = "Customer" });
        var second = await admin.CreateOrganizationAsync(new { name = "Synthetic card second", status = "Customer" });
        var source = await Seed(host, organization: first);
        await Import(host, source, [new("invoice.pdf", Pdf("Synthetic scoped PDF"))]);
        var document = (await Documents(host, source.InvoiceId)).Single();
        string[] routes = [$"/api/v1/billing/invoices/{source.InvoiceId}/history", $"/api/v1/billing/invoices/{source.InvoiceId}/documents", Download(source.InvoiceId, document.Id)];
        var finance = Client(host, CrmRoles.Finance);
        foreach (var route in routes)
        {
            (await finance.GetAsync(route + $"?organizationId={first}")).StatusCode.ShouldBe(HttpStatusCode.OK);
            (await finance.GetAsync(route + $"?organizationId={second}")).StatusCode.ShouldBe(HttpStatusCode.NotFound);
        }
        await using var scope = host.Services.CreateAsyncScope();
        var customer = await scope.ServiceProvider.GetRequiredService<BillingDbContext>().Invoices.Where(i => i.Id == source.InvoiceId).Select(i => i.ExternalCustomerId).SingleAsync();
        await scope.ServiceProvider.GetRequiredService<IBillingApi>().BindHistoricalInvoiceAsync(source.InvoiceId, customer!, second, CancellationToken.None);
        foreach (var route in routes)
        {
            (await finance.GetAsync(route + $"?organizationId={first}")).StatusCode.ShouldBe(HttpStatusCode.NotFound);
            (await finance.GetAsync(route + $"?organizationId={second}")).StatusCode.ShouldBe(HttpStatusCode.OK);
        }
    }
}

public sealed partial class PowerOfficeLedgerTests
{
    [Fact]
    public async Task Card_payment_filter_is_applied_before_paging_and_empty_import_is_distinct_from_never_imported()
    {
        using var po = Provider(); await using var host = Host(po);
        var (customer, org) = await Customer(host);
        var untouched = await Client(host).CreateOrganizationAsync(new { name = "Synthetic ledger not imported", status = "Customer" });
        var invoice = Entry(customer, "OutgoingInvoice");
        var one = Entry(customer, "IncomingOcrGiro");
        var two = Entry(customer, "BankJournal");
        var writeOff = Entry(customer, "BankJournal") with { IsWriteOff = true };
        Pages(po, [invoice, one], [two, writeOff]); await Run(host.Services);
        var finance = Client(host, CrmRoles.Finance);
        var path = Endpoint + $"?organizationId={org}&kind=Payment&limit=1";
        var first = await (await finance.GetAsync(path)).ReadJsonAsync();
        first.GetProperty("total").GetInt32().ShouldBe(2);
        first.GetProperty("entries").GetArrayLength().ShouldBe(1);
        first.GetProperty("entries")[0].GetProperty("source").GetProperty("kind").GetString().ShouldBe("Payment");
        first.GetProperty("sourceCustomers").GetInt32().ShouldBe(1);
        first.GetProperty("oldestSnapshotAt").ValueKind.ShouldBe(System.Text.Json.JsonValueKind.String);
        var second = await (await finance.GetAsync(path + "&offset=1")).ReadJsonAsync();
        second.GetProperty("entries")[0].GetProperty("id").GetString().ShouldNotBe(first.GetProperty("entries")[0].GetProperty("id").GetString());
        (await finance.GetAsync(Endpoint + "?kind=999")).StatusCode.ShouldBe(HttpStatusCode.BadRequest);
        var absent = await Page(host, organization: untouched);
        absent.GetProperty("sourceCustomers").GetInt32().ShouldBe(0);
        absent.GetProperty("oldestSnapshotAt").ValueKind.ShouldBe(System.Text.Json.JsonValueKind.Null);
        Pages(po); await Run(host.Services);
        var empty = await Page(host, organization: org);
        empty.GetProperty("sourceCustomers").GetInt32().ShouldBe(1);
        empty.GetProperty("oldestSnapshotAt").ValueKind.ShouldBe(System.Text.Json.JsonValueKind.String);
        var old = await (await finance.GetAsync(path)).ReadJsonAsync();
        old.GetProperty("entries")[0].GetProperty("presentInLatestScan").GetBoolean().ShouldBeFalse();
    }
}
