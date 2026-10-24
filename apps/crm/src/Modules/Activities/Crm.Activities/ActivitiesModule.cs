using Crm.Activities.Contracts;
using Crm.Activities.Features;
using Crm.Activities.Persistence;
using Crm.Authorization;
using Crm.Infrastructure.DependencyInjection;
using Crm.Infrastructure.Http;
using Crm.SharedKernel.Results;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace Crm.Activities;

public static class ActivitiesModule
{
    public static IServiceCollection AddActivitiesModule(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddModuleDbContext<ActivitiesDbContext>(configuration);
        services.AddModuleServices(typeof(ActivitiesModule).Assembly);
        services.AddScoped<ActivityService>();
        services.AddScoped<ActivityTicketService>();
        services.AddScoped<ITaskWorkApi, TaskWorkApi>();
        services.AddScoped<OutlookService>();
        services.AddScoped<IActivitiesApi, SourceTaskApi>();
        // UX 2026, В6: open and overdue work per organization for the customer list.
        services.AddScoped<IActivityFacts, ActivityFacts>();
        services.AddScoped<Crm.SharedKernel.Operations.IRestoreParticipant, ActivitiesRestoreParticipant>();
        // DEV-11: activities with or from a person in subject requests.
        services.AddScoped<Crm.Privacy.Contracts.IPersonalDataContributor, Features.Privacy.ActivitiesPersonalData>();
        return services;
    }

    public static IEndpointRouteBuilder MapActivitiesEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/v1/activities").WithTags("Activities");

        group.MapGet("/", async ([AsParameters] ActivityParameters p, ActivityService service, HttpRequest http, CancellationToken ct) =>
            {
                // Nullable GUID binding treats an explicitly empty selector as absent. Never broaden that into a timeline.
                if (http.Query.ContainsKey(nameof(p.ActivityId)) && p.ActivityId is null)
                    return Error.Validation("ACT_SELECTION_SCOPE_REQUIRED", "Select an activity within its customer.").ToProblem();
                return (await service.ListAsync(
                    new ActivityQuery(p.OrganizationId, p.OpportunityId, p.ContractId, p.Type, p.Mine ?? false, p.Open ?? false, p.Limit, p.Cursor, p.ActivityId), ct))
                    .ToHttpResult(Results.Ok);
            })
            .RequirePermission(Permissions.ActivitiesRead);

        group.MapPost("/", async (ActivityRequest request, ActivityService service, CancellationToken ct) =>
                (await service.CreateAsync(request, ct)).ToHttpResult(a => Results.Created($"/api/v1/activities/{a.Id}", a)))
            .Validate<ActivityRequest>()
            .RequirePermission(Permissions.ActivitiesWrite);

        group.MapPut("/{id:guid}", async (Guid id, ActivityRequest request, ActivityService service, HttpRequest http, CancellationToken ct) =>
                http.GetIfMatch() is not { } ifMatch
                    ? HeaderExtensions.PreconditionRequired()
                    : (await service.UpdateAsync(id, request, ifMatch, ct)).ToHttpResult(Results.Ok))
            .Validate<ActivityRequest>()
            .RequirePermission(Permissions.ActivitiesWrite);

        group.MapPost("/{id:guid}/complete", async (Guid id, ActivityService service, HttpRequest http, CancellationToken ct) =>
                http.GetIfMatch() is not { } ifMatch
                    ? HeaderExtensions.PreconditionRequired()
                    : (await service.CompleteAsync(id, ifMatch, ct)).ToHttpResult(Results.Ok))
            .RequirePermission(Permissions.ActivitiesWrite);

        group.MapPost("/{id:guid}/reopen", async (Guid id, ActivityService service, HttpRequest http, CancellationToken ct) =>
                http.GetIfMatch() is not { } ifMatch
                    ? HeaderExtensions.PreconditionRequired()
                    : (await service.ReopenAsync(id, ifMatch, ct)).ToHttpResult(Results.Ok))
            .RequirePermission(Permissions.ActivitiesWrite);

        group.MapGet("/{id:guid}/ticket", async (Guid id, Guid organizationId, ActivityTicketService service, CancellationToken ct) =>
                (await service.GetAsync(id, organizationId, ct)).ToHttpResult(Results.Ok))
            .RequirePermission(Permissions.ActivitiesRead).RequirePermission(Permissions.ServiceRead);

        group.MapPut("/{id:guid}/ticket", async (Guid id, ActivityTicketRequest request, ActivityTicketService service, HttpRequest http, CancellationToken ct) =>
                http.GetIfMatch() is not { } ifMatch
                    ? HeaderExtensions.PreconditionRequired()
                    : (await service.PutAsync(id, request, ifMatch, ct)).ToHttpResult(Results.Ok))
            .RequirePermission(Permissions.ActivitiesRead).RequirePermission(Permissions.ActivitiesWrite).RequirePermission(Permissions.ServiceRead);

        // ---------- Outlook (FR-ACT-02, FR-ACT-03) ----------

        group.MapGet("/outlook/status", (OutlookService service) => Results.Ok(service.Status))
            .RequirePermission(Permissions.ActivitiesRead);

        group.MapPost("/{id:guid}/calendar", async (Guid id, ActivityService service, CancellationToken ct) =>
                (await service.AddToCalendarAsync(id, ct)).ToHttpResult(Results.Ok))
            .RequirePermission(Permissions.ActivitiesWrite);

        group.MapDelete("/{id:guid}/calendar", async (Guid id, ActivityService service, CancellationToken ct) =>
                (await service.RemoveFromCalendarAsync(id, ct)).ToHttpResult(Results.Ok))
            .RequirePermission(Permissions.ActivitiesWrite);

        group.MapPost("/calendar/sync", async (int? days, OutlookService service, CancellationToken ct) =>
                (await service.PullCalendarAsync(days ?? 30, ct)).ToHttpResult(Results.Ok))
            .RequirePermission(Permissions.ActivitiesWrite);

        group.MapGet("/mail", async (Guid organizationId, int? take, OutlookService service, CancellationToken ct) =>
                (await service.ListMailAsync(organizationId, take ?? 25, ct)).ToHttpResult(Results.Ok))
            .RequirePermission(Permissions.ActivitiesRead);

        group.MapPost("/mail/save", async (SaveMailRequest request, OutlookService service, CancellationToken ct) =>
                (await service.SaveMailAsync(request, ct)).ToHttpResult(a => Results.Created($"/api/v1/activities/{a.Id}", a)))
            .Validate<SaveMailRequest>()
            .RequirePermission(Permissions.ActivitiesWrite);

        group.MapDelete("/{id:guid}", async (Guid id, ActivityService service, CancellationToken ct) =>
                (await service.DeleteAsync(id, ct)).ToHttpResult(Results.NoContent))
            .RequirePermission(Permissions.ActivitiesWrite);

        return app;
    }
}

public sealed record ActivityParameters(
    [FromQuery] Guid? OrganizationId,
    [FromQuery] Guid? OpportunityId,
    [FromQuery] Guid? ContractId,
    [FromQuery] ActivityType? Type,
    [FromQuery] bool? Mine,
    [FromQuery] bool? Open,
    [FromQuery] int? Limit,
    [FromQuery] string? Cursor,
    [FromQuery] Guid? ActivityId);
