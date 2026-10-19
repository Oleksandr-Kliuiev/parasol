using Crm.Billing.Contracts;
using Crm.Billing.Domain;

namespace Crm.UnitTests;

public class InvoiceMirrorTests
{
    private static ExternalInvoice Source(decimal total = 12_500m, decimal outstanding = 12_500m, InvoiceStatus status = InvoiceStatus.Sent) =>
        new("poweroffice", "10042", "1042", "2026-09-key", null, new DateOnly(2026, 10, 1), new DateOnly(2026, 10, 15), total, outstanding, status, null);

    private static readonly DateTimeOffset Seen = DateTimeOffset.Parse("2026-10-20T08:00:00Z", System.Globalization.CultureInfo.InvariantCulture);

    [Fact]
    public void A_smaller_outstanding_amount_is_an_observed_decrease_not_a_payment()
    {
        var invoice = Invoice.From(Source(), Guid.NewGuid(), Guid.NewGuid(), Seen);
        invoice.Payments.ShouldBeEmpty();

        invoice.Apply(Source(outstanding: 2_500m, status: InvoiceStatus.PartiallyPaid), null, null, Seen.AddDays(1)).ShouldBeTrue();

        var movement = invoice.Payments.ShouldHaveSingleItem();
        movement.Kind.ShouldBe(InvoiceMovementKind.BalanceDecrease);
        movement.Amount.ShouldBe(10_000m);
        movement.ObservedOn.ShouldBe(new DateOnly(2026, 10, 21));
        movement.Source.ShouldNotBeNullOrWhiteSpace();
        invoice.Outstanding.ShouldBe(2_500m);
    }

    [Fact]
    public void A_credited_invoice_with_a_lower_remaining_amount_is_a_credit_note()
    {
        var invoice = Invoice.From(Source(), Guid.NewGuid(), null, Seen);

        invoice.Apply(Source(outstanding: 0m, status: InvoiceStatus.Credited), null, null, Seen.AddDays(1)).ShouldBeTrue();

        var movement = invoice.Payments.ShouldHaveSingleItem();
        movement.Kind.ShouldBe(InvoiceMovementKind.CreditNote);
        movement.Amount.ShouldBe(12_500m);
    }

    [Fact]
    public void Flipping_to_credited_without_a_changed_amount_still_records_the_credit_note()
    {
        var invoice = Invoice.From(Source(), Guid.NewGuid(), null, Seen);

        invoice.Apply(Source(status: InvoiceStatus.Credited), null, null, Seen.AddDays(1)).ShouldBeTrue();

        var movement = invoice.Payments.ShouldHaveSingleItem();
        movement.Kind.ShouldBe(InvoiceMovementKind.CreditNote);
        movement.Amount.ShouldBe(0m);

        // Seeing the same credited state again adds nothing.
        invoice.Apply(Source(status: InvoiceStatus.Credited), null, null, Seen.AddDays(2)).ShouldBeFalse();
        invoice.Payments.Count.ShouldBe(1);
    }

    [Fact]
    public void A_higher_remaining_amount_is_kept_as_a_flagged_increase()
    {
        var invoice = Invoice.From(Source(outstanding: 2_500m, status: InvoiceStatus.PartiallyPaid), Guid.NewGuid(), null, Seen);

        invoice.Apply(Source(outstanding: 4_000m, status: InvoiceStatus.PartiallyPaid), null, null, Seen.AddDays(1)).ShouldBeTrue();

        var movement = invoice.Payments.ShouldHaveSingleItem();
        movement.Kind.ShouldBe(InvoiceMovementKind.BalanceIncrease);
        movement.Amount.ShouldBe(1_500m);
    }

    [Fact]
    public void The_first_sync_records_no_movement_whatever_the_amount()
    {
        Invoice.From(Source(outstanding: 3_000m), null, null, Seen).Payments.ShouldBeEmpty();
        Invoice.From(Source(outstanding: 0m, status: InvoiceStatus.Credited), null, null, Seen).Payments.ShouldBeEmpty();
    }

    [Fact]
    public void An_unchanged_invoice_reports_no_change()
    {
        var now = DateTimeOffset.UtcNow;
        var invoice = Invoice.From(Source(), Guid.NewGuid(), null, now);

        invoice.Apply(Source(), null, null, now.AddHours(1)).ShouldBeFalse();
        invoice.Payments.ShouldBeEmpty();
    }

    [Fact]
    public void An_invoice_past_its_due_date_with_an_outstanding_amount_is_overdue()
    {
        var invoice = Invoice.From(Source(), null, null, DateTimeOffset.UtcNow);

        invoice.IsOverdue(new DateOnly(2026, 10, 16)).ShouldBeTrue();
        invoice.IsOverdue(new DateOnly(2026, 10, 10)).ShouldBeFalse();

        invoice.Apply(Source(outstanding: 0, status: InvoiceStatus.Paid), null, null, DateTimeOffset.UtcNow);
        invoice.IsOverdue(new DateOnly(2026, 11, 1)).ShouldBeFalse();
    }


}
