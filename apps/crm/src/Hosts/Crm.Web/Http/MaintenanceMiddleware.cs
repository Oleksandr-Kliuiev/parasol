using Crm.Authorization;
using Crm.Infrastructure.Http;
using Crm.SharedKernel.Operations;

namespace Crm.Web.Http;

/// <summary>
/// The request half of read-only maintenance (DEV-13, ADR-021). While the CRM is read-only: reads go on; every request that
/// could change data — any non-safe method, a bulk export (it writes its audit entry), the Hangfire dashboard's actions — is
/// answered 503 <c>MAINTENANCE_READ_ONLY</c> before it reaches a handler; endpoints marked <see cref="AllowedInMaintenanceMetadata"/>
/// (the operator's controls, sign-out) pass. Sign-in passes too: provisioning admits the operators who run the maintenance and
/// sends everyone else to the "signing in is paused" page (<see cref="Crm.Web.Auth.AuthenticationSetup.ProvisionUserAsync"/>).
/// Runs before authentication, because the sign-in callback writes there. The database interceptors refuse whatever slips past.
/// </summary>
internal sealed class MaintenanceMiddleware(RequestDelegate next)
{
    public async Task InvokeAsync(HttpContext context, IMaintenanceGate gate)
    {
        var path = context.Request.Path;
        if (!Guarded(path) || IsSignIn(path))
        {
            await next(context);
            return;
        }

        var state = await gate.CurrentAsync(context.RequestAborted);
        var endpoint = context.GetEndpoint();
        if (!state.IsReadOnly || endpoint?.Metadata.GetMetadata<AllowedInMaintenanceMetadata>() is not null)
        {
            await next(context);
            return;
        }

        var method = context.Request.Method;
        var safe = HttpMethods.IsGet(method) || HttpMethods.IsHead(method) || HttpMethods.IsOptions(method);
        if (safe && endpoint?.Metadata.GetMetadata<ExportsDataMetadata>() is null)
        {
            await next(context);
            return;
        }

        await MaintenanceHttp.WriteReadOnlyAsync(context, state);
    }

    private static bool Guarded(PathString path) =>
        path.StartsWithSegments("/api") || path.StartsWithSegments("/bff") || path.StartsWithSegments("/admin/jobs");

    private static bool IsSignIn(PathString path) =>
        path.StartsWithSegments("/bff/login") || path.StartsWithSegments("/bff/dev-login") || path.StartsWithSegments("/signin-oidc");
}
