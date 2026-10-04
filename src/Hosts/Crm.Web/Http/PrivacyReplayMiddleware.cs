using Crm.Privacy.Contracts;

namespace Crm.Web.Http;

/// <summary>
/// DEV-11-AC06: after a database restore, the API waits until crm-worker has applied again the erasures the restored copy no
/// longer has — a restored database must not show or export people who were erased. Health probes are not /api and keep
/// answering, so the restore itself stays observable.
/// </summary>
internal sealed class PrivacyReplayMiddleware(RequestDelegate next)
{
    public async Task InvokeAsync(HttpContext context, IPrivacyReplayGate gate)
    {
        if (context.Request.Path.StartsWithSegments("/api") &&
            context.GetEndpoint()?.Metadata.GetMetadata<Crm.Infrastructure.Http.AllowedInMaintenanceMetadata>() is null &&
            await gate.IsReplayPendingAsync(context.RequestAborted))
        {
            context.Response.StatusCode = StatusCodes.Status503ServiceUnavailable;
            context.Response.Headers.RetryAfter = "60";
            await context.Response.WriteAsJsonAsync(new
            {
                title = "PRIVACY_REPLAY_PENDING",
                status = StatusCodes.Status503ServiceUnavailable,
                code = "PRIVACY_REPLAY_PENDING",
                detail = "The database was restored; erasures made after that copy are being applied again. Try again in a minute.",
            }, options: null, contentType: "application/problem+json");
            return;
        }

        await next(context);
    }
}
