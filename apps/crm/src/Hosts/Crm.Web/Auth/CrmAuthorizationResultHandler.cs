using Crm.Authorization;
using Crm.Reports;
using Crm.Web.Http;
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
        var reverify = authorizeResult.Forbidden &&
                       authorizeResult.AuthorizationFailure?.FailureReasons.Any(r => r.Message == PermissionAuthorization.ReverifyRequired) == true;
        if (authorizeResult.Challenged)
        {
            SecurityLog.For(context).Unauthenticated(context);
        }
        else if (authorizeResult.Forbidden)
        {
            if (policy.AuthenticationSchemes.Contains(BiAccess.Scheme))
            {
                SecurityLog.For(context).BiDenied(BiAccess.ClientOf(context.User), "policy");
            }
            else
            {
                SecurityLog.For(context).Forbidden(context, reverify ? "reverify_required" : "missing_permission");
            }
        }

        if (reverify)
        {
            context.Response.StatusCode = StatusCodes.Status403Forbidden;
            await context.Response.WriteAsJsonAsync(new
            {
                title = PermissionAuthorization.ReverifyRequired,
                status = StatusCodes.Status403Forbidden,
                code = PermissionAuthorization.ReverifyRequired,
                detail = "This action needs you to confirm your identity again: your roles and your sign-in must both be from the last few minutes. Confirm your identity and repeat it.",
                // Relative and fixed: the SPA adds the page to come back to, which the server validates again.
                reverifyUrl = Reverification.Url,
            }, options: null, contentType: "application/problem+json");
            return;
        }

        await _default.HandleAsync(next, context, policy, authorizeResult);
    }
}
