namespace Crm.Backup.Contracts;

/// <summary>The backup sources the CRM reads (M42) and the job whose complete read the backup tab names.</summary>
public static class BackupSources
{
    public const string CloudAlly = "cloudally";

    /// <summary>The recurring read of CloudAlly's tasks, users and statuses; its last run is the read time the tab shows.</summary>
    public const string CloudAllyBackupsJob = "cloudally-backups";
}

/// <summary>
/// The Microsoft 365 services a backup covers (M42), as the tab groups them. Teams includes Microsoft 365 groups, which CloudAlly
/// backs up together ("Teams &amp; Groups"); a source the CRM does not know (Entra ID, Dynamics) is Other.
/// </summary>
public enum BackupService
{
    Mail,
    OneDrive,
    SharePoint,
    Teams,
    Other,
}

/// <summary>
/// A customer's backup account at the source (CloudAlly calls it a user), with the tasks a complete read found for it.
/// <paramref name="Status"/> and <paramref name="Region"/> are the source's own words (ACTIVE, EU).
/// </summary>
public sealed record ExternalBackupAccount(
    string ExternalId,
    string Name,
    string? Email,
    string? Status,
    string? Region,
    IReadOnlyList<ExternalBackupTask> Tasks);

/// <summary>
/// One backup task: one service of one account. <paramref name="Source"/> is the source's name of the service (O365MAIL),
/// <paramref name="Status"/> its state (ACTIVE, PAUSED), <paramref name="Running"/> whether a backup runs now.
/// </summary>
public sealed record ExternalBackupTask(
    string ExternalId,
    BackupService Service,
    string Source,
    string? Alias,
    string? Status,
    bool Running,
    DateTimeOffset? LastBackupAt,
    string? NextBackup,
    int? EntityCount,
    int? BilledEntities,
    long? SizeBytes,
    IReadOnlyList<ExternalBackupEntity> Entities);

/// <summary>
/// A mailbox, OneDrive, site or team inside a task. <paramref name="Name"/> is the source's name of it (an address or a site),
/// <paramref name="FullName"/> the person's or site's name, <paramref name="ExtId"/> its id in Microsoft 365. A last attempt later
/// than the last successful backup means the backup failed; <paramref name="Error"/> is the source's short reason.
/// </summary>
public sealed record ExternalBackupEntity(
    string ExternalId,
    string Name,
    string? FullName,
    string? ExtId,
    string? Status,
    bool Running,
    DateTimeOffset? LastBackupAt,
    DateTimeOffset? LastAttemptAt,
    string? Error,
    string? ErrorLink,
    string? Licensing,
    long? SizeBytes);

/// <summary>
/// A complete read of one source's backups for the organizations it covered (M42): each organization's accounts as listed, and
/// nothing more. What a covered organization had stored and the read no longer lists is forgotten; organizations outside the
/// read are not touched. Only a read that read every page is a snapshot.
/// </summary>
public sealed record BackupSnapshot(
    string System,
    IReadOnlyDictionary<Guid, IReadOnlyList<ExternalBackupAccount>> Organizations,
    bool IsComplete);

public sealed record BackupSnapshotResult(int Accounts, int Tasks, int Entities, int Removed);

/// <summary>
/// One line of what the source bills the partner for an account on a day (M42): cost data. <paramref name="Seats"/> and
/// <paramref name="Accounts"/> are the source's own counts; money is in <paramref name="Currency"/>.
/// </summary>
public sealed record ExternalBackupBillLine(
    string AccountExternalId,
    Guid? OrganizationId,
    string Type,
    string Source,
    string? Service,
    int? Accounts,
    int? Seats,
    decimal? Price,
    decimal? Total,
    string? Currency,
    string? PaymentType,
    DateTimeOffset? NextPaymentAt);

/// <summary>A stored account as an action's preview names it.</summary>
public sealed record BackupAccountRef(Guid Id, string System, string ExternalId, Guid OrganizationId, string Name, string? Email, string? Status, string? Region);

/// <summary>A stored task as an action's preview names it, with its account.</summary>
public sealed record BackupTaskRef(
    Guid Id, string ExternalId, BackupService Service, string Source, string? Alias, string? Status, bool Running, DateTimeOffset? LastBackupAt,
    int Entities, BackupAccountRef Account);

/// <summary>A stored entity as an action's preview names it, with its task; <paramref name="FirstSeenAt"/> is when the CRM first read it.</summary>
public sealed record BackupEntityRef(
    Guid Id, string ExternalId, string Name, string? FullName, string? ExtId, string? Status, DateTimeOffset? LastBackupAt,
    DateTimeOffset FirstSeenAt, BackupTaskRef Task);

/// <summary>
/// Public API of the backup module (M42): the integrations write what they read of the customers' backups, and read the saved copy
/// back for the previews of actions. Nothing here calls a provider.
/// </summary>
public interface IBackupApi
{
    /// <summary>Stores a complete read; an incomplete one changes nothing (and returns zeros).</summary>
    Task<BackupSnapshotResult> ApplySnapshotAsync(BackupSnapshot snapshot, CancellationToken cancellationToken);

    /// <summary>
    /// Stores what a live read of one task found (after an action): its state and its entities' states. A task the CRM has not stored
    /// is left alone, and entities the read does not name stay as they are until the next complete read.
    /// </summary>
    Task ApplyTaskAsync(string system, ExternalBackupTask task, CancellationToken cancellationToken);

    /// <summary>Stores the bill lines read on <paramref name="day"/>; reading the same day again replaces that day's lines of the accounts read.</summary>
    Task<int> ApplyBillsAsync(string system, DateOnly day, IReadOnlyCollection<ExternalBackupBillLine> lines, CancellationToken cancellationToken);

    Task<BackupAccountRef?> GetAccountAsync(string system, string externalId, CancellationToken cancellationToken);

    Task<BackupTaskRef?> GetTaskAsync(string system, string externalId, CancellationToken cancellationToken);

    Task<BackupEntityRef?> GetEntityAsync(string system, string taskExternalId, string entityExternalId, CancellationToken cancellationToken);
}
