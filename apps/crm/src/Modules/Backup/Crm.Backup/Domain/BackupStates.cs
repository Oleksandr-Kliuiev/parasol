namespace Crm.Backup.Domain;

/// <summary>
/// Where one backed-up thing stands (M42), worked out the same way for the tab, its filters and the coverage rules. The order is the
/// order of attention: a failed backup first, a user nobody backs up last among the problems.
/// </summary>
public enum BackupEntityState
{
    Failed,
    Late,
    Paused,
    NotInBackup,

    /// <summary>Added to the backup and not backed up yet, within the limit.</summary>
    Waiting,

    Ok,

    /// <summary>Not this task's to watch: backed up in another task, archived or skipped by the source.</summary>
    Aside,
}

/// <summary>The rules that turn a stored entity and its task into a <see cref="BackupEntityState"/>, kept pure so they are tested alone.</summary>
public static class BackupStates
{
    /// <summary>The coverage rule's default: a backup older than this is late (M38: «старше 26 ч»).</summary>
    public const int DefaultLateHours = 26;

    /// <summary>
    /// A last attempt counts as failed only when it is later than the last success by more than this: the two times of one good run
    /// are written apart by a few seconds.
    /// </summary>
    public static readonly TimeSpan AttemptTolerance = TimeSpan.FromMinutes(1);

    /// <summary>
    /// The state of <paramref name="e"/> in <paramref name="taskStatus"/>'s task at <paramref name="now"/>, late after
    /// <paramref name="lateAfter"/>. The source's error is a failure whatever the times say; a last attempt later than the last success
    /// is one unless a backup is running now (its attempt time moves first). A user who was never backed up is late once the CRM has
    /// known them for longer than the limit.
    /// </summary>
    public static BackupEntityState Of(string? taskStatus, BackupEntityFacts e, DateTimeOffset now, TimeSpan lateAfter)
    {
        if (BackupStatuses.IsAside(e.Status))
        {
            return BackupEntityState.Aside;
        }

        if (BackupStatuses.IsNotActive(e.Status))
        {
            return BackupEntityState.NotInBackup;
        }

        if (BackupStatuses.IsPaused(taskStatus) || BackupStatuses.IsPaused(e.Status))
        {
            return BackupEntityState.Paused;
        }

        if (e.Error is not null || (!e.Running && e.LastAttemptAt is { } attempt && (e.LastBackupAt is not { } success || attempt > success + AttemptTolerance)))
        {
            return BackupEntityState.Failed;
        }

        var lateBefore = now - lateAfter;
        if (e.LastBackupAt is not { } last)
        {
            return e.FirstSeenAt < lateBefore ? BackupEntityState.Late : BackupEntityState.Waiting;
        }

        return last < lateBefore ? BackupEntityState.Late : BackupEntityState.Ok;
    }

    /// <summary>The states that need someone: failed, late, paused, not backed up.</summary>
    public static bool IsProblem(BackupEntityState state) => state <= BackupEntityState.NotInBackup;
}

/// <summary>What the state of an entity depends on, as stored.</summary>
public sealed record BackupEntityFacts(
    string? Status, bool Running, DateTimeOffset? LastBackupAt, DateTimeOffset? LastAttemptAt, string? Error, DateTimeOffset FirstSeenAt)
{
    public static BackupEntityFacts Of(BackupEntity e) => new(e.Status, e.Running, e.LastBackupAt, e.LastAttemptAt, e.Error, e.FirstSeenAt);
}
