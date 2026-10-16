using System.Security.Claims;
using Crm.Identity.Contracts;
using Crm.Web.Auth;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.Extensions.Caching.Memory;

namespace Crm.Web.Http;

/// <summary>
/// Rejects API calls from users deactivated in the CRM (by the Entra user sync, BR-AUTH-05) even while their session cookie is
/// still valid. The active flag is cached briefly per user (Auth:ActiveUserCacheSeconds, default 60).
/// </summary>
internal sealed class ActiveUserMiddleware(RequestDelegate next, IMemoryCache cache, IConfiguration configuration)
{
    public async Task InvokeAsync(HttpContext context)
    {
        var path = context.Request.Path;
        if (context.User.Identity?.IsAuthenticated == true &&
            (path.StartsWithSegments("/api") || (path.StartsWithSegments("/bff") && !path.StartsWithSegments("/bff/logout"))) &&
            Guid.TryParse(context.User.FindFirstValue(CrmClaimTypes.UserId), out var userId) &&
            !await IsActiveAsync(context, userId))
        {
            await context.SignOutAsync(CookieAuthenticationDefaults.AuthenticationScheme);
            context.Response.StatusCode = StatusCodes.Status401Unauthorized;
            await context.Response.WriteAsJsonAsync(new
            {
                title = "USER_INACTIVE",
                status = 401,
                code = "USER_INACTIVE",
                detail = "Your CRM account has been deactivated.",
            });
            return;
        }

        await next(context);
    }

    private async Task<bool> IsActiveAsync(HttpContext context, Guid userId)
    {
        var seconds = configuration.GetValue("Auth:ActiveUserCacheSeconds", 60);
        async Task<bool> Load() =>
            await context.RequestServices.GetRequiredService<IUserDirectory>().GetProfileAsync(userId, context.RequestAborted) is { IsActive: true };

        if (seconds <= 0)
        {
            return await Load();
        }

        return await cache.GetOrCreateAsync($"crm:user-active:{userId}", entry =>
        {
            entry.AbsoluteExpirationRelativeToNow = TimeSpan.FromSeconds(seconds);
            return Load();
        });
    }
}
