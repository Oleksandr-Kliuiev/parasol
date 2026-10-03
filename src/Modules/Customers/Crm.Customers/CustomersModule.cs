using Crm.Authorization;
using Crm.Customers.Contracts;
using Crm.Customers.Features.Contacts;
using Crm.Customers.Features.Organizations;
using Crm.Customers.Features.Search;
using Crm.Customers.Persistence;
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

namespace Crm.Customers;

public static class CustomersModule
{
    public static IServiceCollection AddCustomersModule(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddModuleDbContext<CustomersDbContext>(configuration);
        services.AddOptions<CustomersOptions>().Bind(configuration.GetSection(CustomersOptions.SectionName));
        services.AddModuleServices(typeof(CustomersModule).Assembly);
        services.AddScoped<OrganizationDocumentsService>();
        services.AddScoped<MigrationImportService>();
        services.AddScoped<ICustomersApi, CustomersApi>();
        services.AddScoped<ISearchProvider, OrganizationSearchProvider>();
        services.AddScoped<ISearchProvider, ContactSearchProvider>();
        return services;
    }

    public static IEndpointRouteBuilder MapCustomersEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/v1/customers").WithTags("Customers");
        group.MapGet("/settings", (Microsoft.Extensions.Options.IOptions<CustomersOptions> options) =>
                Results.Ok(new { billingDetailsMaster = options.Value.BillingDetailsMaster }))
            .RequirePermission(Permissions.CustomersRead);
        MapOrganizations(group);
        MapDocuments(group);
        MapContacts(group);
        return app;
    }

    private static void MapOrganizations(RouteGroupBuilder group)
    {
        group.MapGet("/organizations", async (
                [AsParameters] ListOrganizationsParameters p,
                ListOrganizationsHandler handler,
                CancellationToken ct) =>
                Results.Ok(await handler.HandleAsync(new ListOrganizations(p.Search, p.Status, p.AccountManagerId, p.Cursor, p.Limit), ct)))
            .RequirePermission(Permissions.CustomersRead);

        group.MapGet("/organizations/export", async (
                [AsParameters] ListOrganizationsParameters p, string? lang, ExportOrganizationsHandler handler, CancellationToken ct) =>
                (await handler.HandleAsync(new ExportOrganizations(p.Search, p.Status, p.AccountManagerId, lang), ct))
                .ToHttpResult(file => Results.File(file.Content, ExportOrganizationsHandler.ContentType, file.FileName)))
            .RequirePermission(Permissions.CustomersRead)
            .RequireRateLimiting(RateLimitPolicies.Export);

        // ТЗ §6.6: migration from the old systems; ?dryRun=true previews what the file would do without writing it.
        group.MapPost("/organizations/import", async (HttpRequest request, bool? dryRun, MigrationImportService service, CancellationToken ct) =>
            {
                using var reader = new StreamReader(request.Body);
                var csv = await reader.ReadToEndAsync(ct);
                return (await service.ImportAsync(csv, dryRun ?? false, ct)).ToHttpResult(Results.Ok);
            })
            .RequirePermission(Permissions.CustomersDelete)
            .RequireRateLimiting(RateLimitPolicies.Export);

        group.MapGet("/organizations/duplicates", async (Guid? organizationId, FindDuplicatesHandler handler, CancellationToken ct) =>
                Results.Ok(await handler.HandleAsync(new FindDuplicates(organizationId), ct)))
            .RequirePermission(Permissions.CustomersRead);

        group.MapPost("/organizations/duplicates/dismissals", async (DismissDuplicateRequest request, DismissDuplicateHandler handler, CancellationToken ct) =>
                (await handler.HandleAsync(request, ct)).ToHttpResult(Results.NoContent))
            .RequirePermission(Permissions.CustomersWrite);

        group.MapPost("/organizations/{id:guid}/merge", async (Guid id, MergeRequest request, MergeOrganizationsHandler handler, CancellationToken ct) =>
                (await handler.HandleAsync(new MergeOrganizations(id, request.SourceOrganizationId), ct)).ToHttpResult(Results.Ok))
            .RequirePermission(Permissions.CustomersDelete);

        group.MapGet("/organizations/merges", async (ListMergesHandler handler, CancellationToken ct) =>
                Results.Ok(await handler.HandleAsync(default, ct)))
            .RequirePermission(Permissions.CustomersRead);

        group.MapPost("/organizations/merges/{mergeId:guid}/undo", async (Guid mergeId, UndoMergeHandler handler, CancellationToken ct) =>
                (await handler.HandleAsync(new UndoMerge(mergeId), ct)).ToHttpResult(Results.NoContent))
            .RequirePermission(Permissions.CustomersDelete);

        group.MapGet("/organizations/{id:guid}", async (Guid id, GetOrganizationHandler handler, HttpResponse response, CancellationToken ct) =>
                (await handler.HandleAsync(new GetOrganization(id), ct)).ToHttpResult(v => WithETag(response, v.Etag, Results.Ok(v.Value))))
            .RequirePermission(Permissions.CustomersRead);

        group.MapPost("/organizations", async (OrganizationRequest request, CreateOrganizationHandler handler, HttpResponse response, CancellationToken ct) =>
                (await handler.HandleAsync(new CreateOrganization(request), ct))
                .ToHttpResult(v => WithETag(response, v.Etag, Results.Created($"/api/v1/customers/organizations/{v.Value.Id}", v.Value))))
            .Validate<OrganizationRequest>()
            .RequirePermission(Permissions.CustomersWrite);

        group.MapPut("/organizations/{id:guid}", async (
                Guid id, OrganizationRequest request, UpdateOrganizationHandler handler, HttpRequest httpRequest, HttpResponse response, CancellationToken ct) =>
            {
                if (httpRequest.GetIfMatch() is not { } ifMatch)
                {
                    return HeaderExtensions.PreconditionRequired();
                }

                return (await handler.HandleAsync(new UpdateOrganization(id, request, ifMatch), ct))
                    .ToHttpResult(v => WithETag(response, v.Etag, Results.Ok(v.Value)));
            })
            .Validate<OrganizationRequest>()
            .RequirePermission(Permissions.CustomersWrite);

        // FR-CUS-07: the group tree, and whether the parent is the one invoiced.
        group.MapPut("/organizations/{id:guid}/parent", async (
                Guid id, SetParentRequest request, SetOrganizationParentHandler handler, HttpRequest httpRequest, HttpResponse response, CancellationToken ct) =>
            {
                if (httpRequest.GetIfMatch() is not { } ifMatch)
                {
                    return HeaderExtensions.PreconditionRequired();
                }

                return (await handler.HandleAsync(new SetOrganizationParent(id, request, ifMatch), ct))
                    .ToHttpResult(v => WithETag(response, v.Etag, Results.Ok(v.Value)));
            })
            .RequirePermission(Permissions.CustomersWrite);

        group.MapDelete("/organizations/{id:guid}", async (Guid id, DeleteOrganizationHandler handler, CancellationToken ct) =>
                (await handler.HandleAsync(new DeleteOrganization(id), ct)).ToHttpResult(Results.NoContent))
            .RequirePermission(Permissions.CustomersDelete);
    }

    private static void MapDocuments(RouteGroupBuilder group)
    {
        group.MapGet("/organizations/{id:guid}/documents", async (Guid id, OrganizationDocumentsService service, CancellationToken ct) =>
                Results.Ok(await service.ListAsync(id, ct)))
            .RequirePermission(Permissions.CustomersRead);

        group.MapPost("/organizations/{id:guid}/documents/folder", async (Guid id, OrganizationDocumentsService service, CancellationToken ct) =>
                (await service.CreateFolderAsync(id, ct)).ToHttpResult(Results.Ok))
            .RequirePermission(Permissions.CustomersWrite);
    }

    private static void MapContacts(RouteGroupBuilder group)
    {
        group.MapGet("/contact-roles", () => Results.Ok(ContactRoleNames.All))
            .RequirePermission(Permissions.CustomersRead);

        group.MapGet("/organizations/{id:guid}/contacts", async (
                Guid id, bool? includeInactive, ListOrganizationContactsHandler handler, CancellationToken ct) =>
                (await handler.HandleAsync(new ListOrganizationContacts(id, includeInactive ?? false), ct)).ToHttpResult(Results.Ok))
            .RequirePermission(Permissions.CustomersRead);

        group.MapPost("/organizations/{id:guid}/contacts", async (
                Guid id, CreateOrganizationContactRequest request, CreateOrganizationContactHandler handler, CancellationToken ct) =>
                (await handler.HandleAsync(new CreateOrganizationContact(id, request), ct))
                .ToHttpResult(v => Results.Created($"/api/v1/customers/contacts/{v.ContactId}", v)))
            .Validate<CreateOrganizationContactRequest>()
            .RequirePermission(Permissions.ContactsWrite);

        group.MapPut("/organizations/{organizationId:guid}/contacts/{contactId:guid}", async (
                Guid organizationId, Guid contactId, AffiliationRequest request, UpdateAffiliationHandler handler, CancellationToken ct) =>
                (await handler.HandleAsync(new UpdateAffiliation(organizationId, contactId, request), ct)).ToHttpResult(Results.NoContent))
            .Validate<AffiliationRequest>()
            .RequirePermission(Permissions.ContactsWrite);

        group.MapGet("/contacts/{id:guid}", async (Guid id, GetContactHandler handler, HttpResponse response, CancellationToken ct) =>
                (await handler.HandleAsync(new GetContact(id), ct)).ToHttpResult(v => WithETag(response, v.Etag, Results.Ok(v.Contact))))
            .RequirePermission(Permissions.CustomersRead);

        group.MapPut("/contacts/{id:guid}", async (
                Guid id, ContactPersonRequest request, UpdateContactPersonHandler handler, HttpRequest httpRequest, HttpResponse response, CancellationToken ct) =>
            {
                if (httpRequest.GetIfMatch() is not { } ifMatch)
                {
                    return HeaderExtensions.PreconditionRequired();
                }

                return (await handler.HandleAsync(new UpdateContactPerson(id, request, ifMatch), ct))
                    .ToHttpResult(v => WithETag(response, v.Etag, Results.Ok(v.Contact)));
            })
            .Validate<ContactPersonRequest>()
            .RequirePermission(Permissions.ContactsWrite);
    }

    private static IResult WithETag(HttpResponse response, string etag, IResult result)
    {
        response.Headers.ETag = etag;
        return result;
    }
}

public sealed record ListOrganizationsParameters(
    [FromQuery] string? Search,
    [FromQuery] OrganizationStatus? Status,
    [FromQuery] Guid? AccountManagerId,
    [FromQuery] string? Cursor,
    [FromQuery] int? Limit);
