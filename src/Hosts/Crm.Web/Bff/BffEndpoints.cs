using System.Net;
using System.Security.Claims;
using Crm.Authorization;
using Crm.Identity.Contracts;
using Crm.SharedKernel.Application;
using Crm.Web.Auth;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Authentication.OpenIdConnect;

namespace Crm.Web.Bff;

public sealed record BffUser(
    Guid Id,
    string DisplayName,
    string? Email,
    string? PreferredLanguage,
    IReadOnlyList<string> Roles,
    IReadOnlyList<string> Permissions,
    AuthMode AuthMode,
    BffRecordScope RecordScope);

/// <summary>What the user sees of the scoped records (DEV-09), so a list can say "the quotes you own" instead of looking incomplete.</summary>
public sealed record BffRecordScope(RecordScopeMode Mode, bool AllQuotes, bool AllProjects);

public static class BffEndpoints
{
    public static IEndpointRouteBuilder MapBffEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/bff").WithTags("BFF");

        group.MapGet("/login", (HttpContext context, string? returnUrl, string? role, CrmAuthOptions options) =>
            {
                var target = SafeReturnUrl(returnUrl);
                if (options.Mode == AuthMode.Entra)
                {
                    return Results.Challenge(new AuthenticationProperties { RedirectUri = target }, [OpenIdConnectDefaults.AuthenticationScheme]);
                }

                return role is null ? Results.Content(DevLoginPage(target), "text/html; charset=utf-8") : Results.LocalRedirect(
                    $"/bff/dev-login?role={Uri.EscapeDataString(role)}&returnUrl={Uri.EscapeDataString(target)}");
            })
            .AllowAnonymous();

        group.MapGet("/dev-login", async (HttpContext context, string role, string? returnUrl, CrmAuthOptions options, IHostEnvironment env) =>
            {
                if (options.Mode != AuthMode.Development || !env.IsDevelopment() || !CrmRoles.All.Contains(role))
                {
                    return Results.NotFound();
                }

                var slug = role.Replace("Crm.", string.Empty, StringComparison.Ordinal).ToLowerInvariant();
                var identity = new ClaimsIdentity(
                [
                    new Claim(CrmClaimTypes.TenantId, "00000000-0000-0000-0000-00000000dev0"),
                    new Claim(CrmClaimTypes.ObjectId, $"dev-{slug}"),
                    new Claim("preferred_username", $"{slug}@dev.local"),
                    new Claim("name", $"Dev {role.Replace("Crm.", string.Empty, StringComparison.Ordinal)}"),
                    new Claim(ClaimTypes.Role, role),
                ], CookieAuthenticationDefaults.AuthenticationScheme, "name", ClaimTypes.Role);
                var principal = new ClaimsPrincipal(identity);
                await AuthenticationSetup.ProvisionUserAsync(principal, context.RequestServices, context.RequestAborted);
                await context.SignInAsync(CookieAuthenticationDefaults.AuthenticationScheme, principal);
                return Results.LocalRedirect(SafeReturnUrl(returnUrl));
            })
            .AllowAnonymous()
            .ExcludeFromDescription();

        group.MapPost("/logout", async (HttpContext context, CrmAuthOptions options) =>
            {
                await context.SignOutAsync(CookieAuthenticationDefaults.AuthenticationScheme);
                if (options.Mode == AuthMode.Entra)
                {
                    // The SPA navigates to this URL to complete single sign-out at Entra ID.
                    return Results.Ok(new { signOutUrl = "/bff/signout-entra" });
                }

                return Results.Ok(new { signOutUrl = "/" });
            });

        group.MapGet("/signout-entra", (CrmAuthOptions options) =>
                options.Mode == AuthMode.Entra
                    ? Results.SignOut(new AuthenticationProperties { RedirectUri = "/" }, [OpenIdConnectDefaults.AuthenticationScheme])
                    : Results.LocalRedirect("/"))
            .AllowAnonymous();

        group.MapGet("/user", async (ClaimsPrincipal principal, IUserDirectory users, CrmAuthOptions options, IRecordScope scope, CancellationToken ct) =>
            {
                if (!Guid.TryParse(principal.FindFirstValue(CrmClaimTypes.UserId), out var userId) ||
                    await users.GetProfileAsync(userId, ct) is not { IsActive: true } profile)
                {
                    return Results.Unauthorized();
                }

                var roles = principal.GetCrmRoles().Order(StringComparer.Ordinal).ToList();
                return Results.Ok(new BffUser(
                    profile.Id, profile.DisplayName, profile.Email, profile.PreferredLanguage, roles,
                    principal.GetPermissions().Order(StringComparer.Ordinal).ToList(), options.Mode,
                    new BffRecordScope(
                        scope.Mode,
                        scope.LimitedTo(Crm.Authorization.Permissions.QuotesAll) is null,
                        scope.LimitedTo(Crm.Authorization.Permissions.ProjectsAll) is null)));
            });

        return app;
    }

    internal static string SafeReturnUrl(string? returnUrl) =>
        !string.IsNullOrEmpty(returnUrl) && returnUrl.StartsWith('/') && !returnUrl.StartsWith("//", StringComparison.Ordinal) &&
        !returnUrl.StartsWith("/\\", StringComparison.Ordinal)
            ? returnUrl
            : "/";

    private static string DevLoginPage(string returnUrl)
    {
        var buttons = string.Join("\n", CrmRoles.All.Select(role =>
            $"<a href=\"/bff/dev-login?role={WebUtility.UrlEncode(role)}&amp;returnUrl={WebUtility.UrlEncode(returnUrl)}\">{WebUtility.HtmlEncode(role)}</a>"));
        return $$"""
            <!doctype html><html lang="en"><head><meta charset="utf-8"><title>Development sign-in</title>
            <style>html{color-scheme:light}body{background:#f3f5f6;font-family:system-ui;max-width:420px;margin:64px auto;padding:0 16px;color:#15212a}
            a{display:block;padding:10px 14px;margin:6px 0;border:1px solid #d9e0e4;border-radius:6px;text-decoration:none;color:#0a6b73}
            a:hover{background:#ddeff0}p{color:#5a6a74}</style></head><body>
            <h1>Development sign-in</h1><p>Entra ID is disabled (Auth:Mode=Development). Choose a role:</p>
            {{buttons}}
            </body></html>
            """;
    }
}
