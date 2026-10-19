namespace Crm.Billing.Contracts;

public sealed record InvoiceDocumentSource(Guid InvoiceId, Guid VoucherId, InvoiceDocumentKind Kind);
public sealed record ExternalInvoicePdf(string SourceName, byte[] Content);
public sealed record InvoiceDocumentImportResult(int Created, int Unchanged);
