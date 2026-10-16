using Crm.Integrations.Core.Persistence;
using Crm.SharedKernel.Operations;
using Microsoft.EntityFrameworkCore;

namespace Crm.Integrations.Core;

/// <summary>Answers core modules whether the latest run of a job read everything it should (DEV-19); a run still in progress is ignored.</summary>
public sealed class SyncCompletenessReader(IntegrationDbContext db) : ISyncCompletenessSource
{
    public async Task<SyncCompleteness?> LatestAsync(string system, string job, CancellationToken cancellationToken)
    {
        var latest = await db.SyncRuns.AsNoTracking()
            .Where(r => r.System == system && r.Job == job && r.Status != SyncRunStatus.Running)
            .OrderByDescending(r => r.StartedAt)
            .Select(r => new { r.StartedAt, r.Status, r.Failed })
            .FirstOrDefaultAsync(cancellationToken);
        return latest is null ? null : new SyncCompleteness(latest.StartedAt, latest.Status == SyncRunStatus.Succeeded && latest.Failed == 0);
    }
}
