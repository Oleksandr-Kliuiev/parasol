using System.Globalization;
using System.Security.Claims;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.OpenIdConnect;

namespace Crm.Web.Auth;

/// <summary>
/// Re-verification of the person at the keyboard before a privileged action (F-G2-08, ASVS 6.8.4 / 6.3.3). A directory sync or a
/// silent single-sign-on sign-in proves the roles, not that the user is present, so the privileged policies also read the
/// session's <c>auth_time</c>. A re-verification is a sign-in that Entra must answer interactively: <c>prompt=login</c> and
/// <c>max_age</c> in the request, and — because Entra may ignore both — the returned <c>auth_time</c> checked here.
/// </summary>
internal static class Reverification
{
    /// <summary>Query parameter of <c>/bff/login</c> and key of the challenge's protected state.</summary>
    public const string Parameter = "reverify";

    public const string MaxAgeItem = "crm_reverify_max_age";
    public const string ExpectedObjectIdItem = "crm_reverify_oid";

    /// <summary>Appended to the return address when the response could not be accepted; the SPA says so and offers another try.</summary>
    public const string FailedQuery = "reverify=failed";

    /// <summary>The address the API offers in <c>AUTH_REVERIFY_REQUIRED</c>; the SPA adds <c>&amp;returnUrl=</c>.</summary>
    public const string Url = "/bff/login?reverify=1";

    /// <summary>Entra's clock and ours may differ by a little; an <c>auth_time</c> this much older than <c>max_age</c> is still accepted.</summary>
    public static readonly TimeSpan Skew = TimeSpan.FromMinutes(1);

    /// <summary>The challenge of a re-verification: always a password/MFA prompt, never older than <paramref name="maxAge"/>.</summary>
    public static AuthenticationProperties Challenge(string returnUrl, TimeSpan maxAge, string? expectedObjectId)
    {
        var properties = new OpenIdConnectChallengeProperties
        {
            RedirectUri = returnUrl,
            Prompt = "login",
            MaxAge = maxAge,
        };
        properties.Items[MaxAgeItem] = ((long)maxAge.TotalSeconds).ToString(CultureInfo.InvariantCulture);
        if (!string.IsNullOrEmpty(expectedObjectId))
        {
            properties.Items[ExpectedObjectIdItem] = expectedObjectId;
        }

        return properties;
    }

    public static bool IsReverification(AuthenticationProperties? properties) =>
        properties?.Items.ContainsKey(MaxAgeItem) == true;

    /// <summary>
    /// Why the id_token that answers a re-verification cannot be accepted, or null when it can: it must carry <c>auth_time</c>
    /// (the app registration's optional claim), the authentication must be no older than the requested <c>max_age</c> (plus
    /// <see cref="Skew"/>), it must be for the account that asked, and with <paramref name="requiredAcr"/> set (Conditional
    /// Access, EXT-02) its <c>acr</c> must match.
    /// </summary>
    public static string? Reject(ClaimsPrincipal principal, AuthenticationProperties? properties, DateTimeOffset now, string? requiredAcr)
    {
        if (!long.TryParse(Item(properties, MaxAgeItem), NumberStyles.Integer, CultureInfo.InvariantCulture, out var maxAgeSeconds))
        {
            return "not_a_reverification";
        }

        if (AuthTime(principal) is not { } authTime)
        {
            return "auth_time_missing";
        }

        if (now - authTime > TimeSpan.FromSeconds(maxAgeSeconds) + Skew)
        {
            return "auth_time_too_old";
        }

        var expected = Item(properties, ExpectedObjectIdItem);
        var actual = principal.FindFirstValue(CrmClaimTypes.ObjectId) ?? principal.FindFirstValue("oid");
        if (!string.IsNullOrEmpty(expected) && !string.Equals(expected, actual, StringComparison.OrdinalIgnoreCase))
        {
            return "other_account";
        }

        if (!string.IsNullOrWhiteSpace(requiredAcr) && !string.Equals(principal.FindFirstValue("acr"), requiredAcr.Trim(), StringComparison.Ordinal))
        {
            return "acr_mismatch";
        }

        return null;
    }

    /// <summary>
    /// Where to send the browser instead of signing it in, when the sign-in answers a re-verification and cannot be accepted;
    /// null for an ordinary sign-in and for an acceptable re-verification. The one place the callback and the tests decide.
    /// </summary>
    public static string? FailureRedirect(ClaimsPrincipal principal, AuthenticationProperties? properties, DateTimeOffset now, string? requiredAcr, out string? reason)
    {
        reason = IsReverification(properties) ? Reject(principal, properties, now, requiredAcr) : null;
        return reason is null ? null : WithFailure(properties!.RedirectUri ?? "/");
    }

    private static string? Item(AuthenticationProperties? properties, string key) =>
        properties is not null && properties.Items.TryGetValue(key, out var value) ? value : null;

    /// <summary>The id_token's <c>auth_time</c> (Unix seconds), or null when absent or malformed.</summary>
    public static DateTimeOffset? AuthTime(ClaimsPrincipal principal) =>
        long.TryParse(principal.FindFirstValue("auth_time"), NumberStyles.Integer, CultureInfo.InvariantCulture, out var seconds) && seconds > 0
            ? DateTimeOffset.FromUnixTimeSeconds(seconds)
            : null;

    /// <summary>The return address with <see cref="FailedQuery"/> added; the address was validated before and stays a path of this app.</summary>
    public static string WithFailure(string returnUrl)
    {
        var safe = ReturnUrl.Safe(returnUrl);
        var fragment = safe.IndexOf('#', StringComparison.Ordinal);
        var path = fragment < 0 ? safe : safe[..fragment];
        return path + (path.Contains('?', StringComparison.Ordinal) ? "&" : "?") + FailedQuery;
    }
}
