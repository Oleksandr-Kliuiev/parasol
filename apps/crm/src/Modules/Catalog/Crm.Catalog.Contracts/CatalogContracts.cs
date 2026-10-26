using Crm.SharedKernel.Domain;

namespace Crm.Catalog.Contracts;

/// <summary>Product types (docs/02-functional-spec.md §4.4).</summary>
public enum ProductType
{
    MicrosoftLicense,
    ManagedService,
    HourlyService,
    HourBank,
    PowerOfficeService,
    Hardware,
    Bundle,
}

/// <summary>Business line the revenue belongs to.</summary>
public enum BusinessLine
{
    Microsoft,
    Atera,
    PowerOffice,
    Consulting,
    Hardware,
    Other,
}

public enum ProductUnit
{
    Piece,
    User,
    Device,
    License,
    Hour,
    Month,
    Package,
}

public enum BillingPeriod
{
    OneTime,
    Monthly,
    Quarterly,
    Yearly,
}

/// <summary>Microsoft NCE commitment term.</summary>
public enum CommitmentTerm
{
    None,
    P1M,
    P1Y,
    P3Y,
}

public sealed record ProductRef(
    Guid Id,
    string Sku,
    string Name,
    ProductType Type,
    ProductUnit Unit,
    BillingPeriod BillingPeriod,
    decimal VatRate,
    bool IsActive);

/// <summary>Sales price for a product on a date: the active price list of the category, otherwise the product's list price.</summary>
public sealed record ResolvedPrice(Guid ProductId, decimal UnitPrice, decimal? UnitCost, string Currency, Guid? PriceListId, string? PriceListName);

/// <summary>Product data from an external system (PowerOffice products) for the first-load import.</summary>
public sealed record ExternalProductData(string? Code, string Name, string? Description, string? UnitCode, decimal? UnitPrice, decimal? UnitCost)
{
    /// <summary>Stable local external-record key for resuming creation before its integration link is committed.</summary>
    public Guid? SourceRecordId { get; init; }

    /// <summary>Calculate the same import decision without saving entities, affiliations or events.</summary>
    public bool PreviewOnly { get; init; }
}

public sealed record ImportProductResult(Guid ProductId, bool Created);

/// <summary>Public API of the Catalog module for other modules and integrations.</summary>
public interface ICatalogApi
{
    Task<IReadOnlyDictionary<Guid, ProductRef>> GetProductsAsync(IReadOnlyCollection<Guid> productIds, CancellationToken cancellationToken);

    /// <summary>Default customer category code, used when a contract does not name one.</summary>
    Task<string> GetDefaultCategoryAsync(CancellationToken cancellationToken);

    /// <summary>Prices per BR-CAT-01. Products that are unknown are left out.</summary>
    Task<IReadOnlyDictionary<Guid, ResolvedPrice>> ResolvePricesAsync(
        IReadOnlyCollection<Guid> productIds, string? customerCategory, DateOnly date, CancellationToken cancellationToken);

    /// <summary>
    /// The hourly service billed for a work type: an active HourlyService product whose Atera work type matches, otherwise the
    /// product with <paramref name="fallbackSku"/>. Null when neither exists.
    /// </summary>
    Task<ProductRef?> FindHourlyProductAsync(string? workType, string? fallbackSku, CancellationToken cancellationToken);

    /// <summary>Products by Microsoft offer id (case-insensitive), so CSP subscriptions find their catalog product.</summary>
    Task<IReadOnlyDictionary<string, ProductRef>> FindProductsByOfferIdAsync(IReadOnlyCollection<string> offerIds, CancellationToken cancellationToken);

    /// <summary>Work types known from hourly products, for suggestions when time is entered manually.</summary>
    Task<IReadOnlyList<string>> GetWorkTypesAsync(CancellationToken cancellationToken);

    /// <summary>Product ids by SKU (case-insensitive), for automatic linking of external products.</summary>
    Task<IReadOnlyDictionary<string, Guid>> FindProductsBySkuAsync(IReadOnlyCollection<string> skus, CancellationToken cancellationToken);

    /// <summary>Creates a product from external data, or returns the existing one with the same SKU.</summary>
    Task<ImportProductResult> ImportProductAsync(ExternalProductData data, CancellationToken cancellationToken);
}

/// <summary>
/// Implemented by modules that reference products (contracts, quotes, billing). A product that any of them uses can only be
/// deactivated, not deleted (BR-CAT-03).
/// </summary>
public interface IProductUsage
{
    Task<bool> IsUsedAsync(Guid productId, CancellationToken cancellationToken);
}

public sealed record ProductCreated(Guid ProductId, string Sku) : DomainEvent;

public sealed record ProductUpdated(Guid ProductId) : DomainEvent;

public sealed record PriceListActivated(Guid PriceListId, string CustomerCategory, DateOnly ValidFrom, DateOnly? ValidTo) : DomainEvent;
