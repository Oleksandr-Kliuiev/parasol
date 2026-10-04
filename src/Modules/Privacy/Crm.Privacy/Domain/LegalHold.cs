using Crm.SharedKernel.Domain;

namespace Crm.Privacy.Domain;

public enum LegalHoldReason
{
    /// <summary>Bookkeeping documentation beyond what the modules already keep on their own (Bokføringsloven §13).</summary>
    Bookkeeping,

    /// <summary>A dispute or a claim the record is evidence for.</summary>
    LegalClaim,

    /// <summary>An authority (Datatilsynet, police, a court) asked for it to be kept.</summary>
    AuthorityRequest,
    Other,
}

/// <summary>
/// Keeps one record through an erasure, with an explanation and an end date (DEV-11-AC04). A hold names a record, never a
/// whole person: the rest of the person's data is erased as usual, and when the hold ends or is released the record is no
/// longer protected by it.
/// </summary>
public sealed class LegalHold : AuditableEntity
{
    private LegalHold() { }

    public string Module { get; private set; } = string.Empty;

    public string EntityType { get; private set; } = string.Empty;

    public Guid EntityId { get; private set; }

    public LegalHoldReason Reason { get; private set; }

    public string Explanation { get; private set; } = string.Empty;

    /// <summary>The last day the record is kept for this reason; a hold without an end does not exist.</summary>
    public DateOnly Until { get; private set; }

    public DateTimeOffset? ReleasedAt { get; private set; }

    public Guid? ReleasedBy { get; private set; }

    public string? ReleaseReason { get; private set; }

    public static LegalHold Place(string module, string entityType, Guid entityId, LegalHoldReason reason, string explanation, DateOnly until) => new()
    {
        Module = module,
        EntityType = entityType,
        EntityId = entityId,
        Reason = reason,
        Explanation = explanation,
        Until = until,
    };

    public bool IsActiveOn(DateOnly day) => ReleasedAt is null && day <= Until;

    public void Release(string reason, Guid? by, DateTimeOffset at)
    {
        ReleaseReason = reason;
        ReleasedBy = by;
        ReleasedAt = at;
    }
}
