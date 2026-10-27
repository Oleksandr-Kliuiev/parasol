using System.Net;
using System.Security.Claims;
using Crm.Authorization;
using Crm.Identity.Contracts;
using Crm.Infrastructure.Http;
using Crm.SharedKernel.Application;
using Crm.Web.Auth;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Authentication.OpenIdConnect;
using Microsoft.AspNetCore.DataProtection;

namespace Crm.Web.Bff;

public sealed record BffUser(
    Guid Id,
    string DisplayName,
    string? Email,
    string? PreferredLanguage,
    IReadOnlyList<string> Roles,
    IReadOnlyList<string> Permissions,
    AuthMode AuthMode,
    BffRecordScope RecordScope,
    string? MyDayLayout,
    string? JobTitle,
    string? Department,
    DateTimeOffset? LastLoginAt);

/// <summary>What the user sees of the scoped records (DEV-09), so a list can say "the quotes you own" instead of looking incomplete.</summary>
public sealed record BffRecordScope(RecordScopeMode Mode, bool AllQuotes, bool AllProjects);

public static class BffEndpoints
{
    public static IEndpointRouteBuilder MapBffEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/bff").WithTags("BFF");

        group.MapGet("/login", (
                HttpContext context, string? returnUrl, string? role, string? reverify, CrmAuthOptions options,
                Microsoft.Extensions.Options.IOptions<AuthorizationFreshnessOptions> freshness) =>
            {
                var target = SafeReturnUrl(returnUrl);
                // F-G2-08: "confirm your identity" is a sign-in Entra must answer interactively and not older than the freshness
                // window; the same address is the ordinary sign-in without the parameter.
                var confirming = !string.IsNullOrEmpty(reverify) && reverify != "0";
                if (options.Mode == AuthMode.Entra)
                {
                    var properties = confirming
                        ? Reverification.Challenge(
                            target, freshness.Value.PrivilegedFreshness,
                            context.User.FindFirstValue(CrmClaimTypes.ObjectId) ?? context.User.FindFirstValue("oid"))
                        : new AuthenticationProperties { RedirectUri = target };
                    return Results.Challenge(properties, [OpenIdConnectDefaults.AuthenticationScheme]);
                }

                // Development: there is no second factor; confirming is signing in again, as the role already held when there is one.
                role ??= confirming ? context.User.FindAll(ClaimTypes.Role).Select(c => c.Value).FirstOrDefault(CrmRoles.All.Contains) : null;

                return role is null ? Results.Content(DevLoginPage(target), "text/html; charset=utf-8") : Results.LocalRedirect(
                    $"/bff/dev-login?role={Uri.EscapeDataString(role)}&returnUrl={Uri.EscapeDataString(target)}");
            })
            .AllowAnonymous();

        group.MapGet("/dev-login", async (
                HttpContext context, string role, string? user, string? returnUrl, CrmAuthOptions options, IHostEnvironment env) =>
            {
                if (options.Mode != AuthMode.Development || !env.IsDevelopment() || !CrmRoles.All.Contains(role) ||
                    (user is not null && (user.Length is 0 or > 24 || !user.All(char.IsAsciiLetter))))
                {
                    return Results.NotFound();
                }

                // One development user per role. A test that changes the user's own settings (the language) names a user of its own
                // with that role (user=Language: "Dev Language"), so the tests signed in with the role in parallel never see the change.
                var roleName = role.Replace("Crm.", string.Empty, StringComparison.Ordinal);
                var slug = (user is null ? roleName : $"{roleName}-{user}").ToLowerInvariant();
                var identity = new ClaimsIdentity(
                [
                    new Claim(CrmClaimTypes.TenantId, "00000000-0000-0000-0000-00000000dev0"),
                    new Claim(CrmClaimTypes.ObjectId, $"dev-{slug}"),
                    new Claim("preferred_username", $"{slug}@dev.local"),
                    new Claim("name", $"Dev {user ?? roleName}"),
                    new Claim(ClaimTypes.Role, role),
                    // The development sign-in is an interactive authentication: now.
                    new Claim("auth_time", context.RequestServices.GetRequiredService<TimeProvider>().GetUtcNow().ToUnixTimeSeconds()
                        .ToString(System.Globalization.CultureInfo.InvariantCulture)),
                ], CookieAuthenticationDefaults.AuthenticationScheme, "name", ClaimTypes.Role);
                var principal = new ClaimsPrincipal(identity);
                try
                {
                    await AuthenticationSetup.ProvisionUserAsync(principal, context.RequestServices, context.RequestAborted);
                }
                catch (Crm.SharedKernel.Operations.MaintenanceReadOnlyException)
                {
                    return Results.LocalRedirect(AuthenticationSetup.MaintenanceSignInPath);
                }

                await context.SignInAsync(CookieAuthenticationDefaults.AuthenticationScheme, principal);
                return Results.LocalRedirect(SafeReturnUrl(returnUrl));
            })
            .AllowAnonymous()
            .ExcludeFromDescription();

        group.MapPost("/logout", async (
                HttpContext context, CrmAuthOptions options, ISessionDirectory sessions, SessionStateCache cache, TimeProvider time,
                IDataProtectionProvider protection) =>
            {
                // DEV-10: the session ends on the server, so this cookie — and any copy of it — is refused on every replica. Signing
                // out stays possible during read-only maintenance (DEV-13): ending a session reduces access, it changes no data.
                if (Guid.TryParse(context.User.FindFirstValue(CrmClaimTypes.SessionId), out var sessionId))
                {
                    using var signOut = Crm.SharedKernel.Operations.MaintenanceScope.AllowWrites("sign-out");
                    await sessions.EndAsync(sessionId, "SignOut", time.GetUtcNow(), context.RequestAborted);
                    if (Guid.TryParse(context.User.FindFirstValue(CrmClaimTypes.UserId), out var userId))
                    {
                        cache.Forget(userId, sessionId);
                    }
                }

                await context.SignOutAsync(CookieAuthenticationDefaults.AuthenticationScheme);
                if (options.Mode == AuthMode.Entra)
                {
                    // The SPA navigates to this URL to complete single sign-out at Entra ID. The link carries a ticket that only
                    // this POST (which needs the X-CSRF header, so only the SPA) can obtain and that is good for a minute: a
                    // page on another site cannot send the browser to it to sign the user out of Entra.
                    var ticket = protection.CreateProtector(SignOutPurpose).ToTimeLimitedDataProtector()
                        .Protect(Guid.NewGuid().ToString("N"), TimeSpan.FromMinutes(1));
                    return Results.Ok(new { signOutUrl = $"/bff/signout-entra?ticket={Uri.EscapeDataString(ticket)}" });
                }

                return Results.Ok(new { signOutUrl = "/" });
            })
            .AllowedInMaintenance();

        group.MapGet("/signout-entra", (string? ticket, CrmAuthOptions options, IDataProtectionProvider protection) =>
                options.Mode == AuthMode.Entra && IsSignOutTicket(ticket, protection)
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
                        scope.LimitedTo(Crm.Authorization.Permissions.ProjectsAll) is null),
                    profile.MyDayLayout, profile.JobTitle, profile.Department, profile.LastLoginAt));
            });

        return app;
    }

    internal const string SignOutPurpose = "Crm.Web.SignOutTicket";

    internal static bool IsSignOutTicket(string? ticket, IDataProtectionProvider protection)
    {
        if (string.IsNullOrEmpty(ticket) || ticket.Length > 512)
        {
            return false;
        }

        try
        {
            _ = protection.CreateProtector(SignOutPurpose).ToTimeLimitedDataProtector().Unprotect(ticket);
            return true;
        }
        catch (System.Security.Cryptography.CryptographicException)
        {
            return false;
        }
    }

    internal static string SafeReturnUrl(string? returnUrl) => ReturnUrl.Safe(returnUrl);

    /// <summary>
    /// M38: every employee has full access (the Entra group that gives Crm.Admin), so the sign-in that stands for them comes
    /// first; the narrower roles stay below it for testing the permission checks the code keeps.
    /// </summary>
    private static string DevLoginPage(string returnUrl)
    {
        string Link(string role, string label) =>
            $"<a href=\"/bff/dev-login?role={WebUtility.UrlEncode(role)}&amp;returnUrl={WebUtility.UrlEncode(returnUrl)}\">{label}</a>";
        var employee = Link(CrmRoles.Admin, $"Employee (full access) <small>{WebUtility.HtmlEncode(CrmRoles.Admin)}</small>");
        var others = string.Join("\n", CrmRoles.All.Where(role => role != CrmRoles.Admin).Select(role => Link(role, WebUtility.HtmlEncode(role))));
        return $$"""
            <!doctype html><html lang="en"><head><meta charset="utf-8"><title>Development sign-in</title>
            <style>html{color-scheme:light}body{background:#f3f5f6;font-family:system-ui;max-width:420px;margin:64px auto;padding:0 16px;color:#15212a}
            a{display:block;padding:10px 14px;margin:6px 0;border:1px solid #d9e0e4;border-radius:6px;text-decoration:none;color:#0a6b73}
            a:hover{background:#ddeff0}p,small{color:#5a6a74}h2{font-size:16px;margin-top:28px}</style></head><body>
            <h1>Development sign-in</h1><p>Entra ID is disabled (Auth:Mode=Development). Every employee signs in with full access:</p>
            {{employee}}
            <h2>Other roles</h2><p>Only for testing the permission checks; no employee is given them.</p>
            {{others}}
            </body></html>
            """;
    }
}
