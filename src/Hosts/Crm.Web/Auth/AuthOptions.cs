namespace Crm.Web.Auth;

public enum AuthMode
{
    /// <summary>Microsoft Entra ID via OpenID Connect. The only mode allowed outside Development.</summary>
    Entra,

    /// <summary>Local sign-in with a chosen role, for development without an app registration.</summary>
    Development,
}

public sealed class CrmAuthOptions
{
    public const string SectionName = "Auth";

    public AuthMode Mode { get; set; } = AuthMode.Entra;

    /// <summary>How often a session is re-validated against Entra ID via the refresh token (FR-AUTH-03).</summary>
    public TimeSpan RevalidationInterval { get; set; } = TimeSpan.FromMinutes(60);

    public TimeSpan SlidingExpiration { get; set; } = TimeSpan.FromHours(8);

    public TimeSpan AbsoluteExpiration { get; set; } = TimeSpan.FromHours(12);

    /// <summary>
    /// How long a replica trusts what it read about a session (open, user active, roles) before reading again (DEV-10). With the
    /// role sync every two minutes this bounds the revocation of a privilege at about two and a half minutes.
    /// </summary>
    public int SessionStateCacheSeconds { get; set; } = 30;

    /// <summary>
    /// How long a session reads on with roles the authority has not confirmed again (DEV-10): when the directory cannot be
    /// reached, reading continues this long after the last confirmation, then the session must sign in again. Privileged
    /// actions stop much sooner (<c>Auth:PrivilegedFreshness</c>).
    /// </summary>
    public TimeSpan RoleGrace { get; set; } = TimeSpan.FromHours(8);

    /// <summary>
    /// The <c>acr</c> claim a re-verification response must carry (F-G2-08), e.g. the value Conditional Access reports for
    /// multi-factor authentication. Empty by default: the real strength of the second factor is an Entra tenant setting and
    /// stays with EXT-02; the app only checks the claim when told which value to expect.
    /// </summary>
    public string RequiredAcr { get; set; } = string.Empty;
}

public static class CrmClaimTypes
{
    public const string UserId = "crm_uid";
    public const string SessionStarted = "crm_session_started";
    public const string LastValidated = "crm_last_validated";

    /// <summary>The server-side session this cookie belongs to (DEV-10).</summary>
    public const string SessionId = "crm_sid";

    /// <summary>The version of the confirmed roles the cookie's role claims were written from (DEV-10).</summary>
    public const string RolesVersion = "crm_rv";
    public const string ObjectId = "http://schemas.microsoft.com/identity/claims/objectidentifier";
    public const string TenantId = "http://schemas.microsoft.com/identity/claims/tenantid";
}
