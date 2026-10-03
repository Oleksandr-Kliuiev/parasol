using Crm.SharedKernel.Domain;

namespace Crm.Billing.Domain;

/// <summary>
/// A one-time item that is waiting for the next billing run — today only from an accepted quote (BR-SAL-07). It is
/// collected into every run until the basis carrying it is actually exported, so a cancelled or re-collected run never
/// loses it and an exported one never bills it twice.
/// </summary>
public sealed class PendingCharge : AuditableEntity
{
    private PendingCharge() { }

    public Guid OrganizationId { get; private set; }
    public Guid? ProductId { get; private set; }
    public string Description { get; private set; } = string.Empty;
    public decimal Quantity { get; private set; }
    public decimal UnitPrice { get; private set; }
    public decimal DiscountPct { get; private set; }
    public decimal VatRate { get; private set; }

    /// <summary>Where the charge came from, e.g. <c>quote</c>, and the id in that system; together they are unique.</summary>
    public string SourceType { get; private set; } = string.Empty;

    public Guid SourceId { get; private set; }
    public Guid SourceLineId { get; private set; }
    public DateOnly ChargeableFrom { get; private set; }
    public Guid? InvoicedBasisId { get; private set; }
    public DateTimeOffset? InvoicedAt { get; private set; }

    public static PendingCharge Create(
        Guid organizationId,
        Guid? productId,
        string description,
        decimal quantity,
        decimal unitPrice,
        decimal discountPct,
        decimal vatRate,
        string sourceType,
        Guid sourceId,
        Guid sourceLineId,
        DateOnly chargeableFrom) => new()
    {
        OrganizationId = organizationId,
        ProductId = productId,
        Description = description,
        Quantity = decimal.Round(quantity, 2),
        UnitPrice = decimal.Round(unitPrice, 2),
        DiscountPct = decimal.Round(discountPct, 2),
        VatRate = vatRate,
        SourceType = sourceType,
        SourceId = sourceId,
        SourceLineId = sourceLineId,
        ChargeableFrom = chargeableFrom,
    };

    /// <summary>Called when the basis that carried the charge left for the accounting system. Idempotent.</summary>
    public void MarkInvoiced(Guid basisId, DateTimeOffset at)
    {
        if (InvoicedBasisId is not null)
        {
            return;
        }

        InvoicedBasisId = basisId;
        InvoicedAt = at;
    }
}
