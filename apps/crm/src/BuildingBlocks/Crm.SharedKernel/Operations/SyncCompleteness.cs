namespace Crm.SharedKernel.Operations;

/// <summary>
/// How the latest finished run of a synchronization job ended. <paramref name="Complete"/> is true only for a run that finished
/// without failures; a partial run or a run held by a pause is not complete (DEV-19).
/// </summary>
public sealed record SyncCompleteness(DateTimeOffset StartedAt, bool Complete);

/// <summary>
/// Lets a core module ask whether the data an integration brings in can be trusted to be complete, without referencing the
/// integration: it is implemented by the integration layer and answers with ids-free facts only.
/// </summary>
public interface ISyncCompletenessSource
{
    /// <summary>The latest finished run of <paramref name="job"/>, or null when it has never run (nothing to judge).</summary>
    Task<SyncCompleteness?> LatestAsync(string system, string job, CancellationToken cancellationToken);
}
