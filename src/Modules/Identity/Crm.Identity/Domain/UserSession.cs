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

    public static UserSession Start(Guid userId, DateTimeOffset at) => new() { UserId = userId, StartedAt = at };

    public void End(string reason, DateTimeOffset at)
    {
        if (EndedAt is null)
        {
            EndedAt = at;
            EndReason = reason;
        }
    }
}
