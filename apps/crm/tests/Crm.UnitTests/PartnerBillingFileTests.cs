using System.IO.Compression;
using System.Text;
using System.Text.Json;
using Crm.Integrations.PartnerCenter;
using Crm.Licensing.Contracts;

namespace Crm.UnitTests;

/// <summary>
/// One line file of the partner billing export (docs/05 §2.4): gzip JSON Lines with every attribute capitalised, as Microsoft
/// documents the billed invoice reconciliation export (v2). A plain file and the camelCase spelling read before still work.
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
        using var document = JsonDocument.Parse(FullLine);

        PartnerBillingFile.ReadLine(document.RootElement, "G000999").ShouldBe(Expected);
    }

    [Theory]
    // Every line carries PartnerId, the partner's own tenant: it is not a customer.
    [InlineData("""{"PartnerId":"aaaabbbb-0000-cccc-1111-dddd2222eeee","ProductId":"CFQ7TTC0LF8Q","SkuId":"0001","Subtotal":10}""")]
    [InlineData("""{"CustomerId":" ","ProductId":"CFQ7TTC0LF8Q","Subtotal":10}""")]
    [InlineData("""{"CustomerId":"csp-1","SkuId":"0001","Subtotal":10}""")]
    [InlineData("""["CustomerId","csp-1"]""")]
    public void A_line_without_its_customer_or_product_is_not_read(string row)
    {
        using var document = JsonDocument.Parse(row);

        PartnerBillingFile.ReadLine(document.RootElement, "G000123").ShouldBeNull();
    }

    [Fact]
    public void A_gzip_file_is_recognised_by_its_bytes_and_a_plain_one_still_reads()
    {
        var text = FullLine + "\r\n" + ShortLine + "\n\n";
        var plain = Encoding.UTF8.GetBytes(text);
        byte[] withByteOrderMark = [.. Encoding.UTF8.GetPreamble(), .. plain];
        var compressed = Gzip(text);

        var lines = PartnerBillingFile.Read(compressed, "G000999");

        compressed[..2].ShouldBe(new byte[] { 0x1F, 0x8B });
        lines.Count.ShouldBe(2);
        lines[0].ShouldBe(Expected);
        lines[1].ShouldBe(new ExternalBilledLine(
            MsBillingSource.GraphExport, new DateOnly(2026, 9, 1), new DateOnly(2026, 9, 30), "G000123", "csp-2", null, "sub-2",
            "CFQ7TTC0LF8R:0002", null, 2m, 300m, 600m, "NOK"));
        PartnerBillingFile.Read(plain, "G000999").ShouldBe(lines);
        PartnerBillingFile.Read(withByteOrderMark, "G000999").ShouldBe(lines);
    }

    [Fact]
    public void The_camelCase_spelling_and_a_whole_array_read_as_before()
    {
        var lines = PartnerBillingFile.ParseLines(
            """[{"customerId":"csp-1","offerId":"CFQ7TTC0LF8Q","quantity":5,"effectiveUnitPrice":12.5,"totalForCustomer":62.5,"chargeStartDate":"2026-09-01","chargeEndDate":"2026-09-30","currency":"NOK"}]""",
            "G000123");

        lines.ShouldBe([new ExternalBilledLine(
            MsBillingSource.GraphExport, new DateOnly(2026, 9, 1), new DateOnly(2026, 9, 30), "G000123", "csp-1", null, null,
            "CFQ7TTC0LF8Q", null, 5m, 12.5m, 62.5m, "NOK")]);
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
