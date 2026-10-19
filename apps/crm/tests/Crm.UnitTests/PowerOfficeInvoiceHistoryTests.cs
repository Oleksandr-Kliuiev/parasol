using System.Text.Json;
using Crm.Billing.Contracts;
using Crm.Billing.Domain;
using Crm.Integrations.PowerOffice;

namespace Crm.UnitTests;

public class PowerOfficeInvoiceHistoryTests
{
    private static readonly DateTimeOffset Changed = DateTimeOffset.Parse("2026-10-01T10:00:00Z");

    private static PoOutgoingInvoice Header() => new()
    {
        Id = Guid.Parse("11111111-2222-4333-8444-555555555555"), InvoiceNo = 10042, OrderNo = 1042, CustomerId = 7,
        ExternalImportReference = "2026-09-key", VoucherDate = new(2026, 10, 1), DueDate = new(2026, 10, 15),
        CurrencyCode = "NOK", NetAmount = 1000m, TotalAmount = 1250m, NetPostedAmount = 1000m, TotalPostedAmount = 1250m,
        Balance = 250m, VoucherType = "OutgoingInvoice", IsReversed = false,
        LastChangedDateTimeOffset = Changed, BalanceLastChangedDateTimeOffset = Changed,
    };

    private static PoOutgoingInvoiceLine Line() => new()
    {
        Id = 71, SortOrder = 0, LineType = "Normal", Description = "Synthetic support", ProductCode = "SUPPORT",
        Quantity = 1.2345m, ProductUnitPrice = 800.1234m, Allowance = -2.5m, VatRate = .25m,
        NetAmount = 1000m, VatAmount = 250m, TotalAmount = 1250m, NetPostedAmount = 1000m, TotalPostedAmount = 1250m,
    };

    [Fact]
    public void Invoice_maps_dates_reference_and_partial_balance_from_the_reporting_contract()
    {
        var mapped = PowerOfficeInvoiceMapping.Map(Header(), [Line()]);
        mapped.InvoiceNo.ShouldBe("10042");
        mapped.OrderNo.ShouldBe("1042");
        mapped.ExternalReference.ShouldBe("2026-09-key");
        mapped.Status.ShouldBe(InvoiceStatus.PartiallyPaid);
        mapped.InvoiceDate.ShouldBe(new DateOnly(2026, 10, 1));
        mapped.DueDate.ShouldBe(new DateOnly(2026, 10, 15));
        mapped.History!.LineCoverage.ShouldBe(InvoiceLineCoverage.Reconciled);
        mapped.History.Lines.Single().Quantity.ShouldBe(1.2345m);
        mapped.History.Lines.Single().UnitPrice.ShouldBe(800.1234m);
        mapped.History.Lines.Single().VatRate.ShouldBe(.25m);
        mapped.History.Lines.Single().Allowance.ShouldBe(-2.5m);
    }

    [Theory]
    [InlineData("uuid")]
    [InlineData("date")]
    [InlineData("balance")]
    [InlineData("currency")]
    [InlineData("kind")]
    [InlineData("posted")]
    [InlineData("reversed")]
    public void Incomplete_headers_fail_instead_of_inventing_dates_amounts_or_kind(string field)
    {
        var source = field switch
        {
            "uuid" => Header() with { Id = Guid.Empty }, "date" => Header() with { VoucherDate = null },
            "balance" => Header() with { Balance = null }, "currency" => Header() with { CurrencyCode = null },
            "reversed" => Header() with { IsReversed = null },
            "kind" => Header() with { VoucherType = "FutureUnknown" }, _ => Header() with { TotalPostedAmount = null },
        };
        Should.Throw<InvalidOperationException>(() => PowerOfficeInvoiceMapping.Map(source, []));
    }

    [Fact]
    public void Foreign_document_amounts_are_separate_from_client_currency_balances()
    {
        var header = Header() with { CurrencyCode = "EUR", NetAmount = 80m, TotalAmount = 100m, Balance = 625m };
        var line = Line() with { NetAmount = 80m, VatAmount = 20m, TotalAmount = 100m };
        var mapped = PowerOfficeInvoiceMapping.Map(header, [line]);
        mapped.TotalIncVat.ShouldBe(1250m);
        mapped.Outstanding.ShouldBe(625m);
        mapped.History!.TotalAmount.ShouldBe(100m);
        mapped.History.CurrencyCode.ShouldBe("EUR");
        mapped.History.LineCoverage.ShouldBe(InvoiceLineCoverage.Reconciled);
    }

    [Fact]
    public void Credit_note_preserves_signed_lines_and_related_number_without_marking_another_invoice_paid()
    {
        var header = Header() with { VoucherType = "OutgoingCreditNote", RelatedInvoiceNo = 10001, NetAmount = -1000m,
            TotalAmount = -1250m, NetPostedAmount = -1000m, TotalPostedAmount = -1250m, Balance = -1250m };
        var line = Line() with { Quantity = -1.2345m, NetAmount = -1000m, VatAmount = -250m, TotalAmount = -1250m,
            NetPostedAmount = -1000m, TotalPostedAmount = -1250m };
        var mapped = PowerOfficeInvoiceMapping.Map(header, [line]);
        mapped.History!.Kind.ShouldBe(InvoiceDocumentKind.CreditNote);
        mapped.History.RelatedInvoiceNo.ShouldBe("10001");
        mapped.History.Lines.Single().Quantity.ShouldBe(-1.2345m);
        var invoice = Invoice.From(mapped, null, null, Changed);
        invoice.IsOverdue(new DateOnly(2027, 1, 1)).ShouldBeFalse();
        invoice.Payments.ShouldBeEmpty();
        invoice.History!.LineCoverage.ShouldBe(InvoiceLineCoverage.Reconciled);
    }

    [Fact]
    public void Text_and_summary_lines_are_kept_but_not_double_counted()
    {
        var text = new PoOutgoingInvoiceLine { Id = 72, SortOrder = 1, LineType = "Text", Description = "Synthetic terms" };
        var summary = Line() with { Id = 73, SortOrder = 2, LineType = "Summary" };
        var mapped = PowerOfficeInvoiceMapping.Map(Header(), [summary, text, Line(), Line()]);
        mapped.History!.Lines.Select(l => l.Id).ShouldBe([71, 72, 73]);
        mapped.History.LineCoverage.ShouldBe(InvoiceLineCoverage.Reconciled);
    }

    [Fact]
    public void Conflicting_duplicate_line_ids_are_rejected()
    {
        Should.Throw<InvalidOperationException>(() => PowerOfficeInvoiceMapping.Map(Header(), [Line(), Line() with { TotalAmount = 1m }]));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void An_empty_or_mismatched_line_set_is_explicitly_unverified(bool mismatch)
    {
        var mapped = PowerOfficeInvoiceMapping.Map(Header(), mismatch ? [Line() with { NetAmount = 1m }] : []);
        mapped.History!.LineCoverage.ShouldBe(mismatch ? InvoiceLineCoverage.RetrievedUnverified : InvoiceLineCoverage.EmptyUnverified);
    }

    [Fact]
    public void Replaying_the_snapshot_preserves_the_source_id_and_creates_no_movements()
    {
        var mapped = PowerOfficeInvoiceMapping.Map(Header(), [Line()]);
        var invoice = Invoice.From(mapped, null, null, Changed);
        invoice.Apply(mapped, null, null, Changed.AddMinutes(1)).ShouldBeFalse();
        invoice.ExternalId.ShouldBe(Header().Id);
        invoice.History!.Lines.Count.ShouldBe(1);
        invoice.Payments.ShouldBeEmpty();
    }

    [Fact]
    public void Older_source_versions_cannot_regress_the_balance()
    {
        var mapped = PowerOfficeInvoiceMapping.Map(Header(), [Line()]);
        var invoice = Invoice.From(mapped, null, null, Changed);
        var old = PowerOfficeInvoiceMapping.Map(Header() with { Balance = 1000m, BalanceLastChangedDateTimeOffset = Changed.AddDays(-1) }, [Line()]);
        invoice.Apply(old, null, null, Changed.AddDays(1)).ShouldBeFalse();
        invoice.Outstanding.ShouldBe(250m);
        invoice.SyncedAt.ShouldBe(Changed);
        invoice.Payments.ShouldBeEmpty();
    }

    [Fact]
    public void A_posted_source_uuid_cannot_be_reassigned_to_another_customer()
    {
        var invoice = Invoice.From(PowerOfficeInvoiceMapping.Map(Header(), [Line()]), null, null, Changed);
        var other = PowerOfficeInvoiceMapping.Map(Header() with { CustomerId = 8 }, [Line()]);
        Should.Throw<InvalidOperationException>(() => invoice.Apply(other, null, null, Changed));
    }

    [Fact]
    public void Reversed_invoice_is_not_an_overdue_receivable_even_if_source_balance_is_positive()
    {
        var invoice = Invoice.From(PowerOfficeInvoiceMapping.Map(Header() with { IsReversed = true }, [Line()]), null, null, Changed);
        invoice.IsOverdue(new DateOnly(2100, 1, 1)).ShouldBeFalse();
        invoice.Outstanding.ShouldBe(250m);
    }

    [Fact]
    public void Extra_source_fields_survive_the_snapshot_without_becoming_financial_effects()
    {
        var line = Line() with { AdditionalFields = new() { ["AccountNo"] = JsonSerializer.SerializeToElement(3000) } };
        var invoice = Invoice.From(PowerOfficeInvoiceMapping.Map(Header(), [line]), null, null, Changed);
        JsonDocument.Parse(invoice.History!.Lines.Single().SourceJson).RootElement.GetProperty("AccountNo").GetInt32().ShouldBe(3000);
        invoice.Payments.ShouldBeEmpty();
    }
}
