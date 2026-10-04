using Crm.SharedKernel.Domain;

namespace Crm.Privacy.Domain;

/// <summary>
/// What an executed erasure did, by record id and action, and the suppressions it left (DEV-11-AC06): no personal data. Kept
/// in the database and, write-once, in the document store outside it, so a restore from before the erasure finds it there
/// and applies it again before anyone uses the restored copy.
/// </summary>
public sealed class ErasureManifest : Entity
{
    private ErasureManifest() { }

    public Guid CaseId { get; private set; }

    public string CaseNumber { get; private set; } = string.Empty;

    public DateTimeOffset ExecutedAt { get; private set; }

    public string ContentJson { get; private set; } = string.Empty;

    public string Sha256 { get; private set; } = string.Empty;

    /// <summary>Key of the copy in the document store; empty until it was written there.</summary>
    public string? StoreKey { get; private set; }

    public DateTimeOffset? StoredAt { get; private set; }

    /// <summary>Set when this manifest came back from the store after a restore and was applied again.</summary>
    public DateTimeOffset? ReplayedAt { get; private set; }

    public static ErasureManifest Record(Guid id, Guid caseId, string caseNumber, DateTimeOffset executedAt, string contentJson, string sha256) => new()
    {
        Id = id,
        CaseId = caseId,
        CaseNumber = caseNumber,
        ExecutedAt = executedAt,
        ContentJson = contentJson,
        Sha256 = sha256,
    };

    public static ErasureManifest Replayed(Guid id, Guid caseId, string caseNumber, DateTimeOffset executedAt, string contentJson, string sha256, string storeKey, DateTimeOffset at) => new()
    {
        Id = id,
        CaseId = caseId,
        CaseNumber = caseNumber,
        ExecutedAt = executedAt,
        ContentJson = contentJson,
        Sha256 = sha256,
        StoreKey = storeKey,
        StoredAt = executedAt,
        ReplayedAt = at,
    };

    public void MarkStored(string key, DateTimeOffset at)
    {
        StoreKey = key;
        StoredAt = at;
    }
}

/// <summary>One record an executed erasure covered: what views and the operator's procedures look up.</summary>
public sealed class ErasedRecordRow
{
    public long Id { get; init; }

    public Guid ManifestId { get; init; }

    public string Module { get; init; } = string.Empty;

    public string EntityType { get; init; } = string.Empty;

    public Guid EntityId { get; init; }

    public string Action { get; init; } = string.Empty;

    public string DataClass { get; init; } = string.Empty;
}
