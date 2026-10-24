namespace Crm.Billing.Contracts;

public enum CustomerLedgerKind { Invoice, CreditNote, Payment, WriteOff, Reversal, Other }

/// <summary>One posted source entry. Amount/Balance are in client currency; CurrencyAmount uses CurrencyCode.</summary>
public sealed record ExternalCustomerLedgerEntry(
    long ExternalId, string? ExternalCustomerId, Guid VoucherId, long VoucherNo, string? VoucherType,
    string? InvoiceNo, DateOnly PostingDate, DateOnly VoucherDate, DateOnly? DueDate,
    decimal Amount, decimal Balance, decimal CurrencyAmount, string? CurrencyCode, long? MatchId,
    bool? IsWriteOff, DateTimeOffset CreatedAt, DateTimeOffset LastChangedAt, CustomerLedgerKind Kind, string SourceJson);

public sealed record CustomerLedgerBatch(string System, string? ExternalCustomerId, Guid? OrganizationId,
    Guid ScanId, DateTimeOffset ReadStartedAt, IReadOnlyList<ExternalCustomerLedgerEntry> Entries);

public sealed record CustomerLedgerImportResult(int Created, int Updated, int Unchanged);
