using Crm.Authorization;
using Crm.Catalog.Contracts;
using Crm.Contracts.Contracts;
using Crm.Contracts.Domain;
using Crm.Contracts.Features;
using Crm.Contracts.Persistence;
using Crm.Infrastructure.DependencyInjection;
using Crm.Infrastructure.Http;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace Crm.Contracts;

public static class ContractsModule
{
    public static IServiceCollection AddContractsModule(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddModuleDbContext<ContractsDbContext>(configuration);
        services.AddModuleServices(typeof(ContractsModule).Assembly);
        services.AddScoped<ContractService>();
        services.AddScoped<SlaPolicyService>();
        services.AddScoped<HourBankService>();
        services.AddScoped<ReminderService>();
        services.AddScoped<IndexationService>();
        services.AddScoped<ContractLifecycleJob>();
        services.AddScoped<IContractsApi, ContractsApi>();
        services.AddScoped<IProductUsage, ContractProductUsage>();
        return services;
    }

    public static IEndpointRouteBuilder MapContractsEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/v1/contracts").WithTags("Contracts");
        MapSlaPolicies(group);
        MapHourBanks(group);
        MapReminders(group);
        MapIndexation(group);
        MapContracts(group);
        return app;
    }

    /// <summary>Yearly price indexation (FR-CON-05): the preview answers "what would this cost", the apply writes new line versions.</summary>
    private static void MapIndexation(RouteGroupBuilder group)
    {
        group.MapGet("/indexation/preview", async (
                decimal percent, DateOnly effectiveFrom, Guid? organizationId, IndexationService service, CancellationToken ct) =>
                Results.Ok(await service.PreviewAsync(percent, effectiveFrom, organizationId, ct)))
            .RequirePermission(Permissions.ContractsWrite);

        group.MapPost("/indexation", async (IndexationRequest request, IndexationService service, CancellationToken ct) =>
                (await service.ApplyAsync(request, ct)).ToHttpResult(Results.Ok))
            .Validate<IndexationRequest>()
            .RequirePermission(Permissions.ContractsWrite);
    }

    private static void MapContracts(RouteGroupBuilder group)
    {
        group.MapGet("/", async ([AsParameters] ContractListParameters p, ContractService service, CancellationToken ct) =>
                Results.Ok(await service.ListAsync(new ContractQuery(p.Search, p.OrganizationId, p.Status, p.OwnerId, p.EndingWithinDays, p.Cursor, p.Limit), ct)))
            .RequirePermission(Permissions.ContractsRead);

        group.MapGet("/{id:guid}", async (Guid id, ContractService service, HttpResponse response, CancellationToken ct) =>
                (await service.GetAsync(id, ct)).ToHttpResult(v => WithETag(response, v)))
            .RequirePermission(Permissions.ContractsRead);

        group.MapPost("/", async (ContractRequest request, ContractService service, HttpResponse response, CancellationToken ct) =>
                (await service.CreateAsync(request, ct)).ToHttpResult(v =>
                {
                    response.Headers.ETag = v.Etag;
                    return Results.Created($"/api/v1/contracts/{v.Value.Id}", v.Value);
                }))
            .Validate<ContractRequest>()
            .RequirePermission(Permissions.ContractsWrite);

        group.MapPut("/{id:guid}", async (Guid id, ContractRequest request, ContractService service, HttpRequest httpRequest, HttpResponse response, CancellationToken ct) =>
                httpRequest.GetIfMatch() is not { } ifMatch
                    ? HeaderExtensions.PreconditionRequired()
                    : (await service.UpdateAsync(id, request, ifMatch, ct)).ToHttpResult(v => WithETag(response, v)))
            .Validate<ContractRequest>()
            .RequirePermission(Permissions.ContractsWrite);

        group.MapDelete("/{id:guid}", async (Guid id, ContractService service, CancellationToken ct) =>
                (await service.DeleteAsync(id, ct)).ToHttpResult(Results.NoContent))
            .RequirePermission(Permissions.ContractsWrite);

        group.MapPost("/{id:guid}/activate", async (Guid id, ContractService service, HttpResponse response, CancellationToken ct) =>
                (await service.TransitionAsync(id, c => c.Activate(), ct)).ToHttpResult(v => WithETag(response, v)))
            .RequirePermission(Permissions.ContractsWrite);

        group.MapPost("/{id:guid}/suspend", async (Guid id, ContractService service, HttpResponse response, CancellationToken ct) =>
                (await service.TransitionAsync(id, c => c.Suspend(), ct)).ToHttpResult(v => WithETag(response, v)))
            .RequirePermission(Permissions.ContractsWrite);

        group.MapPost("/{id:guid}/notice", async (Guid id, NoticeRequest request, ContractService service, TimeProvider time, HttpResponse response, CancellationToken ct) =>
                (await service.TransitionAsync(id, c => c.GiveNotice(request.NoticeDate ?? time.Today(), request.EndDate), ct)).ToHttpResult(v => WithETag(response, v)))
            .RequirePermission(Permissions.ContractsWrite);

        group.MapPost("/{id:guid}/withdraw-notice", async (Guid id, ContractService service, HttpResponse response, CancellationToken ct) =>
                (await service.TransitionAsync(id, c => c.WithdrawNotice(), ct)).ToHttpResult(v => WithETag(response, v)))
            .RequirePermission(Permissions.ContractsWrite);

        group.MapPost("/{id:guid}/end", async (Guid id, EndRequest request, ContractService service, TimeProvider time, HttpResponse response, CancellationToken ct) =>
                (await service.TransitionAsync(id, c => c.End(request.EndDate ?? time.Today()), ct)).ToHttpResult(v => WithETag(response, v)))
            .RequirePermission(Permissions.ContractsWrite);

        group.MapPost("/{id:guid}/lines", async (Guid id, LineRequest request, ContractService service, HttpResponse response, CancellationToken ct) =>
                (await service.AddLineAsync(id, request, ct)).ToHttpResult(v => WithETag(response, v)))
            .Validate<LineRequest>()
            .RequirePermission(Permissions.ContractsWrite);

        group.MapPost("/{id:guid}/lines/{lineId:guid}/revise", async (
                Guid id, Guid lineId, ReviseLineRequest request, ContractService service, HttpResponse response, CancellationToken ct) =>
                (await service.ReviseLineAsync(id, lineId, request, ct)).ToHttpResult(v => WithETag(response, v)))
            .Validate<ReviseLineRequest>()
            .RequirePermission(Permissions.ContractsWrite);

        group.MapPost("/{id:guid}/lines/{lineId:guid}/end", async (
                Guid id, Guid lineId, EndLineRequest request, ContractService service, HttpResponse response, CancellationToken ct) =>
                (await service.EndLineAsync(id, lineId, request.EndDate, ct)).ToHttpResult(v => WithETag(response, v)))
            .RequirePermission(Permissions.ContractsWrite);

        group.MapDelete("/{id:guid}/lines/{lineId:guid}", async (Guid id, Guid lineId, ContractService service, HttpResponse response, CancellationToken ct) =>
                (await service.RemoveLineAsync(id, lineId, ct)).ToHttpResult(v => WithETag(response, v)))
            .RequirePermission(Permissions.ContractsWrite);
    }

    private static void MapSlaPolicies(RouteGroupBuilder group)
    {
        group.MapGet("/sla-policies", async (bool? includeInactive, SlaPolicyService service, CancellationToken ct) =>
                Results.Ok(await service.ListAsync(includeInactive ?? false, ct)))
            .RequirePermission(Permissions.ContractsRead);

        group.MapPost("/sla-policies", async (SlaPolicyRequest request, SlaPolicyService service, CancellationToken ct) =>
                (await service.SaveAsync(null, request, null, ct)).ToHttpResult(p => Results.Created($"/api/v1/contracts/sla-policies/{p.Id}", p)))
            .Validate<SlaPolicyRequest>()
            .RequirePermission(Permissions.ContractsWrite);

        group.MapPut("/sla-policies/{id:guid}", async (Guid id, SlaPolicyRequest request, SlaPolicyService service, HttpRequest httpRequest, CancellationToken ct) =>
                httpRequest.GetIfMatch() is not { } ifMatch
                    ? HeaderExtensions.PreconditionRequired()
                    : (await service.SaveAsync(id, request, ifMatch, ct)).ToHttpResult(Results.Ok))
            .Validate<SlaPolicyRequest>()
            .RequirePermission(Permissions.ContractsWrite);
    }

    private static void MapHourBanks(RouteGroupBuilder group)
    {
        group.MapGet("/hour-banks", async (Guid? organizationId, Guid? contractId, bool? includeClosed, int? limit, string? cursor, HourBankService service, CancellationToken ct) =>
                Results.Ok(await service.ListAsync(organizationId, contractId, includeClosed ?? false, limit, cursor, ct)))
            .RequirePermission(Permissions.ContractsRead);

        group.MapGet("/hour-banks/{id:guid}", async (Guid id, HourBankService service, CancellationToken ct) =>
                (await service.GetAsync(id, ct)).ToHttpResult(Results.Ok))
            .RequirePermission(Permissions.ContractsRead);

        group.MapPost("/hour-banks", async (CreateHourBankRequest request, HourBankService service, CancellationToken ct) =>
                (await service.CreateAsync(request, ct)).ToHttpResult(b => Results.Created($"/api/v1/contracts/hour-banks/{b.Id}", b)))
            .Validate<CreateHourBankRequest>()
            .RequirePermission(Permissions.ContractsWrite);

        group.MapPost("/hour-banks/{id:guid}/entries", async (Guid id, HourBankEntryRequest request, HourBankService service, CancellationToken ct) =>
                (await service.AddEntryAsync(id, request, ct)).ToHttpResult(Results.Ok))
            .Validate<HourBankEntryRequest>()
            .RequirePermission(Permissions.ContractsWrite);

        group.MapPost("/hour-banks/{id:guid}/close", async (Guid id, HourBankService service, CancellationToken ct) =>
                (await service.CloseAsync(id, ct)).ToHttpResult(Results.NoContent))
            .RequirePermission(Permissions.ContractsWrite);
    }

    private static void MapReminders(RouteGroupBuilder group)
    {
        group.MapGet("/reminders", async (bool? mine, bool? includeAcknowledged, Guid? organizationId, int? limit, string? cursor, ReminderService service, CancellationToken ct) =>
                Results.Ok(await service.ListAsync(mine ?? true, includeAcknowledged ?? false, organizationId, limit, cursor, ct)))
            .RequirePermission(Permissions.ContractsRead);

        group.MapPost("/reminders/{id:guid}/acknowledge", async (Guid id, ReminderService service, CancellationToken ct) =>
                (await service.AcknowledgeAsync(id, ct)).ToHttpResult(Results.NoContent))
            .RequirePermission(Permissions.ContractsRead);
    }

    private static IResult WithETag(HttpResponse response, Versioned<ContractResponse> versioned)
    {
        response.Headers.ETag = versioned.Etag;
        return Results.Ok(versioned.Value);
    }
}

public sealed record ContractListParameters(
    [FromQuery] string? Search,
    [FromQuery] Guid? OrganizationId,
    [FromQuery] ContractStatus? Status,
    [FromQuery] Guid? OwnerId,
    [FromQuery] int? EndingWithinDays,
    [FromQuery] string? Cursor,
    [FromQuery] int? Limit);
