using System.Text.Json;
using Crm.Billing.Contracts;
using Crm.Billing.Domain;
using Crm.Integrations.PowerOffice;

namespace Crm.UnitTests;

public class PowerOfficeLedgerTests
{
    private static readonly DateTimeOffset Changed = DateTimeOffset.Parse("2026-10-18T01:00:00Z");
    private static PoCustomerLedgerEntry Entry() => new()
    {
        Id = 70001, CustomerId = 17, VoucherId = Guid.Parse("11111111-2222-4333-8444-555555555555"), VoucherNo = 71,
        VoucherType = "IncomingOcrGiro", InvoiceNo = "10001", PostingDate = new(2026, 10, 1), VoucherDate = new(2026, 10, 1),
        Amount = -1250.12345678m, Balance = -250.12345678m, CurrencyAmount = -100.01234567m, CurrencyCode = "EUR", MatchId = 42,
        CreatedDateTimeOffset = Changed.AddDays(-1), LastChangedDateTimeOffset = Changed,
    };

    [Theory]
    [InlineData("IncomingOcrGiro", CustomerLedgerKind.Payment)]
    [InlineData("IncomingBankRemittance", CustomerLedgerKind.Payment)]
    [InlineData("BankJournal", CustomerLedgerKind.Payment)]
    [InlineData("OutgoingInvoice", CustomerLedgerKind.Invoice)]
    [InlineData("OutgoingCreditNote", CustomerLedgerKind.CreditNote)]
    [InlineData("ReversalVoucher", CustomerLedgerKind.Reversal)]
    [InlineData("ManualJournal", CustomerLedgerKind.Other)]
    [InlineData("FutureUnknownType", CustomerLedgerKind.Other)]
    [InlineData(null, CustomerLedgerKind.Other)]
    public void Kind_is_proven_by_source_type_not_sign_or_balance(string? type, CustomerLedgerKind expected) =>
        PowerOfficeLedgerMapping.Map(Entry() with { VoucherType = type }).Kind.ShouldBe(expected);

    [Fact]
    public void Write_off_flag_takes_priority_over_bank_voucher_type() =>
        PowerOfficeLedgerMapping.Map(Entry() with { VoucherType = "BankJournal", IsWriteOff = true }).Kind.ShouldBe(CustomerLedgerKind.WriteOff);

    [Theory]
    [InlineData("id")]
    [InlineData("voucher")]
    [InlineData("number")]
    [InlineData("posting")]
    [InlineData("amount")]
    [InlineData("balance")]
    [InlineData("currencyAmount")]
    [InlineData("changed")]
    [InlineData("created")]
    [InlineData("customer")]
    [InlineData("match")]
    public void Missing_or_invalid_required_values_fail_without_fabricated_defaults(string field)
    {
        var invalid = field switch
        {
            "id" => Entry() with { Id = 0 }, "voucher" => Entry() with { VoucherId = Guid.Empty },
            "number" => Entry() with { VoucherNo = null }, "posting" => Entry() with { PostingDate = null },
            "amount" => Entry() with { Amount = null }, "balance" => Entry() with { Balance = null },
            "currencyAmount" => Entry() with { CurrencyAmount = null }, "changed" => Entry() with { LastChangedDateTimeOffset = null },
            "created" => Entry() with { CreatedDateTimeOffset = null }, "customer" => Entry() with { CustomerId = -1 },
            _ => Entry() with { MatchId = 0 },
        };
        Should.Throw<InvalidOperationException>(() => PowerOfficeLedgerMapping.Map(invalid));
    }

    [Fact]
    public void Snapshot_preserves_signed_precision_currency_dates_and_extra_source_fields()
    {
        var source = PowerOfficeLedgerMapping.Map(Entry() with { AdditionalFields = new() { ["Cid"] = JsonSerializer.SerializeToElement("SYNTHETIC-CID") } });
        var row = CustomerLedgerEntry.From("poweroffice", source, Guid.NewGuid(), Changed);
        row.Source.Amount.ShouldBe(-1250.12345678m);
        row.Source.CurrencyAmount.ShouldBe(-100.01234567m);
        row.Source.CurrencyCode.ShouldBe("EUR");
        row.Source.PostingDate.ShouldBe(new DateOnly(2026, 10, 1));
        JsonDocument.Parse(row.Source.SourceJson).RootElement.GetProperty("Cid").GetString().ShouldBe("SYNTHETIC-CID");
        row.Versions.Count.ShouldBe(1);
    }

    [Fact]
    public void Replaying_unchanged_source_keeps_one_version_and_updates_scan_presence()
    {
        var source = PowerOfficeLedgerMapping.Map(Entry());
        var row = CustomerLedgerEntry.From("poweroffice", source, Guid.NewGuid(), Changed);
        var next = Guid.NewGuid();
        row.Apply(source, next, Changed.AddMinutes(1)).ShouldBeFalse();
        row.LastSeenScanId.ShouldBe(next);
        row.Versions.Count.ShouldBe(1);
    }

    [Fact]
    public void Unmatching_is_a_new_source_version_and_keeps_the_previous_evidence()
    {
        var source = PowerOfficeLedgerMapping.Map(Entry());
        var row = CustomerLedgerEntry.From("poweroffice", source, Guid.NewGuid(), Changed);
        var unmatch = PowerOfficeLedgerMapping.Map(Entry() with { MatchId = null, Balance = Entry().Amount, LastChangedDateTimeOffset = Changed.AddMinutes(1) });
        row.Apply(unmatch, Guid.NewGuid(), Changed.AddMinutes(2)).ShouldBeTrue();
        row.MatchId.ShouldBeNull();
        row.Source.Balance.ShouldBe(Entry().Amount!.Value);
        row.Versions.Count.ShouldBe(2);
        row.Versions[0].SnapshotJson.ShouldContain("\"matchId\":42");
    }

    [Fact]
    public void A_missing_source_customer_can_be_filled_for_the_same_posted_operation()
    {
        var row = CustomerLedgerEntry.From("poweroffice", PowerOfficeLedgerMapping.Map(Entry() with { CustomerId = null }), Guid.NewGuid(), Changed);
        var id = row.Id;
        row.Apply(PowerOfficeLedgerMapping.Map(Entry()), Guid.NewGuid(), Changed.AddMinutes(1)).ShouldBeTrue();
        row.Id.ShouldBe(id);
        row.CustomerKey.ShouldBe("17");
        row.Versions.Count.ShouldBe(2);
    }

    [Theory]
    [InlineData("customer")]
    [InlineData("voucher")]
    [InlineData("amount")]
    [InlineData("old")]
    [InlineData("sameTimeConflict")]
    public void Posted_identity_and_source_version_cannot_be_rewritten(string change)
    {
        var row = CustomerLedgerEntry.From("poweroffice", PowerOfficeLedgerMapping.Map(Entry()), Guid.NewGuid(), Changed);
        var invalid = change switch
        {
            "customer" => Entry() with { CustomerId = 18 }, "voucher" => Entry() with { VoucherId = Guid.NewGuid() },
            "amount" => Entry() with { Amount = -1m }, "old" => Entry() with { LastChangedDateTimeOffset = Changed.AddMinutes(-1) },
            _ => Entry() with { MatchId = null },
        };
        Should.Throw<InvalidOperationException>(() => row.Apply(PowerOfficeLedgerMapping.Map(invalid), Guid.NewGuid(), Changed.AddDays(1)));
        row.Versions.Count.ShouldBe(1);
        row.MatchId.ShouldBe(42);
    }
}
