namespace Crm.Licensing.Contracts;

/// <summary>Where a subscription came from (BR-LIC-05).</summary>
public enum SubscriptionSource
{
    PartnerCenter,
    Distributor,
    Manual,
}

public enum SubscriptionStatus
{
    Active,
    Suspended,
    Deleted,
    Pending,
}

/// <summary>NCE commitment term.</summary>
public enum SubscriptionTerm
{
    Unknown,
    P1M,
    P1Y,
    P3Y,
}

public enum SubscriptionBillingCycle
{
    Unknown,
    Monthly,
    Annual,
}

/// <summary>A CSP subscription as an external source reports it.</summary>
public sealed record ExternalSubscription(
    SubscriptionSource Source,
    string CspCustomerId,
    string? CspCustomerName,
    string? TenantId,
    string? OrganizationNumber,
    string SubscriptionId,
    string OfferId,
    string? OfferName,
    string? Sku,
    int Quantity,
    SubscriptionStatus Status,
    SubscriptionTerm Term,
    SubscriptionBillingCycle BillingCycle,
    DateOnly? StartDate,
    DateOnly? CommitmentEndDate,
    DateOnly? RenewalDate,
    bool AutoRenew,
    DateTimeOffset? PurchasedAt,
    decimal? PartnerUnitPrice,
    /// <summary>Set when the caller already knows the CRM organization (e.g. from the mapping of CSP customers).</summary>
    Guid? OrganizationId = null);

public sealed record SubscriptionImportResult(int Created, int Updated, int Unchanged, int WithoutOrganization, IReadOnlyList<string> Warnings);

/// <summary>Licence quantity of one organization and catalog product on a date, with the subscriptions it came from.</summary>
public sealed record SubscriptionQuantity(
    Guid OrganizationId, Guid ProductId, string OfferId, string? OfferName, int Quantity, IReadOnlyList<string> SubscriptionIds);

public enum SubscriptionAttentionKind
{
    /// <summary>The NCE cancellation window is still open (BR-LIC-02).</summary>
    CancellationWindow,

    /// <summary>The subscription renews within the notice period (BR-LIC-02).</summary>
    Renewal,
}

public sealed record SubscriptionAttention(
    Guid SubscriptionId, SubscriptionAttentionKind Kind, Guid? OrganizationId, string OfferName, int Quantity, DateOnly? Date, DateTimeOffset? WindowEndsAt);

/// <summary>Counts for the dashboard (FR-RPT-01).</summary>
public sealed record LicenseSummary(int Subscriptions, int Licenses, int CancellationWindowOpen, int RenewingSoon, int NotBilled, int WithoutOrganization);

/// <summary>Public API of the Licensing module: subscriptions are written by integrations and the distributor import.</summary>
public interface ILicensingApi
{
    /// <summary>Inserts or updates subscriptions of one source and links them to organizations where possible (BR-LIC-01).</summary>
    Task<SubscriptionImportResult> UpsertAsync(IReadOnlyCollection<ExternalSubscription> subscriptions, CancellationToken cancellationToken);

    /// <summary>Active subscriptions on a date grouped by organization and catalog product; unlinked subscriptions are left out (BR-LIC-03).</summary>
    Task<IReadOnlyList<SubscriptionQuantity>> GetSubscriptionQuantitiesAsync(DateOnly date, CancellationToken cancellationToken);

    /// <summary>The same reading restricted in SQL to the customers needed by a billing run (DEV-16); an empty selection reads nothing.</summary>
    Task<IReadOnlyList<SubscriptionQuantity>> GetSubscriptionQuantitiesAsync(IReadOnlyCollection<Guid> organizationIds, DateOnly date, CancellationToken cancellationToken);

    /// <summary>Subscriptions of an organization that are active on a date but have no catalog product, for the billing anomaly list.</summary>
    Task<IReadOnlyList<string>> GetUnmappedOfferNamesAsync(Guid organizationId, DateOnly date, CancellationToken cancellationToken);

    /// <summary>Unmapped offers for the selected customers in one query, grouped once for billing anomaly review.</summary>
    Task<IReadOnlyDictionary<Guid, IReadOnlyList<string>>> GetUnmappedOfferNamesAsync(IReadOnlyCollection<Guid> organizationIds, DateOnly date, CancellationToken cancellationToken);

    /// <summary>Subscriptions that need someone to look at them today: an open cancellation window or a renewal coming up.</summary>
    Task<IReadOnlyList<SubscriptionAttention>> GetAttentionAsync(DateOnly today, CancellationToken cancellationToken);

    Task<LicenseSummary> GetSummaryAsync(DateOnly today, CancellationToken cancellationToken);

    /// <summary>Stores today's "bought / assigned" reading per SKU for an organization (FR-LIC-03). Re-reading the same day replaces it.</summary>
    Task<int> UpsertLicenseUsageAsync(IReadOnlyCollection<LicenseUsageReading> readings, DateOnly date, CancellationToken cancellationToken);

    /// <summary>
    /// Assigned licences per organization and catalog product from the newest snapshot on or before the date, so billing can
    /// count Microsoft 365 users instead of trusting the contract's estimate (BR-CON-02).
    /// </summary>
    Task<IReadOnlyList<AssignedLicenses>> GetAssignedLicensesAsync(DateOnly date, CancellationToken cancellationToken);

    /// <summary>Latest licence readings for only the selected customers, selected on the database before materialization.</summary>
    Task<IReadOnlyList<AssignedLicenses>> GetAssignedLicensesAsync(IReadOnlyCollection<Guid> organizationIds, DateOnly date, CancellationToken cancellationToken);

    /// <summary>
    /// The newest reading of every SKU of the selected customers on or before the date, a fortnight back at most, whether or not a
    /// catalog product sells it (M42: the backup's check of licensed users needs every SKU that gives a mailbox).
    /// </summary>
    Task<IReadOnlyList<LicenseReading>> GetLicenseReadingsAsync(IReadOnlyCollection<Guid> organizationIds, DateOnly date, CancellationToken cancellationToken);

    /// <summary>Microsoft's cost per customer for a period, from the imported billing lines (FR-RPT-02).</summary>
    Task<IReadOnlyList<MsCostByOrganization>> GetMsCostsAsync(DateOnly periodStart, DateOnly periodEnd, CancellationToken cancellationToken);

    /// <summary>Stores what Microsoft charged the partner, linking each line to the organization behind the subscription (FR-LIC-04).</summary>
    Task<MsBillingImportResult> ImportBilledLinesAsync(
        IReadOnlyCollection<ExternalBilledLine> lines, bool dryRun, CancellationToken cancellationToken);
}

/// <summary>What one tenant has bought and assigned of a SKU, as GDAP reports it (FR-LIC-03).</summary>
public sealed record LicenseUsageReading(Guid OrganizationId, string SkuId, string SkuPartNumber, int Purchased, int Assigned);

/// <summary>The newest reading of one SKU of one organization (FR-LIC-03), as <see cref="ILicensingApi.GetLicenseReadingsAsync"/> answers it.</summary>
public sealed record LicenseReading(Guid OrganizationId, string SkuId, string SkuPartNumber, int Purchased, int Assigned, DateOnly SnapshotDate);

/// <summary>Assigned Microsoft 365 licences of one organization and catalog product, for the `PerM365User` quantity model (BR-CON-02).</summary>
public sealed record AssignedLicenses(Guid OrganizationId, Guid ProductId, string SkuPartNumber, int Assigned, int Purchased, DateOnly SnapshotDate);

/// <summary>Where a Microsoft cost line came from (FR-LIC-04).</summary>
public enum MsBillingSource
{
    /// <summary>Partner billing reconciliation export through Microsoft Graph.</summary>
    GraphExport,

    /// <summary>The distributor's invoice file (indirect CSP model).</summary>
    Csv,
}

/// <summary>A line of what Microsoft (or the distributor) charged the partner.</summary>
public sealed record ExternalBilledLine(
    MsBillingSource Source,
    DateOnly PeriodStart,
    DateOnly PeriodEnd,
    string? InvoiceId,
    string CspCustomerId,
    string? CspCustomerName,
    string? SubscriptionId,
    string OfferId,
    string? OfferName,
    decimal Quantity,
    decimal UnitPrice,
    decimal Total,
    string Currency);

/// <summary>What Microsoft charged the partner for one customer in a period (FR-RPT-02).</summary>
public sealed record MsCostByOrganization(Guid OrganizationId, decimal Cost, string Currency, int Lines);

public sealed record MsBillingImportResult(int Created, int Updated, int Unchanged, int WithoutOrganization, IReadOnlyList<string> Warnings);
