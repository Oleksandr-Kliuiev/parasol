using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crm.Authorization;
using WireMock.Matchers;
using WireMock.RequestBuilders;
using static Crm.IntegrationTests.IntegrationTestHelpers;

namespace Crm.IntegrationTests;

/// <summary>
/// The billing defects of the audit of 2026-10-03 (docs/10-audit-2026-10-03.md, A01–A03) through the API. Each test states the
/// required invariant, so it stays red until DEV-01 (A01), DEV-02 (A02) or DEV-03 (A03) fixes the defect; the "Regression"
/// trait lists them and they are never skipped. Every test bills a month no other test uses, and looks only at its own customer.
/// </summary>
public class BillingRegressionApiTests(CrmWebFactory factory)
{
    private const string Billing = "/api/v1/billing";
    private const string Contracts = "/api/v1/contracts";

    private sealed record Customer(Guid OrganizationId, Guid ContractId, Guid ProductId, string Marker);

    /// <summary>A customer with one active contract line billed monthly in advance, for exactly <paramref name="period"/>.</summary>
    private static async Task<Customer> CustomerAsync(HttpClient admin, HttpClient finance, string prefix, DateOnly period, decimal monthlyFee)
    {
        var marker = $"{prefix}{Guid.NewGuid():N}"[..10];
        var organizationId = await admin.CreateOrganizationAsync(new { name = $"{marker} Regresjon AS", status = "Customer" });
        var productId = await CatalogApiTests.CreateProductAsync(
            finance, CatalogApiTests.Product(CatalogApiTests.Sku("REG"), "Managed services", monthlyFee, monthlyFee / 2));
        var contract = await (await admin.PostAsJsonAsync(Contracts, new
        {
            organizationId, title = $"{marker} Drift", type = "Msp", startDate = period, endDate = period.AddMonths(1).AddDays(-1),
            autoRenew = false, renewalTermMonths = 0, noticePeriodDays = 30, invoiceFrequency = "Monthly", invoiceTiming = "InAdvance",
            indexation = false,
        })).ReadJsonAsync();
        var contractId = contract.GetProperty("id").GetGuid();
        (await admin.PostAsJsonAsync($"{Contracts}/{contractId}/lines", new
        {
            productId, quantityModel = "Fixed", quantity = 1m, unitPrice = monthlyFee, validFrom = period,
        })).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await admin.PostAsync($"{Contracts}/{contractId}/activate", null)).StatusCode.ShouldBe(HttpStatusCode.OK);
        return new Customer(organizationId, contractId, productId, marker);
    }

    private static async Task<Guid> CollectedRunAsync(HttpClient finance, DateOnly period, string marker)
    {
        var created = await finance.PostAsJsonAsync($"{Billing}/runs", new { year = period.Year, month = period.Month, notes = marker });
        created.StatusCode.ShouldBe(HttpStatusCode.Created);
        var runId = (await created.ReadJsonAsync()).GetProperty("id").GetGuid();
        (await finance.PostAsync($"{Billing}/runs/{runId}/collect", null)).StatusCode.ShouldBe(HttpStatusCode.OK);
        return runId;
    }

    private static async Task<JsonElement> RunAsync(HttpClient client, Guid runId) =>
        await client.GetFromJsonAsync<JsonElement>($"{Billing}/runs/{runId}");

    private static async Task<JsonElement> BasisOfAsync(HttpClient finance, Guid runId, Customer customer) =>
        (await finance.GetFromJsonAsync<JsonElement>($"{Billing}/runs/{runId}/bases?search={customer.Marker}"))
        .EnumerateArray()
        .Single(b => b.GetProperty("organization").GetProperty("id").GetGuid() == customer.OrganizationId);

    [Fact]
    [Trait("Regression", "A01")]
    public async Task A01_a_corrected_line_stays_one_position_at_the_corrected_amount_after_the_run_is_collected_again()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "regression-a01-admin");
        var finance = factory.ClientAs(CrmRoles.Finance, userKey: "regression-a01-finance");
        var period = new DateOnly(2029, 5, 1);
        var customer = await CustomerAsync(admin, finance, "Q", period, 1_000m);
        var runId = await CollectedRunAsync(finance, period, customer.Marker);
        var basisId = (await BasisOfAsync(finance, runId, customer)).GetProperty("id").GetGuid();

        // Finance corrects the collected 1 000 to 900.
        var read = await finance.GetAsync($"{Billing}/bases/{basisId}");
        var line = (await read.ReadJsonAsync()).GetProperty("lines").EnumerateArray().Single();
        var adjusted = await finance.PutWithETagAsync($"{Billing}/bases/{basisId}/lines/{line.GetProperty("id").GetGuid()}", new
        {
            quantity = 1m, unitPrice = 900m, discountPct = 0m, description = line.GetProperty("description").GetString(),
        }, read.Headers.ETag!.Tag);
        adjusted.StatusCode.ShouldBe(HttpStatusCode.OK);
        (await adjusted.ReadJsonAsync()).GetProperty("totalExVat").GetDecimal().ShouldBe(900m);

        // The contract has not changed when the run is collected again.
        (await finance.PostAsync($"{Billing}/runs/{runId}/collect", null)).StatusCode.ShouldBe(HttpStatusCode.OK);

        // One economic position keeps the correction; the audited code keeps it and bills the contract line again (1 900).
        var recollected = await finance.GetFromJsonAsync<JsonElement>($"{Billing}/bases/{basisId}");
        recollected.GetProperty("totalExVat").GetDecimal().ShouldBe(900m);
        recollected.GetProperty("lines").EnumerateArray().Count().ShouldBe(1);
    }

    [Fact]
    [Trait("Regression", "A02")]
    public async Task A02_a_user_with_both_approval_rights_cannot_release_a_run_alone_by_signing_the_second_approval_first()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "regression-a02-admin");
        var finance = factory.ClientAs(CrmRoles.Finance, userKey: "regression-a02-finance");
        var period = new DateOnly(2029, 1, 1);
        var customer = await CustomerAsync(admin, finance, "R", period, 300_000m);
        var runId = await CollectedRunAsync(finance, period, customer.Marker);
        (await RunAsync(finance, runId)).GetProperty("requiresSecondApproval").GetBoolean().ShouldBeTrue();

        // Admin holds billing.approve and billing.approve.second and signs both, the second one first.
        await admin.PostAsync($"{Billing}/runs/{runId}/second-approve", null);
        await admin.PostAsync($"{Billing}/runs/{runId}/approve", null);

        // BR-BIL-04: the two signatures belong to two people, in either order.
        (await RunAsync(finance, runId)).GetProperty("status").GetString().ShouldNotBe("Approved");
    }

    [Fact]
    [Trait("Regression", "A02")]
    public async Task A02_a_first_approval_does_not_carry_over_to_a_recollected_run_with_other_content()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "regression-a02-admin");
        var finance = factory.ClientAs(CrmRoles.Finance, userKey: "regression-a02-finance");
        var management = factory.ClientAs(CrmRoles.Management, userKey: "regression-a02-management");
        var period = new DateOnly(2029, 2, 1);
        var customer = await CustomerAsync(admin, finance, "S", period, 300_000m);
        var runId = await CollectedRunAsync(finance, period, customer.Marker);
        (await (await finance.PostAsync($"{Billing}/runs/{runId}/approve", null)).ReadJsonAsync())
            .GetProperty("status").GetString().ShouldBe("InReview");

        // After the first signature the contract gets another line and the run is collected again: 350 000 instead of 300 000.
        (await admin.PostAsJsonAsync($"{Contracts}/{customer.ContractId}/lines", new
        {
            productId = customer.ProductId, description = "Tillegg", quantityModel = "Fixed", quantity = 1m, unitPrice = 50_000m, validFrom = period,
        })).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await finance.PostAsync($"{Billing}/runs/{runId}/collect", null)).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await BasisOfAsync(finance, runId, customer)).GetProperty("totalExVat").GetDecimal().ShouldBe(350_000m);

        await management.PostAsync($"{Billing}/runs/{runId}/second-approve", null);

        // Finance never approved the content that would now be exported.
        (await RunAsync(finance, runId)).GetProperty("status").GetString().ShouldNotBe("Approved");
    }

    [Fact]
    [Trait("Regression", "A02")]
    public async Task A02_a_manual_line_that_lifts_a_basis_over_the_threshold_cannot_pass_with_one_approval()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "regression-a02-admin");
        var finance = factory.ClientAs(CrmRoles.Finance, userKey: "regression-a02-finance");
        var period = new DateOnly(2029, 3, 1);
        var customer = await CustomerAsync(admin, finance, "T", period, 10_000m);
        var runId = await CollectedRunAsync(finance, period, customer.Marker);
        (await RunAsync(finance, runId)).GetProperty("requiresSecondApproval").GetBoolean().ShouldBeFalse();

        var basisId = (await BasisOfAsync(finance, runId, customer)).GetProperty("id").GetGuid();
        var etag = (await finance.GetAsync($"{Billing}/bases/{basisId}")).Headers.ETag!.Tag;
        var added = await finance.PostWithETagAsync(
            $"{Billing}/bases/{basisId}/lines", new { description = "Prosjektleveranse", quantity = 1m, unitPrice = 300_000m }, etag);
        added.StatusCode.ShouldBe(HttpStatusCode.OK);
        (await added.ReadJsonAsync()).GetProperty("totalExVat").GetDecimal().ShouldBe(310_000m);

        await finance.PostAsync($"{Billing}/runs/{runId}/approve", null);

        // BR-BIL-04 looks at the basis as it is approved, not as it was collected.
        (await RunAsync(finance, runId)).GetProperty("status").GetString().ShouldNotBe("Approved");
    }

    [Fact]
    [Trait("Regression", "A03")]
    public async Task A03_a_second_run_for_an_exported_and_closed_month_does_not_bill_the_contract_month_or_the_hour_purchase_again()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "regression-a03-admin");
        var finance = factory.ClientAs(CrmRoles.Finance, userKey: "regression-a03-finance");
        var period = new DateOnly(2029, 4, 1);
        BillingApiTests.StubToken(factory);
        var customer = await CustomerAsync(admin, finance, "U", period, 5_000m);

        // A prepaid package bought in the month; the hour-bank line of the contract prices its ten hours (docs/02 §4.9).
        var hourBankProduct = await CatalogApiTests.CreateProductAsync(finance, CatalogApiTests.Product(
            CatalogApiTests.Sku("KLIPP"), "Klippekort", 1_000m, 400m, type: "HourBank", billingPeriod: "OneTime"));
        (await admin.PostAsJsonAsync($"{Contracts}/{customer.ContractId}/lines", new
        {
            productId = hourBankProduct, quantityModel = "Fixed", quantity = 1m, unitPrice = 1_000m, validFrom = period,
        })).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await admin.PostAsJsonAsync($"{Contracts}/hour-banks", new
        {
            organizationId = customer.OrganizationId, contractId = customer.ContractId, name = $"{customer.Marker} 10 t", hours = 10m,
            validFrom = period.AddDays(9),
        })).StatusCode.ShouldBe(HttpStatusCode.Created);

        // The order can reach PowerOffice: the customer and both products are linked, and this stub answers for this customer only.
        var customerNo = Random.Shared.NextInt64(800_000, 899_999);
        await BillingApiTests.LinkAsync(admin, "Organization", customer.OrganizationId, "Customer", customerNo.ToString(CultureInfo.InvariantCulture));
        foreach (var productId in new[] { customer.ProductId, hourBankProduct })
        {
            await BillingApiTests.LinkAsync(admin, "Product", productId, "Product", Random.Shared.NextInt64(10_000, 99_999).ToString(CultureInfo.InvariantCulture));
        }

        factory.PowerOffice.Given(Request.Create().WithPath("/v2/SalesOrders").UsingPost()
                .WithBody(new WildcardMatcher($"*{customer.OrganizationId:N}*")))
            .AtPriority(1)
            .RespondWith(JsonReply(new { Id = 9_401, OrderNo = 9_401, CustomerId = customerNo, Status = "Draft" }));

        // 1. The month is collected, approved, exported to PowerOffice and closed.
        var firstRunId = await CollectedRunAsync(finance, period, customer.Marker);
        var firstBasis = await BasisOfAsync(finance, firstRunId, customer);
        // 5 000 for the month + 10 h × 1 000 for the package.
        firstBasis.GetProperty("totalExVat").GetDecimal().ShouldBe(15_000m);
        var basisId = firstBasis.GetProperty("id").GetGuid();
        (await (await finance.PostAsync($"{Billing}/runs/{firstRunId}/approve", null)).ReadJsonAsync())
            .GetProperty("status").GetString().ShouldBe("Approved");

        // Other tests' open-ended contracts land in the run as well; the run is exported once none of its bases waits any more.
        JsonElement exported = default;
        var runStatus = string.Empty;
        for (var attempt = 0; attempt < 15; attempt++)
        {
            await factory.ProcessEventsAndOutboundAsync();
            exported = await finance.GetFromJsonAsync<JsonElement>($"{Billing}/bases/{basisId}");
            runStatus = (await RunAsync(finance, firstRunId)).GetProperty("status").GetString()!;
            if (exported.GetProperty("status").GetString() != "Approved" && runStatus is "Exported" or "ExportedWithErrors")
            {
                break;
            }
        }

        exported.GetProperty("status").GetString().ShouldBe("Exported");
        exported.GetProperty("orderNo").GetString().ShouldBe("9401");
        runStatus.ShouldBeOneOf("Exported", "ExportedWithErrors");
        (await finance.PostAsync($"{Billing}/runs/{firstRunId}/close", null)).StatusCode.ShouldBe(HttpStatusCode.OK);

        // 2. Another run for the same month, with a new run id and therefore a new export key.
        var second = await finance.PostAsJsonAsync($"{Billing}/runs", new { year = period.Year, month = period.Month, notes = customer.Marker });
        if (second.StatusCode != HttpStatusCode.Created)
        {
            // Refusing an ordinary run for a month that is already billed keeps every charge single as well.
            second.StatusCode.ShouldBe(HttpStatusCode.Conflict);
            return;
        }

        var secondRunId = (await second.ReadJsonAsync()).GetProperty("id").GetGuid();
        (await finance.PostAsync($"{Billing}/runs/{secondRunId}/collect", null)).StatusCode.ShouldBe(HttpStatusCode.OK);
        var billedAgain = (await finance.GetFromJsonAsync<JsonElement>($"{Billing}/runs/{secondRunId}/bases?search={customer.Marker}"))
            .EnumerateArray()
            .Where(b => b.GetProperty("organization").GetProperty("id").GetGuid() == customer.OrganizationId)
            .Sum(b => b.GetProperty("totalExVat").GetDecimal());

        // The contract month and the package left for PowerOffice with the first run; the second run id must not bill them again.
        billedAgain.ShouldBe(0m);
    }
}
