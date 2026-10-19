using Crm.Authorization;
using Crm.Infrastructure.Http;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Routing;

namespace Crm.Integrations.Core.Parasol;

public static class AtlasObservationTaskEndpoints
{
    public static IEndpointRouteBuilder MapParasolObservationTasks(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/v1/parasol").WithTags("Parasol")
            .RequirePermission(Permissions.ParasolAtlasRead).RequirePermission(Permissions.ActivitiesRead);
        group.MapGet("/customers/{customerId:guid}/observations/{observationId}/task-preview", async
            (Guid customerId, string observationId, AtlasObservationTaskService tasks, HttpContext http, CancellationToken ct) =>
            {
                http.Response.Headers.CacheControl = "no-store";
                return (await tasks.PreviewAsync(customerId, observationId, ct)).ToHttpResult(Results.Ok);
            });
        group.MapPost("/customers/{customerId:guid}/observations/{observationId}/task", async
            (Guid customerId, string observationId, AtlasObservationTaskRequest body, AtlasObservationTaskService tasks, HttpContext http, CancellationToken ct) =>
            {
                http.Response.Headers.CacheControl = "no-store";
                return (await tasks.CreateAsync(customerId, observationId, body, ct)).ToHttpResult(Results.Ok);
            }).RequirePermission(Permissions.ActivitiesWrite).WithMetadata(new RequestSizeLimitAttribute(4096));
        group.MapGet("/activities/{activityId:guid}/atlas-observation", async
            (Guid activityId, AtlasObservationTaskService tasks, HttpContext http, CancellationToken ct) =>
            {
                http.Response.Headers.CacheControl = "no-store";
                return (await tasks.SourceAsync(activityId, ct)).ToHttpResult(Results.Ok);
            });
        return app;
    }
}
