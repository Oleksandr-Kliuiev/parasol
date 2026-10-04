namespace Crm.Audit.Persistence;

/// <summary>
/// A link of the audit hash chain (DEV-04): the SHA-256 over the immutable fact of every audit entry from
/// <see cref="FromId"/> to <see cref="ToId"/>, chained to the previous checkpoint. The personal part of an entry (who, from
/// where, what changed) is not in the chain, so retention can remove it without breaking the chain. The chain stored here is
/// no protection against the database owner: every new checkpoint is also written to the log workspace, which is the anchor.
/// </summary>
public sealed class AuditIntegrityCheckpoint
{
    public long Id { get; init; }
    public long FromId { get; init; }
    public long ToId { get; init; }
    public int Entries { get; init; }
    public string? PreviousHash { get; init; }
    public string ChainHash { get; init; } = string.Empty;
    public DateTimeOffset CreatedAt { get; init; }
}
