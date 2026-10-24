namespace Crm.Billing.Contracts;

public enum InvoiceDocumentKind { Invoice, CreditNote }

/// <summary>Retrieval is not proof that PowerOffice supplied every original sales line.</summary>
public enum InvoiceLineCoverage { EmptyUnverified, RetrievedUnverified, Reconciled }

public sealed record ExternalInvoiceLine(
    long Id, int SortOrder, string LineType, string? Description, long? ProductId, string? ProductCode,
    string? UnitCode, decimal? Quantity, decimal? UnitPrice, decimal? Allowance, decimal? VatRate,
    decimal? NetAmount, decimal? VatAmount, decimal? TotalAmount, decimal? NetPostedAmount,
    decimal? TotalPostedAmount, string SourceJson);

/// <summary>Original document currency and signed source amounts, separate from the client-currency balance projection.</summary>
public sealed record ExternalInvoiceHistory(
    Guid ExternalId, string? ExternalCustomerId, InvoiceDocumentKind Kind, string CurrencyCode,
    decimal NetAmount, decimal TotalAmount, decimal NetPostedAmount, decimal TotalPostedAmount, decimal Balance,
    string? RelatedInvoiceNo, bool IsReversed, DateTimeOffset LastChangedAt, DateTimeOffset? BalanceChangedAt,
    InvoiceLineCoverage LineCoverage, IReadOnlyList<ExternalInvoiceLine> Lines, string SourceJson);

public sealed record InvoiceCustomerBinding(Guid InvoiceId, string ExternalCustomerId);
