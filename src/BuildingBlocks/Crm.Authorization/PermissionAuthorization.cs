using System.Globalization;
using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Options;

namespace Crm.Authorization;

/// <summary>Holding any of the listed permissions is enough (a single permission is the usual case).</summary>
public sealed class PermissionRequirement(params string[] permissions) : IAuthorizationRequirement
{
    public IReadOnlyList<string> Permissions { get; } = permissions;
}

/// <summary>How recent the authority's confirmation of the roles must be for privileged actions (DEV-10, section <c>Auth</c>).</summary>
public sealed class AuthorizationFreshnessOptions
{
    /// <summary>The project target of DEC-05: a revoked privilege stops within five minutes, also when the directory is unreachable.</summary>
    public TimeSpan PrivilegedFreshness { get; set; } = TimeSpan.FromMinutes(5);
}

/// <summary>Marks a read endpoint that exports data in bulk: it counts as privileged, like a financial command (DEV-10).</summary>
public sealed class ExportsDataMetadata;

/// <summary>
/// Marks a change that rewrites prices for many customers at once (a mass indexation, activating a price list): it needs the
/// authority's recent confirmation of the caller's roles like a financial command, although its permission (contracts.write,
/// catalog.write) is also used for everyday edits and so is not privileged as a whole (F-G3-10).
/// </summary>
public sealed class RequiresFreshRolesMetadata;

internal sealed class PermissionAuthorizationHandler(IOptions<AuthorizationFreshnessOptions> freshness, TimeProvider time)
    : AuthorizationHandler<PermissionRequirement>
{
    protected override Task HandleRequirementAsync(AuthorizationHandlerContext context, PermissionRequirement requirement)
    {
        var held = context.User.GetPermissions();
        var granted = requirement.Permissions.Where(held.Contains).ToList();
        if (granted.Count == 0)
        {
            return Task.CompletedTask;
        }

        // DEV-10: a financial command, an export or an administrative action uses a privilege only the authority confirmed
        // recently. Unconfirmed — the directory unreachable, no fresh sign-in — it fails closed; reading goes on.
        if (IsPrivileged(granted, context.Resource as HttpContext) && !IsFresh(context.User))
        {
            context.Fail(new AuthorizationFailureReason(this, PermissionAuthorization.ReverifyRequired));
            return Task.CompletedTask;
        }

        context.Succeed(requirement);
        return Task.CompletedTask;
    }

    // A bulk export, whatever its permission; otherwise a change made through privileged permissions only.
    private static bool IsPrivileged(IReadOnlyList<string> granted, HttpContext? http) =>
        http?.GetEndpoint()?.Metadata.GetMetadata<ExportsDataMetadata>() is not null ||
        http?.GetEndpoint()?.Metadata.GetMetadata<RequiresFreshRolesMetadata>() is not null ||
        (granted.All(Permissions.Privileged.Contains) &&
         (http is null || (!HttpMethods.IsGet(http.Request.Method) && !HttpMethods.IsHead(http.Request.Method))));

    // Two things must both be recent (F-G2-08, ASVS 6.8.4): the authority's confirmation of the roles AND the user's own last
    // interactive authentication. A directory sync or a silent single-sign-on re-login moves only the first, so neither
    // proves that the user is at the keyboard now.
    private bool IsFresh(ClaimsPrincipal user) =>
        IsRecent(user, PermissionAuthorization.RolesVerifiedClaim) && IsRecent(user, PermissionAuthorization.AuthTimeClaim);

    private bool IsRecent(ClaimsPrincipal user, string claim) =>
        long.TryParse(user.FindFirstValue(claim), NumberStyles.Integer, CultureInfo.InvariantCulture, out var seconds) &&
        time.GetUtcNow() - DateTimeOffset.FromUnixTimeSeconds(seconds) <= freshness.Value.PrivilegedFreshness;
}

public static class PermissionAuthorization
{
    /// <summary>
    /// Unix seconds of the authority's last confirmation of the caller's roles. The server sets it on every request from its
    /// own record (DEV-10); a value written into a cookie is overwritten, never trusted.
    /// </summary>
    public const string RolesVerifiedClaim = "crm_roles_verified";

    /// <summary>
    /// Unix seconds of the user's last interactive authentication (the id_token's <c>auth_time</c>, kept on the server-side
    /// session). Set by the server on every request from its own record; absent when the identity provider did not say, which
    /// fails closed for privileged actions.
    /// </summary>
    public const string AuthTimeClaim = "crm_auth_time";

    /// <summary>Failure reason and API error code when a privileged action needs a fresh confirmation of the roles.</summary>
    public const string ReverifyRequired = "AUTH_REVERIFY_REQUIRED";
}

/// <summary>Resolves policies named <c>perm:&lt;permission&gt;</c> on demand, so every permission is usable as a policy.</summary>
internal sealed class PermissionPolicyProvider(IOptions<AuthorizationOptions> options) : DefaultAuthorizationPolicyProvider(options)
{
    public const string Prefix = "perm:";

    public override async Task<AuthorizationPolicy?> GetPolicyAsync(string policyName)
    {
        if (!policyName.StartsWith(Prefix, StringComparison.Ordinal))
        {
            return await base.GetPolicyAsync(policyName);
        }

        return new AuthorizationPolicyBuilder()
            .RequireAuthenticatedUser()
            .AddRequirements(new PermissionRequirement(policyName[Prefix.Length..].Split('|')))
            .Build();
    }
}

public static class PermissionAuthorizationExtensions
{
    public static IServiceCollection AddCrmAuthorization(this IServiceCollection services)
    {
        services.AddOptions<AuthorizationFreshnessOptions>().BindConfiguration("Auth");
        services.TryAddSingleton(TimeProvider.System);
        services.AddSingleton<IAuthorizationHandler, PermissionAuthorizationHandler>();
        services.AddSingleton<IAuthorizationPolicyProvider, PermissionPolicyProvider>();
        services.AddAuthorizationBuilder()
            .SetFallbackPolicy(new AuthorizationPolicyBuilder().RequireAuthenticatedUser().Build());
        return services;
    }

    /// <summary>Protects an endpoint; with several permissions any one of them is enough.</summary>
    public static TBuilder RequirePermission<TBuilder>(this TBuilder builder, params string[] permissions)
        where TBuilder : IEndpointConventionBuilder =>
        builder.RequireAuthorization(PermissionPolicyProvider.Prefix + string.Join('|', permissions));

    /// <summary>A change with a price-wide effect: needs a fresh confirmation of the roles whatever its permission (F-G3-10).</summary>
    public static TBuilder RequiresFreshRoles<TBuilder>(this TBuilder builder)
        where TBuilder : IEndpointConventionBuilder =>
        builder.WithMetadata(new RequiresFreshRolesMetadata());

    /// <summary>A bulk export: when its permission is privileged, it needs a fresh confirmation of the roles like a command (DEV-10).</summary>
    public static TBuilder ExportsData<TBuilder>(this TBuilder builder)
        where TBuilder : IEndpointConventionBuilder =>
        builder.WithMetadata(new ExportsDataMetadata());
}
