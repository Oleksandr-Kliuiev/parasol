using System.Text.Json;
using Crm.Catalog.Contracts;
using Crm.SharedKernel.Domain;
using Crm.SharedKernel.Results;

namespace Crm.Catalog.Domain;

public sealed record BundleComponent(Guid ProductId, decimal Quantity);

public sealed record ProductDetails(
    string Sku,
    string Name,
    string? NameEn,
    string? Description,
    ProductType Type,
    BusinessLine BusinessLine,
    ProductUnit Unit,
    BillingPeriod BillingPeriod,
    decimal VatRate,
    decimal ListPrice,
    decimal? UnitCost,
    string Currency,
    string? MicrosoftOfferId,
    CommitmentTerm CommitmentTerm,
    string? AteraWorkType,
    string? RevenueAccount,
    IReadOnlyList<BundleComponent>? Components);

public sealed class Product : AuditableEntity
{
    /// <summary>Norwegian VAT rates (MVA): general, food, transport/culture, exempt.</summary>
    public static readonly IReadOnlyList<decimal> VatRates = [25m, 15m, 12m, 0m];

    private static readonly JsonSerializerOptions ComponentJson = new(JsonSerializerDefaults.Web);

    private Product() { }

    public string Sku { get; private set; } = string.Empty;
    public string Name { get; private set; } = string.Empty;
    public string? NameEn { get; private set; }
    public string? Description { get; private set; }
    public ProductType Type { get; private set; }
    public BusinessLine BusinessLine { get; private set; }
    public ProductUnit Unit { get; private set; }
    public BillingPeriod BillingPeriod { get; private set; }
    public decimal VatRate { get; private set; }
    public decimal ListPrice { get; private set; }
    public decimal? UnitCost { get; private set; }
    public string Currency { get; private set; } = "NOK";
    public string? MicrosoftOfferId { get; private set; }
    public CommitmentTerm CommitmentTerm { get; private set; }
    public string? AteraWorkType { get; private set; }
    public string? RevenueAccount { get; private set; }
    public bool IsActive { get; private set; } = true;

    /// <summary>Bundle contents as JSON, so a change shows up as one readable value in the audit log.</summary>
    public string? ComponentsJson { get; private set; }

    public IReadOnlyList<BundleComponent> Components =>
        ComponentsJson is null ? [] : JsonSerializer.Deserialize<List<BundleComponent>>(ComponentsJson, ComponentJson) ?? [];

    public static Result<Product> Create(ProductDetails details)
    {
        var product = new Product();
        var applied = product.Apply(details);
        if (!applied.IsSuccess)
        {
            return applied.Error!;
        }

        product.Raise(new ProductCreated(product.Id, product.Sku));
        return product;
    }

    public Result Update(ProductDetails details)
    {
        var applied = Apply(details);
        if (applied.IsSuccess)
        {
            Raise(new ProductUpdated(Id));
        }

        return applied;
    }

    public void Deactivate()
    {
        if (IsActive)
        {
            IsActive = false;
            Raise(new ProductUpdated(Id));
        }
    }

    public void Activate()
    {
        if (!IsActive)
        {
            IsActive = true;
            Raise(new ProductUpdated(Id));
        }
    }

    public static string NormalizeSku(string sku) => sku.Trim().ToUpperInvariant();

    private Result Apply(ProductDetails d)
    {
        if (!VatRates.Contains(d.VatRate))
        {
            return Error.Validation("CAT_INVALID_VAT_RATE", $"VAT rate must be one of {string.Join(", ", VatRates)} %.");
        }

        var components = d.Type == ProductType.Bundle ? d.Components ?? [] : [];
        if (d.Type == ProductType.Bundle && components.Count == 0)
        {
            return Error.Validation("CAT_BUNDLE_EMPTY", "A bundle must contain at least one product.");
        }

        if (components.Any(c => c.ProductId == Id))
        {
            return Error.Validation("CAT_BUNDLE_SELF", "A bundle cannot contain itself.");
        }

        Sku = NormalizeSku(d.Sku);
        Name = d.Name.Trim();
        NameEn = Clean(d.NameEn);
        Description = Clean(d.Description);
        Type = d.Type;
        BusinessLine = d.BusinessLine;
        Unit = d.Unit;
        BillingPeriod = d.BillingPeriod;
        VatRate = d.VatRate;
        ListPrice = decimal.Round(d.ListPrice, 2);
        UnitCost = d.UnitCost is { } cost ? decimal.Round(cost, 2) : null;
        Currency = d.Currency.Trim().ToUpperInvariant();
        MicrosoftOfferId = d.Type == ProductType.MicrosoftLicense ? Clean(d.MicrosoftOfferId) : null;
        CommitmentTerm = d.Type == ProductType.MicrosoftLicense ? d.CommitmentTerm : CommitmentTerm.None;
        AteraWorkType = Clean(d.AteraWorkType);
        RevenueAccount = Clean(d.RevenueAccount);
        ComponentsJson = components.Count == 0
            ? null
            : JsonSerializer.Serialize(components.GroupBy(c => c.ProductId).Select(g => new BundleComponent(g.Key, g.Sum(c => c.Quantity))).ToList(), ComponentJson);
        return Result.Success();
    }

    private static string? Clean(string? value) => string.IsNullOrWhiteSpace(value) ? null : value.Trim();
}

/// <summary>Customer category: selects the price list (BR-CAT-01) and the Microsoft licence markup (BR-CAT-02).</summary>
public sealed class CustomerCategory : AuditableEntity
{
    private CustomerCategory() { }

    public CustomerCategory(Guid id, string code, string name, decimal licenseMarkupPct, bool isDefault) : base(id)
    {
        Code = code;
        Name = name;
        LicenseMarkupPct = licenseMarkupPct;
        IsDefault = isDefault;
    }

    public string Code { get; private set; } = string.Empty;
    public string Name { get; private set; } = string.Empty;
    public decimal LicenseMarkupPct { get; private set; }
    public bool IsDefault { get; private set; }

    public static CustomerCategory Create(string code, string name, decimal licenseMarkupPct) =>
        new(SequentialId.New(), NormalizeCode(code), name.Trim(), licenseMarkupPct, isDefault: false);

    public void Update(string name, decimal licenseMarkupPct)
    {
        Name = name.Trim();
        LicenseMarkupPct = licenseMarkupPct;
    }

    public void SetDefault(bool isDefault) => IsDefault = isDefault;

    public static string NormalizeCode(string code) => code.Trim().ToUpperInvariant();
}
