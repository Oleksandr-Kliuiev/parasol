using Crm.Authorization;
using Crm.Infrastructure.DependencyInjection;
using Crm.Infrastructure.Http;
using Crm.Security.Contracts;
using Crm.Security.Features;
using Crm.Security.Persistence;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace Crm.Security;

/// <summary>
/// The security module (M40.S, filled in M41, schema <c>security</c>): the mirror of Huntress's incidents with their remediation plans
/// and comments, its escalations and platform actions, summary reports and usage. Its integration writes it through
/// <see cref="ISecurityApi"/>; the alerts people work with stay in the Service module.
/// </summary>
public static class SecurityModule
{
    public static IServiceCollection AddSecurityModule(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddModuleDbContext<SecurityDbContext>(configuration);
        services.AddModuleServices(typeof(SecurityModule).Assembly);
        services.AddScoped<ISecurityApi, SecurityMirror>();
        services.AddScoped<SecurityQueries>();
        // M43: the monthly reports for the filing of their PDFs and the CRM's monthly summary.
        services.AddScoped<ISecurityReports, SecurityReports>();
        // DEV-11: closed incidents and resolved notices name the customer's staff; they go after the approved period.
        services.AddScoped<Crm.Privacy.Contracts.IRetentionContributor, SecurityRetention>();
        return services;
    }

    /// <summary>
    /// What the interface reads (M41): an incident or a notice behind an alert of the source, and a customer's overview. Reading needs
    /// the right to read operations (<c>service.read</c>), as the alerts do.
    /// </summary>
    public static IEndpointRouteBuilder MapSecurityEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/v1/security").WithTags("Security");

        group.MapGet("/{system}/incidents/{externalId:long}", async (string system, long externalId, SecurityQueries queries, CancellationToken ct) =>
                (await queries.IncidentAsync(system, externalId, ct)).ToHttpResult(Results.Ok))
            .RequirePermission(Permissions.ServiceRead);

        group.MapGet("/{system}/escalations/{externalId:long}", async (string system, long externalId, SecurityQueries queries, CancellationToken ct) =>
                (await queries.NoticeAsync(system, NoticeKind.Escalation, externalId, ct)).ToHttpResult(Results.Ok))
            .RequirePermission(Permissions.ServiceRead);

        group.MapGet("/{system}/platform-actions/{externalId:long}", async (string system, long externalId, SecurityQueries queries, CancellationToken ct) =>
                (await queries.NoticeAsync(system, NoticeKind.PlatformAction, externalId, ct)).ToHttpResult(Results.Ok))
            .RequirePermission(Permissions.ServiceRead);

        group.MapGet("/organizations/{organizationId:guid}/overview", async (Guid organizationId, SecurityQueries queries, CancellationToken ct) =>
                Results.Ok(await queries.OverviewAsync(organizationId, ct)))
            .RequirePermission(Permissions.ServiceRead);

        return app;
    }
}
