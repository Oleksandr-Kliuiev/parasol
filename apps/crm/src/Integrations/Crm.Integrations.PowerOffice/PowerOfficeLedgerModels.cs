using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;
using Crm.Billing.Contracts;

namespace Crm.Integrations.PowerOffice;

/// <summary>CustomerLedgerEntryDto from the official v2 Customerledger/Statement contract.</summary>
public sealed record PoCustomerLedgerEntry
{
    public long Id { get; init; }
    public long? CustomerId { get; init; }
    public Guid VoucherId { get; init; }
    public long? VoucherNo { get; init; }
    public string? VoucherType { get; init; }
    public string? InvoiceNo { get; init; }
    public DateOnly? PostingDate { get; init; }
    public DateOnly? VoucherDate { get; init; }
    public DateOnly? DueDate { get; init; }
    public decimal? Amount { get; init; }
    public decimal? Balance { get; init; }
    public decimal? CurrencyAmount { get; init; }
    public string? CurrencyCode { get; init; }
    public long? MatchId { get; init; }
    public bool? IsWriteOff { get; init; }
    public DateTimeOffset? CreatedDateTimeOffset { get; init; }
    public DateTimeOffset? LastChangedDateTimeOffset { get; init; }
    [JsonExtensionData] public Dictionary<string, JsonElement>? AdditionalFields { get; init; }
}

internal static class PowerOfficeLedgerMapping
{
    public static ExternalCustomerLedgerEntry Map(PoCustomerLedgerEntry source)
    {
        if (source.Id <= 0 || source.VoucherId == Guid.Empty || source.VoucherNo is not > 0 || source.CustomerId is <= 0 ||
            source.PostingDate is null || source.VoucherDate is null || source.Amount is null || source.Balance is null ||
            source.CurrencyAmount is null || source.CreatedDateTimeOffset is null || source.LastChangedDateTimeOffset is null ||
            source.MatchId is <= 0 || source.VoucherType?.Length > 64 || source.InvoiceNo?.Length > 64 ||
            source.CurrencyCode is { } currency && (currency.Length != 3 || currency.Any(c => !char.IsAsciiLetter(c))))
            throw new InvalidOperationException("PowerOffice customer ledger entry is incomplete or invalid.");
        // A signed amount or a reduced balance does not prove a payment. Source write-off has priority over voucher type.
        var kind = source.IsWriteOff == true ? CustomerLedgerKind.WriteOff : source.VoucherType switch
        {
            "OutgoingInvoice" => CustomerLedgerKind.Invoice,
            "OutgoingCreditNote" => CustomerLedgerKind.CreditNote,
            "IncomingOcrGiro" or "IncomingBankRemittance" or "BankJournal" => CustomerLedgerKind.Payment,
            "ReversalVoucher" => CustomerLedgerKind.Reversal,
            _ => CustomerLedgerKind.Other,
        };
        return new ExternalCustomerLedgerEntry(source.Id, source.CustomerId?.ToString(CultureInfo.InvariantCulture), source.VoucherId,
            source.VoucherNo.Value, source.VoucherType, source.InvoiceNo, source.PostingDate.Value, source.VoucherDate.Value,
            source.DueDate, source.Amount.Value, source.Balance.Value, source.CurrencyAmount.Value, source.CurrencyCode,
            source.MatchId, source.IsWriteOff, source.CreatedDateTimeOffset.Value, source.LastChangedDateTimeOffset.Value, kind,
            JsonSerializer.Serialize(source, PoJson.Options));
    }
}
