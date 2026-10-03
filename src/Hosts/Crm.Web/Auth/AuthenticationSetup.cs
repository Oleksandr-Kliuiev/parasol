using System.Globalization;
using System.Security.Claims;
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

    /// <summary>Creates/refreshes the CRM user and stamps session claims. Shared by Entra and development sign-in.</summary>
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
        var profile = await provisioning.EnsureUserAsync(new ExternalIdentity(tenantId, objectId, upn, name, email), cancellationToken);

        var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds().ToString(CultureInfo.InvariantCulture);
        identity.AddClaim(new Claim(CrmClaimTypes.UserId, profile.Id.ToString()));
        identity.AddClaim(new Claim(CrmClaimTypes.SessionStarted, now));
        identity.AddClaim(new Claim(CrmClaimTypes.LastValidated, now));
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
        var now = DateTimeOffset.UtcNow;

        if (ReadUnixClaim(principal, CrmClaimTypes.SessionStarted) is not { } started || now - started > options.AbsoluteExpiration)
        {
            await RejectAsync(context);
            return;
        }

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

        var identity = (ClaimsIdentity)principal.Identity!;
        if (identity.FindFirst(CrmClaimTypes.LastValidated) is { } claim)
        {
            identity.RemoveClaim(claim);
        }

        identity.AddClaim(new Claim(CrmClaimTypes.LastValidated, now.ToUnixTimeSeconds().ToString(CultureInfo.InvariantCulture)));
        context.ShouldRenew = true;
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
