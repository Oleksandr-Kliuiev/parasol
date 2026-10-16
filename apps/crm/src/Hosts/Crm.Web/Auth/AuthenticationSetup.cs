using System.Globalization;
using System.Security.Claims;
using Crm.Authorization;
using Crm.Identity.Contracts;
using Crm.Infrastructure.DependencyInjection;
using Crm.SharedKernel.Operations;
using Crm.Web.Http;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Authentication.OpenIdConnect;
using Microsoft.Identity.Client;
using Microsoft.Identity.Web;

namespace Crm.Web.Auth;

public static class AuthenticationSetup
{
    public const string CookieName = "__Host-crm";
    public const string CorrelationCookieName = "__Host-crm-oidc-corr.";
    public const string NonceCookieName = "__Host-crm-oidc-nonce.";
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

        if (TenantProblem(builder.Configuration["AzureAd:TenantId"], builder.Environment) is { } tenantProblem)
        {
            throw new InvalidOperationException(tenantProblem);
        }

        builder.Services
            // API requests challenge the local session; only /bff/login explicitly starts OIDC.
            .AddAuthentication(authentication =>
            {
                authentication.DefaultScheme = CookieAuthenticationDefaults.AuthenticationScheme;
                authentication.DefaultChallengeScheme = CookieAuthenticationDefaults.AuthenticationScheme;
            })
            .AddMicrosoftIdentityWebApp(
                oidc =>
                {
                    builder.Configuration.Bind("AzureAd", oidc);
                    // The handler's own cookies (state correlation, nonce) get a prefix the browser enforces. They must be
                    // sent back by the cross-site form post from Entra (SameSite=None), hence __Secure-, and a __Host- name
                    // needs Path=/, which the handler would otherwise narrow to the callback path.
                    oidc.CorrelationCookie.Name = CorrelationCookieName;
                    oidc.CorrelationCookie.Path = "/";
                    oidc.NonceCookie.Name = NonceCookieName;
                    oidc.NonceCookie.Path = "/";
                    oidc.ResponseType = "code";
                    oidc.UsePkce = true;
                    oidc.SaveTokens = false;
                    oidc.Events ??= new OpenIdConnectEvents();
                    var previousTicket = oidc.Events.OnTicketReceived;
                    oidc.Events.OnTicketReceived = async context =>
                    {
                        if (previousTicket is not null)
                        {
                            await previousTicket(context);
                        }

                        // The return address travelled in the protected state, but it is validated again where it is used.
                        context.ReturnUri = ReturnUrl.Safe(context.ReturnUri);
                    };
                    var previousRemoteFailure = oidc.Events.OnRemoteFailure;
                    oidc.Events.OnRemoteFailure = async context =>
                    {
                        // Only the exception type: its message can carry what the identity provider sent back.
                        SecurityLog.For(context.HttpContext).SignInFailed(context.Failure?.GetType().Name ?? "unknown");
                        if (previousRemoteFailure is not null)
                        {
                            await previousRemoteFailure(context);
                        }
                    };
                    var previousRemoteSignOut = oidc.Events.OnRemoteSignOut;
                    oidc.Events.OnRemoteSignOut = async context =>
                    {
                        if (previousRemoteSignOut is not null)
                        {
                            await previousRemoteSignOut(context);
                        }

                        await EndRemotelySignedOutSessionsAsync(context);
                    };
                    var previous = oidc.Events.OnTokenValidated;
                    oidc.Events.OnTokenValidated = async context =>
                    {
                        if (previous is not null)
                        {
                            await previous(context);
                        }

                        var services = context.HttpContext.RequestServices;
                        if (Reverification.FailureRedirect(
                                context.Principal!, context.Properties, services.GetRequiredService<TimeProvider>().GetUtcNow(), options.RequiredAcr, out var reason) is { } failed)
                        {
                            // Entra may ignore max_age, so the answer is checked: an authentication older than asked for, or for another
                            // account, proves nothing about who is here now. Nothing is signed in; the user is told and may try again.
                            SecurityLog.For(context.HttpContext).SignInFailed("reverify_" + reason);
                            context.HandleResponse();
                            context.Response.Redirect(failed);
                            return;
                        }

                        try
                        {
                            await ProvisionUserAsync(context.Principal!, context.HttpContext.RequestServices, context.HttpContext.RequestAborted);
                        }
                        catch (MaintenanceReadOnlyException)
                        {
                            // DEV-13: signing in waits for the end of read-only maintenance; the app says so on its start page.
                            context.HandleResponse();
                            context.Response.Redirect(MaintenanceSignInPath);
                        }
                    };
                },
                cookie => ConfigureCookie(cookie, options, revalidate: true),
                OpenIdConnectDefaults.AuthenticationScheme,
                CookieAuthenticationDefaults.AuthenticationScheme)
            .EnableTokenAcquisitionToCallDownstreamApi(RevalidationScopes)
            .AddDistributedTokenCaches();

        // The refresh tokens in identity.TokenCache are encrypted with the shared Data Protection key ring, not only by the
        // disk/TDE: whoever may read the table cannot use them. Entries written before this setting are plain; they are not
        // readable once encryption is on, and the signed-in user simply authenticates again when the cache has no usable entry.
        builder.Services.Configure<Microsoft.Identity.Web.TokenCacheProviders.Distributed.MsalDistributedTokenCacheAdapterOptions>(
            cache => cache.Encrypt = true);

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
    /// A tenant-less (<c>common</c>, <c>organizations</c>, <c>consumers</c>) or missing tenant would accept sign-ins from
    /// anywhere, so outside development the tenant must be a concrete directory (a GUID or a verified domain name).
    /// </summary>
    internal static string? TenantProblem(string? tenantId, IHostEnvironment environment)
    {
        if (environment.IsDevelopment())
        {
            return null;
        }

        var tenant = tenantId?.Trim();
        var concrete = !string.IsNullOrEmpty(tenant) &&
                       (Guid.TryParse(tenant, out var id) && id != Guid.Empty ||
                        tenant.Contains('.', StringComparison.Ordinal) && !tenant.Contains('/', StringComparison.Ordinal) && !tenant.Contains(' ', StringComparison.Ordinal));
        return concrete
            ? null
            : "AzureAd:TenantId must be the tenant's GUID or domain name outside Development: empty, 'common', 'organizations' and 'consumers' would admit other tenants.";
    }

    /// <summary>
    /// Entra's front-channel logout (<c>/signout-oidc</c>) arrives from an iframe without the Strict session cookie, so it is
    /// matched to CRM sessions by the identity provider's session id (<c>sid</c>) and the issuer it names. A request that names
    /// no session ends nothing; one that names another issuer is ignored.
    /// </summary>
    private static async Task EndRemotelySignedOutSessionsAsync(RemoteSignOutContext context)
    {
        var services = context.HttpContext.RequestServices;
        var log = SecurityLog.For(context.HttpContext);
        var sid = context.Request.Query["sid"].ToString();
        var issuer = context.Request.Query["iss"].ToString();
        if (string.IsNullOrEmpty(sid) || sid.Length > 128)
        {
            return;
        }

        try
        {
            var configuration = context.Options.Configuration ?? await context.Options.ConfigurationManager!.GetConfigurationAsync(context.HttpContext.RequestAborted);
            if (!string.IsNullOrEmpty(issuer) && !string.Equals(issuer, configuration.Issuer, StringComparison.Ordinal))
            {
                log.RemoteSignOutIgnored("issuer");
                return;
            }

            using var scope = Crm.SharedKernel.Operations.MaintenanceScope.AllowWrites("remote-sign-out");
            var ended = await services.GetRequiredService<ISessionDirectory>().EndByExternalSessionAsync(
                sid, "RemoteSignOut", services.GetRequiredService<TimeProvider>().GetUtcNow(), context.HttpContext.RequestAborted);
            if (ended > 0)
            {
                services.GetRequiredService<SessionStateCache>().ForgetAll();
            }

            log.RemoteSignOutApplied(ended);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            log.RemoteSignOutIgnored(ex.GetType().Name);
        }
    }

    /// <summary>Where a sign-in refused for maintenance lands: the app's start page says why (DEV-13).</summary>
    public const string MaintenanceSignInPath = "/?maintenance=signin";

    /// <summary>
    /// Creates/refreshes the CRM user with the roles the sign-in token carries, opens a server-side session and stamps the
    /// session claims (DEV-10). Shared by Entra and development sign-in.
    /// </summary>
    public static async Task ProvisionUserAsync(ClaimsPrincipal principal, IServiceProvider services, CancellationToken cancellationToken)
    {
        // DEV-13: signing in writes (the user, a session), so during read-only maintenance only the operators who run it sign in
        // — their privileged actions need a fresh confirmation of the roles, and a sign-in is one. Everyone else waits:
        // MaintenanceReadOnlyException, which the sign-in paths turn into the app's "signing in is paused" page.
        var maintenance = await services.GetRequiredService<IMaintenanceGate>().CurrentAsync(cancellationToken);
        using var operatorSignIn = !maintenance.IsReadOnly
            ? null
            : Permissions.ForRoles(principal.GetCrmRoles()).Contains(Permissions.OperationsMaintenance)
                ? MaintenanceScope.AllowWrites("operator-sign-in")
                : throw new MaintenanceReadOnlyException(maintenance);
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
        // The id_token's auth_time says when the user last authenticated interactively; a silent single-sign-on sign-in keeps the
        // old one. Without it (the optional claim is not configured) privileged actions stay closed until a re-verification.
        var authTime = Reverification.AuthTime(principal) is { } reported && reported > at ? at : Reverification.AuthTime(principal);
        var sessionId = await services.GetRequiredService<ISessionDirectory>().StartAsync(
            profile.Id, at, principal.FindFirstValue("sid"), cancellationToken, authTime);
        var now = at.ToUnixTimeSeconds().ToString(CultureInfo.InvariantCulture);
        identity.AddClaim(new Claim(CrmClaimTypes.UserId, profile.Id.ToString()));
        identity.AddClaim(new Claim(CrmClaimTypes.SessionId, sessionId.ToString()));
        identity.AddClaim(new Claim(CrmClaimTypes.SessionStarted, now));
        identity.AddClaim(new Claim(CrmClaimTypes.LastValidated, now));
        identity.AddClaim(new Claim(PermissionAuthorization.RolesVerifiedClaim, now));
        if (authTime is { } authenticated)
        {
            identity.AddClaim(new Claim(PermissionAuthorization.AuthTimeClaim, authenticated.ToUnixTimeSeconds().ToString(CultureInfo.InvariantCulture)));
        }
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
        if (state.AuthenticatedAt is { } authenticatedAt)
        {
            SetClaim(identity, PermissionAuthorization.AuthTimeClaim, authenticatedAt.ToUnixTimeSeconds().ToString(CultureInfo.InvariantCulture));
        }
        else
        {
            foreach (var claim in identity.FindAll(PermissionAuthorization.AuthTimeClaim).ToList())
            {
                identity.RemoveClaim(claim);
            }
        }

        if (!revalidate || ReadUnixClaim(principal, CrmClaimTypes.LastValidated) is { } last && now - last < options.RevalidationInterval)
        {
            return;
        }

        // DEV-13: redeeming the refresh token writes the token cache, so during read-only maintenance the check waits — the
        // session reads on within the role grace, and the next request after the maintenance revalidates.
        if ((await services.GetRequiredService<Crm.SharedKernel.Operations.IMaintenanceGate>().CurrentAsync(context.HttpContext.RequestAborted)).IsReadOnly)
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
        catch (Exception ex) when (ex is MicrosoftIdentityWebChallengeUserException or MsalUiRequiredException or System.Security.Cryptography.CryptographicException)
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
