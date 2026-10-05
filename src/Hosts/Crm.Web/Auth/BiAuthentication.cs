using Crm.Reports;
using Crm.Web.Http;
using System.Security.Claims;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.IdentityModel.Tokens;

namespace Crm.Web.Auth;

/// <summary>
/// The bearer scheme of the BI read API (DEV-14, ADR-022). Validates what Entra issued — signature through the tenant's keys,
/// issuer, audience, lifetime — for tokens presented on <c>/api/v1/bi</c>. It is not a default scheme: only the BI policy names
/// it, so a bearer token never authenticates the cookie API and the cookie session never reaches the BI API.
/// </summary>
internal static class BiAuthentication
{
    public static WebApplicationBuilder AddBiAuthentication(this WebApplicationBuilder builder)
    {
        var settings = builder.Configuration.GetSection(BiOptions.SectionName).Get<BiOptions>() ?? new BiOptions();
        if (!settings.Enabled)
        {
            return builder;
        }

        // Enabled without these it would admit nobody or everybody: refuse to start instead.
        if (string.IsNullOrWhiteSpace(settings.TenantId) || string.IsNullOrWhiteSpace(settings.Audience) || settings.AllowedClients.Count == 0)
        {
            throw new InvalidOperationException("Bi:Enabled needs Bi:TenantId, Bi:Audience and at least one Bi:AllowedClients entry.");
        }

        builder.Services.AddAuthentication().AddJwtBearer(BiAccess.Scheme, options =>
        {
            options.Authority = $"https://login.microsoftonline.com/{settings.TenantId}/v2.0";
            options.MapInboundClaims = false;
            options.RequireHttpsMetadata = true;
            options.TokenValidationParameters = new TokenValidationParameters
            {
                ValidateIssuer = true,
                ValidIssuers = [$"https://login.microsoftonline.com/{settings.TenantId}/v2.0", $"https://sts.windows.net/{settings.TenantId}/"],
                ValidateAudience = true,
                ValidAudience = settings.Audience,
                ValidateLifetime = true,
                RequireExpirationTime = true,
                RequireSignedTokens = true,
                // Entra signs with RS256; HS256 or "none" is never meant here (ASVS 9.1).
                ValidAlgorithms = [SecurityAlgorithms.RsaSha256],
                ValidTypes = ["JWT", "at+jwt"],
                ValidateIssuerSigningKey = true,
                ClockSkew = TimeSpan.FromMinutes(1),
                NameClaimType = "name",
                RoleClaimType = "roles",
            };
            options.Events = new JwtBearerEvents
            {
                OnAuthenticationFailed = context =>
                {
                    // The exception type only: its message can quote the token's claims.
                    SecurityLog.For(context.HttpContext).BiTokenRejected(context.Exception.GetType().Name);
                    return Task.CompletedTask;
                },
                OnTokenValidated = context =>
                {
                    if (!IsAccessToken(context.Principal))
                    {
                        SecurityLog.For(context.HttpContext).BiTokenRejected("not_an_access_token");
                        context.Fail("The token is not an access token issued to a client application.");
                    }

                    return Task.CompletedTask;
                },
            };
        });
        return builder;
    }

    /// <summary>
    /// The audience is the CRM's own application, the same one the sign-in's id_token is issued for, so the token's kind is
    /// checked here and not left to the audience: an access token names the client it was issued to and how that client
    /// authenticated (<c>azp</c>/<c>azpacr</c>, or <c>appid</c>/<c>appidacr</c> in version 1); an id_token carries a nonce and
    /// none of them; an application token's <c>idtyp</c>, when present, is <c>app</c>.
    /// </summary>
    internal static bool IsAccessToken(ClaimsPrincipal? principal)
    {
        if (principal is null || principal.HasClaim(c => c.Type == "nonce"))
        {
            return false;
        }

        var hasClient = principal.HasClaim(c => c.Type is "azp" or "appid");
        var hasClientAuthentication = principal.HasClaim(c => c.Type is "azpacr" or "appidacr");
        var idtyp = principal.FindFirst("idtyp")?.Value;
        return hasClient && hasClientAuthentication && (idtyp is null || idtyp == "app");
    }
}
