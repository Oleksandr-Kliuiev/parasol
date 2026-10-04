using Crm.Authorization;
using Crm.Catalog.Contracts;
using Crm.Infrastructure.DependencyInjection;
using Crm.Infrastructure.Http;
using Crm.Sales.Contracts;
using Crm.Sales.Domain;
using Crm.Sales.Features;
using Crm.Sales.Persistence;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace Crm.Sales;

public static class SalesModule
{
    public static IServiceCollection AddSalesModule(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddModuleDbContext<SalesDbContext>(configuration);
        services.AddModuleServices(typeof(SalesModule).Assembly);
        services.AddOptions<SalesOptions>().Bind(configuration.GetSection(SalesOptions.SectionName));
        services.AddScoped<SalesService>();
        services.AddScoped<QuoteService>();
        services.AddScoped<Crm.SharedKernel.Operations.IRestoreParticipant, SalesRestoreParticipant>();
        services.AddScoped<QuoteExpiryJob>();
        services.AddScoped<QuoteDocuments>();
        services.AddScoped(sp => new QuoteDocumentJob(
            sp.GetRequiredService<SalesDbContext>(),
            sp.GetRequiredService<QuoteDocuments>(),
            sp.GetRequiredService<Crm.SharedKernel.Documents.IDocumentStore>(),
            sp.GetRequiredService<TimeProvider>(),
            sp.GetRequiredService<Microsoft.Extensions.Logging.ILogger<QuoteDocumentJob>>()));
        services.AddSingleton<Crm.Infrastructure.Persistence.IDatabasePermissionRules, SalesDatabasePermissions>();
        services.AddScoped<Crm.SharedKernel.Application.IRecordScopeReporter, QuoteScopeReporter>();
        services.AddScoped<ISalesApi, SalesApi>();
        services.AddScoped<IProductUsage, QuoteProductUsage>();
        // DEV-11: leads and quote recipients in subject requests, and the retention of leads never converted.
        services.AddScoped<Crm.Privacy.Contracts.IDataSubjectResolver, Features.Privacy.LeadSubjectResolver>();
        services.AddScoped<Crm.Privacy.Contracts.IPersonalDataContributor, Features.Privacy.SalesPersonalData>();
        services.AddScoped<Crm.Privacy.Contracts.IRetentionContributor, Features.Privacy.UnconvertedLeadsRetention>();
        return services;
    }

    public static IEndpointRouteBuilder MapSalesEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/v1/sales").WithTags("Sales");

        group.MapGet("/stages", async (bool? includeInactive, SalesService service, CancellationToken ct) =>
                Results.Ok(await service.ListStagesAsync(includeInactive ?? false, ct)))
            .RequirePermission(Permissions.SalesRead);

        group.MapPost("/stages", async (StageRequest request, SalesService service, CancellationToken ct) =>
                (await service.SaveStageAsync(null, request, null, ct)).ToHttpResult(s => Results.Created($"/api/v1/sales/stages/{s.Id}", s)))
            .Validate<StageRequest>()
            .RequirePermission(Permissions.SalesWrite);

        group.MapPut("/stages/{id:guid}", async (Guid id, StageRequest request, SalesService service, HttpRequest http, CancellationToken ct) =>
                http.GetIfMatch() is not { } ifMatch
                    ? HeaderExtensions.PreconditionRequired()
                    : (await service.SaveStageAsync(id, request, ifMatch, ct)).ToHttpResult(Results.Ok))
            .Validate<StageRequest>()
            .RequirePermission(Permissions.SalesWrite);

        group.MapGet("/leads", async (LeadStatus? status, bool? mine, string? search, int? limit, string? cursor, SalesService service, CancellationToken ct) =>
                Results.Ok(await service.ListLeadsAsync(status, mine ?? false, search, limit, cursor, ct)))
            .RequirePermission(Permissions.SalesRead);

        group.MapPost("/leads", async (LeadRequest request, SalesService service, CancellationToken ct) =>
                (await service.CreateLeadAsync(request, ct)).ToHttpResult(l => Results.Created($"/api/v1/sales/leads/{l.Id}", l)))
            .Validate<LeadRequest>()
            .RequirePermission(Permissions.SalesWrite);

        group.MapPut("/leads/{id:guid}", async (Guid id, LeadRequest request, SalesService service, HttpRequest http, CancellationToken ct) =>
                http.GetIfMatch() is not { } ifMatch
                    ? HeaderExtensions.PreconditionRequired()
                    : (await service.UpdateLeadAsync(id, request, ifMatch, ct)).ToHttpResult(Results.Ok))
            .Validate<LeadRequest>()
            .RequirePermission(Permissions.SalesWrite);

        group.MapPost("/leads/{id:guid}/qualify", async (Guid id, SalesService service, CancellationToken ct) =>
                (await service.QualifyLeadAsync(id, ct)).ToHttpResult(Results.Ok))
            .RequirePermission(Permissions.SalesWrite);

        group.MapPost("/leads/{id:guid}/disqualify", async (Guid id, DisqualifyRequest request, SalesService service, CancellationToken ct) =>
                (await service.DisqualifyLeadAsync(id, request.Reason, ct)).ToHttpResult(Results.Ok))
            .RequirePermission(Permissions.SalesWrite);

        group.MapPost("/leads/{id:guid}/convert", async (Guid id, ConvertLeadRequest request, SalesService service, CancellationToken ct) =>
                (await service.ConvertLeadAsync(id, request, ct)).ToHttpResult(Results.Ok))
            .RequirePermission(Permissions.SalesWrite);

        group.MapGet("/opportunities", async ([AsParameters] OpportunityParameters p, SalesService service, CancellationToken ct) =>
                Results.Ok(await service.ListOpportunitiesAsync(
                    new OpportunityQuery(p.Search, p.OrganizationId, p.OwnerId, p.StageId, p.Status, p.Mine ?? false, p.Stale ?? false, p.Limit, p.Cursor), ct)))
            .RequirePermission(Permissions.SalesRead);

        group.MapGet("/pipeline", async ([AsParameters] OpportunityParameters p, SalesService service, CancellationToken ct) =>
                Results.Ok(await service.GetPipelineAsync(
                    new OpportunityQuery(p.Search, p.OrganizationId, p.OwnerId, p.StageId, null, p.Mine ?? false, p.Stale ?? false), ct)))
            .RequirePermission(Permissions.SalesRead);

        group.MapGet("/opportunities/{id:guid}", async (Guid id, SalesService service, CancellationToken ct) =>
                (await service.GetOpportunityAsync(id, ct)).ToHttpResult(Results.Ok))
            .RequirePermission(Permissions.SalesRead);

        group.MapPost("/opportunities", async (OpportunityRequest request, SalesService service, CancellationToken ct) =>
                (await service.CreateOpportunityAsync(request, ct)).ToHttpResult(o => Results.Created($"/api/v1/sales/opportunities/{o.Id}", o)))
            .Validate<OpportunityRequest>()
            .RequirePermission(Permissions.SalesWrite);

        group.MapPut("/opportunities/{id:guid}", async (Guid id, OpportunityRequest request, SalesService service, HttpRequest http, CancellationToken ct) =>
                http.GetIfMatch() is not { } ifMatch
                    ? HeaderExtensions.PreconditionRequired()
                    : (await service.UpdateOpportunityAsync(id, request, ifMatch, ct)).ToHttpResult(Results.Ok))
            .Validate<OpportunityRequest>()
            .RequirePermission(Permissions.SalesWrite);

        group.MapPost("/opportunities/{id:guid}/stage", async (Guid id, MoveStageRequest request, SalesService service, CancellationToken ct) =>
                (await service.MoveOpportunityAsync(id, request, ct)).ToHttpResult(Results.Ok))
            .RequirePermission(Permissions.SalesWrite);

        group.MapPost("/opportunities/{id:guid}/reopen", async (Guid id, SalesService service, CancellationToken ct) =>
                (await service.ReopenOpportunityAsync(id, ct)).ToHttpResult(Results.Ok))
            .RequirePermission(Permissions.SalesWrite);

        // ---------- Quotes (FR-SAL-03..05) ----------

        group.MapGet("/quote-templates", async (bool? includeInactive, QuoteService service, CancellationToken ct) =>
                Results.Ok(await service.ListTemplatesAsync(includeInactive ?? false, ct)))
            .RequirePermission(Permissions.SalesRead);

        group.MapPost("/quote-templates", async (QuoteTemplateRequest request, QuoteService service, CancellationToken ct) =>
                (await service.SaveTemplateAsync(null, request, null, ct)).ToHttpResult(t => Results.Created($"/api/v1/sales/quote-templates/{t.Id}", t)))
            .Validate<QuoteTemplateRequest>()
            .RequirePermission(Permissions.SalesDiscountApprove, Permissions.IntegrationsManage);

        group.MapPut("/quote-templates/{id:guid}", async (Guid id, QuoteTemplateRequest request, QuoteService service, HttpRequest http, CancellationToken ct) =>
                http.GetIfMatch() is not { } ifMatch
                    ? HeaderExtensions.PreconditionRequired()
                    : (await service.SaveTemplateAsync(id, request, ifMatch, ct)).ToHttpResult(Results.Ok))
            .Validate<QuoteTemplateRequest>()
            .RequirePermission(Permissions.SalesDiscountApprove, Permissions.IntegrationsManage);

        group.MapGet("/quotes", async ([AsParameters] QuoteParameters p, QuoteService service, CancellationToken ct) =>
                Results.Ok(await service.ListAsync(
                    new QuoteQuery(p.Search, p.OrganizationId, p.OpportunityId, p.Status, p.Mine ?? false, p.AwaitingApproval ?? false, p.Limit, p.Cursor), ct)))
            .RequirePermission(Permissions.SalesRead);

        group.MapGet("/quotes/{id:guid}", async (Guid id, QuoteService service, CancellationToken ct) =>
                (await service.GetAsync(id, ct)).ToHttpResult(Results.Ok))
            .RequirePermission(Permissions.SalesRead);

        // DEV-08: the stored document, the same bytes the e-mail carried; read right and finance.read, no write right needed.
        group.MapGet("/quotes/{id:guid}/pdf", async (Guid id, int? revision, QuoteService service, HttpResponse response, CancellationToken ct) =>
                (await service.RenderAsync(id, revision, ct)).ToHttpResult(file =>
                {
                    // Cache-Control: no-store comes with every /api response (SecurityHeadersMiddleware).
                    response.Headers.ETag = $"\"{file.Sha256}\"";
                    response.Headers["X-Document-Revision"] = file.Revision.ToString(System.Globalization.CultureInfo.InvariantCulture);
                    response.Headers["X-Document-Origin"] = file.Origin.ToString();
                    response.Headers["X-Document-Sha256"] = file.Sha256;
                    return Results.File(file.Content, QuoteFile.ContentType, file.FileName);
                }))
            .RequirePermission(Permissions.SalesRead);

        group.MapPost("/quotes", async (QuoteRequest request, QuoteService service, CancellationToken ct) =>
                (await service.CreateAsync(request, ct)).ToHttpResult(q => Results.Created($"/api/v1/sales/quotes/{q.Id}", q)))
            .Validate<QuoteRequest>()
            .RequirePermission(Permissions.SalesWrite);

        group.MapPut("/quotes/{id:guid}", async (Guid id, QuoteRequest request, QuoteService service, HttpRequest http, CancellationToken ct) =>
                http.GetIfMatch() is not { } ifMatch
                    ? HeaderExtensions.PreconditionRequired()
                    : (await service.UpdateAsync(id, request, ifMatch, ct)).ToHttpResult(Results.Ok))
            .Validate<QuoteRequest>()
            .RequirePermission(Permissions.SalesWrite);

        group.MapPost("/quotes/{id:guid}/submit", async (Guid id, QuoteService service, CancellationToken ct) =>
                (await service.SubmitAsync(id, ct)).ToHttpResult(Results.Ok))
            .RequirePermission(Permissions.SalesWrite);

        group.MapPost("/quotes/{id:guid}/withdraw", async (Guid id, QuoteService service, CancellationToken ct) =>
                (await service.WithdrawAsync(id, ct)).ToHttpResult(Results.Ok))
            .RequirePermission(Permissions.SalesWrite);

        group.MapPost("/quotes/{id:guid}/approve", async (Guid id, QuoteService service, CancellationToken ct) =>
                (await service.ApproveAsync(id, ct)).ToHttpResult(Results.Ok))
            .RequirePermission(Permissions.SalesDiscountApprove);

        group.MapPost("/quotes/{id:guid}/reject", async (Guid id, RejectQuoteRequest request, QuoteService service, CancellationToken ct) =>
                (await service.RejectAsync(id, request.Reason, ct)).ToHttpResult(Results.Ok))
            .Validate<RejectQuoteRequest>()
            .RequirePermission(Permissions.SalesDiscountApprove);

        group.MapPost("/quotes/{id:guid}/send", async (Guid id, SendQuoteRequest request, QuoteService service, CancellationToken ct) =>
                (await service.SendAsync(id, request, ct)).ToHttpResult(Results.Ok))
            .Validate<SendQuoteRequest>()
            .RequirePermission(Permissions.SalesWrite);

        group.MapPost("/quotes/{id:guid}/accept", async (Guid id, QuoteService service, CancellationToken ct) =>
                (await service.AcceptAsync(id, ct)).ToHttpResult(Results.Ok))
            .RequirePermission(Permissions.SalesWrite);

        group.MapPost("/quotes/{id:guid}/decline", async (Guid id, DeclineQuoteRequest request, QuoteService service, CancellationToken ct) =>
                (await service.DeclineAsync(id, request.Reason, ct)).ToHttpResult(Results.Ok))
            .RequirePermission(Permissions.SalesWrite);

        group.MapPost("/quotes/{id:guid}/cancel", async (Guid id, QuoteService service, CancellationToken ct) =>
                (await service.CancelAsync(id, ct)).ToHttpResult(Results.Ok))
            .RequirePermission(Permissions.SalesWrite);

        group.MapPost("/quotes/{id:guid}/revise", async (Guid id, QuoteService service, CancellationToken ct) =>
                (await service.ReviseAsync(id, ct)).ToHttpResult(q => Results.Created($"/api/v1/sales/quotes/{q.Id}", q)))
            .RequirePermission(Permissions.SalesWrite);

        // DEV-09: the caller may lose sight of the quote, so the answer carries no quote.
        group.MapPost("/quotes/{id:guid}/transfer", async (Guid id, TransferQuoteRequest request, QuoteService service, HttpRequest http, CancellationToken ct) =>
                http.GetIfMatch() is not { } ifMatch
                    ? HeaderExtensions.PreconditionRequired()
                    : (await service.TransferAsync(id, request, ifMatch, ct)).ToHttpResult(Results.NoContent))
            .Validate<TransferQuoteRequest>()
            .RequirePermission(Permissions.SalesWrite);

        return app;
    }
}

public sealed record QuoteParameters(
    [FromQuery] string? Search,
    [FromQuery] Guid? OrganizationId,
    [FromQuery] Guid? OpportunityId,
    [FromQuery] QuoteStatus? Status,
    [FromQuery] bool? Mine,
    [FromQuery] bool? AwaitingApproval,
    [FromQuery] int? Limit,
    [FromQuery] string? Cursor);

public sealed record OpportunityParameters(
    [FromQuery] string? Search,
    [FromQuery] Guid? OrganizationId,
    [FromQuery] Guid? OwnerId,
    [FromQuery] Guid? StageId,
    [FromQuery] OpportunityStatus? Status,
    [FromQuery] bool? Mine,
    [FromQuery] bool? Stale,
    [FromQuery] int? Limit,
    [FromQuery] string? Cursor);
