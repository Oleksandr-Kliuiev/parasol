using System.Globalization;
using Crm.Licensing.Contracts;
using Crm.SharedKernel.Domain;

namespace Crm.Licensing.Domain;

/// <summary>
/// Mirror of a Microsoft CSP subscription. Not audited: Partner Center (or the distributor file) is the system of record; the import
/// itself is written to the audit log.
/// </summary>
public sealed class CspSubscription : Entity
{
    private CspSubscription() { }

    public SubscriptionSource Source { get; private set; }
    public string CspCustomerId { get; private set; } = string.Empty;
    public string? CspCustomerName { get; private set; }
    public string? TenantId { get; private set; }
    public string SubscriptionId { get; private set; } = string.Empty;
    public string OfferId { get; private set; } = string.Empty;
    public string? OfferName { get; private set; }
    public string? Sku { get; private set; }
    public int Quantity { get; private set; }
    public SubscriptionStatus Status { get; private set; }
    public SubscriptionTerm Term { get; private set; }
    public SubscriptionBillingCycle BillingCycle { get; private set; }
    public DateOnly? StartDate { get; private set; }
    public DateOnly? CommitmentEndDate { get; private set; }
    public DateOnly? RenewalDate { get; private set; }
    public bool AutoRenew { get; private set; }
    public DateTimeOffset? PurchasedAt { get; private set; }

    /// <summary>When the quantity last went up; the cancellation window restarts then (docs/05 §2.5).</summary>
    public DateTimeOffset? QuantityIncreasedAt { get; private set; }

    /// <summary>End of the 7-day NCE cancellation window (BR-LIC-02); null when it has passed or is unknown.</summary>
    public DateTimeOffset? CancellationWindowEndsAt { get; private set; }

    public decimal? PartnerUnitPrice { get; private set; }
    public Guid? OrganizationId { get; private set; }

    /// <summary>Catalog product matched by Microsoft offer id; without it the subscription cannot be billed.</summary>
    public Guid? ProductId { get; private set; }

    public DateTimeOffset SyncedAt { get; private set; }

    public static CspSubscription From(ExternalSubscription source, TimeSpan cancellationWindow, DateTimeOffset now)
    {
        var subscription = new CspSubscription { Source = source.Source, SubscriptionId = source.SubscriptionId };
        subscription.Apply(source, now);
        // The window runs from the purchase, or the start date when the source does not report one; only when neither is known do we
        // assume the subscription is new and warn for the full seven days.
        var purchased = source.PurchasedAt
                        ?? (source.StartDate is { } start ? new DateTimeOffset(start.ToDateTime(TimeOnly.MinValue), TimeSpan.Zero) : now);
        subscription.CancellationWindowEndsAt = purchased + cancellationWindow;
        return subscription;
    }

    /// <summary>Returns true when something changed.</summary>
    public bool Apply(ExternalSubscription s, DateTimeOffset now, TimeSpan? cancellationWindow = null)
    {
        var before = Signature();
        var previousQuantity = Quantity;
        Source = s.Source;
        CspCustomerId = s.CspCustomerId;
        CspCustomerName = s.CspCustomerName;
        TenantId = s.TenantId;
        OfferId = s.OfferId;
        OfferName = s.OfferName;
        Sku = s.Sku;
        Quantity = s.Quantity;
        Status = s.Status;
        Term = s.Term;
        BillingCycle = s.BillingCycle;
        StartDate = s.StartDate;
        CommitmentEndDate = s.CommitmentEndDate;
        RenewalDate = s.RenewalDate;
        AutoRenew = s.AutoRenew;
        PurchasedAt = s.PurchasedAt ?? PurchasedAt;
        PartnerUnitPrice = s.PartnerUnitPrice ?? PartnerUnitPrice;

        if (cancellationWindow is { } window && Quantity > previousQuantity && previousQuantity > 0)
        {
            // Buying more licences opens a new window for the added ones.
            QuantityIncreasedAt = now;
            CancellationWindowEndsAt = now + window;
        }

        var changed = before != Signature();
        if (changed)
        {
            SyncedAt = now;
        }

        return changed;
    }

    public void LinkOrganization(Guid? organizationId) => OrganizationId = organizationId;

    public void LinkProduct(Guid? productId) => ProductId = productId;

    public bool IsCancellationWindowOpen(DateTimeOffset now) => IsCancellationWindowOpen(CancellationWindowEndsAt, now);

    public bool IsRenewingWithin(DateOnly today, int days) => IsRenewingWithin(RenewalDate, CommitmentEndDate, today, days);

    /// <summary>The same rule for a row read without its entity (a summary over every subscription, DEV-12).</summary>
    public static bool IsCancellationWindowOpen(DateTimeOffset? windowEndsAt, DateTimeOffset now) => windowEndsAt is { } ends && ends > now;

    /// <summary>Renewal, or the end of the commitment when no renewal date is known, within <paramref name="days"/> from today.</summary>
    public static bool IsRenewingWithin(DateOnly? renewalDate, DateOnly? commitmentEndDate, DateOnly today, int days) =>
        (renewalDate ?? commitmentEndDate) is { } date && date >= today && date.DayNumber - today.DayNumber <= days;

    // Values are formatted invariantly, and decimals without trailing zeros: the database returns them at column scale
    // (225.5000 for 225.50), which would otherwise look like a change on every sync.
    private string Signature() => string.Join('|', CspCustomerId, CspCustomerName, TenantId, OfferId, OfferName, Sku, Quantity, Status, Term, BillingCycle,
        Format(StartDate), Format(CommitmentEndDate), Format(RenewalDate), AutoRenew, Format(PartnerUnitPrice));

    private static string Format(DateOnly? value) => value?.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) ?? string.Empty;

    private static string Format(decimal? value) => value?.ToString("0.####", CultureInfo.InvariantCulture) ?? string.Empty;
}
