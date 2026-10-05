using Crm.Authorization;
using Crm.Infrastructure.DependencyInjection;
using Crm.Infrastructure.Http;
using Crm.Licensing.Contracts;
using Crm.Licensing.Features;
using Crm.Licensing.Persistence;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

namespace Crm.Licensing;

public static class LicensingModule
{
    public static IServiceCollection AddLicensingModule(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddModuleDbContext<LicensingDbContext>(configuration);
        services.AddOptions<LicensingOptions>().Bind(configuration.GetSection(LicensingOptions.SectionName));
        services.AddModuleServices(typeof(LicensingModule).Assembly);
        services.AddScoped<LicensingService>();
        services.AddScoped<LicenseUsageService>();
        services.AddScoped<Crm.SharedKernel.Operations.IOperationalSignalSource, LicensingOperationalSignals>();
        services.AddScoped<ILicensingApi>(sp => sp.GetRequiredService<LicensingService>());
        return services;
    }

    public static IEndpointRouteBuilder MapLicensingEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/v1/licensing").WithTags("Licensing");

        group.MapGet("/subscriptions", async ([AsParameters] SubscriptionParameters p, LicensingService service, CancellationToken ct) =>
                Results.Ok(await service.ListAsync(new SubscriptionQuery(
                    p.Search, p.OrganizationId, p.Source, p.RenewingSoon ?? false, p.CancellationWindowOpen ?? false, p.NotBilled ?? false, p.WithoutOrganization ?? false,
                    p.Limit, p.Cursor), ct)))
            .RequirePermission(Permissions.LicensingRead);

        group.MapGet("/attention", async (LicensingService service, CancellationToken ct) => Results.Ok(await service.GetAttentionAsync(ct)))
            .RequirePermission(Permissions.LicensingRead);

        // The distributor export is pasted or uploaded as text; ?dryRun=true previews what the file would change (BR-LIC-05).
        group.MapPost("/import", async (HttpRequest request, bool? dryRun, LicensingService service, CancellationToken ct) =>
            {
                using var reader = new StreamReader(request.Body);
                var csv = await reader.ReadToEndAsync(ct);
                return (await service.ImportAsync(csv, dryRun ?? false, ct)).ToHttpResult(Results.Ok);
            })
            .RequirePermission(Permissions.LicensingManage);

        // FR-LIC-03: bought against assigned per SKU; ?unusedOnly=true is the list someone can act on (BR-LIC-04).
        group.MapGet("/usage", async (Guid? organizationId, bool? unusedOnly, LicenseUsageService service, CancellationToken ct) =>
                Results.Ok(await service.GetUsageAsync(organizationId, unusedOnly ?? false, ct)))
            .RequirePermission(Permissions.LicensingRead);

        // FR-LIC-04: what Microsoft charged against what the customer was charged. Cost is finance data, hence the permission.
        group.MapGet("/reconciliation", async (int year, int month, LicenseUsageService service, CancellationToken ct) =>
                (await service.GetReconciliationAsync(year, month, ct)).ToHttpResult(Results.Ok))
            .RequirePermission(Permissions.FinanceCostRead);

        group.MapGet("/reconciliation/periods", async (LicenseUsageService service, CancellationToken ct) =>
                Results.Ok(await service.GetReconciliationPeriodsAsync(ct)))
            .RequirePermission(Permissions.FinanceCostRead);

        // The distributor's invoice file, pasted like the subscription import; ?dryRun=true previews it.
        group.MapPost("/ms-billing/import", async (HttpRequest request, bool? dryRun, LicensingService service, CancellationToken ct) =>
            {
                using var reader = new StreamReader(request.Body);
                var csv = await reader.ReadToEndAsync(ct);
                return (await service.ImportBilledCsvAsync(csv, dryRun ?? false, ct)).ToHttpResult(Results.Ok);
            })
            .RequirePermission(Permissions.FinanceCostRead);

        group.MapGet("/settings", (IOptions<LicensingOptions> options) =>
                Results.Ok(new { cancellationWindowHours = options.Value.CancellationWindowHours, renewalNoticeDays = options.Value.RenewalNoticeDays }))
            .RequirePermission(Permissions.LicensingRead);

        return app;
    }
}

public sealed record SubscriptionParameters(
    [FromQuery] string? Search,
    [FromQuery] Guid? OrganizationId,
    [FromQuery] SubscriptionSource? Source,
    [FromQuery] bool? RenewingSoon,
    [FromQuery] bool? CancellationWindowOpen,
    [FromQuery] bool? NotBilled,
    [FromQuery] bool? WithoutOrganization,
    [FromQuery] int? Limit,
    [FromQuery] string? Cursor);
