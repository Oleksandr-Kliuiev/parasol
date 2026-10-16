using System.Security.Cryptography;
using System.Text;
using Crm.SharedKernel.Domain;

namespace Crm.Customers.Domain;

public enum ImportMode
{
    DryRun,
    Real,
}

public enum ImportRunStatus
{
    /// <summary>A real run is working through the file; one that stops being updated can be resumed by repeating the call.</summary>
    Running,

    Completed,

    /// <summary>A chunk could not be saved: the chunks before it stay committed and the same file resumes after them.</summary>
    Partial,

    Failed,
}

/// <summary>What happened to one source row. Every row of the file gets exactly one of these (DEV-20-AC03).</summary>
public static class ImportAction
{
    public const string Created = "Created";
    public const string Updated = "Updated";
    public const string Unchanged = "Unchanged";

    /// <summary>The file and the CRM disagree, or the match is ambiguous: a person decides. Nothing in a conflicting field is overwritten.</summary>
    public const string Conflict = "Conflict";

    public const string Rejected = "Rejected";
}

/// <summary>Machine-readable reasons of the migration import. Messages and logs carry these, never the values they are about.</summary>
public static class ImportReason
{
    public const string MissingName = "MISSING_NAME";
    public const string InvalidOrgNumber = "INVALID_ORGNR";
    public const string InvalidEmail = "INVALID_EMAIL";
    public const string InvalidContactEmail = "INVALID_CONTACT_EMAIL";
    public const string InvalidDomain = "INVALID_DOMAIN";
    public const string UnknownStatus = "UNKNOWN_STATUS";
    public const string DuplicateInFile = "DUPLICATE_IN_FILE";
    public const string FieldTooLong = "FIELD_TOO_LONG";
    public const string EncodingInvalid = "ENCODING_INVALID";
    public const string RaggedRow = "RAGGED_ROW";
    public const string UnterminatedQuote = "UNTERMINATED_QUOTE";
    public const string OwnerUnknown = "OWNER_UNKNOWN";
    public const string OwnerEmpty = "OWNER_EMPTY";
    public const string InvalidDate = "INVALID_DATE";
    public const string AmbiguousDate = "AMBIGUOUS_DATE";
    public const string ContractDatesOrder = "CONTRACT_DATES_ORDER";
    public const string InvalidCurrency = "INVALID_CURRENCY";
    public const string InvalidVatRate = "INVALID_VAT_RATE";
    public const string InvalidParentOrgNumber = "INVALID_PARENT_ORGNR";
    public const string BrokenReference = "BROKEN_REFERENCE";
    public const string IncompleteExternalId = "EXTERNAL_ID_INCOMPLETE";
    public const string UnknownProduct = "UNKNOWN_PRODUCT";
    public const string AmbiguousMatch = "AMBIGUOUS_MATCH";
    public const string FieldConflict = "FIELD_CONFLICT";
    public const string ContactSuppressed = "CONTACT_SUPPRESSED";
    public const string NearDuplicate = "NEAR_DUPLICATE";
    public const string ValidatedNotImported = "VALIDATED_NOT_IMPORTED";

    /// <summary>The run's chunk could not be saved (a constraint, a lock timeout); the run is Partial.</summary>
    public const string ChunkFailed = "IMPORT_CHUNK_FAILED";
}

/// <summary>
/// One call of the migration import (DEV-20): the manifest of what was read and what became of it. Previews are runs too, so
/// the import that follows is tied to the file that was previewed. It holds no names, e-mail addresses or amounts — only
/// hashes, counters, line numbers, codes and ids.
/// </summary>
public sealed class ImportRun : Entity
{
    /// <summary>Version of the column mapping and rules; a different version of the rules is a different repeat key.</summary>
    public const string CurrentMappingVersion = "customers-migration/2";

    private ImportRun() { }

    public string SourceSha256 { get; private set; } = string.Empty;
    public string MappingVersion { get; private set; } = string.Empty;

    /// <summary>Hash of source and mapping version: the same file read the same way is the same job, whenever it is repeated.</summary>
    public string RepeatKey { get; private set; } = string.Empty;

    public ImportMode Mode { get; private set; }
    public ImportRunStatus Status { get; private set; }
    public int RowsTotal { get; private set; }
    public int Created { get; private set; }
    public int Updated { get; private set; }
    public int Unchanged { get; private set; }
    public int Conflict { get; private set; }
    public int Rejected { get; private set; }
    public int ContactsWritten { get; private set; }

    /// <summary>The last file line a committed chunk covered; a resumed run continues after it.</summary>
    public int LastCommittedLine { get; private set; }

    public DateTimeOffset StartedAt { get; private set; }
    public DateTimeOffset UpdatedAt { get; private set; }
    public DateTimeOffset? FinishedAt { get; private set; }
    public Guid? UserId { get; private set; }

    /// <summary>When a chunk failed: the lines it covered, so a person knows where to look.</summary>
    public int? FailedFromLine { get; private set; }

    public int? FailedToLine { get; private set; }
    public string? FailureCode { get; private set; }

    /// <summary>Counts only (JSON): owner coverage, what was validated but not imported, warning codes. No values.</summary>
    public string? SummaryJson { get; private set; }

    public static string Sha256Hex(byte[] content) => Convert.ToHexStringLower(SHA256.HashData(content));

    public static string RepeatKeyOf(string sourceSha256, string mappingVersion) =>
        Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes($"{sourceSha256}|{mappingVersion}")));

    public static ImportRun Start(string sourceSha256, ImportMode mode, int rowsTotal, Guid? userId, DateTimeOffset at) => new()
    {
        SourceSha256 = sourceSha256,
        MappingVersion = CurrentMappingVersion,
        RepeatKey = RepeatKeyOf(sourceSha256, CurrentMappingVersion),
        Mode = mode,
        Status = ImportRunStatus.Running,
        RowsTotal = rowsTotal,
        StartedAt = at,
        UpdatedAt = at,
        UserId = userId,
    };

    public void Count(string action, int contactsWritten)
    {
        switch (action)
        {
            case ImportAction.Created: Created++; break;
            case ImportAction.Updated: Updated++; break;
            case ImportAction.Unchanged: Unchanged++; break;
            case ImportAction.Conflict: Conflict++; break;
            case ImportAction.Rejected: Rejected++; break;
            default: throw new ArgumentOutOfRangeException(nameof(action));
        }

        ContactsWritten += contactsWritten;
    }

    /// <summary>The run's invariant: every row of the file has exactly one outcome.</summary>
    public bool Accounted => Created + Updated + Unchanged + Conflict + Rejected == RowsTotal;

    public void Committed(int line, DateTimeOffset at)
    {
        LastCommittedLine = Math.Max(LastCommittedLine, line);
        UpdatedAt = at;
    }

    public void Complete(DateTimeOffset at, string? summaryJson)
    {
        Status = ImportRunStatus.Completed;
        FinishedAt = at;
        UpdatedAt = at;
        FailedFromLine = FailedToLine = null;
        FailureCode = null;
        SummaryJson = summaryJson ?? SummaryJson;
    }

    public void Interrupt(ImportRunStatus status, string code, int? fromLine, int? toLine, DateTimeOffset at)
    {
        Status = status;
        FailureCode = code;
        FailedFromLine = fromLine;
        FailedToLine = toLine;
        FinishedAt = at;
        UpdatedAt = at;
    }

    /// <summary>A repeated call takes the run up again after the last committed chunk.</summary>
    public void Resume(Guid? userId, DateTimeOffset at)
    {
        Status = ImportRunStatus.Running;
        FinishedAt = null;
        UpdatedAt = at;
        UserId = userId ?? UserId;
    }

    public void SetSummary(string summaryJson) => SummaryJson = summaryJson;
}

/// <summary>The result of one source row. Names, e-mail addresses and values are never stored here.</summary>
public sealed class ImportRowOutcome : Entity
{
    private ImportRowOutcome() { }

    public Guid RunId { get; private set; }
    public int Line { get; private set; }

    /// <summary>Salted hash of the row's organization number (or normalised name), to relate rows of different files without storing either.</summary>
    public string? SourceKey { get; private set; }

    public string Action { get; private set; } = string.Empty;
    public string? ReasonCode { get; private set; }
    public Guid? OrganizationId { get; private set; }
    public Guid? ContactId { get; private set; }

    /// <summary>Created, Updated, Unchanged or Skipped (null when the row has no contact).</summary>
    public string? ContactAction { get; private set; }

    /// <summary>Field names the import filled, comma separated.</summary>
    public string? FieldsChanged { get; private set; }

    /// <summary>Field names where the file and the CRM differ and the CRM value stayed, comma separated.</summary>
    public string? ConflictFields { get; private set; }

    /// <summary>Warning codes of the row, comma separated.</summary>
    public string? Warnings { get; private set; }

    public static ImportRowOutcome Create(
        Guid runId, int line, string? sourceKey, string action, string? reasonCode, Guid? organizationId, Guid? contactId, string? contactAction,
        IEnumerable<string>? fieldsChanged, IEnumerable<string>? conflictFields, IEnumerable<string>? warnings) => new()
    {
        RunId = runId,
        Line = line,
        SourceKey = sourceKey,
        Action = action,
        ReasonCode = reasonCode,
        OrganizationId = organizationId,
        ContactId = contactId,
        ContactAction = contactAction,
        FieldsChanged = Join(fieldsChanged),
        ConflictFields = Join(conflictFields),
        Warnings = Join(warnings),
    };

    private static string? Join(IEnumerable<string>? values) =>
        values is null ? null : values.Distinct(StringComparer.Ordinal).ToList() is { Count: > 0 } list ? string.Join(',', list) : null;
}

/// <summary>
/// A record the run created or changed: the batch marker. The list of a run is the compensation plan — what to look at, and
/// possibly undo by hand, when a batch must not stand (DEV-20). Reading it changes nothing; the application deletes nothing.
/// </summary>
public sealed class ImportRunEntity : Entity
{
    public const string OrganizationType = "Organization";
    public const string ContactType = "Contact";
    public const string AffiliationType = "Affiliation";

    private ImportRunEntity() { }

    public Guid RunId { get; private set; }
    public string EntityType { get; private set; } = string.Empty;
    public Guid EntityId { get; private set; }
    public string Action { get; private set; } = string.Empty;

    /// <summary>Field names an update filled, comma separated.</summary>
    public string? Fields { get; private set; }

    public static ImportRunEntity Create(Guid runId, string entityType, Guid entityId, string action, IEnumerable<string>? fields) => new()
    {
        RunId = runId,
        EntityType = entityType,
        EntityId = entityId,
        Action = action,
        Fields = fields is null ? null : fields.ToList() is { Count: > 0 } list ? string.Join(',', list) : null,
    };
}
