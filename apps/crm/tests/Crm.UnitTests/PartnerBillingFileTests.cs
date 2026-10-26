using System.IO.Compression;
using System.Text;
using System.Text.Json;
using Crm.Integrations.PartnerCenter;
using Crm.Licensing.Contracts;

namespace Crm.UnitTests;

/// <summary>
/// One line file of the partner billing export (docs/05 §2.4): gzip JSON Lines with every attribute capitalised, as Microsoft
/// documents the billed invoice reconciliation export (v2) and the new commerce reconciliation file's fields. A plain file and
/// the camelCase spelling read before still work.
/// </summary>
public class PartnerBillingFileTests
{
    /// <summary>Every attribute of the "full" set, with synthetic values.</summary>
    private const string FullLine = """
        {"PartnerId":"aaaabbbb-0000-cccc-1111-dddd2222eeee","CustomerId":"csp-1","CustomerName":"Havbris AS","CustomerDomainName":"havbris.example","CustomerCountry":"NO","InvoiceNumber":"G000123","MpnId":"1234567","Tier2MpnId":"","OrderId":"order-1","OrderDate":"2026-08-20T10:15:00Z","ProductId":"CFQ7TTC0LF8Q","SkuId":"0001","AvailabilityId":"CFQ7TTC0K5BF","SkuName":"Microsoft 365 Business Standard","ProductName":"Microsoft 365 Business Standard","ChargeType":"cycleCharge","UnitPrice":130,"Quantity":5,"Subtotal":627.5,"TaxTotal":156.88,"Total":784.38,"Currency":"NOK","PriceAdjustmentDescription":"","PublisherName":"Microsoft Corporation","PublisherId":"","SubscriptionDescription":"Microsoft 365 Business Standard","SubscriptionId":"sub-1","ChargeStartDate":"2026-09-01T00:00:00Z","ChargeEndDate":"2026-09-30T00:00:00Z","TermAndBillingCycle":"1 Year Monthly Billing","EffectiveUnitPrice":125.5,"UnitType":"Licenses","AlternateId":"alt-1","BillableQuantity":5,"BillingFrequency":"Monthly","PricingCurrency":"NOK","PCToBCExchangeRate":1,"PCToBCExchangeRateDate":"2026-08-01T00:00:00Z","MeterDescription":"","ReservationOrderId":"","CreditReasonCode":"","SubscriptionStartDate":"2026-01-01T00:00:00Z","SubscriptionEndDate":"2026-12-31T00:00:00Z","ReferenceId":"ref-1","ProductQualifiers":[],"PromotionId":"","ProductCategory":"Microsoft 365"}
        """;

    private const string ShortLine = """
        {"PartnerId":"aaaabbbb-0000-cccc-1111-dddd2222eeee","CustomerId":"csp-2","InvoiceNumber":"G000123","ProductId":"CFQ7TTC0LF8R","SkuId":"0002","Quantity":"2","Subtotal":"600.00","Total":"750.00","Currency":"NOK","SubscriptionId":"sub-2","ChargeStartDate":"2026-09-01T00:00:00Z","ChargeEndDate":"2026-09-30T00:00:00Z","EffectiveUnitPrice":"300.00"}
        """;

    private static readonly ExternalBilledLine Expected = new(
        MsBillingSource.GraphExport, new DateOnly(2026, 9, 1), new DateOnly(2026, 9, 30), "G000123", "csp-1", "Havbris AS", "sub-1",
        "CFQ7TTC0LF8Q:0001", "Microsoft 365 Business Standard", 5m, 125.5m, 627.5m, "NOK");

    [Fact]
    public void A_v2_line_is_read_from_its_capitalised_attributes_with_the_cost_before_tax()
    {
        PartnerBillingFile.ReadLine(Parse(FullLine), "G000999").ShouldBe(Expected);
    }

    [Fact]
    public void A_seat_line_counts_its_billable_quantity_and_prices_the_unit_in_the_billing_currency()
    {
        // Microsoft: Subtotal = ROUNDDOWN(EffectiveUnitPrice * PCToBCExchangeRate, 2) * BillableQuantity = 4.93 * 12.
        var line = PartnerBillingFile.ReadLine(Parse("""
            {"CustomerId":"csp-1","ProductId":"CFQ7TTC0LH18","SkuId":"0001","Quantity":1,"BillableQuantity":12,"UnitPrice":0.5,"EffectiveUnitPrice":0.47,"PricingCurrency":"USD","PCToBCExchangeRate":10.5,"Subtotal":59.16,"Total":73.95,"Currency":"NOK","ChargeStartDate":"2026-09-01T00:00:00Z","ChargeEndDate":"2026-09-30T00:00:00Z"}
            """), "G000123")!;

        (line.Quantity, line.UnitPrice, line.Total, line.Currency).ShouldBe((12m, 4.935m, 59.16m, "NOK"));
    }

    [Theory]
    // The older file's TotalForCustomer and v2's Total both include tax.
    [InlineData("""{"customerId":"csp-1","offerId":"P","chargeStartDate":"2026-09-01","subtotal":11,"tax":2.75,"totalForCustomer":13.75}""", 11.0)]
    [InlineData("""{"CustomerId":"csp-1","ProductId":"P","ChargeStartDate":"2026-09-01","Total":13.75,"TaxTotal":2.75,"Subtotal":11}""", 11.0)]
    [InlineData("""{"customerId":"csp-1","offerId":"P","chargeStartDate":"2026-09-01","totalForCustomer":13.75}""", 13.75)]
    [InlineData("""{"CustomerId":"csp-1","ProductId":"P","ChargeStartDate":"2026-09-01","BillableQuantity":3,"EffectiveUnitPrice":2.5}""", 7.5)]
    public void The_cost_is_the_subtotal_before_tax_and_an_after_tax_total_only_without_one(string row, double cost)
    {
        PartnerBillingFile.ReadLine(Parse(row), "G000123")!.Total.ShouldBe((decimal)cost);
    }

    [Theory]
    // As Microsoft's field table shows the values: text with a leading apostrophe, zero with an exponent.
    [InlineData("""{"CustomerId":"csp-1","ProductId":"P","ChargeStartDate":"2024-11-01T00:00:00.000Z","Quantity":"'1.000000000000000000","BillableQuantity":"'12.000000000000000000","EffectiveUnitPrice":"'0.47000000000000000000000000000000","PCToBCExchangeRate":"'1.00000000000000000000000000000000","Subtotal":"'5.64000000000000000000","TaxTotal":"'0E-20","Total":"'5.64000000000000000000"}""")]
    // The same as JSON numbers.
    [InlineData("""{"CustomerId":"csp-1","ProductId":"P","ChargeStartDate":"2024-11-01T00:00:00.000Z","Quantity":1.000000000000000000,"BillableQuantity":12.000000000000000000,"EffectiveUnitPrice":0.47000000000000000000000000000000,"PCToBCExchangeRate":1.00000000000000000000000000000000,"Subtotal":5.64000000000000000000,"TaxTotal":0E-20,"Total":5.64000000000000000000}""")]
    public void Amounts_read_as_Microsoft_writes_them(string row)
    {
        var line = PartnerBillingFile.ReadLine(Parse(row), "G000123")!;

        (line.Quantity, line.UnitPrice, line.Total, line.PeriodStart).ShouldBe((12m, 0.47m, 5.64m, new DateOnly(2024, 11, 1)));
    }

    [Theory]
    // Every line carries PartnerId, the partner's own tenant: it is not a customer.
    [InlineData("""{"PartnerId":"aaaabbbb-0000-cccc-1111-dddd2222eeee","ProductId":"P","SkuId":"0001","ChargeStartDate":"2026-09-01","Subtotal":10}""")]
    [InlineData("""{"CustomerId":" ","ProductId":"P","ChargeStartDate":"2026-09-01","Subtotal":10}""")]
    [InlineData("""{"CustomerId":"csp-1","SkuId":"0001","ChargeStartDate":"2026-09-01","Subtotal":10}""")]
    // A made-up start would give the line a new key on every run.
    [InlineData("""{"CustomerId":"csp-1","ProductId":"P","Subtotal":10}""")]
    [InlineData("""{"CustomerId":"csp-1","ProductId":"P","ChargeStartDate":"soon","Subtotal":10}""")]
    // An amount that is not a number is not replaced by the next one (here the total with tax).
    [InlineData("""{"CustomerId":"csp-1","ProductId":"P","ChargeStartDate":"2026-09-01","Subtotal":"n/a","Total":12.5}""")]
    [InlineData("""{"CustomerId":"csp-1","ProductId":"P","ChargeStartDate":"2026-09-01","BillableQuantity":true,"Subtotal":10}""")]
    [InlineData("""["CustomerId","csp-1"]""")]
    public void A_line_without_what_the_crm_compares_is_not_read(string row)
    {
        PartnerBillingFile.ReadLine(Parse(row), "G000123").ShouldBeNull();
    }

    [Fact]
    public void Rows_that_are_not_read_are_counted()
    {
        var content = string.Join('\n', FullLine, """{"CustomerId":"csp-1","ProductId":"P","Subtotal":10}""", ShortLine, """{"PartnerId":"p"}""");

        var (lines, unread) = PartnerBillingFile.ParseLines(content, "G000999");

        lines.Select(l => l.CspCustomerId).ShouldBe(["csp-1", "csp-2"]);
        unread.ShouldBe(2);
    }

    [Fact]
    public void A_gzip_file_is_recognised_by_its_bytes_and_a_plain_one_still_reads()
    {
        var text = FullLine + "\r\n" + ShortLine + "\n\n";
        var plain = Encoding.UTF8.GetBytes(text);
        byte[] withByteOrderMark = [.. Encoding.UTF8.GetPreamble(), .. plain];
        var compressed = Gzip(text);

        var (lines, unread) = PartnerBillingFile.Read(compressed, "G000999");

        compressed[..2].ShouldBe(new byte[] { 0x1F, 0x8B });
        unread.ShouldBe(0);
        lines.Count.ShouldBe(2);
        lines[0].ShouldBe(Expected);
        lines[1].ShouldBe(new ExternalBilledLine(
            MsBillingSource.GraphExport, new DateOnly(2026, 9, 1), new DateOnly(2026, 9, 30), "G000123", "csp-2", null, "sub-2",
            "CFQ7TTC0LF8R:0002", null, 2m, 300m, 600m, "NOK"));
        PartnerBillingFile.Read(plain, "G000999").Lines.ShouldBe(lines);
        PartnerBillingFile.Read(withByteOrderMark, "G000999").Lines.ShouldBe(lines);
    }

    [Fact]
    public void The_camelCase_spelling_and_a_whole_array_read_as_before()
    {
        var (lines, unread) = PartnerBillingFile.ParseLines(
            """[{"customerId":"csp-1","offerId":"CFQ7TTC0LF8Q","quantity":5,"effectiveUnitPrice":12.5,"totalForCustomer":62.5,"chargeStartDate":"2026-09-01","chargeEndDate":"2026-09-30","currency":"NOK"}]""",
            "G000123");

        unread.ShouldBe(0);
        lines.ShouldBe([new ExternalBilledLine(
            MsBillingSource.GraphExport, new DateOnly(2026, 9, 1), new DateOnly(2026, 9, 30), "G000123", "csp-1", null, null,
            "CFQ7TTC0LF8Q", null, 5m, 12.5m, 62.5m, "NOK")]);
    }

    private static JsonElement Parse(string json)
    {
        using var document = JsonDocument.Parse(json);
        return document.RootElement.Clone();
    }

    private static byte[] Gzip(string text)
    {
        using var buffer = new MemoryStream();
        using (var gzip = new GZipStream(buffer, CompressionLevel.Fastest, leaveOpen: true))
        {
            gzip.Write(Encoding.UTF8.GetBytes(text));
        }

        return buffer.ToArray();
    }
}
