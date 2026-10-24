using Crm.Backup.Contracts;

namespace Crm.Backup.Features;

/// <summary>A customer's backups for reports (M43): the Sikkerhetskopi tab's own counts, so the summary and the tab never disagree.</summary>
internal sealed class BackupFacts(BackupQueries queries) : IBackupFacts
{
    public async Task<BackupState> GetStateAsync(Guid organizationId, CancellationToken cancellationToken)
    {
        var overview = await queries.OverviewAsync(organizationId, cancellationToken);
        return new BackupState(overview.Read.StartedAt, overview.Read.Complete,
            overview.Services.Select(s => new BackupServiceState(s.Service, s.Total, s.Ok, s.Failed, s.Late, s.Paused, s.NotInBackup, s.Waiting, s.NewestBackupAt))
                .ToList());
    }
}
