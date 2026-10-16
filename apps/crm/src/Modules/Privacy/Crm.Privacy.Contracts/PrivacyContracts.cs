namespace Crm.Privacy.Contracts;

/// <summary>Who a privacy case is about (DEV-11): an external person the CRM keeps data on.</summary>
public enum DataSubjectKind
{
    /// <summary>A contact person of a customer (customers.Contacts).</summary>
    Contact,

    /// <summary>A lead that was never converted (sales.Leads): a prospect's contact details.</summary>
    Lead,
}

/// <summary>A record in a module, named the way the audit trail names it: module schema, entity type, id.</summary>
public sealed record RecordRef(string Module, string EntityType, Guid EntityId);

/// <summary>An identifier another system keeps for the person, e.g. <c>atera</c> / <c>contact</c> / <c>123</c>.</summary>
public sealed record ExternalReference(string System, string Type, string ExternalId)
{
    public override string ToString() => $"{System}:{Type}:{ExternalId}";
}

/// <summary>
/// The person as the module holding them describes them: the record itself, the e-mail addresses and phone numbers other
/// modules find copies of the person's data by, and the references external systems know the person by. Resolved when a case
/// is previewed or carried out; never stored in the case.
/// </summary>
public sealed record DataSubject(
    DataSubjectKind Kind,
    Guid Id,
    RecordRef Record,
    IReadOnlyList<string> Emails,
    IReadOnlyList<string> Phones,
    IReadOnlyList<ExternalReference> ExternalReferences,
    IReadOnlyList<RecordRef> RelatedRecords);

/// <summary>
/// Answers who a subject of one kind is (Customers for contacts, Sales for leads). External references are not the owning
/// module's to know: <see cref="IExternalReferenceSource"/> adds them.
/// </summary>
public interface IDataSubjectResolver
{
    DataSubjectKind Kind { get; }

    Task<DataSubject?> ResolveAsync(Guid id, CancellationToken cancellationToken);
}

/// <summary>
/// The ids external systems know the person by — the integrations' links and the mirrored person records with their
/// address — so an erasure suppresses them there too.
/// </summary>
public interface IExternalReferenceSource
{
    Task<IReadOnlyList<ExternalReference>> ReferencesAsync(DataSubject subject, CancellationToken cancellationToken);
}

/// <summary>What happens to a record when its subject's data is erased.</summary>
public enum ErasureAction
{
    /// <summary>The row stays (other records refer to it); its personal fields are replaced.</summary>
    Pseudonymize,

    /// <summary>The row is removed: it has no meaning without the person and nothing financial refers to it.</summary>
    Delete,

    /// <summary>Kept, with the reason and until when: a bookkeeping document, a legal hold.</summary>
    Retain,

    /// <summary>
    /// A protected store (the audit trail, a frozen quote document) that the application may not change: hidden from every
    /// view at once and physically cleared by the privacy operator's procedure (runbook 13).
    /// </summary>
    OperatorErasure,
}

/// <summary>Why a record survives an erasure.</summary>
public enum RetentionBasis
{
    /// <summary>Bookkeeping documentation (Bokføringsloven §13): kept until five years after the end of its financial year.</summary>
    Bookkeeping,

    /// <summary>A legal hold placed on the record, with its explanation and end date.</summary>
    LegalHold,
}

/// <summary>One record's fate in an erasure plan.</summary>
public sealed record PlannedErasure(
    RecordRef Record,
    ErasureAction Action,
    string DataClass,
    RetentionBasis? Basis = null,
    DateOnly? RetainUntil = null,
    string? Note = null);

/// <summary>What a module did to one record; written into the deletion manifest (ids only, no personal data).</summary>
public sealed record ErasedRecord(RecordRef Record, ErasureAction Action, string DataClass);

/// <summary>One record of the person's data as the module shows it in a subject export.</summary>
public sealed record PersonalDataItem(string Category, Guid? RecordId, IReadOnlyDictionary<string, string?> Fields);

/// <summary>A module's part of a subject export, with what it deliberately leaves out and why.</summary>
public sealed record PersonalDataSection(string Module, IReadOnlyList<PersonalDataItem> Items, IReadOnlyList<string> Excluded);

/// <summary>
/// A module's part in subject requests (DEV-11): what it holds about the person, what erasure would do to it, doing it, and
/// doing it again after a database restore. Every method is idempotent; a module touches only its own schema.
/// </summary>
public interface IPersonalDataContributor
{
    /// <summary>The module schema, as in <see cref="RecordRef.Module"/>.</summary>
    string Module { get; }

    Task<PersonalDataSection> ExportAsync(DataSubject subject, CancellationToken cancellationToken);

    Task<IReadOnlyList<PlannedErasure>> PlanAsync(DataSubject subject, CancellationToken cancellationToken);

    /// <summary>
    /// Carries out the module's part of an approved plan: <paramref name="plan"/> holds this module's records with their final
    /// action (a held record arrives as <see cref="ErasureAction.Retain"/> and is left alone). <paramref name="reference"/> — the
    /// case number — goes into the audit entry of each erased record (<c>IErasable</c>), instead of the values.
    /// </summary>
    Task<IReadOnlyList<ErasedRecord>> EraseAsync(DataSubject subject, IReadOnlyList<PlannedErasure> plan, string reference, CancellationToken cancellationToken);

    /// <summary>After a restore from before an erasure: applies the recorded actions again to the records that still exist.</summary>
    Task<int> ReapplyAsync(IReadOnlyList<ErasedRecord> records, string reference, CancellationToken cancellationToken);
}

/// <summary>
/// People whose data was erased must not come back with the next synchronization or import (DEV-11): asked before a
/// record is created or filled from outside. Holds no personal data — keyed hashes and external references.
/// </summary>
public interface ISuppressionList
{
    Task<bool> IsSuppressedAsync(string? email, ExternalReference? reference, CancellationToken cancellationToken);

    /// <summary>For a synchronization run: every live suppression at once, checked in memory record by record.</summary>
    Task<ISuppressionCheck> SnapshotAsync(CancellationToken cancellationToken);
}

public interface ISuppressionCheck
{
    bool IsSuppressed(string? email, ExternalReference? reference);
}

/// <summary>Which records of a module an executed erasure covered: views hide what they still hold in protected stores.</summary>
public interface IErasedRecords
{
    Task<IReadOnlySet<Guid>> ErasedAsync(string module, string entityType, IReadOnlyCollection<Guid> entityIds, CancellationToken cancellationToken);
}

/// <summary>
/// Whether a database restore left erasures to apply again (DEV-11): until they are, the API refuses users and
/// synchronizations do not run, so a restored copy never shows or exports erased people.
/// </summary>
public interface IPrivacyReplayGate
{
    Task<bool> IsReplayPendingAsync(CancellationToken cancellationToken);
}

/// <summary>
/// One data class's automatic retention (SEC-GDPR-05): how many records the approved period would remove, and removing a
/// bounded batch of them. The period comes from an approved policy, never from code.
/// </summary>
public interface IRetentionContributor
{
    /// <summary>Stable key of the data class, e.g. <c>sales.unconverted-leads</c>.</summary>
    string DataClass { get; }

    Task<int> CountAsync(DateTimeOffset olderThan, CancellationToken cancellationToken);

    Task<int> ApplyAsync(DateTimeOffset olderThan, int batchSize, CancellationToken cancellationToken);
}
