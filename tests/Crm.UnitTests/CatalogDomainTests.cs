using Crm.Catalog.Contracts;
using Crm.Catalog.Domain;
using Crm.Catalog.Features.PriceLists;

namespace Crm.UnitTests;

public class CatalogDomainTests
{
    private static ProductDetails Details(string sku = "msp-ws", ProductType type = ProductType.ManagedService, decimal vat = 25m, IReadOnlyList<BundleComponent>? components = null) =>
        new(sku, " Managed workstation ", null, null, type, BusinessLine.Atera, ProductUnit.Device, BillingPeriod.Monthly, vat, 450m, 300m, "nok",
            "CFQ7TTC0LF8Q", CommitmentTerm.P1Y, "Remote support", "3000", components);

    [Fact]
    public void Product_normalizes_sku_currency_and_drops_licence_fields_for_services()
    {
        var product = Product.Create(Details()).Value;

        product.Sku.ShouldBe("MSP-WS");
        product.Name.ShouldBe("Managed workstation");
        product.Currency.ShouldBe("NOK");
        product.MicrosoftOfferId.ShouldBeNull();
        product.CommitmentTerm.ShouldBe(CommitmentTerm.None);
        product.DomainEvents.ShouldHaveSingleItem().ShouldBeOfType<ProductCreated>();
    }

    [Fact]
    public void Product_rejects_unknown_vat_rate() =>
        Product.Create(Details(vat: 20m)).Error!.Code.ShouldBe("CAT_INVALID_VAT_RATE");

    [Fact]
    public void Bundle_needs_components_and_merges_duplicates()
    {
        Product.Create(Details(type: ProductType.Bundle)).Error!.Code.ShouldBe("CAT_BUNDLE_EMPTY");

        var part = Guid.NewGuid();
        var bundle = Product.Create(Details(type: ProductType.Bundle, components: [new(part, 1), new(part, 2)])).Value;
        bundle.Components.ShouldHaveSingleItem().ShouldBe(new BundleComponent(part, 3));
    }

    [Theory]
    [InlineData(PriceRounding.None, 12.5, 10.93, 15, 157.12)]
    [InlineData(PriceRounding.Nearest1, 12.5, 10.93, 15, 157)]
    [InlineData(PriceRounding.Nearest5, 12.5, 10.93, 15, 155)]
    [InlineData(PriceRounding.Nearest10, 12.5, 10.93, 15, 160)]
    [InlineData(PriceRounding.Up1, 12.5, 10.93, 15, 158)]
    public void Licence_price_is_partner_price_times_rate_plus_markup(PriceRounding rounding, double partner, double rate, double markup, double expected) =>
        LicensePricing.SalesPrice((decimal)partner, (decimal)rate, (decimal)markup, rounding).ShouldBe((decimal)expected);

    [Fact]
    public void Partner_price_sets_sales_price_and_cost()
    {
        var item = PriceListItem.Create(Guid.NewGuid(), Guid.NewGuid());
        item.SetFromPartnerPrice(12.5m, "usd", 10.93m, 15m, PriceRounding.Nearest1);

        item.UnitPrice.ShouldBe(157m);
        item.UnitCost.ShouldBe(136.63m);
        item.PartnerCurrency.ShouldBe("USD");
    }

    [Fact]
    public void Price_lists_of_the_same_category_overlap_when_periods_touch()
    {
        var y2026 = PriceList.Create("2026", "standard", new DateOnly(2026, 1, 1), new DateOnly(2026, 12, 31), "NOK").Value;
        var y2027 = PriceList.Create("2027", "STANDARD", new DateOnly(2027, 1, 1), null, "NOK").Value;
        var lateStart = PriceList.Create("Autumn", "STANDARD", new DateOnly(2026, 9, 1), null, "NOK").Value;
        var partner = PriceList.Create("Partner", "PARTNER", new DateOnly(2026, 1, 1), null, "NOK").Value;

        y2026.Overlaps(y2027).ShouldBeFalse();
        y2026.Overlaps(lateStart).ShouldBeTrue();
        y2027.Overlaps(lateStart).ShouldBeTrue();
        y2026.Overlaps(partner).ShouldBeFalse();
    }

    [Fact]
    public void Resolver_prefers_active_price_list_covering_the_date_over_list_price()
    {
        var product = Product.Create(Details()).Value;
        var active = PriceList.Create("2026", "STANDARD", new DateOnly(2026, 1, 1), new DateOnly(2026, 12, 31), "NOK").Value;
        active.Activate();
        var draft = PriceList.Create("Draft", "STANDARD", new DateOnly(2026, 1, 1), null, "NOK").Value;
        var activeItem = PriceListItem.Create(active.Id, product.Id);
        activeItem.SetPrice(420m, null);
        var draftItem = PriceListItem.Create(draft.Id, product.Id);
        draftItem.SetPrice(1m, null);
        (PriceList, PriceListItem)[] candidates = [(active, activeItem), (draft, draftItem)];

        var inside = PriceResolver.Resolve(product, candidates, new DateOnly(2026, 6, 1));
        inside.UnitPrice.ShouldBe(420m);
        inside.UnitCost.ShouldBe(300m);
        inside.PriceListId.ShouldBe(active.Id);

        var outside = PriceResolver.Resolve(product, candidates, new DateOnly(2027, 1, 1));
        outside.UnitPrice.ShouldBe(450m);
        outside.PriceListId.ShouldBeNull();
    }
}

public class PriceSheetCsvTests
{
    [Fact]
    public void The_nce_price_sheet_is_read_with_the_offer_composed_from_product_and_sku()
    {
        var csv = string.Join('\n',
            "ProductTitle,ProductId,SkuId,SkuTitle,Publisher,SkuDescription,UnitOfMeasure,TermDuration,BillingPlan,Market,Currency,UnitPrice,PricingTierRangeMin",
            "Microsoft 365 Business Premium,CFQ7TTC0LDPB,0001,Business Premium,Microsoft,Per user,1 License,P1Y,Annual,NO,USD,264.00,0",
            "Microsoft 365 Business Premium,CFQ7TTC0LDPB,0001,Business Premium,Microsoft,Per user,1 License,P1M,Monthly,NO,USD,26.40,0");

        var result = PriceSheetCsv.Parse(csv);

        result.Errors.ShouldBeEmpty();
        result.Rows.Count.ShouldBe(2);
        var annual = result.Rows[0];
        annual.OfferId.ShouldBe("CFQ7TTC0LDPB:0001");
        annual.PartnerPrice.ShouldBe(264.00m);
        annual.Currency.ShouldBe("USD");
        annual.Term.ShouldBe(CommitmentTerm.P1Y);
        result.Rows[1].Term.ShouldBe(CommitmentTerm.P1M);
        result.UnknownColumns.ShouldContain("Publisher");
    }

    [Fact]
    public void A_sheet_with_an_offer_id_column_and_norwegian_numbers_is_read_too()
    {
        var result = PriceSheetCsv.Parse(string.Join('\n',
            "OfferId;OfferName;Pris;Valuta;Term",
            "CFQ7TTC0LF8Q;Business Premium;1 850,40;NOK;P1Y"));

        var row = result.Rows.ShouldHaveSingleItem();
        row.OfferId.ShouldBe("CFQ7TTC0LF8Q");
        row.PartnerPrice.ShouldBe(1850.40m);
        row.Currency.ShouldBe("NOK");
    }

    [Fact]
    public void A_file_without_a_price_column_is_rejected_and_a_bad_price_is_reported()
    {
        PriceSheetCsv.Parse("ProductId;SkuId\nCFQ;0001").Errors.ShouldNotBeEmpty();

        var result = PriceSheetCsv.Parse(string.Join('\n',
            "OfferId;UnitPrice", "OFFER-1;free", "OFFER-2;10"));
        result.Rows.ShouldHaveSingleItem().OfferId.ShouldBe("OFFER-2");
        result.Errors.ShouldHaveSingleItem().ShouldContain("Row 2");
    }
}
