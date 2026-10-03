using Crm.SharedKernel.Domain;

namespace Crm.Customers.Domain;

/// <summary>Record of a merge, kept so it can be undone within <see cref="UndoWindow"/> (BR-CUS-06).</summary>
public sealed class OrganizationMerge : AuditableEntity
{
    public static readonly TimeSpan UndoWindow = TimeSpan.FromDays(30);

    private OrganizationMerge() { }

    public OrganizationMerge(Guid targetId, Guid sourceId, OrganizationSnapshot targetBefore, OrganizationSnapshot sourceBefore, Guid[] movedAffiliationIds)
    {
        TargetId = targetId;
        SourceId = sourceId;
        TargetBefore = targetBefore;
        SourceBefore = sourceBefore;
        MovedAffiliationIds = movedAffiliationIds;
    }

    public Guid TargetId { get; private set; }
    public Guid SourceId { get; private set; }
    public OrganizationSnapshot TargetBefore { get; private set; } = null!;
    public OrganizationSnapshot SourceBefore { get; private set; } = null!;
    public Guid[] MovedAffiliationIds { get; private set; } = [];
    public DateTimeOffset? UndoneAt { get; private set; }

    /// <summary>Target's ModifiedAt right after the merge; a later value means someone edited it and undo is refused.</summary>
    public DateTimeOffset? TargetModifiedAt { get; private set; }

    public bool CanUndo(DateTimeOffset now) => UndoneAt is null && now - CreatedAt <= UndoWindow;

    internal void RecordTargetVersion(DateTimeOffset? modifiedAt) => TargetModifiedAt = modifiedAt;

    internal void MarkUndone(DateTimeOffset at) => UndoneAt = at;
}

/// <summary>A pair the user confirmed is not a duplicate. Stored with the lower id first.</summary>
public sealed class DuplicateDismissal : AuditableEntity
{
    private DuplicateDismissal() { }

    public DuplicateDismissal(Guid a, Guid b)
    {
        (FirstOrganizationId, SecondOrganizationId) = a.CompareTo(b) < 0 ? (a, b) : (b, a);
    }

    public Guid FirstOrganizationId { get; private set; }
    public Guid SecondOrganizationId { get; private set; }
}
