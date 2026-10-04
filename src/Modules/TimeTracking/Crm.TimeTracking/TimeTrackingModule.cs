using Crm.Authorization;
using Crm.Infrastructure.DependencyInjection;
using Crm.Infrastructure.Http;
using Crm.TimeTracking.Contracts;
using Crm.TimeTracking.Features;
using Crm.TimeTracking.Persistence;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace Crm.TimeTracking;

public static class TimeTrackingModule
{
    public static IServiceCollection AddTimeTrackingModule(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddModuleDbContext<TimeTrackingDbContext>(configuration);
        services.AddOptions<TimeTrackingOptions>().Bind(configuration.GetSection(TimeTrackingOptions.SectionName));
        services.AddModuleServices(typeof(TimeTrackingModule).Assembly);
        services.AddScoped<TimeEntryService>();
        services.AddScoped<TimeApprovalService>();
        services.AddScoped<ITimeTrackingApi, TimeImportService>();
        return services;
    }

    public static IEndpointRouteBuilder MapTimeTrackingEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/v1/time").WithTags("Time");

        group.MapGet("/entries", async ([AsParameters] TimeQueryParameters p, TimeEntryService service, CancellationToken ct) =>
                Results.Ok(await service.ListAsync(
                    new TimeQuery(p.Year, p.Month, p.From, p.To, p.OrganizationId, p.TechnicianId, p.Status, p.Source, p.Mine ?? false, p.Limit, p.Cursor), ct)))
            .RequirePermission(Permissions.TimeOwn, Permissions.TimeRead);

        group.MapPost("/entries", async (TimeEntryRequest request, TimeEntryService service, CancellationToken ct) =>
                (await service.CreateAsync(request, ct)).ToHttpResult(e => Results.Created($"/api/v1/time/entries/{e.Id}", e)))
            .Validate<TimeEntryRequest>()
            .RequirePermission(Permissions.TimeOwn, Permissions.TimeManage);

        group.MapPut("/entries/{id:guid}", async (Guid id, TimeEntryRequest request, TimeEntryService service, HttpRequest http, CancellationToken ct) =>
                http.GetIfMatch() is not { } ifMatch
                    ? HeaderExtensions.PreconditionRequired()
                    : (await service.UpdateAsync(id, request, ifMatch, ct)).ToHttpResult(Results.Ok))
            .Validate<TimeEntryRequest>()
            .RequirePermission(Permissions.TimeOwn, Permissions.TimeManage);

        group.MapPost("/entries/{id:guid}/adjust", async (Guid id, AdjustTimeEntryRequest request, TimeEntryService service, CancellationToken ct) =>
                (await service.AdjustAsync(id, request, ct)).ToHttpResult(Results.NoContent))
            .RequirePermission(Permissions.TimeManage);

        group.MapDelete("/entries/{id:guid}", async (Guid id, TimeEntryService service, CancellationToken ct) =>
                (await service.DeleteAsync(id, ct)).ToHttpResult(Results.NoContent))
            .RequirePermission(Permissions.TimeOwn, Permissions.TimeManage);

        group.MapPost("/approve", async (ApproveRequest request, TimeApprovalService service, CancellationToken ct) =>
                (await service.ApproveAsync(request.EntryIds, ct)).ToHttpResult(Results.Ok))
            .RequirePermission(Permissions.TimeManage);

        group.MapPost("/withdraw", async (ApproveRequest request, TimeApprovalService service, CancellationToken ct) =>
                (await service.WithdrawAsync(request.EntryIds, ct)).ToHttpResult(count => Results.Ok(new { withdrawn = count })))
            .RequirePermission(Permissions.TimeManage);

        group.MapGet("/periods", async (int? year, TimeEntryService service, TimeProvider time, CancellationToken ct) =>
                Results.Ok(await service.ListPeriodsAsync(year ?? time.GetUtcNow().Year, ct)))
            .RequirePermission(Permissions.TimeRead, Permissions.TimeManage);

        group.MapPost("/periods/{year:int}/{month:int}/close", async (int year, int month, TimeEntryService service, CancellationToken ct) =>
                (await service.ClosePeriodAsync(year, month, ct)).ToHttpResult(Results.Ok))
            .RequirePermission(Permissions.TimeManage);

        group.MapPost("/periods/{year:int}/{month:int}/reopen", async (int year, int month, ReopenPeriodRequest request, TimeEntryService service, CancellationToken ct) =>
                (await service.ReopenPeriodAsync(year, month, request.Reason, ct)).ToHttpResult(Results.Ok))
            .RequirePermission(Permissions.TimeUnlock);

        group.MapGet("/work-types", async (TimeEntryService service, CancellationToken ct) => Results.Ok(await service.WorkTypesAsync(ct)))
            .RequirePermission(Permissions.TimeOwn, Permissions.TimeRead);

        return app;
    }
}

public sealed record TimeQueryParameters(
    [FromQuery] int? Year,
    [FromQuery] int? Month,
    [FromQuery] DateOnly? From,
    [FromQuery] DateOnly? To,
    [FromQuery] Guid? OrganizationId,
    [FromQuery] Guid? TechnicianId,
    [FromQuery] TimeEntryStatus? Status,
    [FromQuery] TimeSource? Source,
    [FromQuery] bool? Mine,
    [FromQuery] int? Limit,
    [FromQuery] string? Cursor);
