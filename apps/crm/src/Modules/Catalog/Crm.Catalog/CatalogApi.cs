using Crm.Catalog.Contracts;
using Crm.Catalog.Domain;
using Crm.Catalog.Features.PriceLists;
using Crm.Catalog.Persistence;
using Crm.Authorization;
using Crm.SharedKernel.Application;
using Microsoft.EntityFrameworkCore;

namespace Crm.Catalog;

internal sealed class CatalogApi(CatalogDbContext db, PriceListService priceLists) : ICatalogApi
{
    public async Task<IReadOnlyDictionary<Guid, ProductRef>> GetProductsAsync(IReadOnlyCollection<Guid> productIds, CancellationToken cancellationToken)
    {
        if (productIds.Count == 0)
        {
            return new Dictionary<Guid, ProductRef>();
        }

        return await db.Products.AsNoTracking().IgnoreQueryFilters()
            .Where(p => productIds.Contains(p.Id))
            .ToDictionaryAsync(p => p.Id, p => new ProductRef(p.Id, p.Sku, p.Name, p.Type, p.Unit, p.BillingPeriod, p.VatRate, p.IsActive && !p.IsDeleted), cancellationToken);
    }

    public Task<string> GetDefaultCategoryAsync(CancellationToken cancellationToken) => priceLists.DefaultCategoryAsync(cancellationToken);

    public Task<IReadOnlyDictionary<Guid, ResolvedPrice>> ResolvePricesAsync(
        IReadOnlyCollection<Guid> productIds, string? customerCategory, DateOnly date, CancellationToken cancellationToken) =>
        priceLists.ResolveAsync(productIds, customerCategory, date, cancellationToken);

    public async Task<ProductRef?> FindHourlyProductAsync(string? workType, string? fallbackSku, CancellationToken cancellationToken)
    {
        var hourly = db.Products.AsNoTracking().Where(p => p.IsActive && p.Type == ProductType.HourlyService);
        var product = !string.IsNullOrWhiteSpace(workType)
            ? await hourly.Where(p => p.AteraWorkType == workType.Trim()).OrderBy(p => p.Sku).FirstOrDefaultAsync(cancellationToken)
            : null;
        if (product is null && !string.IsNullOrWhiteSpace(fallbackSku))
        {
            var sku = Product.NormalizeSku(fallbackSku);
            product = await db.Products.AsNoTracking().Where(p => p.IsActive && p.Sku == sku).FirstOrDefaultAsync(cancellationToken);
        }

        return product is null ? null : new ProductRef(product.Id, product.Sku, product.Name, product.Type, product.Unit, product.BillingPeriod, product.VatRate, product.IsActive);
    }

    public async Task<IReadOnlyDictionary<string, ProductRef>> FindProductsByOfferIdAsync(IReadOnlyCollection<string> offerIds, CancellationToken cancellationToken)
    {
        var ids = offerIds.Where(id => !string.IsNullOrWhiteSpace(id)).Select(id => id.Trim()).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        if (ids.Count == 0)
        {
            return new Dictionary<string, ProductRef>(StringComparer.OrdinalIgnoreCase);
        }

        var rows = await db.Products.AsNoTracking()
            .Where(p => p.MicrosoftOfferId != null && ids.Contains(p.MicrosoftOfferId))
            .ToListAsync(cancellationToken);
        return rows.ToDictionary(
            p => p.MicrosoftOfferId!,
            p => new ProductRef(p.Id, p.Sku, p.Name, p.Type, p.Unit, p.BillingPeriod, p.VatRate, p.IsActive),
            StringComparer.OrdinalIgnoreCase);
    }

    public async Task<IReadOnlyList<string>> GetWorkTypesAsync(CancellationToken cancellationToken) =>
        await db.Products.AsNoTracking()
            .Where(p => p.IsActive && p.AteraWorkType != null)
            .Select(p => p.AteraWorkType!)
            .Distinct()
            .OrderBy(w => w)
            .ToListAsync(cancellationToken);

    public async Task<IReadOnlyDictionary<string, Guid>> FindProductsBySkuAsync(IReadOnlyCollection<string> skus, CancellationToken cancellationToken)
    {
        var normalized = skus.Where(s => !string.IsNullOrWhiteSpace(s)).Select(Product.NormalizeSku).Distinct().ToList();
        if (normalized.Count == 0)
        {
            return new Dictionary<string, Guid>();
        }

        var rows = await db.Products.AsNoTracking().Where(p => normalized.Contains(p.Sku)).Select(p => new { p.Sku, p.Id }).ToListAsync(cancellationToken);
        return rows.ToDictionary(r => r.Sku, r => r.Id, StringComparer.OrdinalIgnoreCase);
    }

    public async Task<ImportProductResult> ImportProductAsync(ExternalProductData data, CancellationToken cancellationToken)
    {
        var sku = Product.NormalizeSku(string.IsNullOrWhiteSpace(data.Code) ? data.Name : data.Code);
        if (sku.Length > 64)
        {
            sku = sku[..64];
        }

        if (await db.Products.AsNoTracking().Where(p => p.Sku == sku).Select(p => (Guid?)p.Id).FirstOrDefaultAsync(cancellationToken) is { } existing)
        {
            return new ImportProductResult(existing, false);
        }

        var unit = data.UnitCode?.Trim().ToUpperInvariant() switch
        {
            "HUR" or "TIM" or "T" or "H" => ProductUnit.Hour,
            "MON" or "MND" => ProductUnit.Month,
            _ => ProductUnit.Piece,
        };
        var created = Product.Create(new ProductDetails(
            sku, data.Name, null, data.Description,
            unit == ProductUnit.Hour ? ProductType.HourlyService : ProductType.PowerOfficeService,
            BusinessLine.Other, unit, unit == ProductUnit.Month ? BillingPeriod.Monthly : BillingPeriod.OneTime,
            25m, Math.Max(0, data.UnitPrice ?? 0), data.UnitCost is > 0 ? data.UnitCost : null, "NOK", null, CommitmentTerm.None, null, null, null));
        if (!created.IsSuccess)
        {
            throw new InvalidOperationException($"Cannot import product: {created.Error!.Code}.");
        }

        db.Products.Add(created.Value);
        try
        {
            await db.SaveChangesAsync(cancellationToken);
        }
        catch (DbUpdateException)
        {
            // The next record must not trip over this one's half-built product.
            db.ChangeTracker.Clear();
            throw;
        }

        return new ImportProductResult(created.Value.Id, true);
    }
}

internal sealed class ProductSearchProvider(CatalogDbContext db) : ISearchProvider
{
    public string Group => "products";

    public string RequiredPermission => Permissions.CatalogRead;

    public int Order => 30;

    public async Task<IReadOnlyList<SearchHit>> SearchAsync(SearchTerm term, int take, CancellationToken cancellationToken)
    {
        var query = db.Products.AsNoTracking();
        foreach (var word in term.Words)
        {
            query = query.Where(p => p.Name.Contains(word) || p.Sku.Contains(word));
        }

        var rows = await query
            .OrderBy(p => p.IsActive ? 0 : 1).ThenBy(p => p.Name)
            .Take(take)
            .Select(p => new { p.Id, p.Name, p.Sku })
            .ToListAsync(cancellationToken);
        return rows.Select(r => new SearchHit(r.Id, r.Name, r.Sku, $"/catalog/products/{r.Id}")).ToList();
    }
}
