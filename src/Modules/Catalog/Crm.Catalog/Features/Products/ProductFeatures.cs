using Crm.Authorization;
using Crm.Catalog.Contracts;
using Crm.Catalog.Domain;
using Crm.Catalog.Persistence;
using Crm.Infrastructure.Persistence;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Results;
using FluentValidation;
using Microsoft.EntityFrameworkCore;

namespace Crm.Catalog.Features.Products;

public sealed record Versioned<T>(T Value, string Etag);

public sealed record BundleComponentDto(Guid ProductId, decimal Quantity, string? Sku = null, string? Name = null);

public sealed record ProductRequest(
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
    string? Currency,
    string? MicrosoftOfferId,
    CommitmentTerm? CommitmentTerm,
    string? AteraWorkType,
    string? RevenueAccount,
    IReadOnlyList<BundleComponentDto>? Components)
{
    internal ProductDetails ToDetails() => new(
        Sku, Name, NameEn, Description, Type, BusinessLine, Unit, BillingPeriod, VatRate, ListPrice, UnitCost,
        string.IsNullOrWhiteSpace(Currency) ? "NOK" : Currency, MicrosoftOfferId, CommitmentTerm ?? Contracts.CommitmentTerm.None,
        AteraWorkType, RevenueAccount, Components?.Select(c => new BundleComponent(c.ProductId, c.Quantity)).ToList());
}

internal sealed class ProductRequestValidator : AbstractValidator<ProductRequest>
{
    public ProductRequestValidator()
    {
        RuleFor(x => x.Sku).NotEmpty().MaximumLength(64).Matches("^[A-Za-z0-9._\\-/]+\\z").WithMessage("SKU may only contain letters, digits and . _ - /");
        RuleFor(x => x.Name).NotEmpty().MaximumLength(256);
        RuleFor(x => x.NameEn).MaximumLength(256);
        RuleFor(x => x.Description).MaximumLength(2000);
        RuleFor(x => x.Type).IsInEnum();
        RuleFor(x => x.BusinessLine).IsInEnum();
        RuleFor(x => x.Unit).IsInEnum();
        RuleFor(x => x.BillingPeriod).IsInEnum();
        RuleFor(x => x.VatRate).Must(v => Product.VatRates.Contains(v)).WithErrorCode("CAT_INVALID_VAT_RATE").WithMessage("VAT rate must be 25, 15, 12 or 0 %.");
        RuleFor(x => x.ListPrice).GreaterThanOrEqualTo(0).LessThan(100_000_000);
        RuleFor(x => x.UnitCost).GreaterThanOrEqualTo(0).LessThan(100_000_000).When(x => x.UnitCost is not null);
        RuleFor(x => x.Currency).Length(3).When(x => !string.IsNullOrWhiteSpace(x.Currency));
        RuleFor(x => x.MicrosoftOfferId).MaximumLength(128);
        RuleFor(x => x.AteraWorkType).MaximumLength(128);
        RuleFor(x => x.RevenueAccount).MaximumLength(16);
        RuleFor(x => x.Components).Must(c => c is { Count: > 0 }).When(x => x.Type == ProductType.Bundle)
            .WithErrorCode("CAT_BUNDLE_EMPTY").WithMessage("A bundle must contain at least one product.");
        RuleForEach(x => x.Components).ChildRules(c => c.RuleFor(i => i.Quantity).GreaterThan(0));
    }
}

public sealed record ProductListItem(
    Guid Id,
    string Sku,
    string Name,
    ProductType Type,
    BusinessLine BusinessLine,
    ProductUnit Unit,
    BillingPeriod BillingPeriod,
    decimal ListPrice,
    [property: SensitiveData(Permissions.FinanceCostRead)] decimal? UnitCost,
    string Currency,
    bool IsActive);

public sealed record ProductResponse(
    Guid Id,
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
    [property: SensitiveData(Permissions.FinanceCostRead)] decimal? UnitCost,
    [property: SensitiveData(Permissions.FinanceCostRead)] decimal? MarginPct,
    string Currency,
    string? MicrosoftOfferId,
    CommitmentTerm CommitmentTerm,
    string? AteraWorkType,
    string? RevenueAccount,
    IReadOnlyList<BundleComponentDto> Components,
    bool IsActive,
    DateTimeOffset CreatedAt,
    DateTimeOffset? ModifiedAt);

public sealed record ListProducts(string? Search, ProductType? Type, bool? Active, string? Cursor, int? Limit);

public sealed record GetProduct(Guid Id);

public sealed record CreateProduct(ProductRequest Request);

public sealed record UpdateProduct(Guid Id, ProductRequest Request, string IfMatch);

public sealed record SetProductActive(Guid Id, bool Active);

public sealed record DeleteProduct(Guid Id);

internal static class CatalogErrors
{
    public static Error ProductNotFound(Guid id) => Error.NotFound("CAT_PRODUCT_NOT_FOUND", $"Product {id} was not found.");

    public static Error DuplicateSku(Guid existingId) => Error.Conflict(
        "CAT_DUPLICATE_SKU", "A product with this SKU already exists.", new Dictionary<string, object?> { ["existingId"] = existingId });

    public static Error ProductInUse => Error.Conflict("CAT_PRODUCT_IN_USE", "The product is in use and can only be deactivated.");

    public static Error UnknownComponents => Error.Validation("CAT_BUNDLE_UNKNOWN_PRODUCT", "A bundle component refers to a product that does not exist.");

    public static Error NestedBundle => Error.Validation("CAT_BUNDLE_NESTED", "A bundle cannot contain another bundle.");

    public static Error InvalidETag => Error.PreconditionFailed("INVALID_ETAG", "The If-Match header is not a valid ETag.");
}

internal sealed class ListProductsHandler(CatalogDbContext db) : IQueryHandler<ListProducts, PagedResult<ProductListItem>>
{
    public async Task<PagedResult<ProductListItem>> HandleAsync(ListProducts query, CancellationToken cancellationToken)
    {
        var limit = KeysetCursor.ClampLimit(query.Limit);
        var products = db.Products.AsNoTracking();
        if (!string.IsNullOrWhiteSpace(query.Search))
        {
            var term = query.Search.Trim();
            products = products.Where(p => p.Name.Contains(term) || p.Sku.Contains(term) || (p.NameEn != null && p.NameEn.Contains(term)));
        }

        if (query.Type is { } type)
        {
            products = products.Where(p => p.Type == type);
        }

        if (query.Active is { } active)
        {
            products = products.Where(p => p.IsActive == active);
        }

        if (KeysetCursor.Decode(query.Cursor) is { } cursor)
        {
            products = products.Where(p => p.Name.CompareTo(cursor.SortKey) > 0 || (p.Name == cursor.SortKey && p.Id.CompareTo(cursor.Id) > 0));
        }

        var page = await products.OrderBy(p => p.Name).ThenBy(p => p.Id).Take(limit + 1)
            .Select(p => new ProductListItem(p.Id, p.Sku, p.Name, p.Type, p.BusinessLine, p.Unit, p.BillingPeriod, p.ListPrice, p.UnitCost, p.Currency, p.IsActive))
            .ToListAsync(cancellationToken);
        var items = page.Take(limit).ToList();
        var last = items.LastOrDefault();
        return new PagedResult<ProductListItem>(items, page.Count > limit && last is not null ? new KeysetCursor(last.Name, last.Id).Encode() : null);
    }
}

internal sealed class GetProductHandler(CatalogDbContext db) : IQueryHandler<GetProduct, Result<Versioned<ProductResponse>>>
{
    public async Task<Result<Versioned<ProductResponse>>> HandleAsync(GetProduct query, CancellationToken cancellationToken)
    {
        var product = await db.Products.SingleOrDefaultAsync(p => p.Id == query.Id, cancellationToken);
        return product is null
            ? CatalogErrors.ProductNotFound(query.Id)
            : new Versioned<ProductResponse>(await db.ToResponseAsync(product, cancellationToken), db.GetETag(product));
    }
}

internal sealed class CreateProductHandler(CatalogDbContext db) : ICommandHandler<CreateProduct, Result<Versioned<ProductResponse>>>
{
    public async Task<Result<Versioned<ProductResponse>>> HandleAsync(CreateProduct command, CancellationToken cancellationToken)
    {
        var details = command.Request.ToDetails();
        if (await db.CheckComponentsAsync(details.Components, cancellationToken) is { } componentError)
        {
            return componentError;
        }

        var created = Product.Create(details);
        if (!created.IsSuccess)
        {
            return created.Error!;
        }

        if (await db.FindBySkuAsync(created.Value.Sku, null, cancellationToken) is { } existingId)
        {
            return CatalogErrors.DuplicateSku(existingId);
        }

        db.Products.Add(created.Value);
        await db.SaveChangesAsync(cancellationToken);
        return new Versioned<ProductResponse>(await db.ToResponseAsync(created.Value, cancellationToken), db.GetETag(created.Value));
    }
}

internal sealed class UpdateProductHandler(CatalogDbContext db, ICurrentUser user) : ICommandHandler<UpdateProduct, Result<Versioned<ProductResponse>>>
{
    public async Task<Result<Versioned<ProductResponse>>> HandleAsync(UpdateProduct command, CancellationToken cancellationToken)
    {
        var product = await db.Products.SingleOrDefaultAsync(p => p.Id == command.Id, cancellationToken);
        if (product is null)
        {
            return CatalogErrors.ProductNotFound(command.Id);
        }

        if (!db.ApplyIfMatch(product, command.IfMatch))
        {
            return CatalogErrors.InvalidETag;
        }

        // Users who cannot see the cost cannot change or clear it.
        var details = command.Request.ToDetails();
        if (!user.HasPermission(Permissions.FinanceCostRead))
        {
            details = details with { UnitCost = product.UnitCost };
        }

        if (await db.CheckComponentsAsync(details.Components, cancellationToken) is { } componentError)
        {
            return componentError;
        }

        var updated = product.Update(details);
        if (!updated.IsSuccess)
        {
            return updated.Error!;
        }

        if (await db.FindBySkuAsync(product.Sku, product.Id, cancellationToken) is { } existingId)
        {
            return CatalogErrors.DuplicateSku(existingId);
        }

        await db.SaveChangesAsync(cancellationToken);
        return new Versioned<ProductResponse>(await db.ToResponseAsync(product, cancellationToken), db.GetETag(product));
    }
}

internal sealed class SetProductActiveHandler(CatalogDbContext db) : ICommandHandler<SetProductActive, Result>
{
    public async Task<Result> HandleAsync(SetProductActive command, CancellationToken cancellationToken)
    {
        var product = await db.Products.SingleOrDefaultAsync(p => p.Id == command.Id, cancellationToken);
        if (product is null)
        {
            return CatalogErrors.ProductNotFound(command.Id);
        }

        if (command.Active)
        {
            product.Activate();
        }
        else
        {
            product.Deactivate();
        }

        await db.SaveChangesAsync(cancellationToken);
        return Result.Success();
    }
}

internal sealed class DeleteProductHandler(CatalogDbContext db, IEnumerable<IProductUsage> usages) : ICommandHandler<DeleteProduct, Result>
{
    public async Task<Result> HandleAsync(DeleteProduct command, CancellationToken cancellationToken)
    {
        var product = await db.Products.SingleOrDefaultAsync(p => p.Id == command.Id, cancellationToken);
        if (product is null)
        {
            return CatalogErrors.ProductNotFound(command.Id);
        }

        // BR-CAT-03: price lists, bundles and other modules (contracts, quotes, billing) keep a used product alive.
        var idText = product.Id.ToString();
        var usedHere = await db.PriceListItems.AnyAsync(i => i.ProductId == product.Id, cancellationToken) ||
                       await db.Products.AnyAsync(p => p.ComponentsJson != null && p.ComponentsJson.Contains(idText), cancellationToken);
        if (usedHere)
        {
            return CatalogErrors.ProductInUse;
        }

        foreach (var usage in usages)
        {
            if (await usage.IsUsedAsync(product.Id, cancellationToken))
            {
                return CatalogErrors.ProductInUse;
            }
        }

        product.MarkDeleted();
        await db.SaveChangesAsync(cancellationToken);
        return Result.Success();
    }
}

internal static class ProductQueries
{
    public static async Task<Guid?> FindBySkuAsync(this CatalogDbContext db, string sku, Guid? excludeId, CancellationToken ct) =>
        await db.Products.AsNoTracking().Where(p => p.Sku == sku && p.Id != excludeId).Select(p => (Guid?)p.Id).FirstOrDefaultAsync(ct);

    public static async Task<Error?> CheckComponentsAsync(this CatalogDbContext db, IReadOnlyList<BundleComponent>? components, CancellationToken ct)
    {
        if (components is not { Count: > 0 })
        {
            return null;
        }

        var ids = components.Select(c => c.ProductId).Distinct().ToList();
        var found = await db.Products.AsNoTracking().Where(p => ids.Contains(p.Id)).Select(p => p.Type).ToListAsync(ct);
        if (found.Count != ids.Count)
        {
            return CatalogErrors.UnknownComponents;
        }

        return found.Contains(ProductType.Bundle) ? CatalogErrors.NestedBundle : null;
    }

    public static async Task<ProductResponse> ToResponseAsync(this CatalogDbContext db, Product p, CancellationToken ct)
    {
        var components = p.Components;
        var ids = components.Select(c => c.ProductId).ToList();
        var names = ids.Count == 0
            ? []
            : await db.Products.AsNoTracking().IgnoreQueryFilters().Where(x => ids.Contains(x.Id)).ToDictionaryAsync(x => x.Id, x => new { x.Sku, x.Name }, ct);

        return new ProductResponse(
            p.Id, p.Sku, p.Name, p.NameEn, p.Description, p.Type, p.BusinessLine, p.Unit, p.BillingPeriod, p.VatRate, p.ListPrice, p.UnitCost,
            Margin(p.ListPrice, p.UnitCost), p.Currency, p.MicrosoftOfferId, p.CommitmentTerm, p.AteraWorkType, p.RevenueAccount,
            components.Select(c => new BundleComponentDto(c.ProductId, c.Quantity, names.GetValueOrDefault(c.ProductId)?.Sku, names.GetValueOrDefault(c.ProductId)?.Name)).ToList(),
            p.IsActive, p.CreatedAt, p.ModifiedAt);
    }

    public static decimal? Margin(decimal price, decimal? cost) =>
        cost is { } c && price > 0 ? decimal.Round((price - c) / price * 100m, 1) : null;
}
