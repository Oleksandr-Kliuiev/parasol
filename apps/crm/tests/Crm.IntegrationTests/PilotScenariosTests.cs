using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using ClosedXML.Excel;
using Crm.Authorization;
using Crm.Billing.Contracts;
using Crm.Billing.Features;
using Crm.Billing.Persistence;
using Crm.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using WireMock.Matchers;
using WireMock.RequestBuilders;
using static Crm.IntegrationTests.IntegrationTestHelpers;

namespace Crm.IntegrationTests;

/// <summary>
/// The parallel pilot month's tooling and the exceptions it has to survive (DEV-22): the line trace, the comparison with the
/// independent figures, the Finance sign-off, the readiness probe and the KPI baseline, through the API and SQL Server. Every
/// test bills a month of its own (2041-03 … 2041-10) and looks only at its own customer, as the database is shared. The real
/// pilot (real users, a real month) is outside these tests: they prove the tooling and the refusals, not that Finance signed.
/// </summary>
public class PilotScenariosTests(CrmWebFactory factory) : IAsyncDisposable
{
    private readonly List<(HttpClient Client, Guid RunId)> _runs = [];

    private const string Billing = "/api/v1/billing";
    private const string Contracts = "/api/v1/contracts";
    private const string CsvHeader = "orgnr;period;currency;group;productCode;quantity;amountExVat;externalRef";

    private sealed record Customer(Guid OrganizationId, string OrgNumber, Guid ContractId, string Marker);

    private static object ProductBody(string sku, string name, decimal price, decimal vat, string type = "ManagedService", string billingPeriod = "Monthly", string? workType = null) => new
    {
        sku, name, type, businessLine = "Atera", unit = type == "HourlyService" ? "Hour" : "Device", billingPeriod, vatRate = vat, listPrice = price, unitCost = price / 2,
        ateraWorkType = workType,
    };

    /// <summary>An organization with an active contract that ends in the month and one line per (price, VAT) pair.</summary>
    private async Task<(Customer Customer, IReadOnlyList<(Guid ProductId, string Sku)> Products)> CustomerAsync(
        HttpClient admin, HttpClient finance, string prefix, DateOnly period, bool link, params (decimal Price, decimal Vat)[] lines)
    {
        var marker = $"{prefix}{Guid.NewGuid():N}"[..10];
        var orgNumber = TestData.OrgNumber();
        var organizationId = await admin.CreateOrganizationAsync(new { name = $"{marker} Pilot AS", status = "Customer", orgNumber });
        var end = period.AddMonths(1).AddDays(-1);
        var contractId = (await (await admin.PostAsJsonAsync(Contracts, new
        {
            organizationId, title = $"{marker} Drift", type = "Msp", startDate = period, endDate = end, autoRenew = false, renewalTermMonths = 0,
            noticePeriodDays = 30, invoiceFrequency = "Monthly", invoiceTiming = "InAdvance", indexation = false,
        })).ReadJsonAsync()).GetProperty("id").GetGuid();
        var products = new List<(Guid, string)>();
        foreach (var (price, vat) in lines)
        {
            var sku = CatalogApiTests.Sku("PLT");
            var productId = await CatalogApiTests.CreateProductAsync(finance, ProductBody(sku, $"Tjeneste {sku}", price, vat));
            (await admin.PostAsJsonAsync($"{Contracts}/{contractId}/lines", new
            {
                productId, quantityModel = "Fixed", quantity = 1m, unitPrice = price, validFrom = period,
            })).StatusCode.ShouldBe(HttpStatusCode.OK);
            products.Add((productId, sku));
        }

        (await admin.PostAsync($"{Contracts}/{contractId}/activate", null)).StatusCode.ShouldBe(HttpStatusCode.OK);
        if (link)
        {
            BillingApiTests.StubToken(factory);
            await BillingApiTests.LinkAsync(admin, "Organization", organizationId, "Customer", TestData.PowerOfficeId().ToString(CultureInfo.InvariantCulture));
            foreach (var (productId, _) in products)
            {
                await BillingApiTests.LinkAsync(admin, "Product", productId, "Product", TestData.PowerOfficeId().ToString(CultureInfo.InvariantCulture));
            }
        }

        return (new Customer(organizationId, orgNumber, contractId, marker), products);
    }

    private async Task<Guid> CollectedRunAsync(HttpClient finance, DateOnly period, string marker)
    {
        var created = await finance.PostAsJsonAsync($"{Billing}/runs", new { year = period.Year, month = period.Month, notes = marker });
        created.StatusCode.ShouldBe(HttpStatusCode.Created, await created.Content.ReadAsStringAsync());
        var runId = (await created.ReadJsonAsync()).GetProperty("id").GetGuid();
        _runs.Add((finance, runId));
        (await finance.RunCommandAsync(runId, "collect")).StatusCode.ShouldBe(HttpStatusCode.OK);
        return runId;
    }

    /// <summary>
    /// An open run of ours keeps holding what it collected — queued one-time items, approved hours — from every other test of the
    /// shared database, and keeps its period busy. Whatever a test leaves open is discarded, which releases the charges.
    /// </summary>
    public async ValueTask DisposeAsync()
    {
        foreach (var (client, runId) in _runs)
        {
            try
            {
                var read = await client.GetAsync($"{Billing}/runs/{runId}");
                if (read.IsSuccessStatusCode && (await read.ReadJsonAsync()).GetProperty("status").GetString() != "Closed")
                {
                    await client.DeleteWithETagAsync($"{Billing}/runs/{runId}", read.Headers.ETag!.Tag);
                }
            }
            catch (HttpRequestException)
            {
            }
        }

        GC.SuppressFinalize(this);
    }

    private static async Task<JsonElement> TraceAsync(HttpClient client, Guid runId, string query = "") =>
        await client.GetFromJsonAsync<JsonElement>($"{Billing}/runs/{runId}/trace{query}");

    private static Task<HttpResponseMessage> CompareAsync(HttpClient client, Guid runId, string csv)
    {
        var content = new StringContent(csv, Encoding.UTF8, "text/csv");
        return client.PostAsync($"{Billing}/runs/{runId}/pilot/compare", content);
    }

    private static string Csv(params string[] rows) => CsvHeader + "\n" + string.Join("\n", rows) + "\n";

    private static string Sha256(string text) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(text)));

    private static JsonElement ItemWhere(JsonElement result, Func<JsonElement, bool> predicate) =>
        result.GetProperty("comparison").GetProperty("items").EnumerateArray().Single(predicate);

    private static object Signoff(JsonElement compared, IEnumerable<object> explanations, string? sha = null, string? statement = null, string fallback = "Finance reruns the month by hand in the old spreadsheet and invoices from it.") => new
    {
        comparisonId = compared.GetProperty("comparison").GetProperty("comparisonId").GetGuid(),
        comparisonSha256 = sha ?? compared.GetProperty("documentSha256").GetString(),
        explanations,
        fallbackProcess = fallback,
        statement = statement ?? PilotSignoff.Statement,
    };

    private static List<object> ExplainAll(JsonElement compared, string text = "Known difference, rounded differently in the old sheet.", string role = "Crm.Finance") =>
        compared.GetProperty("comparison").GetProperty("items").EnumerateArray()
            .Where(i => i.GetProperty("status").GetString() != "Matched")
            .Select(i => (object)new { key = i.GetProperty("key").GetString(), text, ownerRole = role })
            .ToList();

    private async Task<List<AuditEntry>> AuditAsync(string action, Guid entityId)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<BillingDbContext>().AuditEntries.AsNoTracking()
            .Where(a => a.Action == action && a.EntityId == entityId).ToListAsync();
    }

    private static string Key(Guid runId, string kind, Guid id) => $"billing-pilot/{runId:N}/{kind}-{id:N}.json";

    // ---------- Hour bank, end to end ----------

    [Fact]
    public async Task Hour_bank_hours_covered_by_the_contract_or_drawn_from_the_bank_are_information_lines_and_only_the_overage_is_billed_traced_and_compared()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "pilot-hb-admin");
        var finance = factory.ClientAs(CrmRoles.Finance, userKey: "pilot-hb-finance");
        var lead = factory.ClientAs(CrmRoles.ServiceLead, userKey: "pilot-hb-lead");
        var technician = factory.ClientAs(CrmRoles.Technician, userKey: "pilot-hb-tech");
        var period = new DateOnly(2041, 3, 1);
        var marker = $"H{Guid.NewGuid():N}"[..10];
        var workType = $"Pilot-{marker}";
        var orgNumber = TestData.OrgNumber();
        var organizationId = await admin.CreateOrganizationAsync(new { name = $"{marker} Timebank AS", status = "Customer", orgNumber });
        var hourSku = CatalogApiTests.Sku("HRS");
        await CatalogApiTests.CreateProductAsync(finance, ProductBody(hourSku, "Support hour", 1100m, 25m, "HourlyService", "OneTime", workType));
        var sla = await (await admin.PostAsJsonAsync($"{Contracts}/sla-policies", new
        {
            name = $"{marker} SLA", coverage = "Business8x5",
            p1 = new { responseMinutes = 60, resolutionMinutes = 240 }, p2 = new { responseMinutes = 120, resolutionMinutes = 480 },
            p3 = new { responseMinutes = 480, resolutionMinutes = 1440 }, p4 = new { responseMinutes = 960, resolutionMinutes = 2880 },
            includedHoursPerMonth = 2m, overageRate = 1250m, afterHoursMultiplier = 1.5m, coveredWorkTypes = workType,
        })).ReadJsonAsync();
        var contractId = (await (await admin.PostAsJsonAsync(Contracts, new
        {
            organizationId, title = $"{marker} Drift", type = "Msp", startDate = new DateOnly(2041, 1, 1), endDate = new DateOnly(2041, 3, 31), autoRenew = false,
            renewalTermMonths = 0, noticePeriodDays = 30, slaPolicyId = sla.GetProperty("id").GetGuid(), invoiceFrequency = "Monthly", invoiceTiming = "InAdvance",
            indexation = false,
        })).ReadJsonAsync()).GetProperty("id").GetGuid();
        (await admin.PostAsync($"{Contracts}/{contractId}/activate", null)).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await admin.PostAsJsonAsync($"{Contracts}/hour-banks", new
        {
            organizationId, contractId, name = $"{marker} klippekort", hours = 1m, validFrom = new DateOnly(2041, 2, 1), overageRate = 1400m,
        })).StatusCode.ShouldBe(HttpStatusCode.Created);

        // Five hours in the month: two covered by the contract, one drawn from the bank, two at the bank's overage rate.
        var entry = await (await technician.PostAsJsonAsync("/api/v1/time/entries", new
        {
            organizationId, workDate = new DateOnly(2041, 3, 10), hours = 5m, workType, billable = true, onsite = false, afterHours = false, description = "Feilsøking",
        })).ReadJsonAsync();
        (await lead.PostAsJsonAsync("/api/v1/time/approve", new { entryIds = new[] { entry.GetProperty("id").GetGuid() } })).StatusCode.ShouldBe(HttpStatusCode.OK);

        var runId = await CollectedRunAsync(finance, period, marker);
        var trace = await TraceAsync(finance, runId, $"?payerId={organizationId}");

        trace.GetProperty("totalCount").GetInt32().ShouldBe(3);
        var rows = trace.GetProperty("items").EnumerateArray().ToList();
        var info = rows.Where(r => r.GetProperty("group").GetString() == "Info").ToList();
        info.Count.ShouldBe(2, "covered and prepaid hours are shown, not billed");
        info.ShouldAllBe(r => r.GetProperty("lineTotal").GetDecimal() == 0m);
        info.Select(r => r.GetProperty("quantity").GetDecimal()).Order().ShouldBe([1m, 2m]);
        var billed = rows.Single(r => r.GetProperty("group").GetString() == "HourlyWork");
        billed.GetProperty("quantity").GetDecimal().ShouldBe(2m);
        billed.GetProperty("unitPrice").GetDecimal().ShouldBe(1400m);
        billed.GetProperty("lineTotal").GetDecimal().ShouldBe(2800m);
        billed.GetProperty("productCode").GetString().ShouldBe(hourSku);
        billed.GetProperty("payerOrgNumber").GetString().ShouldBe(orgNumber);
        billed.GetProperty("vatRate").GetDecimal().ShouldBe(25m);

        // The independent figures agree on the money; a row for the information group is refused, because it has no price to compare.
        var compared = await CompareAsync(finance, runId, Csv(
            $"{orgNumber};2041-03;NOK;HourlyWork;;2;2 800,00;HB-1",
            $"{orgNumber};2041-03;NOK;Info;;3;0;HB-INFO"));
        compared.StatusCode.ShouldBe(HttpStatusCode.OK, await compared.Content.ReadAsStringAsync());
        var result = await compared.ReadJsonAsync();
        var statusCounts = result.GetProperty("comparison").GetProperty("statusCounts");
        statusCounts.GetProperty("Matched").GetInt32().ShouldBe(1);
        statusCounts.GetProperty("Rejected").GetInt32().ShouldBe(1);
        ItemWhere(result, i => i.GetProperty("status").GetString() == "Rejected").GetProperty("reasonCode").GetString().ShouldBe("GROUP_NOT_COMPARABLE");
        var matched = ItemWhere(result, i => i.GetProperty("status").GetString() == "Matched");
        matched.GetProperty("crmAmount").GetDecimal().ShouldBe(2800m);
        matched.GetProperty("crmQuantity").GetDecimal().ShouldBe(2m);
    }

    // ---------- Trace ----------

    [Fact]
    public async Task The_trace_pages_by_keyset_filters_by_payer_group_and_anomaly_hides_money_and_exports_without_evaluable_cells()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "pilot-trace-admin");
        var finance = factory.ClientAs(CrmRoles.Finance, userKey: "pilot-trace-finance");
        var lead = factory.ClientAs(CrmRoles.ServiceLead, userKey: "pilot-trace-lead");
        var technician = factory.ClientAs(CrmRoles.Technician, userKey: "pilot-trace-tech");
        var period = new DateOnly(2041, 4, 1);
        var (customer, products) = await CustomerAsync(admin, finance, "T", period, link: false, (1_000m, 25m), (2_000m, 25m));
        var runId = await CollectedRunAsync(finance, period, customer.Marker);

        // Finance adds a one-off line by hand whose text would be a formula in a spreadsheet.
        var basis = (await finance.GetFromJsonAsync<JsonElement>($"{Billing}/runs/{runId}/bases?search={customer.Marker}")).EnumerateArray().Single();
        var basisId = basis.GetProperty("id").GetGuid();
        var etag = (await finance.GetAsync($"{Billing}/bases/{basisId}")).Headers.ETag!.Tag;
        (await finance.PostWithETagAsync($"{Billing}/bases/{basisId}/lines", new
        {
            description = "=HYPERLINK(\"http://evil.example\",\"x\")", quantity = 1m, unitPrice = 300m, reason = "Fast pris",
        }, etag)).StatusCode.ShouldBe(HttpStatusCode.OK);

        // Two at a time: a cursor, the count of the whole filter, and no row twice.
        var first = await TraceAsync(finance, runId, $"?payerId={customer.OrganizationId}&limit=2");
        first.GetProperty("totalCount").GetInt32().ShouldBe(3);
        first.GetProperty("items").GetArrayLength().ShouldBe(2);
        var cursor = first.GetProperty("nextCursor").GetString();
        cursor.ShouldNotBeNullOrEmpty();
        var second = await TraceAsync(finance, runId, $"?payerId={customer.OrganizationId}&limit=2&cursor={Uri.EscapeDataString(cursor!)}");
        second.GetProperty("items").GetArrayLength().ShouldBe(1);
        second.GetProperty("nextCursor").ValueKind.ShouldBe(JsonValueKind.Null);
        var seen = first.GetProperty("items").EnumerateArray().Concat(second.GetProperty("items").EnumerateArray()).Select(r => r.GetProperty("lineId").GetGuid()).ToList();
        seen.Distinct().Count().ShouldBe(3);

        // Group filter: the manual line is the only one-off line; origin and change reason are on the row.
        var oneOff = (await TraceAsync(finance, runId, $"?payerId={customer.OrganizationId}&group=OneOff")).GetProperty("items").EnumerateArray().ShouldHaveSingleItem();
        oneOff.GetProperty("origin").GetString().ShouldBe("Manual");
        oneOff.GetProperty("changeReason").GetString().ShouldBe("Fast pris");
        oneOff.GetProperty("manuallyAdjusted").GetBoolean().ShouldBeTrue();
        (await TraceAsync(finance, runId, $"?payerId={customer.OrganizationId}&group=Subscription")).GetProperty("totalCount").GetInt32().ShouldBe(2);
        var subscription = (await TraceAsync(finance, runId, $"?payerId={customer.OrganizationId}&group=Subscription")).GetProperty("items").EnumerateArray()
            .Select(r => r.GetProperty("productCode").GetString()!).Order().ToList();
        subscription.ShouldBe(products.Select(p => p.Sku).Order().ToList());

        // An anomaly code nobody has matches nothing; a hostile one is refused instead of widening the pattern.
        (await TraceAsync(finance, runId, $"?payerId={customer.OrganizationId}&anomaly=NO_SUCH_CODE")).GetProperty("totalCount").GetInt32().ShouldBe(0);
        (await finance.GetAsync($"{Billing}/runs/{runId}/trace?anomaly=%25%22")).StatusCode.ShouldBe(HttpStatusCode.BadRequest);
        (await finance.GetAsync($"{Billing}/runs/{Guid.NewGuid()}/trace")).StatusCode.ShouldBe(HttpStatusCode.NotFound);

        // Money is removed for a role without finance.read; a technician sees no billing at all.
        var asLead = (await TraceAsync(lead, runId, $"?payerId={customer.OrganizationId}")).GetProperty("items").EnumerateArray().First();
        asLead.TryGetProperty("unitPrice", out _).ShouldBeFalse();
        asLead.TryGetProperty("lineTotal", out _).ShouldBeFalse();
        asLead.TryGetProperty("discountPct", out _).ShouldBeFalse();
        asLead.GetProperty("quantity").GetDecimal().ShouldBe(1m);
        (await technician.GetAsync($"{Billing}/runs/{runId}/trace")).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        (await technician.GetAsync($"{Billing}/runs/{runId}/trace.xlsx")).StatusCode.ShouldBe(HttpStatusCode.Forbidden);

        // The Excel file walks the same rows; a text that would be evaluated keeps a quote prefix; the lead's file has no amounts.
        var file = await finance.GetAsync($"{Billing}/runs/{runId}/trace.xlsx?payerId={customer.OrganizationId}&lang=en");
        file.StatusCode.ShouldBe(HttpStatusCode.OK);
        file.Content.Headers.ContentType!.MediaType.ShouldBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        using (var workbook = new XLWorkbook(await file.Content.ReadAsStreamAsync()))
        {
            var sheet = workbook.Worksheet("Trace");
            sheet.Row(1).CellsUsed().Select(c => c.GetString()).ShouldContain("Line total ex. VAT");
            sheet.RowsUsed().Count().ShouldBe(4, "the header and three lines");
            var formula = sheet.RowsUsed().Skip(1).SelectMany(r => r.CellsUsed()).Single(c => c.GetString().StartsWith("=HYPERLINK", StringComparison.Ordinal));
            formula.DataType.ShouldBe(XLDataType.Text);
            formula.Style.IncludeQuotePrefix.ShouldBeTrue();
            formula.HasFormula.ShouldBeFalse();
        }

        var leadFile = await lead.GetAsync($"{Billing}/runs/{runId}/trace.xlsx?payerId={customer.OrganizationId}&lang=en");
        leadFile.StatusCode.ShouldBe(HttpStatusCode.OK);
        using (var workbook = new XLWorkbook(await leadFile.Content.ReadAsStreamAsync()))
        {
            var headers = workbook.Worksheet("Trace").Row(1).CellsUsed().Select(c => c.GetString()).ToList();
            headers.ShouldNotContain("Line total ex. VAT");
            headers.ShouldNotContain("Unit price");
            headers.ShouldContain("Quantity");
        }

        // The KPI baseline sees the hand work of this run: one manual line, no failed basis of ours, nothing invented for what
        // the data cannot give.
        var kpi = await finance.GetFromJsonAsync<JsonElement>($"{Billing}/pilot/kpi?from=2041-04-01&to=2041-04-01");
        var runKpi = kpi.GetProperty("runs").EnumerateArray().Single(r => r.GetProperty("runId").GetGuid() == runId);
        runKpi.GetProperty("manualLines").GetInt32().ShouldBe(1);
        runKpi.GetProperty("lines").GetInt32().ShouldBeGreaterThanOrEqualTo(3);
        runKpi.GetProperty("manualShare").GetDouble().ShouldBeGreaterThan(0d);
        runKpi.GetProperty("hoursCollectedToClosed").ValueKind.ShouldBe(JsonValueKind.Null, "the run is not closed");
        kpi.GetProperty("overdueUnacknowledgedReminders").GetInt32().ShouldBeGreaterThanOrEqualTo(0);
        kpi.GetProperty("notMeasured").EnumerateArray().Select(n => n.GetProperty("kpi").GetString())
            .ShouldBe(["timeToFirstSuccessfulScenarioPerUser", "missedRenewals", "exceptionAgeOfResolvedItems", "loginsByRole"]);
        kpi.GetProperty("notMeasured").EnumerateArray().ShouldAllBe(n => n.GetProperty("reason").GetString()!.Length > 20);
        (await lead.GetAsync($"{Billing}/pilot/kpi")).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        (await finance.GetAsync($"{Billing}/pilot/kpi?from=2041-05-01&to=2041-04-01")).StatusCode.ShouldBe(HttpStatusCode.BadRequest);
        (await finance.GetAsync($"{Billing}/pilot/kpi?from=2030-01-01&to=2041-04-01")).StatusCode.ShouldBe(HttpStatusCode.BadRequest);
    }

    // ---------- Compare and sign-off ----------

    [Fact]
    public async Task The_comparison_names_every_key_stores_nothing_in_billing_and_the_signoff_needs_an_owner_for_every_exception()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "pilot-sign-admin");
        var finance = factory.ClientAs(CrmRoles.Finance, userKey: "pilot-sign-finance");
        var management = factory.ClientAs(CrmRoles.Management, userKey: "pilot-sign-management");
        var period = new DateOnly(2041, 5, 1);
        var (customer, _) = await CustomerAsync(admin, finance, "S", period, link: false, (5_000m, 25m));
        var runId = await CollectedRunAsync(finance, period, customer.Marker);
        var strangerOrg = TestData.OrgNumber();
        var runBefore = await finance.GetFromJsonAsync<JsonElement>($"{Billing}/runs/{runId}");
        var etagBefore = await finance.RunETagAsync(runId);

        // Finance and Admin may compare; Management reads billing but may not sign for it.
        var csv = Csv(
            $"{customer.OrgNumber};2041-05;NOK;Subscription;;;5000,00;INV-1",
            $"{customer.OrgNumber};2041-05;NOK;License;;;300;INV-2",
            $"{strangerOrg};2041-05;NOK;;;;100;OLD-7",
            $"{customer.OrgNumber};2041-04;NOK;Subscription;;;5;WRONG-MONTH",
            $"{customer.OrgNumber};2041-05;EUR;Subscription;;;45;EUR-1");
        (await CompareAsync(management, runId, csv)).StatusCode.ShouldBe(HttpStatusCode.Forbidden);

        var response = await CompareAsync(finance, runId, csv);
        response.StatusCode.ShouldBe(HttpStatusCode.OK, await response.Content.ReadAsStringAsync());
        var compared = await response.ReadJsonAsync();
        var comparison = compared.GetProperty("comparison");
        comparison.GetProperty("fileSha256").GetString().ShouldBe(Sha256(csv));
        comparison.GetProperty("runId").GetGuid().ShouldBe(runId);
        comparison.GetProperty("runContentRevision").GetInt32().ShouldBe(runBefore.GetProperty("contentRevision").GetInt32());
        comparison.GetProperty("contentDigest").GetString().ShouldNotBeNullOrEmpty();
        compared.GetProperty("documentSha256").GetString()!.Length.ShouldBe(64);

        // Every key has a verdict; money is compared exactly, per currency, with the difference stated.
        ItemWhere(compared, i => i.GetProperty("orgNumber").GetString() == customer.OrgNumber && i.GetProperty("group").GetString() == "Subscription" && i.GetProperty("currency").GetString() == "NOK" && i.GetProperty("status").GetString() != "Rejected")
            .GetProperty("status").GetString().ShouldBe("Matched");
        var license = ItemWhere(compared, i => i.GetProperty("orgNumber").GetString() == customer.OrgNumber && i.GetProperty("group").GetString() == "License");
        license.GetProperty("status").GetString().ShouldBe("MissingInCrm");
        license.GetProperty("difference").GetDecimal().ShouldBe(300m);
        ItemWhere(compared, i => i.GetProperty("orgNumber").GetString() == strangerOrg).GetProperty("status").GetString().ShouldBe("MissingCustomer");
        ItemWhere(compared, i => i.GetProperty("reasonCode").GetString() == "PERIOD_MISMATCH" && i.GetProperty("orgNumber").GetString() == customer.OrgNumber).GetProperty("status").GetString().ShouldBe("Rejected");
        var euro = ItemWhere(compared, i => i.GetProperty("orgNumber").GetString() == customer.OrgNumber && i.GetProperty("currency").GetString() == "EUR");
        euro.GetProperty("status").GetString().ShouldBe("MissingInCrm", "the CRM bills in NOK only; another currency is its own key");
        comparison.GetProperty("totals").EnumerateArray().Select(t => t.GetProperty("currency").GetString()).Order().ShouldBe(["EUR", "NOK"]);
        // Other tests' customers are in the same run: the CRM bills them and the file does not list them.
        var ours = comparison.GetProperty("items").EnumerateArray()
            .Where(i => i.GetProperty("orgNumber").GetString() == customer.OrgNumber || i.GetProperty("orgNumber").GetString() == strangerOrg).ToList();
        ours.Count(i => i.GetProperty("status").GetString() != "Matched").ShouldBe(4);
        comparison.GetProperty("payers").EnumerateArray()
            .Single(p => p.GetProperty("orgNumber").GetString() == customer.OrgNumber && p.GetProperty("currency").GetString() == "NOK")
            .GetProperty("status").GetString().ShouldBe("Different");
        comparison.GetProperty("exceptionCount").GetInt32().ShouldBeGreaterThanOrEqualTo(4);

        // Nothing changed in billing: the run is the same version. The comparison is an object in the store with a trail.
        (await finance.RunETagAsync(runId)).ShouldBe(etagBefore);
        var comparisonId = comparison.GetProperty("comparisonId").GetGuid();
        (await factory.Documents.ReadAsync(Key(runId, "comparison", comparisonId), CancellationToken.None)).ShouldNotBeNull();
        var compareAudit = (await AuditAsync("Reconcile", comparisonId)).ShouldHaveSingleItem();
        compareAudit.Changes!.ShouldContain(compared.GetProperty("documentSha256").GetString()!);
        compareAudit.Changes!.ShouldNotContain("INV-1");

        var explanations = ExplainAll(compared);
        explanations.Count.ShouldBe(comparison.GetProperty("exceptionCount").GetInt32());
        string Url() => $"{Billing}/runs/{runId}/pilot/signoff";

        // Refusals: the body is validated, the signer must be allowed, and the run version is the one on screen.
        (await management.PostWithETagAsync(Url(), Signoff(compared, explanations), etagBefore)).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        (await finance.PostAsJsonAsync(Url(), Signoff(compared, explanations))).StatusCode.ShouldBe((HttpStatusCode)428);
        (await finance.PostWithETagAsync(Url(), Signoff(compared, explanations, statement: "I agree"), etagBefore)).StatusCode.ShouldBe(HttpStatusCode.BadRequest);
        (await finance.PostWithETagAsync(Url(), Signoff(compared, [.. explanations.Take(1), new { key = "x", text = "short", ownerRole = "Crm.Finance" }]), etagBefore))
            .StatusCode.ShouldBe(HttpStatusCode.BadRequest);
        (await finance.PostWithETagAsync(Url(), Signoff(compared, ExplainAll(compared, "Known difference, rounded differently.", "Somebody")), etagBefore))
            .StatusCode.ShouldBe(HttpStatusCode.BadRequest);

        var unexplained = await finance.PostWithETagAsync(Url(), Signoff(compared, explanations.Take(explanations.Count - 1)), etagBefore);
        unexplained.StatusCode.ShouldBe(HttpStatusCode.Conflict);
        var problem = await unexplained.ReadJsonAsync();
        problem.GetProperty("code").GetString().ShouldBe("BIL_PILOT_UNEXPLAINED");
        problem.GetProperty("count").GetInt32().ShouldBe(1);

        var unknown = await finance.PostWithETagAsync(Url(), Signoff(compared, [.. explanations, new { key = "no|such|key|*", text = "Not part of the comparison.", ownerRole = "Crm.Finance" }]), etagBefore);
        (await unknown.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe("BIL_PILOT_EXPLANATION_UNKNOWN");

        var tampered = await finance.PostWithETagAsync(Url(), Signoff(compared, explanations, sha: new string('a', 64)), etagBefore);
        tampered.StatusCode.ShouldBe(HttpStatusCode.Conflict);
        (await tampered.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe("BIL_PILOT_COMPARISON_MISMATCH");

        // Everything explained: the signature is the signed-in user's, with the server's time; the trail holds ids and hashes only.
        var secret = "Rounded per invoice in the old sheet, owner confirms";
        var signed = await finance.PostWithETagAsync(Url(), Signoff(compared, ExplainAll(compared, secret, "Crm.Management")), etagBefore);
        signed.StatusCode.ShouldBe(HttpStatusCode.Created, await signed.Content.ReadAsStringAsync());
        var signedResult = await signed.ReadJsonAsync();
        var signoffId = signedResult.GetProperty("signoffId").GetGuid();
        var signerId = await finance.UserIdAsync();
        var document = JsonSerializer.Deserialize<JsonElement>((await factory.Documents.ReadAsync(Key(runId, "signoff", signoffId), CancellationToken.None))!);
        document.GetProperty("signedBy").GetGuid().ShouldBe(signerId);
        document.GetProperty("comparisonSha256").GetString().ShouldBe(compared.GetProperty("documentSha256").GetString());
        document.GetProperty("explanations").GetArrayLength().ShouldBe(explanations.Count);
        document.GetProperty("explanations").EnumerateArray().ShouldAllBe(e => e.GetProperty("ownerRole").GetString() == "Crm.Management");
        document.GetProperty("fallbackProcess").GetString()!.ShouldContain("old spreadsheet");
        document.GetProperty("statement").GetString().ShouldBe(PilotSignoff.Statement);
        (DateTimeOffset.UtcNow - document.GetProperty("signedAt").GetDateTimeOffset()).ShouldBeLessThan(TimeSpan.FromMinutes(2));
        var signAudit = (await AuditAsync("Sign", signoffId)).ShouldHaveSingleItem();
        signAudit.UserId.ShouldBe(signerId);
        signAudit.Changes!.ShouldContain(compared.GetProperty("documentSha256").GetString()!);
        signAudit.Changes!.ShouldNotContain(secret);
        signAudit.Changes!.ShouldNotContain("old spreadsheet");

        // A second sign-off of the same comparison is a new document; the first one is not touched.
        var firstBytes = (await factory.Documents.ReadAsync(Key(runId, "signoff", signoffId), CancellationToken.None))!;
        var again = await finance.PostWithETagAsync(Url(), Signoff(compared, ExplainAll(compared, "Second look, same view.", "Crm.Finance")), await finance.RunETagAsync(runId));
        again.StatusCode.ShouldBe(HttpStatusCode.Created);
        var secondId = (await again.ReadJsonAsync()).GetProperty("signoffId").GetGuid();
        secondId.ShouldNotBe(signoffId);
        (await factory.Documents.ReadAsync(Key(runId, "signoff", signoffId), CancellationToken.None))!.ShouldBe(firstBytes);

        // The overview is metadata: hashes, counts and people — no amount, no explanation, no fallback text.
        var overviewResponse = await management.GetAsync($"{Billing}/runs/{runId}/pilot");
        overviewResponse.StatusCode.ShouldBe(HttpStatusCode.OK);
        var overviewText = await overviewResponse.Content.ReadAsStringAsync();
        overviewText.ShouldNotContain(secret);
        overviewText.ShouldNotContain("old spreadsheet");
        overviewText.ShouldNotContain("amount", Case.Insensitive);
        var overview = JsonSerializer.Deserialize<JsonElement>(overviewText);
        overview.GetProperty("statement").GetString().ShouldBe(PilotSignoff.Statement);
        overview.GetProperty("comparisons").EnumerateArray().Single().GetProperty("signoffs").GetInt32().ShouldBe(2);
        overview.GetProperty("comparisons").EnumerateArray().Single().GetProperty("stale").GetBoolean().ShouldBeFalse();
        overview.GetProperty("signoffs").GetArrayLength().ShouldBe(2);
        overview.GetProperty("signoffs").EnumerateArray().ShouldAllBe(s => s.GetProperty("signedBy").GetProperty("id").GetGuid() == signerId);
    }

    [Fact]
    public async Task A_signoff_of_a_comparison_made_before_the_run_changed_is_refused_and_so_is_a_signoff_on_an_old_screen()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "pilot-stale-admin");
        var finance = factory.ClientAs(CrmRoles.Finance, userKey: "pilot-stale-finance");
        var period = new DateOnly(2041, 10, 1);
        var (customer, _) = await CustomerAsync(admin, finance, "R", period, link: false, (4_000m, 25m));
        var runId = await CollectedRunAsync(finance, period, customer.Marker);

        var compared = await (await CompareAsync(finance, runId, Csv($"{customer.OrgNumber};2041-10;NOK;Subscription;;;4000;A"))).ReadJsonAsync();
        ItemWhere(compared, i => i.GetProperty("orgNumber").GetString() == customer.OrgNumber && i.GetProperty("status").GetString() != "MissingInFile")
            .GetProperty("status").GetString().ShouldBe("Matched");
        var oldScreen = await finance.RunETagAsync(runId);
        var revision = compared.GetProperty("comparison").GetProperty("runContentRevision").GetInt32();

        // A line is added after the comparison: the run has a new content revision.
        var basisId = (await finance.GetFromJsonAsync<JsonElement>($"{Billing}/runs/{runId}/bases?search={customer.Marker}")).EnumerateArray().Single().GetProperty("id").GetGuid();
        var basisEtag = (await finance.GetAsync($"{Billing}/bases/{basisId}")).Headers.ETag!.Tag;
        (await finance.PostWithETagAsync($"{Billing}/bases/{basisId}/lines", new { description = "Ekstra", quantity = 1m, unitPrice = 100m }, basisEtag))
            .StatusCode.ShouldBe(HttpStatusCode.OK);
        (await finance.GetFromJsonAsync<JsonElement>($"{Billing}/runs/{runId}")).GetProperty("contentRevision").GetInt32().ShouldBeGreaterThan(revision);

        var url = $"{Billing}/runs/{runId}/pilot/signoff";
        var onOldScreen = await finance.PostWithETagAsync(url, Signoff(compared, ExplainAll(compared)), oldScreen);
        onOldScreen.StatusCode.ShouldBe(HttpStatusCode.PreconditionFailed);
        (await onOldScreen.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe("CONCURRENCY_CONFLICT");

        var stale = await finance.PostWithETagAsync(url, Signoff(compared, ExplainAll(compared)), await finance.RunETagAsync(runId));
        stale.StatusCode.ShouldBe(HttpStatusCode.Conflict);
        (await stale.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe("BIL_PILOT_COMPARISON_STALE");

        var overview = await finance.GetFromJsonAsync<JsonElement>($"{Billing}/runs/{runId}/pilot");
        overview.GetProperty("comparisons").EnumerateArray().Single().GetProperty("stale").GetBoolean().ShouldBeTrue();
        overview.GetProperty("signoffs").GetArrayLength().ShouldBe(0);

        // A new comparison of the new version can be signed.
        var again = await (await CompareAsync(finance, runId, Csv($"{customer.OrgNumber};2041-10;NOK;Subscription;;;4000;A", $"{customer.OrgNumber};2041-10;NOK;OneOff;;;100;B"))).ReadJsonAsync();
        (await finance.PostWithETagAsync(url, Signoff(again, ExplainAll(again)), await finance.RunETagAsync(runId))).StatusCode.ShouldBe(HttpStatusCode.Created);
    }

    [Fact]
    public async Task Comparing_and_signing_need_a_recent_confirmation_of_the_roles_and_a_recent_sign_in_while_reading_goes_on()
    {
        var keyRing = Directory.CreateTempSubdirectory("crm-keys-").FullName;
        try
        {
            var time = ManualTimeProvider.InThePast();
            await using var host = new SessionHost(factory, time, keyRing, crmAppId: $"pilot-app-{Guid.NewGuid():N}", tenant: Guid.NewGuid().ToString(), logs: null);
            var (finance, _) = await host.SignInAsync($"pilot-finance-{Guid.NewGuid():N}", CrmRoles.Finance);
            var runId = Guid.NewGuid();

            // Fresh: authorized (the run does not exist, so the answer is 404 and not 403).
            (await finance.GetAsync($"{Billing}/runs/{runId}/trace")).StatusCode.ShouldBe(HttpStatusCode.NotFound);
            (await CompareAsync(finance, runId, Csv())).StatusCode.ShouldBe(HttpStatusCode.NotFound);

            time.Advance(TimeSpan.FromMinutes(6));
            (await finance.GetAsync($"{Billing}/runs/{runId}/trace")).StatusCode.ShouldBe(HttpStatusCode.NotFound, "reading goes on");
            (await finance.GetAsync($"{Billing}/runs/{runId}/pilot")).StatusCode.ShouldBe(HttpStatusCode.NotFound, "reading goes on");
            foreach (var response in new[]
                     {
                         await finance.GetAsync($"{Billing}/runs/{runId}/trace.xlsx"),
                         await CompareAsync(finance, runId, Csv()),
                         await finance.PostWithETagAsync($"{Billing}/runs/{runId}/pilot/signoff", new
                         {
                             comparisonId = Guid.NewGuid(), comparisonSha256 = new string('a', 64), explanations = Array.Empty<object>(),
                             fallbackProcess = "Manual process, written down.", statement = PilotSignoff.Statement,
                         }, "\"AAAA\""),
                     })
            {
                response.StatusCode.ShouldBe(HttpStatusCode.Forbidden);
                (await response.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe("AUTH_REVERIFY_REQUIRED");
            }
        }
        finally
        {
            Directory.Delete(keyRing, recursive: true);
        }
    }

    // ---------- Credit note and VAT ----------

    private async Task<(Customer Customer, IReadOnlyList<(Guid ProductId, string Sku)> Products, Guid RunId, string OrderNo)> ExportedRunAsync(
        DateOnly period, string prefix, int orderNo, params (decimal Price, decimal Vat)[] lines)
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: $"pilot-{prefix}-admin");
        var finance = factory.ClientAs(CrmRoles.Finance, userKey: $"pilot-{prefix}-finance");
        var (customer, products) = await CustomerAsync(admin, finance, prefix, period, link: true, lines);
        factory.PowerOffice.Given(Request.Create().WithPath("/v2/SalesOrders").UsingPost().WithBody(new WildcardMatcher($"*{customer.OrganizationId:N}*")))
            .AtPriority(1)
            .RespondWith(JsonReply(new { Id = orderNo, OrderNo = orderNo, CustomerId = 1, Status = "Draft" }));
        var runId = await CollectedRunAsync(finance, period, customer.Marker);
        (await (await finance.RunCommandAsync(runId, "approve")).ReadJsonAsync()).GetProperty("status").GetString().ShouldBe("Approved");
        (await factory.WaitForRunExportAsync(finance, runId)).ShouldBeOneOf("Exported", "ExportedWithErrors");
        (await finance.PostAsync($"{Billing}/runs/{runId}/close", null)).StatusCode.ShouldBe(HttpStatusCode.OK);
        return (customer, products, runId, orderNo.ToString(CultureInfo.InvariantCulture));
    }

    [Fact]
    public async Task A_credited_invoice_is_visible_on_the_billed_line_and_the_independent_figure_that_ignores_it_is_a_difference_that_needs_an_owner()
    {
        var finance = factory.ClientAs(CrmRoles.Finance, userKey: "pilot-credit-finance");
        var period = new DateOnly(2041, 6, 1);
        var (customer, _, runId, orderNo) = await ExportedRunAsync(period, "C", 41_006, (5_000m, 25m));

        // PowerOffice invoices the order and then credits the invoice (two syncs).
        var invoiceNo = $"CRN-{customer.Marker}";
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var billing = scope.ServiceProvider.GetRequiredService<IBillingApi>();
            ExternalInvoice Invoice(InvoiceStatus status, decimal outstanding) => new(
                "poweroffice", invoiceNo, orderNo, null, customer.OrganizationId, new DateOnly(2041, 6, 30), new DateOnly(2041, 7, 14), 6_250m, outstanding, status, null);
            (await billing.UpsertInvoicesAsync([Invoice(InvoiceStatus.Sent, 6_250m)], CancellationToken.None)).Created.ShouldBe(1);
            (await billing.UpsertInvoicesAsync([Invoice(InvoiceStatus.Credited, 0m)], CancellationToken.None)).Updated.ShouldBe(1);
        }

        var row = (await TraceAsync(finance, runId, $"?payerId={customer.OrganizationId}")).GetProperty("items").EnumerateArray().ShouldHaveSingleItem();
        row.GetProperty("basisStatus").GetString().ShouldBe("Exported");
        row.GetProperty("orderNo").GetString().ShouldBe(orderNo);
        row.GetProperty("invoiceNo").GetString().ShouldBe(invoiceNo);
        row.GetProperty("invoiceStatus").GetString().ShouldBe("Credited");
        row.GetProperty("lineTotal").GetDecimal().ShouldBe(5_000m);

        // The old method's figure for the month is nil after the credit; the CRM run still says what was billed.
        var compared = await (await CompareAsync(finance, runId, Csv($"{customer.OrgNumber};2041-06;NOK;Subscription;;;0;CREDITED-{customer.Marker}"))).ReadJsonAsync();
        var item = ItemWhere(compared, i => i.GetProperty("orgNumber").GetString() == customer.OrgNumber && i.GetProperty("group").GetString() == "Subscription");
        item.GetProperty("status").GetString().ShouldBe("Different");
        item.GetProperty("reasonCode").GetString().ShouldBe("AMOUNT");
        item.GetProperty("difference").GetDecimal().ShouldBe(-5_000m);
        item.GetProperty("crmAmount").GetDecimal().ShouldBe(5_000m);

        var url = $"{Billing}/runs/{runId}/pilot/signoff";
        var etag = await finance.RunETagAsync(runId);
        (await finance.PostWithETagAsync(url, Signoff(compared, []), etag)).StatusCode.ShouldBe(HttpStatusCode.Conflict);
        (await finance.PostWithETagAsync(url, Signoff(compared, ExplainAll(compared, "Credited in PowerOffice after invoicing; the old sheet nets it out.")), etag))
            .StatusCode.ShouldBe(HttpStatusCode.Created);
    }

    [Fact]
    public async Task The_vat_rate_of_each_line_is_on_the_trace_but_the_poweroffice_order_carries_the_product_code_only_so_the_product_decides_the_vat()
    {
        var finance = factory.ClientAs(CrmRoles.Finance, userKey: "pilot-vat-finance");
        var period = new DateOnly(2041, 7, 1);
        var (customer, products, runId, _) = await ExportedRunAsync(period, "V", 41_007, (5_000m, 25m), (2_000m, 15m));

        var rows = (await TraceAsync(finance, runId, $"?payerId={customer.OrganizationId}")).GetProperty("items").EnumerateArray().ToList();
        rows.Count.ShouldBe(2);
        rows.Single(r => r.GetProperty("productCode").GetString() == products[0].Sku).GetProperty("vatRate").GetDecimal().ShouldBe(25m);
        rows.Single(r => r.GetProperty("productCode").GetString() == products[1].Sku).GetProperty("vatRate").GetDecimal().ShouldBe(15m);

        var body = factory.PowerOffice.LogEntries
            .Single(e => e.RequestMessage!.Method == "POST" && e.RequestMessage.Path == "/v2/SalesOrders" &&
                         e.RequestMessage.Body!.Contains(customer.OrganizationId.ToString("N"), StringComparison.Ordinal)).RequestMessage!.Body!;
        var lines = JsonSerializer.Deserialize<JsonElement>(body).GetProperty("Lines").EnumerateArray().ToList();
        lines.Select(l => l.GetProperty("ProductCode").GetString()).Order().ShouldBe(products.Select(p => p.Sku).Order().ToList());
        lines.Select(l => l.GetProperty("UnitPrice").GetDecimal()).Order().ShouldBe([2_000m, 5_000m]);

        // This pins what the integration sends today: no VAT code or rate per line. The VAT of an order line is PowerOffice's,
        // taken from the product it finds by code; a product set up there with another rate gives another VAT (DEV-22 finding).
        body.ShouldNotContain("vat", Case.Insensitive);
    }

    // ---------- Readiness ----------

    [Fact]
    public async Task The_readiness_probe_says_what_crm_web_can_know_and_marks_the_rest_unknown()
    {
        var finance = factory.ClientAs(CrmRoles.Finance, userKey: "pilot-ready-finance");
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "pilot-ready-admin");
        var technician = factory.ClientAs(CrmRoles.Technician, userKey: "pilot-ready-tech");
        (await technician.GetAsync($"{Billing}/pilot-readiness")).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        (await finance.GetAsync($"{Billing}/pilot-readiness?period=2041-9")).StatusCode.ShouldBe(HttpStatusCode.BadRequest);

        // The shared test host can send everything (PowerOffice writes on, quote and notification mail on): not safe, and it says why.
        var open = await finance.GetFromJsonAsync<JsonElement>($"{Billing}/pilot-readiness?period=2041-09");
        open.GetProperty("safeForParallelRun").GetBoolean().ShouldBeFalse();
        open.GetProperty("source").GetString().ShouldBe("crm-web");
        open.GetProperty("caveats").EnumerateArray().Select(c => c.GetString()).ShouldContain("WORKER_CONFIG_NOT_VERIFIED");
        JsonElement Check(JsonElement report, string name) => report.GetProperty("checks").EnumerateArray().Single(c => c.GetProperty("check").GetString() == name);
        Check(open, "poweroffice.sends").GetProperty("ok").GetBoolean().ShouldBeFalse();
        Check(open, "poweroffice.sends").GetProperty("code").GetString().ShouldBe("POWEROFFICE_SENDS_POSSIBLE");
        Check(open, "mail.sales").GetProperty("ok").GetBoolean().ShouldBeFalse();
        Check(open, "mail.notifications").GetProperty("state").GetString().ShouldBe("On");
        Check(open, "poweroffice.credentials").GetProperty("state").GetString().ShouldBe("UnknownFromWeb");
        Check(open, "poweroffice.credentials").GetProperty("ok").ValueKind.ShouldBe(JsonValueKind.Null);
        Check(open, "maintenance").GetProperty("state").GetString().ShouldBe("Normal");
        Check(open, "runs.targetPeriod").GetProperty("code").GetString().ShouldBe("PERIOD_FREE");

        // An open run for the period is said to be open.
        await CollectedRunAsync(finance, new DateOnly(2041, 9, 1), "ready");
        Check(await finance.GetFromJsonAsync<JsonElement>($"{Billing}/pilot-readiness?period=2041-09"), "runs.targetPeriod")
            .GetProperty("code").GetString().ShouldBe("PERIOD_OPEN_RUN");

        // A host with writes, quote mail and notification mail off is safe — and still says the worker was not asked.
        await using var quiet = factory.WithWebHostBuilder(builder =>
        {
            builder.UseSetting("Integrations:PowerOffice:WriteEnabled", "false");
            builder.UseSetting("Sales:EmailEnabled", "false");
            builder.UseSetting("Notifications:EmailEnabled", "false");
        });
        using var client = quiet.CreateClient();
        client.DefaultRequestHeaders.Add(TestAuthHandler.RolesHeader, CrmRoles.Finance);
        client.DefaultRequestHeaders.Add(TestAuthHandler.UserHeader, "pilot-ready-quiet");
        var safe = await client.GetFromJsonAsync<JsonElement>($"{Billing}/pilot-readiness");
        safe.GetProperty("safeForParallelRun").GetBoolean().ShouldBeTrue();
        Check(safe, "poweroffice.sends").GetProperty("code").GetString().ShouldBe("POWEROFFICE_SENDS_BLOCKED");
        Check(safe, "mail.graphMailbox").GetProperty("state").GetString().ShouldBe("On", "reading a mailbox sends nothing and does not decide");
        safe.GetProperty("caveats").GetArrayLength().ShouldBe(1);
        safe.GetProperty("checks").EnumerateArray().Any(c => c.GetProperty("check").GetString() == "runs.targetPeriod").ShouldBeFalse("no period was asked about");
    }
}
