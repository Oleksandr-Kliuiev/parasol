using Crm.Authorization;
using Crm.Catalog.Contracts;
using Crm.Catalog.Domain;
using Crm.Catalog.Features.PriceLists;
using Crm.Catalog.Features.Products;
using Crm.Catalog.Persistence;
using Crm.Infrastructure.DependencyInjection;
using Crm.Infrastructure.Http;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Results;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace Crm.Catalog;

public static class CatalogModule
{
    public static IServiceCollection AddCatalogModule(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddModuleDbContext<CatalogDbContext>(configuration);
        services.AddOptions<CatalogOptions>().Bind(configuration.GetSection(CatalogOptions.SectionName));
        services.AddModuleServices(typeof(CatalogModule).Assembly);
        services.AddScoped<PriceListService>();
        services.AddScoped<ICatalogApi, CatalogApi>();
        services.AddScoped<ISearchProvider, ProductSearchProvider>();
        return services;
    }

    public static IEndpointRouteBuilder MapCatalogEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/v1/catalog").WithTags("Catalog");
        MapProducts(group);
        MapPriceLists(group);
        return app;
    }

    private static void MapProducts(RouteGroupBuilder group)
    {
        group.MapGet("/products", async ([AsParameters] ListProductsParameters p, ListProductsHandler handler, CancellationToken ct) =>
                Results.Ok(await handler.HandleAsync(new ListProducts(p.Search, p.Type, p.Active, p.Cursor, p.Limit), ct)))
            .RequirePermission(Permissions.CatalogRead);

        group.MapGet("/products/{id:guid}", async (Guid id, GetProductHandler handler, HttpResponse response, CancellationToken ct) =>
                (await handler.HandleAsync(new GetProduct(id), ct)).ToHttpResult(v => WithETag(response, v.Etag, Results.Ok(v.Value))))
            .RequirePermission(Permissions.CatalogRead);

        group.MapPost("/products", async (ProductRequest request, CreateProductHandler handler, HttpResponse response, CancellationToken ct) =>
                (await handler.HandleAsync(new CreateProduct(request), ct))
                .ToHttpResult(v => WithETag(response, v.Etag, Results.Created($"/api/v1/catalog/products/{v.Value.Id}", v.Value))))
            .Validate<ProductRequest>()
            .RequirePermission(Permissions.CatalogWrite);

        group.MapPut("/products/{id:guid}", async (
                Guid id, ProductRequest request, UpdateProductHandler handler, HttpRequest httpRequest, HttpResponse response, CancellationToken ct) =>
                httpRequest.GetIfMatch() is not { } ifMatch
                    ? HeaderExtensions.PreconditionRequired()
                    : (await handler.HandleAsync(new UpdateProduct(id, request, ifMatch), ct)).ToHttpResult(v => WithETag(response, v.Etag, Results.Ok(v.Value))))
            .Validate<ProductRequest>()
            .RequirePermission(Permissions.CatalogWrite);

        group.MapPost("/products/{id:guid}/deactivate", async (Guid id, SetProductActiveHandler handler, CancellationToken ct) =>
                (await handler.HandleAsync(new SetProductActive(id, false), ct)).ToHttpResult(Results.NoContent))
            .RequirePermission(Permissions.CatalogWrite);

        group.MapPost("/products/{id:guid}/activate", async (Guid id, SetProductActiveHandler handler, CancellationToken ct) =>
                (await handler.HandleAsync(new SetProductActive(id, true), ct)).ToHttpResult(Results.NoContent))
            .RequirePermission(Permissions.CatalogWrite);

        group.MapDelete("/products/{id:guid}", async (Guid id, DeleteProductHandler handler, CancellationToken ct) =>
                (await handler.HandleAsync(new DeleteProduct(id), ct)).ToHttpResult(Results.NoContent))
            .RequirePermission(Permissions.CatalogWrite);
    }

    private static void MapPriceLists(RouteGroupBuilder group)
    {
        group.MapGet("/categories", async (PriceListService service, CancellationToken ct) => Results.Ok(await service.ListCategoriesAsync(ct)))
            .RequirePermission(Permissions.CatalogRead);

        group.MapPost("/categories", async (CategoryRequest request, PriceListService service, CancellationToken ct) =>
                (await service.SaveCategoryAsync(null, request, null, ct)).ToHttpResult(c => Results.Created($"/api/v1/catalog/categories/{c.Id}", c)))
            .Validate<CategoryRequest>()
            .RequirePermission(Permissions.CatalogWrite);

        group.MapPut("/categories/{id:guid}", async (Guid id, CategoryRequest request, PriceListService service, HttpRequest httpRequest, CancellationToken ct) =>
                httpRequest.GetIfMatch() is not { } ifMatch
                    ? HeaderExtensions.PreconditionRequired()
                    : (await service.SaveCategoryAsync(id, request, ifMatch, ct)).ToHttpResult(Results.Ok))
            .Validate<CategoryRequest>()
            .RequirePermission(Permissions.CatalogWrite);

        group.MapGet("/price-lists", async (string? category, PriceListStatus? status, PriceListService service, CancellationToken ct) =>
                Results.Ok(await service.ListAsync(category, status, ct)))
            .RequirePermission(Permissions.CatalogRead);

        group.MapGet("/price-lists/{id:guid}", async (Guid id, PriceListService service, HttpResponse response, CancellationToken ct) =>
                (await service.GetAsync(id, ct)).ToHttpResult(v => WithETag(response, v.Etag, Results.Ok(v.Value))))
            .RequirePermission(Permissions.CatalogRead);

        group.MapPost("/price-lists", async (PriceListRequest request, PriceListService service, HttpResponse response, CancellationToken ct) =>
                (await service.CreateAsync(request, ct))
                .ToHttpResult(v => WithETag(response, v.Etag, Results.Created($"/api/v1/catalog/price-lists/{v.Value.Id}", v.Value))))
            .Validate<PriceListRequest>()
            .RequirePermission(Permissions.CatalogWrite);

        group.MapPut("/price-lists/{id:guid}", async (
                Guid id, PriceListRequest request, PriceListService service, HttpRequest httpRequest, HttpResponse response, CancellationToken ct) =>
                httpRequest.GetIfMatch() is not { } ifMatch
                    ? HeaderExtensions.PreconditionRequired()
                    : (await service.UpdateAsync(id, request, ifMatch, ct)).ToHttpResult(v => WithETag(response, v.Etag, Results.Ok(v.Value))))
            .Validate<PriceListRequest>()
            .RequirePermission(Permissions.CatalogWrite);

        group.MapPost("/price-lists/{id:guid}/activate", async (Guid id, PriceListService service, CancellationToken ct) =>
                (await service.SetActiveAsync(id, true, ct)).ToHttpResult(Results.NoContent))
            .RequirePermission(Permissions.CatalogWrite);

        group.MapPost("/price-lists/{id:guid}/deactivate", async (Guid id, PriceListService service, CancellationToken ct) =>
                (await service.SetActiveAsync(id, false, ct)).ToHttpResult(Results.NoContent))
            .RequirePermission(Permissions.CatalogWrite);

        group.MapPost("/price-lists/{id:guid}/copy", async (Guid id, CopyPriceListRequest request, PriceListService service, CancellationToken ct) =>
                (await service.CopyAsync(id, request, ct)).ToHttpResult(v => Results.Created($"/api/v1/catalog/price-lists/{v.Value.Id}", v.Value)))
            .Validate<CopyPriceListRequest>()
            .RequirePermission(Permissions.CatalogWrite);

        group.MapDelete("/price-lists/{id:guid}", async (Guid id, PriceListService service, CancellationToken ct) =>
                (await service.DeleteAsync(id, ct)).ToHttpResult(Results.NoContent))
            .RequirePermission(Permissions.CatalogWrite);

        group.MapPut("/price-lists/{id:guid}/items/{productId:guid}", async (
                Guid id, Guid productId, PriceItemRequest request, PriceListService service, CancellationToken ct) =>
                (await service.SetItemAsync(id, productId, request, ct)).ToHttpResult(Results.Ok))
            .Validate<PriceItemRequest>()
            .RequirePermission(Permissions.CatalogWrite);

        // FR-CAT-03: Microsoft's NCE price sheet is pasted or uploaded as text; ?dryRun=true previews what it would change.
        group.MapPost("/price-lists/{id:guid}/price-sheet", async (
                Guid id, decimal exchangeRate, decimal? markupPct, bool? dryRun, HttpRequest httpRequest, PriceListService service, CancellationToken ct) =>
            {
                using var reader = new StreamReader(httpRequest.Body);
                var csv = await reader.ReadToEndAsync(ct);
                var request = new PriceSheetImportRequest(exchangeRate, markupPct);
                return (await service.ImportPriceSheetAsync(id, csv, request, dryRun ?? false, ct)).ToHttpResult(Results.Ok);
            })
            .RequirePermission(Permissions.FinanceCostRead);

        group.MapDelete("/price-lists/{id:guid}/items/{productId:guid}", async (Guid id, Guid productId, PriceListService service, CancellationToken ct) =>
                (await service.RemoveItemAsync(id, productId, ct)).ToHttpResult(Results.NoContent))
            .RequirePermission(Permissions.CatalogWrite);

        group.MapGet("/prices", async ([FromQuery] Guid[] productId, string? category, DateOnly? date, PriceListService service, TimeProvider time, CancellationToken ct) =>
            {
                if (productId.Length is 0 or > 200)
                {
                    return Error.Validation("CAT_PRODUCTS_REQUIRED", "Pass between 1 and 200 productId values.").ToProblem();
                }

                var prices = await service.ResolveAsync(productId, category, date ?? DateOnly.FromDateTime(time.GetLocalNow().DateTime), ct);
                return Results.Ok(prices.Values.Select(p => new ResolvedPriceResponse(p.ProductId, p.UnitPrice, p.UnitCost, p.Currency, p.PriceListId, p.PriceListName)).ToList());
            })
            .RequirePermission(Permissions.CatalogRead);

        group.MapGet("/settings", (Microsoft.Extensions.Options.IOptions<CatalogOptions> options) =>
                Results.Ok(new { licensePriceRounding = options.Value.LicensePriceRounding, vatRates = Product.VatRates }))
            .RequirePermission(Permissions.CatalogRead);
    }

    private static IResult WithETag(HttpResponse response, string etag, IResult result)
    {
        response.Headers.ETag = etag;
        return result;
    }
}

public sealed record ListProductsParameters(
    [FromQuery] string? Search,
    [FromQuery] ProductType? Type,
    [FromQuery] bool? Active,
    [FromQuery] string? Cursor,
    [FromQuery] int? Limit);
