namespace Crm.SharedKernel.Operations;

/// <summary>
/// One finding of a restore check or reconciliation (DEV-13). <see cref="Subject"/> names a record by id or number — never by
/// personal data, since reports are kept in the document store; <see cref="NeedsPerson"/> marks what an operator or Finance
/// has to decide before crm-worker sends again.
/// </summary>
public sealed record RestoreLine(string Area, string Subject, string Finding, string? Action, bool NeedsPerson);

/// <summary>
/// A module's part in a restore (DEV-13, ADR-021). Checks only read; reconciliation compares the effects the journal shows after
/// the restore point with what the restored copy knows and, when applied, holds back what would repeat one. Modules implement it
/// over their own tables and never over another's.
/// </summary>
public interface IRestoreParticipant
{
    string Area { get; }

    /// <summary>
    /// Sends of this area under way right now (leased operations, posts): the operator waits for zero after switching to
    /// read-only, before the database is restored, so no answer lands in a database that is about to be replaced.
    /// </summary>
    Task<int> InFlightAsync(CancellationToken cancellationToken);

    Task<IReadOnlyList<RestoreLine>> CheckAsync(DateTimeOffset restorePoint, CancellationToken cancellationToken);

    Task<IReadOnlyList<RestoreLine>> ReconcileAsync(
        DateTimeOffset restorePoint, IReadOnlyList<ExternalEffectEntry> effects, bool apply, CancellationToken cancellationToken);
}
