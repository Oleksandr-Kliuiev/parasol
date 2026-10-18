using System.Text.Json;
using System.Text.Json.Serialization;

namespace Crm.Integrations.PowerOffice;

/// <summary>PowerOffice v2 OutgoingInvoiceDto: the source identity is a UUID; dates and balances use the reporting contract.</summary>
public sealed record PoOutgoingInvoice
{
    public Guid Id { get; init; }
    public long? InvoiceNo { get; init; }
    public long? OrderNo { get; init; }
    public long? CustomerId { get; init; }
    public string? ExternalImportReference { get; init; }
    public DateOnly? VoucherDate { get; init; }
    public DateOnly? DueDate { get; init; }
    public decimal? NetAmount { get; init; }
    public decimal? TotalAmount { get; init; }
    public decimal? NetPostedAmount { get; init; }
    public decimal? TotalPostedAmount { get; init; }
    public decimal? Balance { get; init; }
    public string? CurrencyCode { get; init; }
    public string? VoucherType { get; init; }
    public bool? IsReversed { get; init; }
    public long? RelatedInvoiceNo { get; init; }
    public DateTimeOffset? LastChangedDateTimeOffset { get; init; }
    public DateTimeOffset? BalanceLastChangedDateTimeOffset { get; init; }
    [JsonExtensionData] public Dictionary<string, JsonElement>? AdditionalFields { get; init; }
}

public sealed record PoOutgoingInvoiceLine
{
    public long Id { get; init; }
    public int SortOrder { get; init; }
    public string? LineType { get; init; }
    public string? Description { get; init; }
    public long? ProductId { get; init; }
    public string? ProductCode { get; init; }
    public string? UnitOfMeasureCode { get; init; }
    public decimal? Quantity { get; init; }
    public decimal? ProductUnitPrice { get; init; }
    public decimal? Allowance { get; init; }
    public decimal? VatRate { get; init; }
    public decimal? NetAmount { get; init; }
    public decimal? VatAmount { get; init; }
    public decimal? TotalAmount { get; init; }
    public decimal? NetPostedAmount { get; init; }
    public decimal? TotalPostedAmount { get; init; }
    [JsonExtensionData] public Dictionary<string, JsonElement>? AdditionalFields { get; init; }
}
