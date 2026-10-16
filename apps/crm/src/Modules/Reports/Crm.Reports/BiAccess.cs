using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.Extensions.Options;

namespace Crm.Reports;

/// <summary>
/// Who may read the BI API (DEV-14, ADR-022). The token is validated by the <see cref="Scheme"/> bearer scheme (signature,
/// issuer, audience, lifetime); this policy then asks the questions only the CRM can: is it our tenant, is it a client
/// application we named, and does it hold a BI role (application permission). No delegated scope is accepted: a signed-in
/// user's token would authorize without any check of that user in the CRM. The CRM's own roles and the
/// cookie session play no part: a bearer token opens nothing outside <c>/api/v1/bi</c>, and a cookie opens nothing inside it.
/// </summary>
public static class BiAccess
{
    public const string Scheme = "BiBearer";
    public const string Policy = "bi";
    public const string ReadRole = "Crm.Bi.Read";
    public const string CostRole = "Crm.Bi.Cost";

    /// <summary>The client application of a token: <c>azp</c> (v2 tokens) or <c>appid</c> (v1).</summary>
    public static string? ClientOf(ClaimsPrincipal user) => user.FindFirstValue("azp") ?? user.FindFirstValue("appid");

    public static bool HoldsRead(ClaimsPrincipal user) => Holds(user, ReadRole);

    public static bool HoldsCost(ClaimsPrincipal user) => Holds(user, CostRole);

    /// <summary>A dataset of Microsoft's costs and margins needs the cost grant; the others the read grant.</summary>
    public static bool MayRead(ClaimsPrincipal user, BiDataset dataset) => dataset.RequiresCost ? HoldsCost(user) : HoldsRead(user);

    private static bool Holds(ClaimsPrincipal user, string role) => user.FindAll("roles").Any(c => c.Value == role);
}

public sealed class BiRequirement : IAuthorizationRequirement;

internal sealed class BiAuthorizationHandler(IOptions<BiOptions> options) : AuthorizationHandler<BiRequirement>
{
    protected override Task HandleRequirementAsync(AuthorizationHandlerContext context, BiRequirement requirement)
    {
        var settings = options.Value;
        var user = context.User;
        var client = BiAccess.ClientOf(user);
        var tenant = user.FindFirstValue("tid");

        // Fail closed: no tenant, no audience or no named client configured means nobody reads.
        if (settings is { Enabled: true, TenantId.Length: > 0 } &&
            string.Equals(tenant, settings.TenantId, StringComparison.OrdinalIgnoreCase) &&
            client is not null && settings.AllowedClients.Contains(client, StringComparer.OrdinalIgnoreCase) &&
            (BiAccess.HoldsRead(user) || BiAccess.HoldsCost(user)))
        {
            context.Succeed(requirement);
        }

        return Task.CompletedTask;
    }
}
