using Crm.Authorization;
using Crm.Billing.Contracts;
using Crm.Billing.Features;
using Crm.Billing.Persistence;
using Crm.Catalog.Contracts;
using Crm.Infrastructure.DependencyInjection;
using Crm.Infrastructure.Http;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

namespace Crm.Billing;

public static class BillingModule
{
    public static IServiceCollection AddBillingModule(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddModuleDbContext<BillingDbContext>(configuration);
        services.AddOptions<BillingOptions>().Bind(configuration.GetSection(BillingOptions.SectionName));
        services.AddModuleServices(typeof(BillingModule).Assembly);
        services.AddScoped<ChargeLedger>();
        services.AddScoped<BillingCollector>();
        services.AddScoped<BillingService>();
        services.AddScoped<IBillingApi, BillingApi>();
        services.AddScoped<IProductUsage, BillingProductUsage>();
        services.AddSingleton<Crm.Infrastructure.Persistence.IDatabasePermissionRules, BillingDatabasePermissions>();
        return services;
    }

    public static IEndpointRouteBuilder MapBillingEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/v1/billing").WithTags("Billing");

        group.MapGet("/runs", async ([AsParameters] RunParameters p, BillingService service, CancellationToken ct) =>
                Results.Ok(await service.ListRunsAsync(new RunQuery(p.Status, p.Year, p.Limit, p.Cursor, p.OpenOnly ?? false), ct)))
            .RequirePermission(Permissions.BillingRead);

        group.MapGet("/runs/{id:guid}", async (Guid id, BillingService service, HttpResponse response, CancellationToken ct) =>
                (await service.GetRunAsync(id, ct)).ToHttpResult(run => WithETag(response, run.Etag, Results.Ok(run))))
            .RequirePermission(Permissions.BillingRead);

        group.MapPost("/runs", async (CreateRunRequest request, BillingService service, CancellationToken ct) =>
                (await service.CreateRunAsync(request, ct)).ToHttpResult(run => Results.Created($"/api/v1/billing/runs/{run.Id}", run)))
            .Validate<CreateRunRequest>()
            .RequirePermission(Permissions.BillingManage);

        // Collect and both approvals carry the run's ETag (If-Match): an approval is about the revision the user saw (ADR-012).
        group.MapPost("/runs/{id:guid}/collect", async (Guid id, BillingService service, HttpRequest http, CancellationToken ct) =>
                http.GetIfMatch() is not { } ifMatch
                    ? HeaderExtensions.PreconditionRequired()
                    : (await service.CollectAsync(id, ifMatch, ct)).ToHttpResult(Results.Ok))
            .RequirePermission(Permissions.BillingManage);

        group.MapPost("/runs/{id:guid}/review", async (Guid id, BillingService service, CancellationToken ct) =>
                (await service.ReviewAsync(id, ct)).ToHttpResult(Results.Ok))
            .RequirePermission(Permissions.BillingManage);

        group.MapPost("/runs/{id:guid}/approve", async (Guid id, BillingService service, HttpRequest http, CancellationToken ct) =>
                http.GetIfMatch() is not { } ifMatch
                    ? HeaderExtensions.PreconditionRequired()
                    : (await service.ApproveAsync(id, second: false, ifMatch, ct)).ToHttpResult(Results.Ok))
            .RequirePermission(Permissions.BillingApprove);

        // BR-BIL-04: a run with a basis above the threshold also needs Management.
        group.MapPost("/runs/{id:guid}/second-approve", async (Guid id, BillingService service, HttpRequest http, CancellationToken ct) =>
                http.GetIfMatch() is not { } ifMatch
                    ? HeaderExtensions.PreconditionRequired()
                    : (await service.ApproveAsync(id, second: true, ifMatch, ct)).ToHttpResult(Results.Ok))
            .RequirePermission(Permissions.BillingApproveSecond);

        group.MapPost("/runs/{id:guid}/export", async (Guid id, BillingService service, CancellationToken ct) =>
                (await service.StartExportAsync(id, ct)).ToHttpResult(Results.Ok))
            .RequirePermission(Permissions.BillingManage);

        group.MapPost("/runs/{id:guid}/close", async (Guid id, BillingService service, CancellationToken ct) =>
                (await service.CloseAsync(id, ct)).ToHttpResult(Results.Ok))
            .RequirePermission(Permissions.BillingManage);

        group.MapDelete("/runs/{id:guid}", async (Guid id, BillingService service, HttpRequest http, CancellationToken ct) =>
                http.GetIfMatch() is not { } ifMatch
                    ? HeaderExtensions.PreconditionRequired()
                    : (await service.DiscardAsync(id, ifMatch, ct)).ToHttpResult(Results.NoContent))
            .RequirePermission(Permissions.BillingManage);

        group.MapGet("/runs/{id:guid}/bases", async (Guid id, bool? anomaliesOnly, BillingBasisStatus? status, string? search, BillingService service, CancellationToken ct) =>
                (await service.ListBasesAsync(new BasisQuery(id, anomaliesOnly ?? false, status, search), ct)).ToHttpResult(Results.Ok))
            .RequirePermission(Permissions.BillingRead);

        group.MapGet("/bases/{id:guid}", async (Guid id, BillingService service, HttpResponse response, CancellationToken ct) =>
                (await service.GetBasisAsync(id, ct)).ToHttpResult(basis => WithETag(response, basis.Etag, Results.Ok(basis))))
            .RequirePermission(Permissions.BillingRead);

        group.MapPost("/bases/{id:guid}/lines", async (Guid id, ManualLineRequest request, BillingService service, HttpRequest http, CancellationToken ct) =>
                http.GetIfMatch() is not { } ifMatch
                    ? HeaderExtensions.PreconditionRequired()
                    : (await service.AddLineAsync(id, request, ifMatch, ct)).ToHttpResult(Results.Ok))
            .Validate<ManualLineRequest>()
            .RequirePermission(Permissions.BillingManage);

        group.MapPut("/bases/{id:guid}/lines/{lineId:guid}", async (
                    Guid id, Guid lineId, AdjustLineRequest request, BillingService service, HttpRequest http, CancellationToken ct) =>
                http.GetIfMatch() is not { } ifMatch
                    ? HeaderExtensions.PreconditionRequired()
                    : (await service.AdjustLineAsync(id, lineId, request, ifMatch, ct)).ToHttpResult(Results.Ok))
            .Validate<AdjustLineRequest>()
            .RequirePermission(Permissions.BillingManage);

        group.MapDelete("/bases/{id:guid}/lines/{lineId:guid}", async (Guid id, Guid lineId, BillingService service, HttpRequest http, CancellationToken ct) =>
                http.GetIfMatch() is not { } ifMatch
                    ? HeaderExtensions.PreconditionRequired()
                    : (await service.RemoveLineAsync(id, lineId, ifMatch, ct)).ToHttpResult(Results.Ok))
            .RequirePermission(Permissions.BillingManage);

        // A collected line is never deleted outright: it is excluded with a reason, so the next collect cannot bring it back (BR-BIL-02).
        group.MapPost("/bases/{id:guid}/lines/{lineId:guid}/exclude", async (
                    Guid id, Guid lineId, LineDecisionRequest request, BillingService service, HttpRequest http, CancellationToken ct) =>
                http.GetIfMatch() is not { } ifMatch
                    ? HeaderExtensions.PreconditionRequired()
                    : (await service.ExcludeLineAsync(id, lineId, request, ifMatch, ct)).ToHttpResult(Results.Ok))
            .Validate<LineDecisionRequest>()
            .RequirePermission(Permissions.BillingManage);

        group.MapPost("/bases/{id:guid}/lines/{lineId:guid}/revert", async (Guid id, Guid lineId, BillingService service, HttpRequest http, CancellationToken ct) =>
                http.GetIfMatch() is not { } ifMatch
                    ? HeaderExtensions.PreconditionRequired()
                    : (await service.RevertLineAsync(id, lineId, ifMatch, ct)).ToHttpResult(Results.Ok))
            .RequirePermission(Permissions.BillingManage);

        group.MapPost("/bases/{id:guid}/lines/{lineId:guid}/keep", async (
                    Guid id, Guid lineId, LineDecisionRequest request, BillingService service, HttpRequest http, CancellationToken ct) =>
                http.GetIfMatch() is not { } ifMatch
                    ? HeaderExtensions.PreconditionRequired()
                    : (await service.KeepLineAsync(id, lineId, request, ifMatch, ct)).ToHttpResult(Results.Ok))
            .Validate<LineDecisionRequest>()
            .RequirePermission(Permissions.BillingManage);

        group.MapGet("/legacy-lines", async (BillingService service, CancellationToken ct) => Results.Ok(await service.LegacyLinesAsync(ct)))
            .RequirePermission(Permissions.BillingManage);

        group.MapPost("/bases/{id:guid}/retry", async (Guid id, BillingService service, CancellationToken ct) =>
                (await service.RetryAsync(id, ct)).ToHttpResult(Results.Ok))
            .RequirePermission(Permissions.BillingManage);

        // Cancelling a basis of an open run changes what the run invoices, so it needs the basis the user saw (ADR-012).
        group.MapPost("/bases/{id:guid}/cancel", async (Guid id, CancelBasisRequest request, BillingService service, HttpRequest http, CancellationToken ct) =>
                http.GetIfMatch() is not { } ifMatch
                    ? HeaderExtensions.PreconditionRequired()
                    : (await service.CancelAsync(id, request, ifMatch, ct)).ToHttpResult(Results.Ok))
            .Validate<CancelBasisRequest>()
            .RequirePermission(Permissions.BillingManage);

        // ADR-013: a basis whose send got no answer is reconciled by a person who checked the accounting system.
        group.MapPost("/bases/{id:guid}/reconcile", async (Guid id, ReconcileRequest request, BillingService service, HttpRequest http, CancellationToken ct) =>
                http.GetIfMatch() is not { } ifMatch
                    ? HeaderExtensions.PreconditionRequired()
                    : (await service.ReconcileAsync(id, request, ifMatch, ct)).ToHttpResult(Results.Ok))
            .Validate<ReconcileRequest>()
            .RequirePermission(Permissions.BillingManage);

        // An exported line is corrected with a new charge for the next run, never by changing the exported order (BR-BIL-10).
        group.MapPost("/bases/{id:guid}/lines/{lineId:guid}/corrections", async (
                    Guid id, Guid lineId, CorrectionRequest request, BillingService service, CancellationToken ct) =>
                (await service.AddCorrectionAsync(id, lineId, request, ct)).ToHttpResult(c => Results.Created($"/api/v1/billing/bases/{id}", c)))
            .Validate<CorrectionRequest>()
            .RequirePermission(Permissions.BillingManage);

        group.MapGet("/charges/legacy", async (BillingService service, CancellationToken ct) => Results.Ok(await service.LegacyChargesAsync(ct)))
            .RequirePermission(Permissions.BillingManage);

        group.MapPost("/charges/{id:guid}/legacy-decision", async (Guid id, LegacyDecisionRequest request, BillingService service, HttpRequest http, CancellationToken ct) =>
                http.GetIfMatch() is not { } ifMatch
                    ? HeaderExtensions.PreconditionRequired()
                    : (await service.DecideLegacyAsync(id, request, ifMatch, ct)).ToHttpResult(Results.NoContent))
            .Validate<LegacyDecisionRequest>()
            .RequirePermission(Permissions.BillingManage);

        group.MapGet("/invoices", async ([AsParameters] InvoiceParameters p, BillingService service, CancellationToken ct) =>
                Results.Ok(await service.ListInvoicesAsync(new InvoiceQuery(p.OrganizationId, p.OpenOnly ?? false, p.OverdueOnly ?? false, p.Limit, p.Cursor), ct)))
            .RequirePermission(Permissions.BillingRead);

        group.MapGet("/settings", (IOptions<BillingOptions> options) => Results.Ok(new
                {
                    secondApprovalThreshold = options.Value.SecondApprovalThreshold,
                    totalChangeAnomalyPct = options.Value.TotalChangeAnomalyPct,
                    detailedHourLines = options.Value.DetailedHourLines,
                }))
            .RequirePermission(Permissions.BillingRead);

        return app;
    }

    private static IResult WithETag(HttpResponse response, string etag, IResult result)
    {
        response.Headers.ETag = etag;
        return result;
    }
}

public sealed record RunParameters(
    [FromQuery] BillingRunStatus? Status, [FromQuery] int? Year, [FromQuery] int? Limit, [FromQuery] string? Cursor, [FromQuery] bool? OpenOnly);

public sealed record InvoiceParameters(
    [FromQuery] Guid? OrganizationId, [FromQuery] bool? OpenOnly, [FromQuery] bool? OverdueOnly, [FromQuery] int? Limit, [FromQuery] string? Cursor);

/// <summary>A product that has ever been billed stays in the catalog (BR-CAT-03).</summary>
internal sealed class BillingProductUsage(BillingDbContext db) : IProductUsage
{
    public Task<bool> IsUsedAsync(Guid productId, CancellationToken cancellationToken) =>
        db.BillingLines.IgnoreQueryFilters().AnyAsync(l => l.ProductId == productId, cancellationToken);
}
