using Crm.Authorization;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Authorization.Policy;

namespace Crm.Web.Auth;

/// <summary>
/// Answers a privileged action whose roles the authority has not confirmed recently with a coded 403 (DEV-10), so the app can
/// tell the user to sign in again instead of showing a bare "forbidden". Every other result is the default.
/// </summary>
internal sealed class CrmAuthorizationResultHandler : IAuthorizationMiddlewareResultHandler
{
    private readonly AuthorizationMiddlewareResultHandler _default = new();

    public async Task HandleAsync(RequestDelegate next, HttpContext context, AuthorizationPolicy policy, PolicyAuthorizationResult authorizeResult)
    {
        if (authorizeResult.Forbidden &&
            authorizeResult.AuthorizationFailure?.FailureReasons.Any(r => r.Message == PermissionAuthorization.ReverifyRequired) == true)
        {
            context.Response.StatusCode = StatusCodes.Status403Forbidden;
            await context.Response.WriteAsJsonAsync(new
            {
                title = PermissionAuthorization.ReverifyRequired,
                status = StatusCodes.Status403Forbidden,
                code = PermissionAuthorization.ReverifyRequired,
                detail = "This action needs your roles confirmed by Microsoft Entra ID in the last few minutes. Sign in again and repeat it.",
            }, options: null, contentType: "application/problem+json");
            return;
        }

        await _default.HandleAsync(next, context, policy, authorizeResult);
    }
}
