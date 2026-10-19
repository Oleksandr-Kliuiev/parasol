using Crm.Authorization;
using Crm.Customers.Contracts;
using Crm.Customers.Features.Contacts;
using Crm.Customers.Features.Organizations;
using Crm.Customers.Features.Privacy;
using Crm.Customers.Features.Search;
using Crm.Customers.Persistence;
using Crm.Infrastructure.DependencyInjection;
using Crm.Infrastructure.Http;
using Crm.Privacy.Contracts;
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
        services.AddScoped<MigrationRunReader>();
        services.AddScoped<MigrationReconciliationService>();
        services.AddSingleton<Crm.Infrastructure.Persistence.IDatabasePermissionRules, CustomersDatabasePermissions>();
        services.AddScoped<ICustomersApi, CustomersApi>();
        services.AddScoped<IOrganizationWorkLease, OrganizationWorkLease>();
        services.AddScoped<ISearchProvider, OrganizationSearchProvider>();
        services.AddScoped<ISearchProvider, ContactSearchProvider>();
        // DEV-11: the contact person in subject requests and the retention of former customers' contacts.
        services.AddScoped<IDataSubjectResolver, ContactSubjectResolver>();
        services.AddScoped<IPersonalDataContributor, CustomersPersonalData>();
        services.AddScoped<IRetentionContributor, FormerContactsRetention>();
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
            .ExportsData()
            .RequireRateLimiting(RateLimitPolicies.Export);

        // ТЗ §6.6, DEV-20: migration from the old systems. ?dryRun=true previews what the file would do and stores the run, so the
        // real import can name it with ?expectedSha256=; the same file repeated resumes or returns its run. Not allowed in
        // maintenance: even a preview stores a run.
        group.MapPost("/organizations/import", async (
                HttpRequest request, bool? dryRun, string? expectedSha256, MigrationImportService service, CancellationToken ct) =>
            {
                var (content, failure) = await CsvUpload.ReadBytesAsync(request, ct);
                return content is null ? failure! : (await service.ImportAsync(content, dryRun ?? false, expectedSha256, ct)).ToHttpResult(Results.Ok);
            })
            .RequirePermission(Permissions.CustomersDelete)
            .RequireRateLimiting(RateLimitPolicies.Migration);

        group.MapGet("/organizations/import/runs", async (string? cursor, int? limit, MigrationRunReader reader, CancellationToken ct) =>
                Results.Ok(await reader.ListAsync(cursor, limit, ct)))
            .RequirePermission(Permissions.CustomersDelete)
            .ExportsData()
            // Paging a run's rows is one request per page of a one-off migration: the hourly limit of the migration itself
            // (not the 10 per hour of a file export) bounds it (F-G1-14).
            .RequireRateLimiting(RateLimitPolicies.Migration);

        group.MapGet("/organizations/import/runs/{id:guid}", async (Guid id, MigrationRunReader reader, CancellationToken ct) =>
                (await reader.GetAsync(id, ct)).ToHttpResult(Results.Ok))
            .RequirePermission(Permissions.CustomersDelete);

        group.MapGet("/organizations/import/runs/{id:guid}/rows", async (
                Guid id, string? action, string? cursor, int? limit, MigrationRunReader reader, CancellationToken ct) =>
                (await reader.RowsAsync(id, action, cursor, limit, ct)).ToHttpResult(Results.Ok))
            .RequirePermission(Permissions.CustomersDelete)
            .ExportsData()
            .RequireRateLimiting(RateLimitPolicies.Migration);

        // The batch marker: what the run created or changed — the compensation list; reading it changes nothing.
        group.MapGet("/organizations/import/runs/{id:guid}/entities", async (
                Guid id, string? cursor, int? limit, MigrationRunReader reader, CancellationToken ct) =>
                (await reader.EntitiesAsync(id, cursor, limit, ct)).ToHttpResult(Results.Ok))
            .RequirePermission(Permissions.CustomersDelete)
            .ExportsData()
            .RequireRateLimiting(RateLimitPolicies.Migration);

        // Cutover reconciliation: the old system's totals against the CRM's register. Reads only.
        group.MapPost("/organizations/import/reconcile", async (HttpRequest request, MigrationReconciliationService service, CancellationToken ct) =>
            {
                var (content, failure) = await CsvUpload.ReadBytesAsync(request, ct);
                return content is null ? failure! : (await service.ReconcileAsync(content, ct)).ToHttpResult(Results.Ok);
            })
            .RequirePermission(Permissions.CustomersDelete)
            .ExportsData()
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

        group.MapGet("/organizations/merges", async (int? limit, string? cursor, ListMergesHandler handler, CancellationToken ct) =>
                Results.Ok(await handler.HandleAsync(new ListMerges(limit, cursor), ct)))
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
