using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crm.Authorization;
using Shouldly;

namespace Crm.IntegrationTests;

/// <summary>
/// DEV-22: a contract that has ended (the lifecycle job marks it Ended once its end date has passed) is still billed for the
/// periods it covered. Found when a billing test lost its contract to that job between activation and collect.
/// Bills 2047-03: no other class uses that month.
/// </summary>
public class EndedContractBillingTests(CrmWebFactory factory)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task A_contract_that_has_ended_is_still_billed_for_the_period_it_covered()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "ended-admin");
        var finance = factory.ClientAs(CrmRoles.Finance, userKey: "ended-finance");
        var marker = $"E{Guid.NewGuid():N}"[..10];
        var organizationId = await admin.CreateOrganizationAsync(new { name = $"{marker} Ended AS", status = "Customer" });
        var productId = await CatalogApiTests.CreateProductAsync(finance, CatalogApiTests.Product(CatalogApiTests.Sku("END"), "Managed services", 2_500m, 1_000m));
        var contractId = (await (await admin.PostAsJsonAsync("/api/v1/contracts", new
        {
            organizationId, title = $"{marker} Ending", type = "Msp", startDate = "2047-03-01", endDate = "2047-12-31", autoRenew = false,
            renewalTermMonths = 0, noticePeriodDays = 30, invoiceFrequency = "Monthly", invoiceTiming = "InAdvance", indexation = false,
        }, Ct)).ReadJsonAsync()).GetProperty("id").GetGuid();
        (await admin.PostAsJsonAsync($"/api/v1/contracts/{contractId}/lines", new
        {
            productId, quantityModel = "Fixed", quantity = 1m, unitPrice = 2_500m, validFrom = "2047-03-01",
        }, Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await admin.PostAsync($"/api/v1/contracts/{contractId}/activate", null, Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
        BillingApiTests.StubToken(factory);
        await BillingApiTests.LinkAsync(admin, "Organization", organizationId, "Customer", TestExternalIds.Next(800_000, 899_999));
        await BillingApiTests.LinkAsync(admin, "Product", productId, "Product", TestExternalIds.Next(100_000, 199_999));

        // The contract ends on the last day of the period it is about to be billed for.
        var ended = await admin.PostAsJsonAsync($"/api/v1/contracts/{contractId}/end", new { endDate = "2047-03-31" }, Ct);
        ended.StatusCode.ShouldBe(HttpStatusCode.OK);
        (await ended.ReadJsonAsync()).GetProperty("status").GetString().ShouldBe("Ended");

        var run = await finance.PostAsJsonAsync("/api/v1/billing/runs", new { year = 2047, month = 3, notes = marker }, Ct);
        run.StatusCode.ShouldBe(HttpStatusCode.Created, await run.Content.ReadAsStringAsync(Ct));
        var runId = (await run.ReadJsonAsync()).GetProperty("id").GetGuid();
        try
        {
            (await finance.RunCommandAsync(runId, "collect")).StatusCode.ShouldBe(HttpStatusCode.OK);
            var bases = await finance.GetFromJsonAsync<JsonElement>($"/api/v1/billing/runs/{runId}/bases?search={marker}", Ct);
            var ours = bases.EnumerateArray().Single(b => b.GetProperty("organization").GetProperty("id").GetGuid() == organizationId);
            ours.GetProperty("totalExVat").GetDecimal().ShouldBe(2_500m);
        }
        finally
        {
            // Leave the month free for a re-run of this test's host.
            var read = await finance.GetAsync($"/api/v1/billing/runs/{runId}", Ct);
            if (read.Headers.ETag is { } etag)
            {
                using var delete = new HttpRequestMessage(HttpMethod.Delete, $"/api/v1/billing/runs/{runId}");
                delete.Headers.TryAddWithoutValidation("If-Match", etag.ToString());
                await finance.SendAsync(delete, Ct);
            }
        }
    }
}
