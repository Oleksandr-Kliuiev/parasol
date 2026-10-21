using Crm.Authorization;
using Crm.Infrastructure.Http;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Routing;

namespace Crm.Activities.Features;

/// <summary>
/// Alerts as tasks (M38). Reads need activities.read AND service.read, the create activities.write AND service.read: each
/// RequirePermission call is its own policy, so two calls require both. Answers describe one moment and are never cached.
/// </summary>
internal static class SourceTaskEndpoints
{
    public static RouteGroupBuilder MapSourceTaskEndpoints(this RouteGroupBuilder group)
    {
        group.MapGet("/source-tasks/preview", async (Guid alertId, AlertTaskService tasks, HttpResponse response, CancellationToken ct) =>
            {
                response.Headers.CacheControl = "no-store";
                return (await tasks.PreviewAsync(alertId, ct)).ToHttpResult(Results.Ok);
            })
            .RequirePermission(Permissions.ActivitiesRead).RequirePermission(Permissions.ServiceRead);

        group.MapPost("/source-tasks", async (AlertTaskRequest request, AlertTaskService tasks, HttpResponse response, CancellationToken ct) =>
            {
                response.Headers.CacheControl = "no-store";
                return (await tasks.CreateAsync(request, ct)).ToHttpResult(Results.Ok);
            })
            .Validate<AlertTaskRequest>()
            .RequirePermission(Permissions.ActivitiesWrite).RequirePermission(Permissions.ServiceRead)
            .WithMetadata(new RequestSizeLimitAttribute(4096));

        // A read with the ids of one page of alerts in its body; it changes nothing, so read-only maintenance lets it through.
        group.MapPost("/source-tasks/lookup", async (AlertTaskLookupRequest request, AlertTaskService tasks, HttpResponse response, CancellationToken ct) =>
            {
                response.Headers.CacheControl = "no-store";
                return (await tasks.LookupAsync(request, ct)).ToHttpResult(Results.Ok);
            })
            .Validate<AlertTaskLookupRequest>()
            .RequirePermission(Permissions.ActivitiesRead).RequirePermission(Permissions.ServiceRead)
            .WithMetadata(new RequestSizeLimitAttribute(8192))
            .AllowedInMaintenance();

        group.MapGet("/{id:guid}/source", async (Guid id, AlertTaskService tasks, HttpResponse response, CancellationToken ct) =>
            {
                response.Headers.CacheControl = "no-store";
                return (await tasks.SourceOfTaskAsync(id, ct)).ToHttpResult(Results.Ok);
            })
            .RequirePermission(Permissions.ActivitiesRead).RequirePermission(Permissions.ServiceRead);

        return group;
    }
}
