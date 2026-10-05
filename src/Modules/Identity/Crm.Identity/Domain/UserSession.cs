using Crm.SharedKernel.Domain;

namespace Crm.Identity.Domain;

/// <summary>
/// A signed-in session (DEV-10). The cookie carries its id; signing out ends it, and every replica refuses a cookie whose
/// session has ended — a copied cookie does not outlive the sign-out.
/// </summary>
public sealed class UserSession : Entity
{
    private UserSession() { }

    public Guid UserId { get; private set; }

    public DateTimeOffset StartedAt { get; private set; }

    public DateTimeOffset? EndedAt { get; private set; }

    public string? EndReason { get; private set; }

    /// <summary>SHA-256 (hex) of the identity provider's session id; the id itself is never stored.</summary>
    public string? ExternalSessionHash { get; private set; }

    /// <summary>
    /// When the user last authenticated interactively, as the identity provider reported it (the id_token's <c>auth_time</c>).
    /// A silent single-sign-on sign-in starts a session but does not move it. Null when the provider did not say.
    /// </summary>
    public DateTimeOffset? AuthenticatedAt { get; private set; }

    public static UserSession Start(Guid userId, DateTimeOffset at, string? externalSessionHash = null, DateTimeOffset? authenticatedAt = null) =>
        new() { UserId = userId, StartedAt = at, ExternalSessionHash = externalSessionHash, AuthenticatedAt = authenticatedAt };

    public void End(string reason, DateTimeOffset at)
    {
        if (EndedAt is null)
        {
            EndedAt = at;
            EndReason = reason;
        }
    }
}
