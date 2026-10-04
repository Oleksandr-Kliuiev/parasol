using Crm.SharedKernel.Domain;

namespace Crm.Billing.Domain;

/// <summary>
/// A one-time item that is waiting for the next billing run — today only from an accepted quote (BR-SAL-07). It is
/// collected into every run until the basis carrying it is actually exported, so a cancelled or re-collected run never
/// loses it and an exported one never bills it twice.
/// </summary>
public sealed class PendingCharge : AuditableEntity
{
    /// <summary>Finance adds to an exported line: <see cref="SourceId"/> is that line, <see cref="SourceLineId"/> the correction (ADR-013).</summary>
    public const string CorrectionSource = "correction";

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

    /// <summary>Why Finance added a correction; kept with the charge it becomes.</summary>
    public string? Reason { get; private set; }

    /// <summary>
    /// When the source event that last decided this charge happened (a project phase completed or reopened). An event that
    /// is older — delivered late after a retry, or replayed by a person — is stale and changes nothing (DEV-07).
    /// </summary>
    public DateTimeOffset? SourceChangedAt { get; private set; }

    /// <summary>Whether an event that happened at <paramref name="occurredAt"/> is older than what last decided the charge.</summary>
    public bool DecidedSince(DateTimeOffset occurredAt) => SourceChangedAt is { } changed && changed >= occurredAt;

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
        DateOnly chargeableFrom,
        DateTimeOffset? sourceChangedAt = null) => new()
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
        SourceChangedAt = sourceChangedAt,
    };

    /// <summary>
    /// A correction of something already exported: a new one-time charge that refers to the line it adds to, billed by the
    /// next run (BR-BIL-10). Only positive amounts: crediting belongs to the accounting system until Finance decides otherwise.
    /// </summary>
    public static PendingCharge Correction(
        Guid organizationId, Guid? productId, string description, decimal amount, decimal vatRate, Guid correctedLineId, Guid correctionId,
        string reason, DateOnly chargeableFrom)
    {
        var charge = Create(organizationId, productId, description, 1m, amount, 0m, vatRate, CorrectionSource, correctedLineId, correctionId, chargeableFrom);
        charge.Reason = reason.Length > 512 ? reason[..512] : reason;
        return charge;
    }

    /// <summary>
    /// The source billable again after it was withdrawn (a project phase completed again): the same item comes back, so its
    /// charge key stays the same and the register still knows what was billed with it (ADR-013).
    /// </summary>
    public void Requeue(Guid? productId, string description, decimal unitPrice, DateOnly chargeableFrom, DateTimeOffset sourceChangedAt)
    {
        Restore();
        ProductId = productId;
        Description = description;
        UnitPrice = decimal.Round(unitPrice, 2);
        ChargeableFrom = chargeableFrom;
        SourceChangedAt = sourceChangedAt;
    }

    /// <summary>The source is no longer billable (a project phase reopened) while nothing was exported with the charge.</summary>
    public void Withdraw(DateTimeOffset sourceChangedAt)
    {
        MarkDeleted();
        SourceChangedAt = sourceChangedAt;
    }

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
