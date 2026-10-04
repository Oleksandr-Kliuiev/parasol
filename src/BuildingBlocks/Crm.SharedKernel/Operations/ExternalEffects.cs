namespace Crm.SharedKernel.Operations;

/// <summary>Where an external effect stands: about to happen, happened, refused, or found unnecessary.</summary>
public enum EffectPhase
{
    /// <summary>Written before the request leaves: alone, it means the effect may have happened (no answer came back).</summary>
    Sending,
    Sent,
    Failed,

    /// <summary>The handler found nothing to do (already done, cancelled meanwhile): no effect.</summary>
    Skipped,
}

/// <summary>
/// An effect on a system outside the CRM — a sales order in PowerOffice, a ticket in Atera, an e-mail, a calendar event, a
/// channel post — named by the CRM record that caused it. It never carries personal data: the journal lies outside the
/// database, where an erasure (DEV-11) does not reach.
/// </summary>
public sealed record ExternalEffect(string System, string Kind, string EntityType, Guid EntityId, Guid? OperationId = null);

/// <summary>
/// One entry of the journal. <see cref="Reference"/> is the external system's identifier of what was created (an order number,
/// an event id) when it is known.
/// </summary>
public sealed record ExternalEffectEntry(
    string Id,
    string System,
    string Kind,
    string EntityType,
    Guid EntityId,
    Guid? OperationId,
    EffectPhase Phase,
    DateTimeOffset At,
    string? Reference);

/// <summary>
/// The write-ahead journal of external effects (DEV-13, ADR-021), kept in the document store beside the database rather than in
/// it. A database restored to an earlier point forgets what was sent after that point; the journal does not, so the restore
/// reconciliation can hold back what would otherwise be sent a second time.
/// </summary>
public interface IExternalEffectJournal
{
    /// <summary>
    /// Written before the effect. Throws when the entry cannot be stored — and then the caller must not cause the effect, or a
    /// restore could not know about it. It is also the switch's last word: the maintenance state is read now, and while the CRM
    /// is read-only (or the state cannot be read) nothing is journaled and a maintenance exception is thrown, so no replica
    /// whose cached state is a moment old can begin a send.
    /// </summary>
    Task<ExternalEffectEntry> BeginAsync(ExternalEffect effect, CancellationToken cancellationToken);

    /// <summary>
    /// The outcome. Best effort: when the store refuses it is logged, and the <see cref="EffectPhase.Sending"/> entry already
    /// tells a restore that the effect may have happened.
    /// </summary>
    Task CompleteAsync(ExternalEffectEntry begun, EffectPhase outcome, string? reference, CancellationToken cancellationToken);

    /// <summary>Every entry about one record, oldest first.</summary>
    Task<IReadOnlyList<ExternalEffectEntry>> ForEntityAsync(string entityType, Guid entityId, CancellationToken cancellationToken);

    /// <summary>Every entry written at or after <paramref name="since"/>, oldest first.</summary>
    Task<IReadOnlyList<ExternalEffectEntry>> SinceAsync(DateTimeOffset since, CancellationToken cancellationToken);
}

/// <summary>What the entries about one effect add up to.</summary>
public static class ExternalEffects
{
    /// <summary>
    /// Whether the effect may exist: it was sent, or it was being sent and no outcome followed. A failed or skipped attempt
    /// created nothing.
    /// </summary>
    public static bool MayExist(IEnumerable<ExternalEffectEntry> entries)
    {
        var settled = new Dictionary<string, EffectPhase>(StringComparer.Ordinal);
        var sending = new List<string>();
        foreach (var entry in entries)
        {
            var attempt = AttemptOf(entry);
            if (entry.Phase == EffectPhase.Sending)
            {
                sending.Add(attempt);
            }
            else
            {
                settled[attempt] = entry.Phase;
            }
        }

        return settled.Values.Any(p => p == EffectPhase.Sent) || sending.Any(a => !settled.ContainsKey(a));
    }

    /// <summary>The external reference of the latest sent attempt, when one was reported.</summary>
    public static string? LatestReference(IEnumerable<ExternalEffectEntry> entries) =>
        entries.Where(e => e.Phase == EffectPhase.Sent && e.Reference is not null).OrderBy(e => e.At).LastOrDefault()?.Reference;

    /// <summary>The attempt an entry belongs to: an outcome carries the id of the Sending entry it completes.</summary>
    public static string AttemptOf(ExternalEffectEntry entry)
    {
        var separator = entry.Id.IndexOf('~', StringComparison.Ordinal);
        return separator < 0 ? entry.Id : entry.Id[..separator];
    }
}
