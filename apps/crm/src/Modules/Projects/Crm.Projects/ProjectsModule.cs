using Crm.Authorization;
using Crm.Infrastructure.DependencyInjection;
using Crm.Infrastructure.Http;
using Crm.Projects.Contracts;
using Crm.Projects.Domain;
using Crm.Projects.Features;
using Crm.Projects.Persistence;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace Crm.Projects;

public static class ProjectsModule
{
    public static IServiceCollection AddProjectsModule(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddModuleDbContext<ProjectsDbContext>(configuration);
        services.AddModuleServices(typeof(ProjectsModule).Assembly);
        services.AddScoped<ProjectService>();
        services.AddScoped<IProjectsApi, ProjectsApi>();
        services.AddScoped<Crm.SharedKernel.Application.IRecordScopeReporter, ProjectScopeReporter>();
        return services;
    }

    public static IEndpointRouteBuilder MapProjectsEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/v1/projects").WithTags("Projects");

        group.MapGet("/", async ([AsParameters] ProjectListParameters p, ProjectService service, CancellationToken ct) =>
                Results.Ok(await service.ListAsync(new ProjectQuery(p.Search, p.OrganizationId, p.Status, p.ManagerId, p.OpenOnly ?? false, p.Limit, p.Cursor), ct)))
            .RequirePermission(Permissions.ProjectsRead);

        group.MapGet("/{id:guid}", async (Guid id, ProjectService service, HttpResponse response, CancellationToken ct) =>
                (await service.GetAsync(id, ct)).ToHttpResult(p => WithETag(response, p.Etag, Results.Ok(p))))
            .RequirePermission(Permissions.ProjectsRead);

        group.MapPost("/", async (ProjectRequest request, ProjectService service, HttpResponse response, CancellationToken ct) =>
                (await service.CreateAsync(request, ct))
                .ToHttpResult(p => WithETag(response, p.Etag, Results.Created($"/api/v1/projects/{p.Id}", p))))
            .Validate<ProjectRequest>()
            .RequirePermission(Permissions.ProjectsWrite);

        group.MapPut("/{id:guid}", async (
                Guid id, ProjectRequest request, ProjectService service, HttpRequest httpRequest, HttpResponse response, CancellationToken ct) =>
            {
                if (httpRequest.GetIfMatch() is not { } ifMatch)
                {
                    return HeaderExtensions.PreconditionRequired();
                }

                return (await service.UpdateAsync(id, request, ifMatch, ct)).ToHttpResult(p => WithETag(response, p.Etag, Results.Ok(p)));
            })
            .Validate<ProjectRequest>()
            .RequirePermission(Permissions.ProjectsWrite);

        group.MapPost("/{id:guid}/status", async (Guid id, StatusRequest request, ProjectService service, HttpResponse response, CancellationToken ct) =>
                (await service.SetStatusAsync(id, request.Status, ct)).ToHttpResult(p => WithETag(response, p.Etag, Results.Ok(p))))
            .RequirePermission(Permissions.ProjectsWrite);

        group.MapDelete("/{id:guid}", async (Guid id, ProjectService service, CancellationToken ct) =>
                (await service.DeleteAsync(id, ct)).ToHttpResult(Results.NoContent))
            .RequirePermission(Permissions.ProjectsWrite);

        // DEV-09: the team decides, with the manager and the task assignees, who sees the project in the Restricted mode.
        group.MapPost("/{id:guid}/members", async (Guid id, ProjectMemberRequest request, ProjectService service, HttpResponse response, CancellationToken ct) =>
                (await service.AddMemberAsync(id, request, ct)).ToHttpResult(p => WithETag(response, p.Etag, Results.Ok(p))))
            .Validate<ProjectMemberRequest>()
            .RequirePermission(Permissions.ProjectsWrite);

        group.MapDelete("/{id:guid}/members/{userId:guid}", async (Guid id, Guid userId, ProjectService service, HttpResponse response, CancellationToken ct) =>
                (await service.RemoveMemberAsync(id, userId, ct)).ToHttpResult(p => WithETag(response, p.Etag, Results.Ok(p))))
            .RequirePermission(Permissions.ProjectsWrite);

        MapPhases(group);
        return app;
    }

    private static void MapPhases(RouteGroupBuilder group)
    {
        group.MapPost("/{id:guid}/phases", async (Guid id, PhaseRequest request, ProjectService service, HttpResponse response, CancellationToken ct) =>
                (await service.AddPhaseAsync(id, request, ct)).ToHttpResult(p => WithETag(response, p.Etag, Results.Ok(p))))
            .Validate<PhaseRequest>()
            .RequirePermission(Permissions.ProjectsWrite);

        group.MapPut("/{id:guid}/phases/{phaseId:guid}", async (
                Guid id, Guid phaseId, PhaseRequest request, ProjectService service, HttpResponse response, CancellationToken ct) =>
                (await service.UpdatePhaseAsync(id, phaseId, request, ct)).ToHttpResult(p => WithETag(response, p.Etag, Results.Ok(p))))
            .Validate<PhaseRequest>()
            .RequirePermission(Permissions.ProjectsWrite);

        // Completing a phase that carries a fee queues the fee for the next billing run (docs/02 §4.10).
        group.MapPost("/{id:guid}/phases/{phaseId:guid}/status", async (
                Guid id, Guid phaseId, PhaseStatusRequest request, ProjectService service, HttpResponse response, CancellationToken ct) =>
                (await service.SetPhaseStatusAsync(id, phaseId, request.Status, ct)).ToHttpResult(p => WithETag(response, p.Etag, Results.Ok(p))))
            .RequirePermission(Permissions.ProjectsWrite);

        group.MapDelete("/{id:guid}/phases/{phaseId:guid}", async (Guid id, Guid phaseId, ProjectService service, HttpResponse response, CancellationToken ct) =>
                (await service.RemovePhaseAsync(id, phaseId, ct)).ToHttpResult(p => WithETag(response, p.Etag, Results.Ok(p))))
            .RequirePermission(Permissions.ProjectsWrite);

        group.MapPost("/{id:guid}/phases/{phaseId:guid}/tasks", async (
                Guid id, Guid phaseId, TaskRequest request, ProjectService service, HttpResponse response, CancellationToken ct) =>
                (await service.AddTaskAsync(id, phaseId, request, ct)).ToHttpResult(p => WithETag(response, p.Etag, Results.Ok(p))))
            .Validate<TaskRequest>()
            .RequirePermission(Permissions.ProjectsWrite);

        group.MapPut("/{id:guid}/tasks/{taskId:guid}", async (
                Guid id, Guid taskId, TaskRequest request, ProjectService service, HttpResponse response, CancellationToken ct) =>
                (await service.UpdateTaskAsync(id, taskId, request, ct)).ToHttpResult(p => WithETag(response, p.Etag, Results.Ok(p))))
            .Validate<TaskRequest>()
            .RequirePermission(Permissions.ProjectsWrite);

        group.MapDelete("/{id:guid}/tasks/{taskId:guid}", async (Guid id, Guid taskId, ProjectService service, HttpResponse response, CancellationToken ct) =>
                (await service.RemoveTaskAsync(id, taskId, ct)).ToHttpResult(p => WithETag(response, p.Etag, Results.Ok(p))))
            .RequirePermission(Permissions.ProjectsWrite);
    }

    private static IResult WithETag(HttpResponse response, string etag, IResult result)
    {
        response.Headers.ETag = etag;
        return result;
    }
}

public sealed record ProjectListParameters(
    [FromQuery] string? Search,
    [FromQuery] Guid? OrganizationId,
    [FromQuery] ProjectStatus? Status,
    [FromQuery] Guid? ManagerId,
    [FromQuery] bool? OpenOnly,
    [FromQuery] int? Limit,
    [FromQuery] string? Cursor);
