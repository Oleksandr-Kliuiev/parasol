using Crm.SharedKernel.Domain;

namespace Crm.Privacy.Domain;

public enum SuppressionKind
{
    /// <summary>A keyed hash of a normalized e-mail address: it confirms a known address, it does not reveal one.</summary>
    Email,

    /// <summary>The person's id in an external system, e.g. <c>atera:contact:123</c>.</summary>
    ExternalReference,
}

/// <summary>
/// Keeps an erased person from coming back with the next synchronization or import (DEV-11-AC05) — the minimum to recognise
/// them, nothing to identify them by. Lifted only with a new lawful basis, recorded with who and why.
/// </summary>
public sealed class Suppression : AuditableEntity
{
    private Suppression() { }

    public SuppressionKind Kind { get; private set; }

    public string Value { get; private set; } = string.Empty;

    public Guid CaseId { get; private set; }

    public DateTimeOffset? LiftedAt { get; private set; }

    public Guid? LiftedBy { get; private set; }

    public string? LiftReason { get; private set; }

    public static Suppression For(SuppressionKind kind, string value, Guid caseId) => new() { Kind = kind, Value = value, CaseId = caseId };

    public void Lift(string reason, Guid? by, DateTimeOffset at)
    {
        LiftReason = reason;
        LiftedBy = by;
        LiftedAt = at;
    }
}
