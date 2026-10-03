using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Crm.Authorization;
using Crm.Integrations.PowerOffice;
using WireMock.RequestBuilders;
using WireMock.ResponseBuilders;
using static Crm.IntegrationTests.IntegrationTestHelpers;

namespace Crm.IntegrationTests;

/// <summary>
/// The whole billing run (docs/02 §4.9). The test database is shared, so other tests' contracts are collected as well; every
/// assertion therefore looks at this test's own basis, its own customer or its own sales order.
/// </summary>
public class BillingApiTests(CrmWebFactory factory)
{
    private const string Billing = "/api/v1/billing";
    private const string Contracts = "/api/v1/contracts";

    internal static async Task LinkAsync(HttpClient admin, string entityType, Guid entityId, string externalType, string externalId) =>
        (await admin.PostAsJsonAsync("/api/v1/integrations/links", new
        {
            system = "poweroffice", externalType, externalId, entityId, entityType,
        })).StatusCode.ShouldBe(HttpStatusCode.OK);

    /// <summary>
    /// Dispatches events and outbound operations until the basis has left the queue. Other test classes run in parallel and
    /// drain the same outbox, so a single pass can end before this basis has been picked up.
    /// </summary>
    private async Task<JsonElement> WaitForExportAsync(HttpClient client, Guid basisId)
    {
        JsonElement basis = default;
        for (var attempt = 0; attempt < 10; attempt++)
        {
            await factory.ProcessEventsAndOutboundAsync();
            basis = await client.GetFromJsonAsync<JsonElement>($"{Billing}/bases/{basisId}");
            if (basis.GetProperty("status").GetString() != "Approved")
            {
                return basis;
            }
        }

        return basis;
    }

    internal static void StubToken(CrmWebFactory factory)
    {
        var basic = Convert.ToBase64String(Encoding.UTF8.GetBytes("test-application-key:test-client-key"));
        factory.PowerOffice.Given(Request.Create().WithPath("/OAuth/Token").UsingPost().WithHeader("Authorization", $"Basic {basic}"))
            .RespondWith(JsonReply(new { access_token = "po-token", token_type = "bearer", expires_in = 1200 }));
    }

    [Fact]
    public async Task A_monthly_run_collects_contracts_licences_and_hours_then_exports_to_poweroffice()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "billing-admin");
        var finance = factory.ClientAs(CrmRoles.Finance, userKey: "billing-finance");
        var lead = factory.ClientAs(CrmRoles.ServiceLead, userKey: "billing-lead");
        var technician = factory.ClientAs(CrmRoles.Technician, userKey: "billing-tech");
        var marker = $"B{Guid.NewGuid():N}"[..10];
        var period = new DateOnly(2027, 3, 1);
        var contractStart = new DateOnly(2027, 1, 1);
        StubToken(factory);

        var orgNumber = TestData.OrgNumber();
        var organizationId = await admin.CreateOrganizationAsync(new { name = $"{marker} Faktura AS", status = "Customer", orgNumber });
        var customerId = Random.Shared.NextInt64(700_000, 799_999).ToString(CultureInfo.InvariantCulture);
        await LinkAsync(admin, "Organization", organizationId, "Customer", customerId);

        // Catalog: a monthly managed service, a Microsoft licence tied to an offer id and an hourly product.
        var offerId = $"CFQ7-{marker}";
        // The work type is unique to this test: other tests keep hourly products of their own, and the rate is looked up by work type.
        var workType = $"Remote-{marker}";
        var serviceSku = CatalogApiTests.Sku("MSP");
        var licenceSku = CatalogApiTests.Sku("M365");
        var hourSku = CatalogApiTests.Sku("HOUR");
        var serviceProduct = await CatalogApiTests.CreateProductAsync(finance, CatalogApiTests.Product(serviceSku, "Managed services", 5_000m, 2_000m));
        var licenceProduct = await CatalogApiTests.CreateProductAsync(finance, new
        {
            sku = licenceSku, name = "Microsoft 365 Business Premium", type = "MicrosoftLicense", businessLine = "Microsoft", unit = "License",
            billingPeriod = "Monthly", vatRate = 25m, listPrice = 250m, unitCost = 200m, microsoftOfferId = offerId, commitmentTerm = "P1Y",
        });
        var hourProduct = await CatalogApiTests.CreateProductAsync(finance, new
        {
            sku = hourSku, name = "Support hour", type = "HourlyService", businessLine = "Consulting", unit = "Hour",
            billingPeriod = "OneTime", vatRate = 25m, listPrice = 1_250m, unitCost = 500m, ateraWorkType = workType,
        });
        // The link says the product exists in PowerOffice; the order line carries the SKU, which is the product code there (docs/05 §4.2).
        foreach (var productId in new[] { serviceProduct, licenceProduct, hourProduct })
        {
            await LinkAsync(admin, "Product", productId, "Product", Random.Shared.NextInt64(10_000, 99_999).ToString(CultureInfo.InvariantCulture));
        }

        // A contract billed monthly in advance: a fixed fee and a licence line counted from the CSP subscriptions.
        var contract = await (await admin.PostAsJsonAsync(Contracts, new
        {
            organizationId, title = $"{marker} Drift", type = "Mixed", startDate = contractStart, endDate = period.AddMonths(1).AddDays(-1),
            autoRenew = false, renewalTermMonths = 0, noticePeriodDays = 30, invoiceFrequency = "Monthly", invoiceTiming = "InAdvance",
            indexation = false, customerReference = "PO-4711",
        })).ReadJsonAsync();
        var contractId = contract.GetProperty("id").GetGuid();
        (await admin.PostAsJsonAsync($"{Contracts}/{contractId}/lines", new
        {
            productId = serviceProduct, quantityModel = "Fixed", quantity = 1m, unitPrice = 5_000m, validFrom = contractStart,
        })).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await admin.PostAsJsonAsync($"{Contracts}/{contractId}/lines", new
        {
            productId = licenceProduct, quantityModel = "PerSubscription", quantity = 1m, unitPrice = 250m, validFrom = contractStart,
        })).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await admin.PostAsync($"{Contracts}/{contractId}/activate", null)).StatusCode.ShouldBe(HttpStatusCode.OK);

        // 25 licences from a distributor file; the org number links them to the customer (BR-LIC-01).
        var csv = string.Join('\n',
            "Kundeid;Kundenavn;Organisasjonsnummer;AbonnementsID;OfferId;Produktnavn;Antall;Status;Bindingstid;Startdato;Fornyelsesdato;Autofornyelse;Partnerpris",
            $"csp-{marker};{marker} Faktura AS;{orgNumber};sub-{marker};{offerId};Microsoft 365 Business Premium;25;Active;P1Y;{contractStart:yyyy-MM-dd};2028-01-01;ja;225,50");
        (await admin.PostAsync("/api/v1/licensing/import", new StringContent(csv, Encoding.UTF8, "text/csv"))).StatusCode.ShouldBe(HttpStatusCode.OK);
        var subscription = (await admin.GetFromJsonAsync<JsonElement>($"/api/v1/licensing/subscriptions?search={marker}")).EnumerateArray().ShouldHaveSingleItem();
        subscription.GetProperty("organizationId").GetGuid().ShouldBe(organizationId);
        subscription.GetProperty("productId").GetGuid().ShouldBe(licenceProduct);

        // Three hours of remote work in the period, approved by the service lead and billed at the catalog rate.
        var entry = await (await technician.PostAsJsonAsync("/api/v1/time/entries", new
        {
            organizationId, workDate = new DateOnly(2027, 3, 12), hours = 3m, workType, billable = true, onsite = false,
            afterHours = false, description = "Feilsøking av skriver",
        })).ReadJsonAsync();
        var entryId = entry.GetProperty("id").GetGuid();
        (await lead.PostAsJsonAsync("/api/v1/time/approve", new { entryIds = new[] { entryId } })).StatusCode.ShouldBe(HttpStatusCode.OK);

        // 1. A run is started and collected.
        (await lead.PostAsJsonAsync($"{Billing}/runs", new { year = period.Year, month = period.Month })).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        var run = await (await finance.PostAsJsonAsync($"{Billing}/runs", new { year = period.Year, month = period.Month, notes = marker })).ReadJsonAsync();
        var runId = run.GetProperty("id").GetGuid();
        run.GetProperty("status").GetString().ShouldBe("Draft");

        // BR-BIL-01: only one open run per period.
        var duplicate = await finance.PostAsJsonAsync($"{Billing}/runs", new { year = period.Year, month = period.Month });
        duplicate.StatusCode.ShouldBe(HttpStatusCode.Conflict);
        (await duplicate.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe("BIL_PERIOD_BUSY");

        (await (await finance.PostAsync($"{Billing}/runs/{runId}/collect", null)).ReadJsonAsync())
            .GetProperty("status").GetString().ShouldBe("Collected");

        var bases = await finance.GetFromJsonAsync<JsonElement>($"{Billing}/runs/{runId}/bases?search={marker}");
        var basis = bases.EnumerateArray().Single(b => b.GetProperty("organization").GetProperty("id").GetGuid() == organizationId);
        // 5 000 fixed + 25 × 250 licences + 3 × 1 250 hours = 15 000 (docs/02 §4.9).
        basis.GetProperty("totalExVat").GetDecimal().ShouldBe(15_000m);
        var basisId = basis.GetProperty("id").GetGuid();

        var detail = await finance.GetFromJsonAsync<JsonElement>($"{Billing}/bases/{basisId}");
        var groups = detail.GetProperty("lines").EnumerateArray().GroupBy(l => l.GetProperty("group").GetString()!).ToDictionary(g => g.Key, g => g.ToList());
        groups["Subscription"].Single().GetProperty("lineTotal").GetDecimal().ShouldBe(5_000m);
        groups["Subscription"].Single().GetProperty("description").GetString().ShouldBe("Managed services (01.03.2027–31.03.2027)");
        groups["License"].Single().GetProperty("quantity").GetDecimal().ShouldBe(25m);
        groups["License"].Single().GetProperty("lineTotal").GetDecimal().ShouldBe(6_250m);
        var hourLine = groups["HourlyWork"].Single();
        hourLine.GetProperty("lineTotal").GetDecimal().ShouldBe(3_750m);
        hourLine.GetProperty("description").GetString()!.ShouldContain("Feilsøking av skriver");
        detail.GetProperty("customerReference").GetString().ShouldBe("PO-4711");
        detail.GetProperty("anomalies").EnumerateArray().Select(a => a.GetProperty("code").GetString()).ShouldBeEmpty();

        // A technician sees no billing at all, and the service lead sees no money.
        (await technician.GetAsync($"{Billing}/runs")).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        var asLead = await lead.GetFromJsonAsync<JsonElement>($"{Billing}/bases/{basisId}");
        asLead.TryGetProperty("totalExVat", out _).ShouldBeFalse();
        asLead.GetProperty("lines").EnumerateArray().First().TryGetProperty("unitPrice", out _).ShouldBeFalse();

        // 2. Finance adds a one-off line by hand; re-collecting keeps it (BR-BIL-02).
        var read = await finance.GetAsync($"{Billing}/bases/{basisId}");
        var etag = read.Headers.ETag!.Tag;
        // The SPA sends If-Match from the body, so the property has to be named "etag" in JSON, not "eTag".
        (await read.ReadJsonAsync()).GetProperty("etag").GetString().ShouldBe(etag);
        var withManual = await finance.PostWithETagAsync($"{Billing}/bases/{basisId}/lines", new
        {
            productId = hourProduct, description = "Onboarding, fast pris", quantity = 1m, unitPrice = 4_000m,
        }, etag);
        withManual.StatusCode.ShouldBe(HttpStatusCode.OK);
        (await withManual.ReadJsonAsync()).GetProperty("totalExVat").GetDecimal().ShouldBe(19_000m);

        (await finance.PostAsync($"{Billing}/runs/{runId}/collect", null)).StatusCode.ShouldBe(HttpStatusCode.OK);
        var recollected = await finance.GetFromJsonAsync<JsonElement>($"{Billing}/bases/{basisId}");
        recollected.GetProperty("totalExVat").GetDecimal().ShouldBe(19_000m);
        recollected.GetProperty("lines").EnumerateArray().Count(l => l.GetProperty("manuallyAdjusted").GetBoolean()).ShouldBe(1);

        // 3. Approval hands the run to the export queue; PowerOffice gets one sales order per customer.
        factory.PowerOffice.Given(Request.Create().WithPath("/v2/SalesOrders").UsingGet()).AtPriority(5)
            .RespondWith(Response.Create().WithStatusCode(204));
        factory.PowerOffice.Given(Request.Create().WithPath("/v2/SalesOrders").UsingPost()).AtPriority(5)
            .RespondWith(JsonReply(new { Id = 8_001, OrderNo = 5_042, CustomerId = long.Parse(customerId, CultureInfo.InvariantCulture), Status = "Draft" }));

        (await lead.PostAsync($"{Billing}/runs/{runId}/approve", null)).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        var approved = await (await finance.PostAsync($"{Billing}/runs/{runId}/approve", null)).ReadJsonAsync();
        approved.GetProperty("status").GetString().ShouldBe("Approved");
        approved.GetProperty("approvedBy").GetProperty("name").GetString().ShouldBe("Test billing-finance");

        // An approved basis is immutable (BR-BIL-10).
        var lockedEtag = (await finance.GetAsync($"{Billing}/bases/{basisId}")).Headers.ETag!.Tag;
        var locked = await finance.PostWithETagAsync($"{Billing}/bases/{basisId}/lines", new { description = "too late", quantity = 1m, unitPrice = 1m }, lockedEtag);
        locked.StatusCode.ShouldBe(HttpStatusCode.Conflict);
        (await locked.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe("BIL_BASIS_LOCKED");

        var exported = await WaitForExportAsync(finance, basisId);
        exported.GetProperty("status").GetString().ShouldBe("Exported");
        exported.GetProperty("orderNo").GetString().ShouldBe("5042");
        exported.GetProperty("attempts").EnumerateArray().First().GetProperty("result").GetString().ShouldBe("Exported");
        (await finance.GetFromJsonAsync<JsonElement>($"{Billing}/runs/{runId}")).GetProperty("exported").GetInt32().ShouldBeGreaterThanOrEqualTo(1);

        // BR-BIL-08: the hours behind the order are invoiced now. The export event reaches the time module through the
        // outbox, so the status follows the order by a moment.
        async Task<JsonElement> EntryAsync() =>
            (await finance.GetFromJsonAsync<JsonElement>($"/api/v1/time/entries?organizationId={organizationId}"))
            .GetProperty("items").EnumerateArray().Single(e => e.GetProperty("id").GetGuid() == entryId);
        await factory.EventuallyAsync(async () => (await EntryAsync()).GetProperty("status").GetString() == "Invoiced");
        (await EntryAsync()).GetProperty("status").GetString().ShouldBe("Invoiced");

        // BR-BIL-05/06: exactly one order for this basis, carrying the customer reference and the mapped product codes.
        var posted = factory.PowerOffice.LogEntries
            .Select(e => e.RequestMessage)
            .Where(r => r is { Path: "/v2/SalesOrders", Method: "POST" } && r.Body?.Contains(organizationId.ToString("N"), StringComparison.Ordinal) == true)
            .ToList();
        // The times say whether a second order came from a retry or from two executors at once (DEV-07).
        posted.Count.ShouldBe(1, "Orders sent: " + string.Join(", ", posted.Select(r => r!.DateTime.ToString("HH:mm:ss.fff", CultureInfo.InvariantCulture))));
        var order = posted.Single()!.Body!;
        order.ShouldContain("PO-4711");
        order.ShouldContain(serviceSku);
        order.ShouldContain("Onboarding, fast pris");

        // 4. The invoice comes back from PowerOffice and lands on the basis and the customer.
        var invoiceNo = $"INV-{marker}";
        factory.PowerOffice.Given(Request.Create().WithPath("/v2/OutgoingInvoices").UsingGet().WithParam("PageNumber", "1")).AtPriority(5)
            .RespondWith(JsonReply(new[]
            {
                new
                {
                    Id = 9_001, InvoiceNo = invoiceNo, OrderNo = 5_042, CustomerId = long.Parse(customerId, CultureInfo.InvariantCulture),
                    InvoiceDate = "2027-03-31T00:00:00+00:00", DueDate = "2027-04-14T00:00:00+00:00",
                    TotalAmount = 23_750m, RemainingAmount = 23_750m, Status = "Sent", IsCredited = false,
                    PdfUrl = "https://go.poweroffice.net/invoice/9001", LastChangedDateTimeOffset = "2027-03-31T10:00:00+00:00",
                },
            }));
        factory.PowerOffice.Given(Request.Create().WithPath("/v2/OutgoingInvoices").UsingGet().WithParam("PageNumber", "2")).AtPriority(5)
            .RespondWith(Response.Create().WithStatusCode(204));

        await factory.RunJobAsync<PowerOfficeInvoiceSyncJob>(j => j.RunAsync(CancellationToken.None));

        var invoices = await finance.GetFromJsonAsync<JsonElement>($"{Billing}/invoices?organizationId={organizationId}");
        var invoice = invoices.GetProperty("invoices").EnumerateArray().ShouldHaveSingleItem();
        invoice.GetProperty("invoiceNo").GetString().ShouldBe(invoiceNo);
        invoice.GetProperty("basisId").GetGuid().ShouldBe(basisId);
        invoice.GetProperty("outstanding").GetDecimal().ShouldBe(23_750m);
        invoices.GetProperty("outstanding").GetDecimal().ShouldBe(23_750m);

        // A payment in PowerOffice lowers the outstanding amount; the newer stub wins by priority.
        factory.PowerOffice.Given(Request.Create().WithPath("/v2/OutgoingInvoices").UsingGet().WithParam("PageNumber", "1")).AtPriority(2)
            .RespondWith(JsonReply(new[]
            {
                new
                {
                    Id = 9_001, InvoiceNo = invoiceNo, OrderNo = 5_042, InvoiceDate = "2027-03-31T00:00:00+00:00", DueDate = "2027-04-14T00:00:00+00:00",
                    TotalAmount = 23_750m, RemainingAmount = 0m, Status = "Paid", IsCredited = false, LastChangedDateTimeOffset = "2027-04-10T10:00:00+00:00",
                },
            }));
        factory.PowerOffice.Given(Request.Create().WithPath("/v2/OutgoingInvoices").UsingGet().WithParam("PageNumber", "2")).AtPriority(2)
            .RespondWith(Response.Create().WithStatusCode(204));
        await factory.RunJobAsync<PowerOfficeInvoiceSyncJob>(j => j.RunAsync(CancellationToken.None));

        var paid = (await finance.GetFromJsonAsync<JsonElement>($"{Billing}/invoices?organizationId={organizationId}"))
            .GetProperty("invoices").EnumerateArray().Single();
        paid.GetProperty("status").GetString().ShouldBe("Paid");
        paid.GetProperty("outstanding").GetDecimal().ShouldBe(0m);

        // 5. The run is closed and stays closed, once no basis of it waits for export any more.
        (await factory.WaitForRunExportAsync(finance, runId)).ShouldBeOneOf("Exported", "ExportedWithErrors");
        (await finance.PostAsync($"{Billing}/runs/{runId}/close", null)).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await finance.GetFromJsonAsync<JsonElement>($"{Billing}/runs/{runId}")).GetProperty("status").GetString().ShouldBe("Closed");
        (await finance.PostAsync($"{Billing}/runs/{runId}/collect", null)).StatusCode.ShouldBe(HttpStatusCode.Conflict);
    }

    [Fact]
    public async Task Anomalies_are_reported_and_a_large_basis_waits_for_a_second_approval()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "billing-admin2");
        var finance = factory.ClientAs(CrmRoles.Finance, userKey: "billing-finance2");
        var management = factory.ClientAs(CrmRoles.Management, userKey: "billing-management");
        var marker = $"A{Guid.NewGuid():N}"[..10];
        var period = new DateOnly(2027, 7, 1);
        StubToken(factory);

        // No PowerOffice customer link and no product mapping: both must be flagged before approval (BR-BIL-03).
        var organizationId = await admin.CreateOrganizationAsync(new { name = $"{marker} Avvik AS", status = "Customer" });
        var productId = await CatalogApiTests.CreateProductAsync(finance, CatalogApiTests.Product(CatalogApiTests.Sku("BIG"), "Stor leveranse", 300_000m, 100_000m));
        var contract = await (await admin.PostAsJsonAsync(Contracts, new
        {
            organizationId, title = $"{marker} Stor", type = "Msp", startDate = period, endDate = period.AddMonths(1).AddDays(-1),
            autoRenew = false, renewalTermMonths = 0, noticePeriodDays = 30, invoiceFrequency = "Monthly", invoiceTiming = "InAdvance", indexation = false,
        })).ReadJsonAsync();
        var contractId = contract.GetProperty("id").GetGuid();
        (await admin.PostAsJsonAsync($"{Contracts}/{contractId}/lines", new
        {
            productId, quantityModel = "Fixed", quantity = 1m, unitPrice = 300_000m, validFrom = period,
        })).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await admin.PostAsync($"{Contracts}/{contractId}/activate", null)).StatusCode.ShouldBe(HttpStatusCode.OK);

        var runId = (await (await finance.PostAsJsonAsync($"{Billing}/runs", new { year = period.Year, month = period.Month })).ReadJsonAsync())
            .GetProperty("id").GetGuid();
        var collected = await (await finance.PostAsync($"{Billing}/runs/{runId}/collect", null)).ReadJsonAsync();
        collected.GetProperty("requiresSecondApproval").GetBoolean().ShouldBeTrue();
        collected.GetProperty("withAnomalies").GetInt32().ShouldBeGreaterThan(0);

        var flagged = await finance.GetFromJsonAsync<JsonElement>($"{Billing}/runs/{runId}/bases?anomaliesOnly=true&search={marker}");
        var basis = flagged.EnumerateArray().Single();
        var codes = basis.GetProperty("anomalies").EnumerateArray().Select(a => a.GetProperty("code").GetString()).ToList();
        codes.ShouldContain("BIL_CUSTOMER_NOT_LINKED");
        codes.ShouldContain("BIL_PRODUCT_NOT_MAPPED");
        var basisId = basis.GetProperty("id").GetGuid();

        // BR-BIL-04: Finance alone cannot release a run above the threshold.
        var afterFirst = await (await finance.PostAsync($"{Billing}/runs/{runId}/approve", null)).ReadJsonAsync();
        afterFirst.GetProperty("status").GetString().ShouldBe("InReview");
        (await finance.PostAsync($"{Billing}/runs/{runId}/second-approve", null)).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        var afterSecond = await (await management.PostAsync($"{Billing}/runs/{runId}/second-approve", null)).ReadJsonAsync();
        afterSecond.GetProperty("status").GetString().ShouldBe("Approved");
        afterSecond.GetProperty("secondApprovedBy").GetProperty("name").GetString().ShouldBe("Test billing-management");

        // Without a customer link the export fails with a readable reason, and the basis can then be cancelled (BR-BIL-09).
        var failed = await WaitForExportAsync(finance, basisId);
        failed.GetProperty("status").GetString().ShouldBe("Failed");
        failed.GetProperty("attempts").EnumerateArray().First().GetProperty("message").GetString()
            .ShouldBe("The customer is not linked to a PowerOffice customer.");

        (await finance.PostAsJsonAsync($"{Billing}/bases/{basisId}/cancel", new { reason = "Kunden mangler i PowerOffice" })).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await finance.GetFromJsonAsync<JsonElement>($"{Billing}/bases/{basisId}")).GetProperty("status").GetString().ShouldBe("Cancelled");
    }
}
