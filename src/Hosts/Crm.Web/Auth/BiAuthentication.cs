using Crm.Reports;
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
                ValidateIssuerSigningKey = true,
                ClockSkew = TimeSpan.FromMinutes(1),
                NameClaimType = "name",
                RoleClaimType = "roles",
            };
        });
        return builder;
    }
}
