using Crm.Authorization;
using Crm.Infrastructure.DependencyInjection;
using Crm.Infrastructure.Http;
using Crm.Infrastructure.Persistence;
using Crm.Privacy.Contracts;
using Crm.Privacy.Features;
using Crm.Privacy.Persistence;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace Crm.Privacy;

/// <summary>
/// Data subject requests, legal holds, suppressions, deletion manifests and retention (DEV-11, ADR-020). The other modules take
/// part through <c>Crm.Privacy.Contracts</c>; this module owns the cases and the evidence, never another module's data.
/// </summary>
public static class PrivacyModule
{
    public static IServiceCollection AddPrivacyModule(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddModuleDbContext<PrivacyDbContext>(configuration);
        services.AddOptions<PrivacyOptions>().Bind(configuration.GetSection(PrivacyOptions.SectionName));
        services.AddModuleServices(typeof(PrivacyModule).Assembly);
        services.AddScoped<PrivacyCaseService>();
        services.AddScoped<LegalHoldService>();
        services.AddScoped<Crm.SharedKernel.Operations.IRestoreParticipant, PrivacyRestoreParticipant>();
        services.AddScoped<SuppressionHasher>();
        services.AddScoped<ISuppressionList, SuppressionList>();
        services.AddScoped<IErasedRecords, ErasedRecords>();
        services.AddSingleton<PrivacyReplayGate>();
        services.AddSingleton<IPrivacyReplayGate>(sp => sp.GetRequiredService<PrivacyReplayGate>());
        services.AddScoped(sp => new PrivacyReplayJob(
            sp.GetRequiredService<PrivacyDbContext>(),
            sp.GetRequiredService<Crm.SharedKernel.Documents.IDocumentStore>(),
            sp.GetServices<IPersonalDataContributor>(),
            sp.GetRequiredService<PrivacyCaseService>(),
            sp.GetRequiredService<PrivacyReplayGate>(),
            sp.GetRequiredService<SuppressionHasher>(),
            sp.GetRequiredService<TimeProvider>(),
            sp.GetRequiredService<Microsoft.Extensions.Logging.ILogger<PrivacyReplayJob>>()));
        services.AddScoped<PrivacyRetentionJob>();
        services.AddSingleton<IDatabasePermissionRules, PrivacyDatabasePermissions>();
        return services;
    }

    public static IEndpointRouteBuilder MapPrivacyEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/v1/privacy").WithTags("Privacy");

        group.MapGet("/cases", async (bool? includeClosed, int? limit, string? cursor, PrivacyCaseService service, CancellationToken ct) =>
                Results.Ok(await service.ListAsync(includeClosed ?? false, limit, cursor, ct)))
            .RequirePermission(Permissions.PrivacyManage);

        group.MapPost("/cases", async (OpenCaseRequest request, PrivacyCaseService service, HttpResponse response, CancellationToken ct) =>
                (await service.OpenAsync(request, ct)).ToHttpResult(c => WithETag(response, c.Etag, Results.Created($"/api/v1/privacy/cases/{c.Id}", c))))
            .Validate<OpenCaseRequest>()
            .RequirePermission(Permissions.PrivacyManage);

        group.MapGet("/cases/{id:guid}", async (Guid id, PrivacyCaseService service, HttpResponse response, CancellationToken ct) =>
                (await service.GetAsync(id, ct)).ToHttpResult(c => WithETag(response, c.Etag, Results.Ok(c))))
            .RequirePermission(Permissions.PrivacyManage);

        group.MapPost("/cases/{id:guid}/verify", async (
                Guid id, VerifyCaseRequest request, PrivacyCaseService service, HttpRequest http, HttpResponse response, CancellationToken ct) =>
                http.GetIfMatch() is not { } ifMatch
                    ? HeaderExtensions.PreconditionRequired()
                    : (await service.VerifyAsync(id, ifMatch, request, ct)).ToHttpResult(c => WithETag(response, c.Etag, Results.Ok(c))))
            .Validate<VerifyCaseRequest>()
            .RequirePermission(Permissions.PrivacyManage);

        group.MapPost("/cases/{id:guid}/reject", async (
                Guid id, RejectCaseRequest request, PrivacyCaseService service, HttpRequest http, HttpResponse response, CancellationToken ct) =>
                http.GetIfMatch() is not { } ifMatch
                    ? HeaderExtensions.PreconditionRequired()
                    : (await service.RejectAsync(id, ifMatch, request, ct)).ToHttpResult(c => WithETag(response, c.Etag, Results.Ok(c))))
            .Validate<RejectCaseRequest>()
            .RequirePermission(Permissions.PrivacyManage);

        group.MapPost("/cases/{id:guid}/preview", async (Guid id, PrivacyCaseService service, HttpRequest http, HttpResponse response, CancellationToken ct) =>
                http.GetIfMatch() is not { } ifMatch
                    ? HeaderExtensions.PreconditionRequired()
                    : (await service.PreviewAsync(id, ifMatch, ct)).ToHttpResult(p => WithETag(response, p.Etag, Results.Ok(p))))
            .RequirePermission(Permissions.PrivacyManage);

        group.MapGet("/cases/{id:guid}/plan", async (Guid id, PrivacyCaseService service, CancellationToken ct) =>
                (await service.GetPlanAsync(id, ct)).ToHttpResult(Results.Ok))
            .RequirePermission(Permissions.PrivacyManage);

        // Everything about a person at once (art. 15): an export, so it needs roles confirmed within minutes (DEV-10).
        group.MapGet("/cases/{id:guid}/export", async (Guid id, PrivacyCaseService service, HttpResponse response, CancellationToken ct) =>
                (await service.ExportAsync(id, ct)).ToHttpResult(file =>
                {
                    response.Headers.ETag = file.Etag;
                    return Results.File(file.Content, "application/json", file.FileName);
                }))
            .RequirePermission(Permissions.PrivacyManage)
            .ExportsData()
            .RequireRateLimiting(RateLimitPolicies.Export);

        group.MapPost("/cases/{id:guid}/execute", async (
                Guid id, ExecuteCaseRequest request, PrivacyCaseService service, HttpRequest http, HttpResponse response, CancellationToken ct) =>
                http.GetIfMatch() is not { } ifMatch
                    ? HeaderExtensions.PreconditionRequired()
                    : (await service.ExecuteAsync(id, ifMatch, request, ct)).ToHttpResult(c => WithETag(response, c.Etag, Results.Ok(c))))
            .Validate<ExecuteCaseRequest>()
            .RequirePermission(Permissions.PrivacyManage);

        group.MapGet("/holds", async (bool? includeEnded, int? limit, string? cursor, LegalHoldService service, CancellationToken ct) =>
                Results.Ok(await service.ListAsync(includeEnded ?? false, limit, cursor, ct)))
            .RequirePermission(Permissions.PrivacyManage);

        group.MapPost("/holds", async (PlaceHoldRequest request, LegalHoldService service, CancellationToken ct) =>
                (await service.PlaceAsync(request, ct)).ToHttpResult(h => Results.Created($"/api/v1/privacy/holds/{h.Id}", h)))
            .Validate<PlaceHoldRequest>()
            .RequirePermission(Permissions.PrivacyManage);

        group.MapPost("/holds/{id:guid}/release", async (Guid id, ReleaseRequest request, LegalHoldService service, HttpRequest http, CancellationToken ct) =>
                http.GetIfMatch() is not { } ifMatch
                    ? HeaderExtensions.PreconditionRequired()
                    : (await service.ReleaseAsync(id, ifMatch, request, ct)).ToHttpResult(Results.Ok))
            .Validate<ReleaseRequest>()
            .RequirePermission(Permissions.PrivacyManage);

        group.MapGet("/suppressions", async (int? limit, string? cursor, LegalHoldService service, CancellationToken ct) =>
                Results.Ok(await service.SuppressionsAsync(limit, cursor, ct)))
            .RequirePermission(Permissions.PrivacyManage);

        group.MapPost("/suppressions/{id:guid}/lift", async (Guid id, ReleaseRequest request, LegalHoldService service, HttpRequest http, CancellationToken ct) =>
                http.GetIfMatch() is not { } ifMatch
                    ? HeaderExtensions.PreconditionRequired()
                    : (await service.LiftAsync(id, ifMatch, request, ct)).ToHttpResult(Results.Ok))
            .Validate<ReleaseRequest>()
            .RequirePermission(Permissions.PrivacyManage);

        group.MapGet("/retention", async (PrivacyDbContext db, Microsoft.Extensions.Options.IOptions<PrivacyOptions> options, CancellationToken ct) =>
            {
                var last = await db.RetentionRuns.AsNoTracking().OrderByDescending(r => r.StartedAt).FirstOrDefaultAsync(ct);
                var policies = await db.RetentionPolicies.AsNoTracking().OrderBy(p => p.DataClass).ToListAsync(ct);
                return Results.Ok(new
                {
                    mode = options.Value.Retention.Mode,
                    policies,
                    proposals = options.Value.Retention.ProposedDays,
                    lastRun = last is null ? null : PrivacyRetentionJob.ToReport(last),
                });
            })
            .RequirePermission(Permissions.PrivacyManage);

        return app;
    }

    private static IResult WithETag(HttpResponse response, string etag, IResult result)
    {
        response.Headers.ETag = etag;
        return result;
    }
}
