namespace Crm.SharedKernel.Operations;

/// <summary>
/// How the latest finished run of a synchronization job ended. <paramref name="Complete"/> is true only for a run that finished
/// without failures; a partial run or a run held by a pause is not complete (DEV-19). <paramref name="Late"/> is true when that
/// run ended longer ago than the job's freshness limit, so the next read is overdue (the connections page calls the job late).
/// </summary>
public sealed record SyncCompleteness(DateTimeOffset StartedAt, bool Complete, bool Late = false);

/// <summary>
/// Lets a core module ask whether the data an integration brings in can be trusted to be complete, without referencing the
/// integration: it is implemented by the integration layer and answers with ids-free facts only.
/// </summary>
public interface ISyncCompletenessSource
{
    /// <summary>The latest finished run of <paramref name="job"/>, or null when it has never run (nothing to judge).</summary>
    Task<SyncCompleteness?> LatestAsync(string system, string job, CancellationToken cancellationToken);

    /// <summary>
    /// Whether <paramref name="system"/> is switched on in this installation (M41). A source that is switched off and was never read
    /// has said nothing about the data, so a status line leaves it out instead of calling it "not read yet" for good.
    /// </summary>
    bool IsConnected(string system);
}
