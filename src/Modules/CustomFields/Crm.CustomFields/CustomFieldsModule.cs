using Crm.Authorization;
using Crm.CustomFields.Domain;
using Crm.CustomFields.Features;
using Crm.CustomFields.Persistence;
using Crm.Infrastructure.DependencyInjection;
using Crm.Infrastructure.Http;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace Crm.CustomFields;

public static class CustomFieldsModule
{
    public static IServiceCollection AddCustomFieldsModule(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddModuleDbContext<CustomFieldsDbContext>(configuration);
        services.AddModuleServices(typeof(CustomFieldsModule).Assembly);
        services.AddScoped<CustomFieldService>();
        return services;
    }

    public static IEndpointRouteBuilder MapCustomFieldsEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/v1/custom-fields").WithTags("CustomFields");

        group.MapGet("/definitions", async (CustomFieldEntity? entity, bool? includeInactive, CustomFieldService service, CancellationToken ct) =>
                Results.Ok(await service.ListAsync(entity, includeInactive ?? false, ct)))
            .RequirePermission(Permissions.CustomersRead);

        group.MapPost("/definitions", async (CustomFieldRequest request, CustomFieldService service, CancellationToken ct) =>
                (await service.SaveAsync(null, request, ct)).ToHttpResult(field => Results.Created($"/api/v1/custom-fields/definitions/{field.Id}", field)))
            .Validate<CustomFieldRequest>()
            .RequirePermission(Permissions.CustomFieldsManage);

        group.MapPut("/definitions/{id:guid}", async (Guid id, CustomFieldRequest request, CustomFieldService service, CancellationToken ct) =>
                (await service.SaveAsync(id, request, ct)).ToHttpResult(Results.Ok))
            .Validate<CustomFieldRequest>()
            .RequirePermission(Permissions.CustomFieldsManage);

        group.MapPost("/definitions/{id:guid}/active", async (Guid id, SetActiveRequest request, CustomFieldService service, CancellationToken ct) =>
                (await service.SetActiveAsync(id, request.Active, ct)).ToHttpResult(Results.NoContent))
            .RequirePermission(Permissions.CustomFieldsManage);

        group.MapDelete("/definitions/{id:guid}", async (Guid id, CustomFieldService service, CancellationToken ct) =>
                (await service.DeleteAsync(id, ct)).ToHttpResult(Results.NoContent))
            .RequirePermission(Permissions.CustomFieldsManage);

        // Values hang off a record by id; they follow the permissions of the customer data they describe.
        group.MapGet("/{entity}/{entityId:guid}", async (CustomFieldEntity entity, Guid entityId, CustomFieldService service, CancellationToken ct) =>
                Results.Ok(await service.GetValuesAsync(entity, entityId, ct)))
            .RequirePermission(Permissions.CustomersRead);

        group.MapPut("/{entity}/{entityId:guid}", async (
                CustomFieldEntity entity, Guid entityId, SaveCustomFieldValuesRequest request, CustomFieldService service, CancellationToken ct) =>
                (await service.SaveValuesAsync(entity, entityId, request.Values, ct)).ToHttpResult(Results.Ok))
            .RequirePermission(Permissions.CustomersWrite);

        return app;
    }
}

public sealed record SetActiveRequest(bool Active);
