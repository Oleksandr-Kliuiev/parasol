using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Crm.Authorization;

namespace Crm.IntegrationTests;

public class CatalogApiTests(CrmWebFactory factory)
{
    private const string Products = "/api/v1/catalog/products";
    private const string PriceLists = "/api/v1/catalog/price-lists";

    internal static string Sku(string prefix = "TEST") => $"{prefix}-{Guid.NewGuid():N}"[..20].ToUpperInvariant();

    internal static object Product(string sku, string name = "Managed workstation", decimal listPrice = 450m, decimal? unitCost = 300m, string type = "ManagedService",
        string billingPeriod = "Monthly") => new
    {
        sku,
        name,
        type,
        businessLine = "Atera",
        unit = "Device",
        billingPeriod,
        vatRate = 25m,
        listPrice,
        unitCost,
    };

    internal static async Task<Guid> CreateProductAsync(HttpClient finance, object body)
    {
        var response = await finance.PostAsJsonAsync(Products, body);
        response.StatusCode.ShouldBe(HttpStatusCode.Created);
        return (await response.ReadJsonAsync()).GetProperty("id").GetGuid();
    }

    [Fact]
    public async Task Finance_maintains_products_and_cost_is_hidden_from_sales()
    {
        var finance = factory.ClientAs(CrmRoles.Finance);
        var sales = factory.ClientAs(CrmRoles.Sales);
        var sku = Sku();

        (await sales.PostAsJsonAsync(Products, Product(Sku()))).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        var id = await CreateProductAsync(finance, Product(sku.ToLowerInvariant()));

        var asFinance = await finance.GetFromJsonAsync<JsonElement>($"{Products}/{id}");
        asFinance.GetProperty("sku").GetString().ShouldBe(sku);
        asFinance.GetProperty("unitCost").GetDecimal().ShouldBe(300m);
        asFinance.GetProperty("marginPct").GetDecimal().ShouldBe(33.3m);

        var asSales = await sales.GetFromJsonAsync<JsonElement>($"{Products}/{id}");
        asSales.GetProperty("listPrice").GetDecimal().ShouldBe(450m);
        asSales.TryGetProperty("unitCost", out _).ShouldBeFalse();
        asSales.TryGetProperty("marginPct", out _).ShouldBeFalse();

        var duplicate = await finance.PostAsJsonAsync(Products, Product(sku));
        duplicate.StatusCode.ShouldBe(HttpStatusCode.Conflict);
        (await duplicate.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe("CAT_DUPLICATE_SKU");

        var list = await sales.GetFromJsonAsync<JsonElement>($"{Products}?search={sku}");
        list.GetProperty("items").EnumerateArray().ShouldHaveSingleItem().TryGetProperty("unitCost", out _).ShouldBeFalse();
    }

    [Fact]
    public async Task Price_list_prices_apply_within_their_period_and_active_lists_may_not_overlap()
    {
        var finance = factory.ClientAs(CrmRoles.Finance);
        var category = $"C{Guid.NewGuid():N}"[..12].ToUpperInvariant();
        (await finance.PostAsJsonAsync("/api/v1/catalog/categories", new { code = category, name = "Test category", licenseMarkupPct = 20m, isDefault = false }))
            .StatusCode.ShouldBe(HttpStatusCode.Created);
        var service = await CreateProductAsync(finance, Product(Sku()));
        var licence = await CreateProductAsync(finance, Product(Sku("M365"), "Microsoft 365 Business Premium", 250m, null, "MicrosoftLicense"));

        var created = await finance.PostAsJsonAsync(PriceLists, new { name = "2026", customerCategory = category, validFrom = "2026-01-01", validTo = "2026-12-31" });
        created.StatusCode.ShouldBe(HttpStatusCode.Created);
        var listId = (await created.ReadJsonAsync()).GetProperty("id").GetGuid();
        (await finance.PutAsJsonAsync($"{PriceLists}/{listId}/items/{service}", new { unitPrice = 420m, unitCost = 290m })).StatusCode.ShouldBe(HttpStatusCode.OK);
        var licenceItem = await finance.PutAsJsonAsync($"{PriceLists}/{listId}/items/{licence}", new { partnerPrice = 22m, partnerCurrency = "USD", exchangeRate = 10.5m });
        var licencePrice = await licenceItem.ReadJsonAsync();
        licencePrice.GetProperty("unitPrice").GetDecimal().ShouldBe(277m); // 22 × 10.5 × 1.20 = 277.2 → nearest krone
        licencePrice.GetProperty("unitCost").GetDecimal().ShouldBe(231m);
        (await finance.PostAsync($"{PriceLists}/{listId}/activate", null)).StatusCode.ShouldBe(HttpStatusCode.NoContent);

        var overlapping = await finance.PostAsJsonAsync(PriceLists, new { name = "Autumn", customerCategory = category, validFrom = "2026-09-01" });
        var overlappingId = (await overlapping.ReadJsonAsync()).GetProperty("id").GetGuid();
        var conflict = await finance.PostAsync($"{PriceLists}/{overlappingId}/activate", null);
        conflict.StatusCode.ShouldBe(HttpStatusCode.Conflict);
        (await conflict.ReadJsonAsync()).GetProperty("priceListId").GetGuid().ShouldBe(listId);

        var inside = await finance.GetFromJsonAsync<JsonElement>($"/api/v1/catalog/prices?productId={service}&productId={licence}&category={category}&date=2026-06-01");
        var servicePrice = inside.EnumerateArray().Single(p => p.GetProperty("productId").GetGuid() == service);
        servicePrice.GetProperty("unitPrice").GetDecimal().ShouldBe(420m);
        servicePrice.GetProperty("priceListId").GetGuid().ShouldBe(listId);

        var outside = await factory.ClientAs(CrmRoles.Technician).GetFromJsonAsync<JsonElement>($"/api/v1/catalog/prices?productId={service}&category={category}&date=2027-01-01");
        var listPrice = outside.EnumerateArray().ShouldHaveSingleItem();
        listPrice.GetProperty("unitPrice").GetDecimal().ShouldBe(450m);
        listPrice.TryGetProperty("unitCost", out _).ShouldBeFalse();

        var copy = await finance.PostAsJsonAsync($"{PriceLists}/{listId}/copy", new { name = "2027", validFrom = "2027-01-01", adjustPct = 10m });
        var copied = await copy.ReadJsonAsync();
        copied.GetProperty("status").GetString().ShouldBe("Draft");
        copied.GetProperty("items").EnumerateArray().Single(i => i.GetProperty("productId").GetGuid() == service).GetProperty("unitPrice").GetDecimal().ShouldBe(462m);
    }

    [Fact]
    public async Task Used_products_can_only_be_deactivated()
    {
        var finance = factory.ClientAs(CrmRoles.Finance);
        var unused = await CreateProductAsync(finance, Product(Sku()));
        var used = await CreateProductAsync(finance, Product(Sku()));
        var bundle = await finance.PostAsJsonAsync(Products, new
        {
            sku = Sku("BUNDLE"), name = "Starter pack", type = "Bundle", businessLine = "Other", unit = "Package", billingPeriod = "Monthly", vatRate = 25m, listPrice = 900m,
            components = new[] { new { productId = used, quantity = 2m } },
        });
        bundle.StatusCode.ShouldBe(HttpStatusCode.Created);

        var inUse = await finance.DeleteAsync($"{Products}/{used}");
        inUse.StatusCode.ShouldBe(HttpStatusCode.Conflict);
        (await inUse.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe("CAT_PRODUCT_IN_USE");
        (await finance.PostAsync($"{Products}/{used}/deactivate", null)).StatusCode.ShouldBe(HttpStatusCode.NoContent);
        (await finance.GetFromJsonAsync<JsonElement>($"{Products}/{used}")).GetProperty("isActive").GetBoolean().ShouldBeFalse();

        (await finance.DeleteAsync($"{Products}/{unused}")).StatusCode.ShouldBe(HttpStatusCode.NoContent);
        (await finance.GetAsync($"{Products}/{unused}")).StatusCode.ShouldBe(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task The_nce_price_sheet_prices_a_draft_price_list_and_the_preview_writes_nothing()
    {
        var finance = factory.ClientAs(CrmRoles.Finance);
        var marker = $"{Guid.NewGuid():N}"[..8].ToUpperInvariant();
        var offerId = $"CFQ7{marker}:0001";
        var productId = await CreateProductAsync(finance, new
        {
            sku = Sku("M365"),
            name = $"Microsoft 365 Business Premium {marker}",
            type = "MicrosoftLicense",
            businessLine = "Microsoft",
            unit = "User",
            billingPeriod = "Monthly",
            vatRate = 25m,
            listPrice = 0m,
            unitCost = (decimal?)null,
            microsoftOfferId = offerId,
            commitmentTerm = "P1Y",
        });

        var category = (await finance.GetFromJsonAsync<JsonElement>("/api/v1/catalog/categories")).EnumerateArray().First();
        var created = await finance.PostAsJsonAsync(PriceLists, new
        {
            name = $"NCE {marker}",
            customerCategory = category.GetProperty("code").GetString(),
            validFrom = DateOnly.FromDateTime(DateTime.UtcNow).ToString("yyyy-MM-dd"),
            validTo = (string?)null,
            currency = "NOK",
        });
        created.StatusCode.ShouldBe(HttpStatusCode.Created);
        var priceListId = (await created.ReadJsonAsync()).GetProperty("id").GetGuid();

        var csv = string.Join('\n',
            "ProductTitle,ProductId,SkuId,SkuTitle,TermDuration,BillingPlan,Currency,UnitPrice",
            $"Microsoft 365 Business Premium,CFQ7{marker},0001,Business Premium,P1Y,Annual,USD,264.00",
            $"Microsoft 365 Business Premium,CFQ7{marker},0001,Business Premium,P1M,Monthly,USD,26.40",
            "Something else entirely,CFQ7UNKNOWN,0009,Other,P1Y,Annual,USD,10.00");

        // FR-CAT-03: the preview says what it would do and leaves the price list untouched.
        var preview = await (await finance.PostAsync(
            $"{PriceLists}/{priceListId}/price-sheet?exchangeRate=10.5&markupPct=15&dryRun=true",
            new StringContent(csv, Encoding.UTF8, "text/csv"))).ReadJsonAsync();
        preview.GetProperty("matched").GetInt32().ShouldBe(1);
        preview.GetProperty("changed").GetInt32().ShouldBe(1);
        preview.GetProperty("withoutProduct").GetInt32().ShouldBe(1);
        var previewRow = preview.GetProperty("rows").EnumerateArray().ShouldHaveSingleItem();
        previewRow.GetProperty("offerId").GetString().ShouldBe(offerId);
        // The annual row is the one used, because the product is sold on a yearly commitment: 264 × 10.5 × 1.15 = 3188.
        previewRow.GetProperty("unitPrice").GetDecimal().ShouldBe(3188m);
        previewRow.GetProperty("previousUnitPrice").ValueKind.ShouldBe(JsonValueKind.Null);
        (await finance.GetFromJsonAsync<JsonElement>($"{PriceLists}/{priceListId}")).GetProperty("items").EnumerateArray().ShouldBeEmpty();

        var applied = await (await finance.PostAsync(
            $"{PriceLists}/{priceListId}/price-sheet?exchangeRate=10.5&markupPct=15",
            new StringContent(csv, Encoding.UTF8, "text/csv"))).ReadJsonAsync();
        applied.GetProperty("changed").GetInt32().ShouldBe(1);

        var item = (await finance.GetFromJsonAsync<JsonElement>($"{PriceLists}/{priceListId}")).GetProperty("items").EnumerateArray().ShouldHaveSingleItem();
        item.GetProperty("productId").GetGuid().ShouldBe(productId);
        item.GetProperty("unitPrice").GetDecimal().ShouldBe(3188m);
        item.GetProperty("partnerPrice").GetDecimal().ShouldBe(264m);
        item.GetProperty("unitCost").GetDecimal().ShouldBe(2772m);

        // Running the same sheet again changes nothing.
        (await (await finance.PostAsync(
            $"{PriceLists}/{priceListId}/price-sheet?exchangeRate=10.5&markupPct=15",
            new StringContent(csv, Encoding.UTF8, "text/csv"))).ReadJsonAsync())
            .GetProperty("changed").GetInt32().ShouldBe(0);

        // An active price list is not re-priced behind anyone's back.
        (await finance.PostAsync($"{PriceLists}/{priceListId}/activate", null)).StatusCode.ShouldBe(HttpStatusCode.NoContent);
        var onActive = await finance.PostAsync(
            $"{PriceLists}/{priceListId}/price-sheet?exchangeRate=10.5", new StringContent(csv, Encoding.UTF8, "text/csv"));
        onActive.StatusCode.ShouldBe(HttpStatusCode.Conflict);
        (await onActive.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe("CAT_PRICE_LIST_NOT_DRAFT");

        // Partner prices are cost data: sales may not import them.
        var sales = factory.ClientAs(CrmRoles.Sales, userKey: "price-sheet-sales");
        (await sales.PostAsync($"{PriceLists}/{priceListId}/price-sheet?exchangeRate=10.5", new StringContent(csv, Encoding.UTF8, "text/csv")))
            .StatusCode.ShouldBe(HttpStatusCode.Forbidden);
    }
}
