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
}

public static class CrmClaimTypes
{
    public const string UserId = "crm_uid";
    public const string SessionStarted = "crm_session_started";
    public const string LastValidated = "crm_last_validated";
    public const string ObjectId = "http://schemas.microsoft.com/identity/claims/objectidentifier";
    public const string TenantId = "http://schemas.microsoft.com/identity/claims/tenantid";
}
