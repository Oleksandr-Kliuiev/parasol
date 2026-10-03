using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crm.Authorization;
using static Crm.IntegrationTests.IntegrationTestHelpers;

namespace Crm.IntegrationTests;

/// <summary>Group invoicing (FR-CUS-07), proration (FR-BIL-05) and yearly indexation (FR-CON-05).</summary>
public class GroupAndIndexationTests(CrmWebFactory factory)
{
    private const string Organizations = "/api/v1/customers/organizations";
    private const string Contracts = "/api/v1/contracts";
    private const string Billing = "/api/v1/billing";

    private static readonly DateOnly Today = DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, TimeZoneInfo.FindSystemTimeZoneById("Europe/Oslo")).DateTime);

    private static string Iso(DateOnly date) => date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

    private static object ContractBody(Guid organizationId, DateOnly start, bool indexation = false) => new
    {
        organizationId,
        title = "Managed services",
        type = "Msp",
        startDate = Iso(start),
        endDate = (string?)null,
        // Open-ended: an automatically renewed contract would need an end date, and these tests only care about prices.
        autoRenew = false,
        renewalTermMonths = 0,
        noticePeriodDays = 90,
        invoiceFrequency = "Monthly",
        invoiceTiming = "InAdvance",
        indexation,
        nextIndexationDate = indexation ? Iso(Today) : null,
    };

    private static async Task<Guid> ActiveContractAsync(HttpClient client, Guid organizationId, Guid productId, DateOnly start, decimal price, DateOnly lineFrom, bool indexation = false)
    {
        var contract = await client.PostAsJsonAsync(Contracts, ContractBody(organizationId, start, indexation));
        contract.StatusCode.ShouldBe(HttpStatusCode.Created);
        var contractId = (await contract.ReadJsonAsync()).GetProperty("id").GetGuid();
        (await client.PostAsJsonAsync($"{Contracts}/{contractId}/lines", new
        {
            productId, quantityModel = "Fixed", quantity = 1m, unitPrice = price, discountPct = 0m, validFrom = Iso(lineFrom),
        })).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await client.PostAsync($"{Contracts}/{contractId}/activate", null)).StatusCode.ShouldBe(HttpStatusCode.OK);
        return contractId;
    }

    [Fact]
    public async Task A_subsidiary_billed_through_its_parent_lands_on_the_parent_invoice()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "group-admin");
        var finance = factory.ClientAs(CrmRoles.Finance, userKey: "group-finance");
        var marker = $"G{Guid.NewGuid():N}"[..10];
        var product = await CatalogApiTests.CreateProductAsync(finance, CatalogApiTests.Product(CatalogApiTests.Sku("GRP")));
        var parentId = await admin.CreateOrganizationAsync(new { name = $"{marker} Konsern AS", status = "Customer" });
        var childId = await admin.CreateOrganizationAsync(new { name = $"{marker} Datter AS", status = "Customer" });

        // A billing run owns its period alone, so every test picks a month of its own.
        var period = new DateOnly(2028, 5, 1);
        await ActiveContractAsync(admin, parentId, product, period, 1_000m, period);
        await ActiveContractAsync(admin, childId, product, period, 500m, period);

        // Without a group each company gets its own basis.
        var firstRun = await CollectAsync(finance, period, marker);
        var separate = await BasesAsync(finance, firstRun, marker);
        separate.Count.ShouldBe(2);

        // FR-CUS-07: the subsidiary joins the parent's invoice.
        var etag = (await admin.GetAsync($"{Organizations}/{childId}")).Headers.ETag!.Tag;
        var linked = await admin.PutWithETagAsync($"{Organizations}/{childId}/parent", new { parentId, billedThroughParent = true }, etag);
        linked.StatusCode.ShouldBe(HttpStatusCode.OK);
        var child = await linked.ReadJsonAsync();
        child.GetProperty("parent").GetProperty("id").GetGuid().ShouldBe(parentId);
        child.GetProperty("billedThroughParent").GetBoolean().ShouldBeTrue();
        (await admin.GetFromJsonAsync<JsonElement>($"{Organizations}/{parentId}"))
            .GetProperty("children").EnumerateArray().ShouldContain(c => c.GetProperty("id").GetGuid() == childId);

        // A group may not loop back on itself.
        var parentEtag = (await admin.GetAsync($"{Organizations}/{parentId}")).Headers.ETag!.Tag;
        var loop = await admin.PutWithETagAsync($"{Organizations}/{parentId}/parent", new { parentId = childId, billedThroughParent = false }, parentEtag);
        loop.StatusCode.ShouldBe(HttpStatusCode.BadRequest);
        (await loop.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe("CUS_PARENT_CYCLE");

        // Re-collecting the same run moves the subsidiary's lines onto the parent's basis, marked with its name.
        (await finance.PostAsync($"{Billing}/runs/{firstRun}/collect", null)).StatusCode.ShouldBe(HttpStatusCode.OK);
        var bases = await BasesAsync(finance, firstRun, marker);
        var basis = bases.ShouldHaveSingleItem();
        basis.GetProperty("organization").GetProperty("id").GetGuid().ShouldBe(parentId);
        var detail = await finance.GetFromJsonAsync<JsonElement>($"{Billing}/bases/{basis.GetProperty("id").GetGuid()}");
        var lines = detail.GetProperty("lines").EnumerateArray().ToList();
        lines.Count.ShouldBe(2);
        lines.ShouldContain(l => l.GetProperty("description").GetString()!.StartsWith($"{marker} Datter AS:", StringComparison.Ordinal));
        detail.GetProperty("totalExVat").GetDecimal().ShouldBe(1_500m);
    }

    [Fact]
    public async Task A_line_that_starts_mid_period_is_billed_for_its_days()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "proration-admin");
        var finance = factory.ClientAs(CrmRoles.Finance, userKey: "proration-finance");
        var marker = $"R{Guid.NewGuid():N}"[..10];
        var product = await CatalogApiTests.CreateProductAsync(finance, CatalogApiTests.Product(CatalogApiTests.Sku("PRO")));
        var organizationId = await admin.CreateOrganizationAsync(new { name = $"{marker} Proratert AS", status = "Customer" });

        // A month with 30 days, so the arithmetic is easy to read.
        var period = new DateOnly(2027, 4, 1);
        await ActiveContractAsync(admin, organizationId, product, period, 3_000m, period.AddDays(15));

        var runId = await CollectAsync(finance, period, marker);
        var basis = (await BasesAsync(finance, runId, marker)).ShouldHaveSingleItem();
        var detail = await finance.GetFromJsonAsync<JsonElement>($"{Billing}/bases/{basis.GetProperty("id").GetGuid()}");
        var line = detail.GetProperty("lines").EnumerateArray().Single();

        // 16.04–30.04 is 15 of 30 days: half the monthly price, and the line says so.
        line.GetProperty("lineTotal").GetDecimal().ShouldBe(1_500m);
        line.GetProperty("description").GetString()!.ShouldContain("16.04.2027–30.04.2027");
        line.GetProperty("description").GetString()!.ShouldContain("15/30");
    }

    [Fact]
    public async Task Indexation_previews_the_new_prices_and_writes_them_from_the_effective_date()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "indexation-admin");
        var finance = factory.ClientAs(CrmRoles.Finance, userKey: "indexation-finance");
        var marker = $"I{Guid.NewGuid():N}"[..10];
        var product = await CatalogApiTests.CreateProductAsync(finance, CatalogApiTests.Product(CatalogApiTests.Sku("IDX")));
        var organizationId = await admin.CreateOrganizationAsync(new { name = $"{marker} Indeks AS", status = "Customer" });
        var start = Today.AddMonths(-6);
        var contractId = await ActiveContractAsync(admin, organizationId, product, start, 1_000m, start, indexation: true);

        var effectiveFrom = Today.AddMonths(1);
        var preview = await admin.GetFromJsonAsync<JsonElement>(
            $"{Contracts}/indexation/preview?percent=3.5&effectiveFrom={Iso(effectiveFrom)}&organizationId={organizationId}");
        var candidate = preview.GetProperty("contracts").EnumerateArray().Single(c => c.GetProperty("contractId").GetGuid() == contractId);
        candidate.GetProperty("monthlyBefore").GetDecimal().ShouldBe(1_000m);
        candidate.GetProperty("monthlyAfter").GetDecimal().ShouldBe(1_035m);
        candidate.GetProperty("lines").EnumerateArray().Single().GetProperty("priceAfter").GetDecimal().ShouldBe(1_035m);

        // The preview wrote nothing.
        (await admin.GetFromJsonAsync<JsonElement>($"{Contracts}/{contractId}"))
            .GetProperty("lines").EnumerateArray().Single().GetProperty("unitPrice").GetDecimal().ShouldBe(1_000m);

        var applied = await admin.PostAsJsonAsync($"{Contracts}/indexation", new
        {
            percent = 3.5m,
            effectiveFrom = Iso(effectiveFrom),
            contractIds = new[] { contractId },
        });
        applied.StatusCode.ShouldBe(HttpStatusCode.OK);
        var result = await applied.ReadJsonAsync();
        result.GetProperty("contracts").GetInt32().ShouldBe(1);
        result.GetProperty("lines").GetInt32().ShouldBe(1);

        // BR-CON-03: the old price is kept as its own version, and the new one starts on the effective date.
        var contract = await admin.GetFromJsonAsync<JsonElement>($"{Contracts}/{contractId}");
        var lines = contract.GetProperty("lines").EnumerateArray().OrderBy(l => l.GetProperty("version").GetInt32()).ToList();
        lines.Count.ShouldBe(2);
        lines[0].GetProperty("unitPrice").GetDecimal().ShouldBe(1_000m);
        lines[0].GetProperty("validTo").GetString().ShouldBe(Iso(effectiveFrom.AddDays(-1)));
        lines[1].GetProperty("unitPrice").GetDecimal().ShouldBe(1_035m);
        lines[1].GetProperty("validFrom").GetString().ShouldBe(Iso(effectiveFrom));
        contract.GetProperty("nextIndexationDate").GetString().ShouldBe(Iso(effectiveFrom.AddYears(1)));

        // The same contract is no longer offered for this round.
        (await admin.GetFromJsonAsync<JsonElement>(
                $"{Contracts}/indexation/preview?percent=3.5&effectiveFrom={Iso(effectiveFrom)}&organizationId={organizationId}"))
            .GetProperty("contracts").EnumerateArray().ShouldNotContain(c => c.GetProperty("contractId").GetGuid() == contractId);

        // Reading prices is a contract right; a technician has neither the preview nor the apply.
        var technician = factory.ClientAs(CrmRoles.Technician, userKey: "indexation-technician");
        (await technician.GetAsync($"{Contracts}/indexation/preview?percent=3.5&effectiveFrom={Iso(effectiveFrom)}"))
            .StatusCode.ShouldBe(HttpStatusCode.Forbidden);
    }

    private static async Task<Guid> CollectAsync(HttpClient finance, DateOnly period, string marker)
    {
        var run = await (await finance.PostAsJsonAsync($"{Billing}/runs", new { year = period.Year, month = period.Month, notes = marker })).ReadJsonAsync();
        var runId = run.GetProperty("id").GetGuid();
        (await finance.PostAsync($"{Billing}/runs/{runId}/collect", null)).StatusCode.ShouldBe(HttpStatusCode.OK);
        return runId;
    }

    private static async Task<List<JsonElement>> BasesAsync(HttpClient finance, Guid runId, string marker) =>
        (await finance.GetFromJsonAsync<JsonElement>($"{Billing}/runs/{runId}/bases?search={marker}")).EnumerateArray().ToList();
}
