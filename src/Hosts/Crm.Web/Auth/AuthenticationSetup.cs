using System.Globalization;
using System.Security.Claims;
using Crm.Authorization;
using Crm.Identity.Contracts;
using Crm.Infrastructure.DependencyInjection;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Authentication.OpenIdConnect;
using Microsoft.Identity.Client;
using Microsoft.Identity.Web;

namespace Crm.Web.Auth;

public static class AuthenticationSetup
{
    public const string CookieName = "__Host-crm";
    private static readonly string[] RevalidationScopes = ["User.Read"];
    private static readonly TimeSpan RevalidationRetry = TimeSpan.FromMinutes(5);

    public static WebApplicationBuilder AddCrmAuthentication(this WebApplicationBuilder builder)
    {
        var options = builder.Configuration.GetSection(CrmAuthOptions.SectionName).Get<CrmAuthOptions>() ?? new CrmAuthOptions();
        builder.Services.AddSingleton(options);

        if (options.Mode == AuthMode.Development)
        {
            if (!builder.Environment.IsDevelopment())
            {
                throw new InvalidOperationException("Auth:Mode=Development is only allowed in the Development environment.");
            }

            builder.Services
                .AddAuthentication(CookieAuthenticationDefaults.AuthenticationScheme)
                .AddCookie(cookie => ConfigureCookie(cookie, options, revalidate: false));
            return builder;
        }

        builder.Services
            .AddAuthentication(OpenIdConnectDefaults.AuthenticationScheme)
            .AddMicrosoftIdentityWebApp(
                oidc =>
                {
                    builder.Configuration.Bind("AzureAd", oidc);
                    oidc.ResponseType = "code";
                    oidc.UsePkce = true;
                    oidc.SaveTokens = false;
                    oidc.Events ??= new OpenIdConnectEvents();
                    var previous = oidc.Events.OnTokenValidated;
                    oidc.Events.OnTokenValidated = async context =>
                    {
                        if (previous is not null)
                        {
                            await previous(context);
                        }

                        await ProvisionUserAsync(context.Principal!, context.HttpContext.RequestServices, context.HttpContext.RequestAborted);
                    };
                },
                cookie => ConfigureCookie(cookie, options, revalidate: true),
                OpenIdConnectDefaults.AuthenticationScheme,
                CookieAuthenticationDefaults.AuthenticationScheme)
            .EnableTokenAcquisitionToCallDownstreamApi(RevalidationScopes)
            .AddDistributedTokenCaches();

        if (builder.Configuration.GetConnectionString(ModuleRegistration.ConnectionStringName) is { } connectionString)
        {
            builder.Services.AddDistributedSqlServerCache(cache =>
            {
                cache.ConnectionString = connectionString;
                cache.SchemaName = "identity";
                cache.TableName = "TokenCache";
            });
        }

        return builder;
    }

    /// <summary>
    /// Creates/refreshes the CRM user with the roles the sign-in token carries, opens a server-side session and stamps the
    /// session claims (DEV-10). Shared by Entra and development sign-in.
    /// </summary>
    public static async Task ProvisionUserAsync(ClaimsPrincipal principal, IServiceProvider services, CancellationToken cancellationToken)
    {
        var identity = (ClaimsIdentity)principal.Identity!;
        var tenantId = principal.FindFirstValue(CrmClaimTypes.TenantId) ?? principal.FindFirstValue("tid")
                       ?? throw new InvalidOperationException("Token has no tenant id.");
        var objectId = principal.FindFirstValue(CrmClaimTypes.ObjectId) ?? principal.FindFirstValue("oid")
                       ?? throw new InvalidOperationException("Token has no object id.");
        var upn = principal.FindFirstValue("preferred_username") ?? principal.FindFirstValue(ClaimTypes.Upn) ?? objectId;
        var name = principal.FindFirstValue("name") ?? principal.Identity?.Name ?? upn;
        var email = principal.FindFirstValue("email") ?? principal.FindFirstValue(ClaimTypes.Email) ?? (upn.Contains('@') ? upn : null);

        var provisioning = services.GetRequiredService<IUserProvisioning>();
        var profile = await provisioning.EnsureUserAsync(
            new ExternalIdentity(tenantId, objectId, upn, name, email, Roles: principal.GetCrmRoles().ToList()), cancellationToken);

        var at = services.GetRequiredService<TimeProvider>().GetUtcNow();
        var sessionId = await services.GetRequiredService<ISessionDirectory>().StartAsync(profile.Id, at, cancellationToken);
        var now = at.ToUnixTimeSeconds().ToString(CultureInfo.InvariantCulture);
        identity.AddClaim(new Claim(CrmClaimTypes.UserId, profile.Id.ToString()));
        identity.AddClaim(new Claim(CrmClaimTypes.SessionId, sessionId.ToString()));
        identity.AddClaim(new Claim(CrmClaimTypes.SessionStarted, now));
        identity.AddClaim(new Claim(CrmClaimTypes.LastValidated, now));
        identity.AddClaim(new Claim(PermissionAuthorization.RolesVerifiedClaim, now));
    }

    private static void ConfigureCookie(CookieAuthenticationOptions cookie, CrmAuthOptions options, bool revalidate)
    {
        cookie.Cookie.Name = CookieName;
        cookie.Cookie.HttpOnly = true;
        cookie.Cookie.SecurePolicy = CookieSecurePolicy.Always;
        cookie.Cookie.SameSite = SameSiteMode.Strict;
        cookie.Cookie.Path = "/";
        cookie.SlidingExpiration = true;
        cookie.ExpireTimeSpan = options.SlidingExpiration;
        cookie.LoginPath = "/bff/login";

        cookie.Events.OnRedirectToLogin = context => ApiAwareStatus(context, StatusCodes.Status401Unauthorized);
        cookie.Events.OnRedirectToAccessDenied = context => ApiAwareStatus(context, StatusCodes.Status403Forbidden);
        cookie.Events.OnValidatePrincipal = context => ValidatePrincipalAsync(context, options, revalidate);
    }

    private static Task ApiAwareStatus(RedirectContext<CookieAuthenticationOptions> context, int statusCode)
    {
        if (context.Request.Path.StartsWithSegments("/api") || context.Request.Path.StartsWithSegments("/bff"))
        {
            context.Response.StatusCode = statusCode;
            return Task.CompletedTask;
        }

        context.Response.Redirect(context.RedirectUri);
        return Task.CompletedTask;
    }

    private static async Task ValidatePrincipalAsync(CookieValidatePrincipalContext context, CrmAuthOptions options, bool revalidate)
    {
        var principal = context.Principal!;
        var services = context.HttpContext.RequestServices;
        var now = services.GetRequiredService<TimeProvider>().GetUtcNow();

        if (ReadUnixClaim(principal, CrmClaimTypes.SessionStarted) is not { } started || now - started > options.AbsoluteExpiration)
        {
            await RejectAsync(context);
            return;
        }

        // DEV-10: the session and its roles are the server's, not the cookie's. A cookie from before sessions were kept names
        // none and signs in once more; an ended session, a deactivated user or roles left unconfirmed too long end this one.
        if (!Guid.TryParse(principal.FindFirstValue(CrmClaimTypes.UserId), out var userId) ||
            !Guid.TryParse(principal.FindFirstValue(CrmClaimTypes.SessionId), out var sessionId))
        {
            await RejectAsync(context);
            return;
        }

        var state = await services.GetRequiredService<SessionStateCache>()
            .GetAsync(userId, sessionId, services.GetRequiredService<ISessionDirectory>(), context.HttpContext.RequestAborted);
        if (!state.SessionOpen || !state.IsActive || state.RolesVerifiedAt is not { } verified || now - verified > options.RoleGrace)
        {
            await RejectAsync(context);
            return;
        }

        var identity = (ClaimsIdentity)principal.Identity!;
        var version = state.RolesVersion.ToString(CultureInfo.InvariantCulture);
        if (principal.FindFirstValue(CrmClaimTypes.RolesVersion) != version ||
            !principal.GetCrmRoles().Order(StringComparer.Ordinal).SequenceEqual(state.Roles.Order(StringComparer.Ordinal)))
        {
            foreach (var claim in identity.Claims.Where(c => c.Type is ClaimTypes.Role or "roles" || c.Type == identity.RoleClaimType).ToList())
            {
                identity.RemoveClaim(claim);
            }

            foreach (var role in state.Roles)
            {
                identity.AddClaim(new Claim(identity.RoleClaimType, role));
            }

            SetClaim(identity, CrmClaimTypes.RolesVersion, version);
            context.ShouldRenew = true;
        }

        // Written from the server's record on every request, so a value a cookie carries is never what authorization reads.
        SetClaim(identity, PermissionAuthorization.RolesVerifiedClaim, verified.ToUnixTimeSeconds().ToString(CultureInfo.InvariantCulture));

        if (!revalidate || ReadUnixClaim(principal, CrmClaimTypes.LastValidated) is { } last && now - last < options.RevalidationInterval)
        {
            return;
        }

        try
        {
            // Force a refresh-token redemption: fails if the account was disabled, the password reset or sessions revoked.
            var tokens = context.HttpContext.RequestServices.GetRequiredService<ITokenAcquisition>();
            await tokens.GetAccessTokenForUserAsync(
                RevalidationScopes, user: principal, tokenAcquisitionOptions: new TokenAcquisitionOptions { ForceRefresh = true });
        }
        catch (Exception ex) when (ex is MicrosoftIdentityWebChallengeUserException or MsalUiRequiredException)
        {
            await RejectAsync(context);
            return;
        }
        catch (Exception ex) when (IsUnavailable(ex, context.HttpContext.RequestAborted))
        {
            // DEV-10: Entra cannot be reached, so the check is postponed, not passed. The session reads on within the role grace
            // while the directory's confirmation keeps governing privileged actions, and asks again in a few minutes rather than
            // on every request. Only the exception type is logged: messages may name the account.
            services.GetRequiredService<ILoggerFactory>().CreateLogger(typeof(AuthenticationSetup))
                .LogWarning("Session revalidation with Entra ID is unavailable ({Error}); next attempt in {Minutes} minutes.", ex.GetType().Name, RevalidationRetry.TotalMinutes);
            var retryAt = now - options.RevalidationInterval + RevalidationRetry;
            SetClaim(identity, CrmClaimTypes.LastValidated, retryAt.ToUnixTimeSeconds().ToString(CultureInfo.InvariantCulture));
            context.ShouldRenew = true;
            return;
        }

        SetClaim(identity, CrmClaimTypes.LastValidated, now.ToUnixTimeSeconds().ToString(CultureInfo.InvariantCulture));
        context.ShouldRenew = true;
    }

    /// <summary>
    /// Entra did not answer — the network, a timeout, throttling or a server error — as opposed to answering that the account
    /// may not have a token. Anything else is unexpected and fails the request.
    /// </summary>
    internal static bool IsUnavailable(Exception error, CancellationToken requestAborted) => error switch
    {
        HttpRequestException or TimeoutException => true,
        OperationCanceledException => !requestAborted.IsCancellationRequested,
        MsalServiceException service => service.StatusCode is 0 or 429 or >= 500 ||
                                        service.ErrorCode is MsalError.RequestTimeout or MsalError.ServiceNotAvailable,
        MsalClientException client => client.ErrorCode is MsalError.RequestTimeout or MsalError.ServiceNotAvailable,
        _ => false,
    };

    private static void SetClaim(ClaimsIdentity identity, string type, string value)
    {
        foreach (var claim in identity.FindAll(type).ToList())
        {
            identity.RemoveClaim(claim);
        }

        identity.AddClaim(new Claim(type, value));
    }

    private static async Task RejectAsync(CookieValidatePrincipalContext context)
    {
        context.RejectPrincipal();
        await context.HttpContext.SignOutAsync(CookieAuthenticationDefaults.AuthenticationScheme);
    }

    private static DateTimeOffset? ReadUnixClaim(ClaimsPrincipal principal, string type) =>
        long.TryParse(principal.FindFirstValue(type), NumberStyles.Integer, CultureInfo.InvariantCulture, out var seconds)
            ? DateTimeOffset.FromUnixTimeSeconds(seconds)
            : null;
}
