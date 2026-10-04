using Crm.Authorization;
using Crm.Catalog.Contracts;
using Crm.Catalog.Domain;
using Crm.Catalog.Features.Products;
using Crm.Catalog.Persistence;
using Crm.Infrastructure.Persistence;
using Crm.SharedKernel.Results;
using Crm.SharedKernel.Text;
using FluentValidation;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Crm.Catalog.Features.PriceLists;

public sealed record CategoryRequest(string Code, string Name, decimal LicenseMarkupPct, bool IsDefault);

public sealed record CategoryResponse(Guid Id, string Code, string Name, decimal LicenseMarkupPct, bool IsDefault, string Etag);

internal sealed class CategoryRequestValidator : AbstractValidator<CategoryRequest>
{
    public CategoryRequestValidator()
    {
        RuleFor(x => x.Code).NotEmpty().MaximumLength(32).Matches("^[A-Za-z0-9_\\-]+$");
        RuleFor(x => x.Name).NotEmpty().MaximumLength(128);
        RuleFor(x => x.LicenseMarkupPct).InclusiveBetween(-100, 1000);
    }
}

public sealed record PriceListRequest(string Name, string CustomerCategory, DateOnly ValidFrom, DateOnly? ValidTo, string? Currency);

internal sealed class PriceListRequestValidator : AbstractValidator<PriceListRequest>
{
    public PriceListRequestValidator()
    {
        RuleFor(x => x.Name).NotEmpty().MaximumLength(128);
        RuleFor(x => x.CustomerCategory).NotEmpty().MaximumLength(32);
        RuleFor(x => x.ValidTo).GreaterThanOrEqualTo(x => x.ValidFrom).When(x => x.ValidTo is not null)
            .WithErrorCode("CAT_INVALID_PERIOD").WithMessage("The price list must end on or after its start date.");
        RuleFor(x => x.Currency).Length(3).When(x => !string.IsNullOrWhiteSpace(x.Currency));
    }
}

/// <summary>Either a sales price (with optional cost) or a Microsoft partner price that the sales price is calculated from.</summary>
public sealed record PriceItemRequest(decimal? UnitPrice, decimal? UnitCost, decimal? PartnerPrice, string? PartnerCurrency, decimal? ExchangeRate);

internal sealed class PriceItemRequestValidator : AbstractValidator<PriceItemRequest>
{
    public PriceItemRequestValidator()
    {
        RuleFor(x => x).Must(x => x.UnitPrice is not null || x.PartnerPrice is not null)
            .WithErrorCode("CAT_PRICE_REQUIRED").WithMessage("Enter a sales price or a partner price.");
        RuleFor(x => x.UnitPrice).GreaterThanOrEqualTo(0).LessThan(100_000_000).When(x => x.UnitPrice is not null);
        RuleFor(x => x.UnitCost).GreaterThanOrEqualTo(0).LessThan(100_000_000).When(x => x.UnitCost is not null);
        RuleFor(x => x.PartnerPrice).GreaterThanOrEqualTo(0).LessThan(10_000_000).When(x => x.PartnerPrice is not null);
        RuleFor(x => x.PartnerCurrency).NotEmpty().Length(3).When(x => x.PartnerPrice is not null);
        RuleFor(x => x.ExchangeRate).NotNull().GreaterThan(0).LessThan(10_000).When(x => x.PartnerPrice is not null);
    }
}

public sealed record CopyPriceListRequest(string Name, DateOnly ValidFrom, DateOnly? ValidTo, decimal? AdjustPct);

internal sealed class CopyPriceListRequestValidator : AbstractValidator<CopyPriceListRequest>
{
    public CopyPriceListRequestValidator()
    {
        RuleFor(x => x.Name).NotEmpty().MaximumLength(128);
        RuleFor(x => x.ValidTo).GreaterThanOrEqualTo(x => x.ValidFrom).When(x => x.ValidTo is not null);
        RuleFor(x => x.AdjustPct).InclusiveBetween(-50, 100).When(x => x.AdjustPct is not null);
    }
}

public sealed record PriceListSummary(
    Guid Id, string Name, string CustomerCategory, DateOnly ValidFrom, DateOnly? ValidTo, string Currency, PriceListStatus Status, int Items, bool IsCurrent);

public sealed record PriceListItemResponse(
    Guid ProductId,
    string Sku,
    string ProductName,
    ProductType ProductType,
    ProductUnit Unit,
    decimal ListPrice,
    decimal UnitPrice,
    [property: SensitiveData(Permissions.FinanceCostRead)] decimal? UnitCost,
    [property: SensitiveData(Permissions.FinanceCostRead)] decimal? MarginPct,
    [property: SensitiveData(Permissions.FinanceCostRead)] decimal? PartnerPrice,
    [property: SensitiveData(Permissions.FinanceCostRead)] string? PartnerCurrency,
    [property: SensitiveData(Permissions.FinanceCostRead)] decimal? ExchangeRate);

public sealed record PriceListResponse(
    Guid Id,
    string Name,
    string CustomerCategory,
    DateOnly ValidFrom,
    DateOnly? ValidTo,
    string Currency,
    PriceListStatus Status,
    IReadOnlyList<PriceListItemResponse> Items,
    DateTimeOffset CreatedAt,
    DateTimeOffset? ModifiedAt);

public sealed record ResolvedPriceResponse(
    Guid ProductId,
    decimal UnitPrice,
    [property: SensitiveData(Permissions.FinanceCostRead)] decimal? UnitCost,
    string Currency,
    Guid? PriceListId,
    string? PriceListName);

public sealed record PriceSheetImportRequest(decimal ExchangeRate, decimal? MarkupPct);

/// <summary>What one product's price becomes when the sheet is applied; the preview and the real import produce the same rows.</summary>
public sealed record PriceSheetImportRow(
    Guid ProductId,
    string ProductName,
    string OfferId,
    decimal PartnerPrice,
    string PartnerCurrency,
    decimal UnitPrice,
    decimal? PreviousUnitPrice,
    bool Changed);

public sealed record PriceSheetImportResult(
    int Matched,
    int Changed,
    int Unchanged,
    int WithoutProduct,
    decimal ExchangeRate,
    decimal MarkupPct,
    IReadOnlyList<PriceSheetImportRow> Rows,
    IReadOnlyList<string> Warnings);

internal static class PriceListErrors
{
    public static Error NotFound(Guid id) => Error.NotFound("CAT_PRICE_LIST_NOT_FOUND", $"Price list {id} was not found.");

    public static Error CategoryNotFound(string code) => Error.Validation("CAT_UNKNOWN_CATEGORY", $"Customer category '{code}' does not exist.");

    public static Error CategoryCodeTaken => Error.Conflict("CAT_DUPLICATE_CATEGORY", "A customer category with this code already exists.");

    public static Error Overlap(PriceList other) => Error.Conflict(
        "CAT_PRICE_LIST_OVERLAP",
        $"The period overlaps the active price list '{other.Name}' for the same customer category.",
        new Dictionary<string, object?> { ["priceListId"] = other.Id, ["name"] = other.Name });

    public static Error NotDraft => Error.Conflict(
        "CAT_PRICE_LIST_NOT_DRAFT", "Prices are imported into a draft price list; deactivate it first.");

    public static Error ActiveCannotBeDeleted => Error.Conflict("CAT_PRICE_LIST_ACTIVE", "Deactivate the price list before deleting it.");
}

/// <summary>Customer categories, price lists and their items. One service keeps the overlap rule (BR-CAT-01) in one place.</summary>
internal sealed class PriceListService(CatalogDbContext db, IOptions<CatalogOptions> options, TimeProvider time)
{
    /// <summary>Rows a price sheet answer lists; the counts always cover the whole sheet.</summary>
    public const int MaxPreviewRows = 500;

    public async Task<IReadOnlyList<CategoryResponse>> ListCategoriesAsync(CancellationToken ct)
    {
        // Tracked: each row carries its ETag.
        var categories = await db.CustomerCategories.OrderByDescending(c => c.IsDefault).ThenBy(c => c.Code).ToListAsync(ct);
        return categories.Select(c => new CategoryResponse(c.Id, c.Code, c.Name, c.LicenseMarkupPct, c.IsDefault, db.GetETag(c))).ToList();
    }

    public async Task<Result<CategoryResponse>> SaveCategoryAsync(Guid? id, CategoryRequest request, string? ifMatch, CancellationToken ct)
    {
        CustomerCategory category;
        if (id is null)
        {
            var code = CustomerCategory.NormalizeCode(request.Code);
            if (await db.CustomerCategories.AnyAsync(c => c.Code == code, ct))
            {
                return PriceListErrors.CategoryCodeTaken;
            }

            category = CustomerCategory.Create(code, request.Name, request.LicenseMarkupPct);
            db.CustomerCategories.Add(category);
        }
        else
        {
            if (await db.CustomerCategories.SingleOrDefaultAsync(c => c.Id == id, ct) is not { } existing)
            {
                return Error.NotFound("CAT_CATEGORY_NOT_FOUND", $"Customer category {id} was not found.");
            }

            if (ifMatch is null || !db.ApplyIfMatch(existing, ifMatch))
            {
                return CatalogErrors.InvalidETag;
            }

            category = existing;
            category.Update(request.Name, request.LicenseMarkupPct);
        }

        if (request.IsDefault && !category.IsDefault)
        {
            foreach (var other in await db.CustomerCategories.Where(c => c.IsDefault && c.Id != category.Id).ToListAsync(ct))
            {
                other.SetDefault(false);
            }

            category.SetDefault(true);
        }

        await db.SaveChangesAsync(ct);
        return new CategoryResponse(category.Id, category.Code, category.Name, category.LicenseMarkupPct, category.IsDefault, db.GetETag(category));
    }

    public async Task<IReadOnlyList<PriceListSummary>> ListAsync(string? category, PriceListStatus? status, CancellationToken ct)
    {
        var today = DateOnly.FromDateTime(time.GetLocalNow().DateTime);
        var lists = db.PriceLists.AsNoTracking();
        if (!string.IsNullOrWhiteSpace(category))
        {
            var code = CustomerCategory.NormalizeCode(category);
            lists = lists.Where(l => l.CustomerCategory == code);
        }

        if (status is { } s)
        {
            lists = lists.Where(l => l.Status == s);
        }

        var rows = await lists
            .OrderBy(l => l.CustomerCategory).ThenByDescending(l => l.ValidFrom)
            .Select(l => new { List = l, Items = db.PriceListItems.Count(i => i.PriceListId == l.Id) })
            .ToListAsync(ct);
        return rows.Select(r => new PriceListSummary(
            r.List.Id, r.List.Name, r.List.CustomerCategory, r.List.ValidFrom, r.List.ValidTo, r.List.Currency, r.List.Status, r.Items,
            r.List.Status == PriceListStatus.Active && r.List.Covers(today))).ToList();
    }

    public async Task<Result<Versioned<PriceListResponse>>> GetAsync(Guid id, CancellationToken ct)
    {
        var list = await db.PriceLists.SingleOrDefaultAsync(l => l.Id == id, ct);
        return list is null ? PriceListErrors.NotFound(id) : new Versioned<PriceListResponse>(await ToResponseAsync(list, ct), db.GetETag(list));
    }

    public async Task<Result<Versioned<PriceListResponse>>> CreateAsync(PriceListRequest request, CancellationToken ct)
    {
        if (await CheckCategoryAsync(request.CustomerCategory, ct) is { } error)
        {
            return error;
        }

        var created = PriceList.Create(request.Name, request.CustomerCategory, request.ValidFrom, request.ValidTo, request.Currency ?? "NOK");
        if (!created.IsSuccess)
        {
            return created.Error!;
        }

        db.PriceLists.Add(created.Value);
        await db.SaveChangesAsync(ct);
        return new Versioned<PriceListResponse>(await ToResponseAsync(created.Value, ct), db.GetETag(created.Value));
    }

    public async Task<Result<Versioned<PriceListResponse>>> UpdateAsync(Guid id, PriceListRequest request, string ifMatch, CancellationToken ct)
    {
        if (await db.PriceLists.SingleOrDefaultAsync(l => l.Id == id, ct) is not { } list)
        {
            return PriceListErrors.NotFound(id);
        }

        if (!db.ApplyIfMatch(list, ifMatch))
        {
            return CatalogErrors.InvalidETag;
        }

        if (await CheckCategoryAsync(request.CustomerCategory, ct) is { } categoryError)
        {
            return categoryError;
        }

        var updated = list.Update(request.Name, request.CustomerCategory, request.ValidFrom, request.ValidTo, request.Currency ?? list.Currency);
        if (!updated.IsSuccess)
        {
            return updated.Error!;
        }

        if (list.Status == PriceListStatus.Active && await FindOverlapAsync(list, ct) is { } overlap)
        {
            return PriceListErrors.Overlap(overlap);
        }

        await db.SaveChangesAsync(ct);
        return new Versioned<PriceListResponse>(await ToResponseAsync(list, ct), db.GetETag(list));
    }

    public async Task<Result> SetActiveAsync(Guid id, bool active, CancellationToken ct)
    {
        if (await db.PriceLists.SingleOrDefaultAsync(l => l.Id == id, ct) is not { } list)
        {
            return PriceListErrors.NotFound(id);
        }

        if (active)
        {
            if (await FindOverlapAsync(list, ct) is { } overlap)
            {
                return PriceListErrors.Overlap(overlap);
            }

            list.Activate();
        }
        else
        {
            list.Deactivate();
        }

        await db.SaveChangesAsync(ct);
        return Result.Success();
    }

    public async Task<Result> DeleteAsync(Guid id, CancellationToken ct)
    {
        if (await db.PriceLists.SingleOrDefaultAsync(l => l.Id == id, ct) is not { } list)
        {
            return PriceListErrors.NotFound(id);
        }

        if (list.Status == PriceListStatus.Active)
        {
            return PriceListErrors.ActiveCannotBeDeleted;
        }

        foreach (var item in await db.PriceListItems.Where(i => i.PriceListId == id).ToListAsync(ct))
        {
            item.MarkDeleted();
        }

        list.MarkDeleted();
        await db.SaveChangesAsync(ct);
        return Result.Success();
    }

    public async Task<Result<Versioned<PriceListResponse>>> CopyAsync(Guid id, CopyPriceListRequest request, CancellationToken ct)
    {
        if (await db.PriceLists.AsNoTracking().SingleOrDefaultAsync(l => l.Id == id, ct) is not { } source)
        {
            return PriceListErrors.NotFound(id);
        }

        var created = PriceList.Create(request.Name, source.CustomerCategory, request.ValidFrom, request.ValidTo, source.Currency);
        if (!created.IsSuccess)
        {
            return created.Error!;
        }

        db.PriceLists.Add(created.Value);
        var factor = 1 + ((request.AdjustPct ?? 0) / 100m);
        foreach (var item in await db.PriceListItems.AsNoTracking().Where(i => i.PriceListId == id).ToListAsync(ct))
        {
            var copy = PriceListItem.Create(created.Value.Id, item.ProductId);
            copy.SetPrice(item.UnitPrice * factor, item.UnitCost);
            db.PriceListItems.Add(copy);
        }

        await db.SaveChangesAsync(ct);
        return new Versioned<PriceListResponse>(await ToResponseAsync(created.Value, ct), db.GetETag(created.Value));
    }

    public async Task<Result<PriceListItemResponse>> SetItemAsync(Guid id, Guid productId, PriceItemRequest request, CancellationToken ct)
    {
        if (await db.PriceLists.AsNoTracking().SingleOrDefaultAsync(l => l.Id == id, ct) is not { } list)
        {
            return PriceListErrors.NotFound(id);
        }

        if (await db.Products.AsNoTracking().SingleOrDefaultAsync(p => p.Id == productId, ct) is not { } product)
        {
            return CatalogErrors.ProductNotFound(productId);
        }

        var item = await db.PriceListItems.SingleOrDefaultAsync(i => i.PriceListId == id && i.ProductId == productId, ct);
        if (item is null)
        {
            item = PriceListItem.Create(id, productId);
            db.PriceListItems.Add(item);
        }

        if (request.PartnerPrice is { } partnerPrice)
        {
            var markup = await db.CustomerCategories.AsNoTracking()
                .Where(c => c.Code == list.CustomerCategory).Select(c => (decimal?)c.LicenseMarkupPct).SingleOrDefaultAsync(ct) ?? 0m;
            item.SetFromPartnerPrice(partnerPrice, request.PartnerCurrency!, request.ExchangeRate!.Value, markup, options.Value.LicensePriceRounding);
        }
        else
        {
            item.SetPrice(request.UnitPrice!.Value, request.UnitCost);
        }

        await db.SaveChangesAsync(ct);
        return ToItem(item, product);
    }

    /// <summary>
    /// FR-CAT-03: applies Microsoft's NCE price sheet to a draft price list. Products are matched on their Microsoft offer
    /// id; ?dryRun=true answers "what would change" by computing the same prices without saving them.
    /// </summary>
    public async Task<Result<PriceSheetImportResult>> ImportPriceSheetAsync(
        Guid id, string csv, PriceSheetImportRequest request, bool dryRun, CancellationToken ct)
    {
        if (request.ExchangeRate is <= 0 or > 1000 || request.MarkupPct is < -100 or > 500)
        {
            return Error.Validation("CAT_PRICE_SHEET_PARAMETERS", "Give an exchange rate above 0 and a markup between -100 and 500 per cent.");
        }

        if (await db.PriceLists.AsNoTracking().SingleOrDefaultAsync(l => l.Id == id, ct) is not { } list)
        {
            return PriceListErrors.NotFound(id);
        }

        if (list.Status != PriceListStatus.Draft)
        {
            return PriceListErrors.NotDraft;
        }

        var parsed = PriceSheetCsv.Parse(csv);
        if (parsed.Rows.Count == 0)
        {
            return Error.Validation("CAT_PRICE_SHEET_INVALID", string.Join(" ", parsed.Errors.Take(5).DefaultIfEmpty("The file has no priced rows.")),
                new Dictionary<string, object?> { ["errors"] = parsed.Errors, ["unknownColumns"] = parsed.UnknownColumns });
        }

        var markup = request.MarkupPct ?? await db.CustomerCategories.AsNoTracking()
            .Where(c => c.Code == list.CustomerCategory).Select(c => (decimal?)c.LicenseMarkupPct).SingleOrDefaultAsync(ct) ?? 0m;
        var rounding = options.Value.LicensePriceRounding;
        var products = await db.Products.AsNoTracking().Where(p => p.MicrosoftOfferId != null).ToListAsync(ct);
        var existing = await db.PriceListItems.Where(i => i.PriceListId == id).ToListAsync(ct);
        var itemsByProduct = existing.ToDictionary(i => i.ProductId);

        var warnings = new List<string>(parsed.Errors);
        var rows = new List<PriceSheetImportRow>();
        var matchedOffers = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var product in products)
        {
            var candidates = parsed.Rows.Where(r => string.Equals(r.OfferId, product.MicrosoftOfferId, StringComparison.OrdinalIgnoreCase)).ToList();
            if (candidates.Count == 0)
            {
                continue;
            }

            // A SKU is priced once per term in the sheet; the product says which term it is sold on.
            var sheetRow = candidates.Find(r => r.Term == product.CommitmentTerm) ?? candidates[0];
            matchedOffers.Add(sheetRow.OfferId);
            var unitPrice = LicensePricing.SalesPrice(sheetRow.PartnerPrice, request.ExchangeRate, markup, rounding);
            var item = itemsByProduct.GetValueOrDefault(product.Id);
            var changed = item is null || item.UnitPrice != unitPrice || item.PartnerPrice != sheetRow.PartnerPrice;
            rows.Add(new PriceSheetImportRow(
                product.Id, product.Name, sheetRow.OfferId, sheetRow.PartnerPrice, sheetRow.Currency, unitPrice, item?.UnitPrice, changed));

            if (dryRun || !changed)
            {
                continue;
            }

            if (item is null)
            {
                item = PriceListItem.Create(id, product.Id);
                db.PriceListItems.Add(item);
            }

            item.SetFromPartnerPrice(sheetRow.PartnerPrice, sheetRow.Currency, request.ExchangeRate, markup, rounding);
        }

        var withoutProduct = parsed.Rows.Select(r => r.OfferId).Distinct(StringComparer.OrdinalIgnoreCase).Count(o => !matchedOffers.Contains(o));
        if (withoutProduct > 0)
        {
            warnings.Add($"{withoutProduct} offers in the file have no product with that Microsoft offer id.");
        }

        if (!dryRun && rows.Exists(r => r.Changed))
        {
            await db.SaveChangesAsync(ct);
        }

        return new PriceSheetImportResult(
            rows.Count,
            rows.Count(r => r.Changed),
            rows.Count(r => !r.Changed),
            withoutProduct,
            request.ExchangeRate,
            markup,
            // A sample for the screen, changed first; the counts above cover every row (DEV-12).
            rows.OrderByDescending(r => r.Changed).ThenBy(r => r.ProductName, StringComparer.CurrentCultureIgnoreCase).Take(MaxPreviewRows).ToList(),
            WarningList.Capped(warnings));
    }

    public async Task<Result> RemoveItemAsync(Guid id, Guid productId, CancellationToken ct)
    {
        if (await db.PriceListItems.SingleOrDefaultAsync(i => i.PriceListId == id && i.ProductId == productId, ct) is not { } item)
        {
            return Error.NotFound("CAT_PRICE_NOT_FOUND", "The product has no price in this price list.");
        }

        item.MarkDeleted();
        await db.SaveChangesAsync(ct);
        return Result.Success();
    }

    public async Task<IReadOnlyDictionary<Guid, ResolvedPrice>> ResolveAsync(
        IReadOnlyCollection<Guid> productIds, string? category, DateOnly date, CancellationToken ct)
    {
        var code = string.IsNullOrWhiteSpace(category) ? await DefaultCategoryAsync(ct) : CustomerCategory.NormalizeCode(category);
        var products = await db.Products.AsNoTracking().IgnoreQueryFilters().Where(p => productIds.Contains(p.Id)).ToListAsync(ct);
        var candidates = await (
                from item in db.PriceListItems.AsNoTracking()
                join list in db.PriceLists.AsNoTracking() on item.PriceListId equals list.Id
                where productIds.Contains(item.ProductId) && list.CustomerCategory == code && list.Status == PriceListStatus.Active &&
                      list.ValidFrom <= date && (list.ValidTo == null || list.ValidTo >= date)
                select new { list, item })
            .ToListAsync(ct);
        var pairs = candidates.Select(c => (c.list, c.item)).ToList();
        return products.ToDictionary(p => p.Id, p => PriceResolver.Resolve(p, pairs, date));
    }

    public async Task<string> DefaultCategoryAsync(CancellationToken ct) =>
        await db.CustomerCategories.AsNoTracking().Where(c => c.IsDefault).Select(c => c.Code).FirstOrDefaultAsync(ct)
        ?? await db.CustomerCategories.AsNoTracking().OrderBy(c => c.Code).Select(c => c.Code).FirstOrDefaultAsync(ct)
        ?? "STANDARD";

    private async Task<Error?> CheckCategoryAsync(string category, CancellationToken ct)
    {
        var code = CustomerCategory.NormalizeCode(category);
        return await db.CustomerCategories.AnyAsync(c => c.Code == code, ct) ? null : PriceListErrors.CategoryNotFound(code);
    }

    private async Task<PriceList?> FindOverlapAsync(PriceList list, CancellationToken ct)
    {
        var others = await db.PriceLists.AsNoTracking()
            .Where(l => l.Id != list.Id && l.CustomerCategory == list.CustomerCategory && l.Status == PriceListStatus.Active)
            .ToListAsync(ct);
        return others.FirstOrDefault(list.Overlaps);
    }

    private async Task<PriceListResponse> ToResponseAsync(PriceList list, CancellationToken ct)
    {
        var rows = await (
                from item in db.PriceListItems.AsNoTracking()
                join product in db.Products.AsNoTracking().IgnoreQueryFilters() on item.ProductId equals product.Id
                where item.PriceListId == list.Id
                orderby product.Name
                select new { item, product })
            .ToListAsync(ct);
        return new PriceListResponse(
            list.Id, list.Name, list.CustomerCategory, list.ValidFrom, list.ValidTo, list.Currency, list.Status,
            rows.Select(r => ToItem(r.item, r.product)).ToList(), list.CreatedAt, list.ModifiedAt);
    }

    // Without a cost of its own, the item is costed like the price resolver does: at the product's cost.
    private static PriceListItemResponse ToItem(PriceListItem item, Product product) => new(
        product.Id, product.Sku, product.Name, product.Type, product.Unit, product.ListPrice, item.UnitPrice, item.UnitCost ?? product.UnitCost,
        ProductQueries.Margin(item.UnitPrice, item.UnitCost ?? product.UnitCost), item.PartnerPrice, item.PartnerCurrency, item.ExchangeRate);
}
