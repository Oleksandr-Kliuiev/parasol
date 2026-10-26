using Crm.Integrations.Core.Persistence;
using Crm.SharedKernel.Operations;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;

namespace Crm.Integrations.Core;

/// <summary>
/// Answers core modules whether the latest run of a job read everything it should (DEV-19), and whether it ended longer ago
/// than the job's freshness limit, the one the connections page uses (DEV-17); a run still in progress is ignored.
/// </summary>
public sealed class SyncCompletenessReader(IntegrationDbContext db, IConfiguration configuration, TimeProvider time) : ISyncCompletenessSource
{
    public async Task<SyncCompleteness?> LatestAsync(string system, string job, CancellationToken cancellationToken)
    {
        var latest = await db.SyncRuns.AsNoTracking()
            .Where(r => r.System == system && r.Job == job && r.Status != SyncRunStatus.Running)
            .OrderByDescending(r => r.StartedAt)
            .Select(r => new { r.StartedAt, r.FinishedAt, r.Status, r.Failed })
            .FirstOrDefaultAsync(cancellationToken);
        if (latest is null)
        {
            return null;
        }

        var age = time.GetUtcNow() - (latest.FinishedAt ?? latest.StartedAt);
        return new SyncCompleteness(latest.StartedAt, latest.Status == SyncRunStatus.Succeeded && latest.Failed == 0,
            age > TimeSpan.FromMinutes(FreshnessLimits.Minutes(configuration, job)));
    }
}
