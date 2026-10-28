using Crm.Authorization;
using Crm.Backup.Contracts;
using Crm.Backup.Features;
using Crm.Backup.Persistence;
using Crm.Infrastructure.DependencyInjection;
using Crm.Infrastructure.Http;
using Crm.Service.Contracts;
using Crm.SharedKernel.Results;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace Crm.Backup;

/// <summary>
/// The backup module (M40.S, filled in M42): the customers' Microsoft 365 backups at CloudAlly as the integration reads them, the
/// Sikkerhetskopi tab's reads, and the coverage rules about backups — a failed, late or paused backup, and licensed users nobody
/// backs up. The integration writes through <see cref="IBackupApi"/>; nothing here calls a provider.
/// </summary>
public static class BackupModule
{
    public static IServiceCollection AddBackupModule(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddModuleDbContext<BackupDbContext>(configuration);
        services.AddModuleServices(typeof(BackupModule).Assembly);
        services.AddOptions<BackupOptions>().Bind(configuration.GetSection(BackupOptions.SectionName));
        services.AddScoped<IBackupApi, BackupApi>();
        services.AddScoped<BackupQueries>();
        services.AddScoped<IBackupFacts, BackupFacts>();
        services.AddScoped<LicensedUsers>();
        // Global search finds the people and sites in the customers' backups, with the rights of the tab that shows them.
        services.AddScoped<Crm.SharedKernel.Application.ISearchProvider, BackupSearchProvider>();
        // M42: the coverage rules of backups, checked by the Service module after each complete read of CloudAlly.
        services.AddScoped<ICoverageRule, BackupFailedRule>();
        services.AddScoped<ICoverageRule, BackupLateRule>();
        services.AddScoped<ICoverageRule, BackupPausedRule>();
        services.AddScoped<ICoverageRule, LicensedUserNotBackedUpRule>();
        return services;
    }

    public static IEndpointRouteBuilder MapBackupEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/v1/backup").WithTags("Backup");

        // The customer's backups as saved: read with the rights of the Drift area, whose part they are.
        group.MapGet("/organizations/{organizationId:guid}", async (Guid organizationId, BackupQueries queries, CancellationToken ct) =>
                Results.Ok(await queries.OverviewAsync(organizationId, ct)))
            .RequirePermission(Permissions.ServiceRead);

        group.MapGet("/organizations/{organizationId:guid}/entities", async (
                Guid organizationId, BackupService? service, string? state, string? q, string? cursor, int? limit, BackupQueries queries,
                CancellationToken ct) =>
                (await queries.EntitiesAsync(organizationId, service, state, q, cursor, limit, ct)).ToHttpResult(Results.Ok))
            .RequirePermission(Permissions.ServiceRead);

        return app;
    }
}
