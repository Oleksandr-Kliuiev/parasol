namespace Crm.Backup.Contracts;

/// <summary>One service of a customer's backups with its users, sites or teams counted by state (M42's one rule of state).</summary>
public sealed record BackupServiceState(
    BackupService Service, int Total, int Ok, int Failed, int Late, int Paused, int NotInBackup, int Waiting, DateTimeOffset? NewestBackupAt);

/// <summary>
/// A customer's backups as the saved copy has them now (M43, the CRM's monthly summary): when the source was last read and whether
/// that read was complete, and each service's counts. No names or addresses.
/// </summary>
public sealed record BackupState(DateTimeOffset? ReadAt, bool ReadComplete, IReadOnlyList<BackupServiceState> Services);

/// <summary>The Backup module's figures for reports (M43).</summary>
public interface IBackupFacts
{
    Task<BackupState> GetStateAsync(Guid organizationId, CancellationToken cancellationToken);
}
