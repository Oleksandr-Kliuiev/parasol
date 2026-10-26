using Crm.Security.Contracts;
using Crm.Security.Domain;
using Crm.Security.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crm.Security.Features;

/// <summary>
/// The mirror of a security source (M41), written by its integration: the scheduled reads and the read-back after an action. Each
/// write is one transaction under the source's lock of that kind of record, so a read started by hand, the scheduled one and an
/// action's read-back wait for each other instead of inserting the same incident twice.
/// </summary>
internal sealed class SecurityMirror(SecurityDbContext db, TimeProvider time) : ISecurityApi
{
    public async Task<SecurityApplyResult> ApplyIncidentsAsync(IReadOnlyCollection<IncidentReading> readings, CancellationToken cancellationToken)
    {
        var total = SecurityApplyResult.None;
        foreach (var group in readings.GroupBy(r => r.Incident.System, StringComparer.Ordinal))
        {
            var bySource = group.DistinctBy(r => r.Incident.ExternalId).ToList();
            total += await LockedAsync("security-incidents:" + group.Key, async ct =>
            {
                var now = time.GetUtcNow();
                var ids = bySource.Select(r => r.Incident.ExternalId).ToList();
                var stored = await db.Incidents.Include(i => i.Remediations).Include(i => i.Comments)
                    .Where(i => i.System == group.Key && ids.Contains(i.ExternalId))
                    .AsSplitQuery()
                    .ToDictionaryAsync(i => i.ExternalId, ct);
                int added = 0, updated = 0;
                foreach (var reading in bySource)
                {
                    var isNew = !stored.TryGetValue(reading.Incident.ExternalId, out var incident);
                    // A read that began before the stored one (a scheduled read under way while an action read the incident back) knows
                    // less than the mirror does: it is left out, and the next read brings what is new.
                    if (incident is not null && reading.ReadAt is { } readAt && incident.ReadAt > readAt)
                    {
                        continue;
                    }

                    if (incident is null)
                    {
                        incident = Incident.From(reading.Incident, now);
                        db.Incidents.Add(incident);
                    }

                    var changed = !isNew && incident.Apply(reading.Incident, now);
                    if (reading.Remediations is { } remediations)
                    {
                        changed |= incident.ApplyRemediations(remediations, now);
                    }

                    if (reading.Comments is { } comments)
                    {
                        changed |= incident.ApplyComments(comments, now);
                    }

                    added += isNew ? 1 : 0;
                    updated += !isNew && changed ? 1 : 0;
                }

                return new SecurityApplyResult(added, updated);
            }, cancellationToken);
        }

        return total;
    }

    public async Task<int> CloseMissingIncidentsAsync(string system, IReadOnlyCollection<long> externalIds, CancellationToken cancellationToken)
    {
        if (externalIds.Count == 0)
        {
            return 0;
        }

        var ids = externalIds.Distinct().ToList();
        return await LockedAsync("security-incidents:" + system, async ct =>
        {
            var now = time.GetUtcNow();
            var incidents = await db.Incidents.Where(i => i.System == system && ids.Contains(i.ExternalId)).ToListAsync(ct);
            return incidents.Count(i => i.Gone(now));
        }, cancellationToken);
    }

    public async Task<IReadOnlyList<IncidentView>> GetOpenIncidentsAsync(string system, CancellationToken cancellationToken)
    {
        var open = Incident.OpenStatuses.ToList();
        var incidents = await db.Incidents.AsNoTracking().Include(i => i.Remediations)
            .Where(i => i.System == system && open.Contains(i.Status))
            .OrderBy(i => i.ExternalId)
            .AsSplitQuery()
            .ToListAsync(cancellationToken);
        return incidents.Select(i => i.ToView()).ToList();
    }

    public async Task<IncidentView?> GetIncidentAsync(string system, long externalId, CancellationToken cancellationToken) =>
        (await db.Incidents.AsNoTracking().Include(i => i.Remediations)
            .SingleOrDefaultAsync(i => i.System == system && i.ExternalId == externalId, cancellationToken))?.ToView();

    public async Task<SecurityApplyResult> ApplyNoticesAsync(IReadOnlyCollection<ExternalNotice> notices, CancellationToken cancellationToken)
    {
        var total = SecurityApplyResult.None;
        foreach (var group in notices.GroupBy(n => (n.System, n.Kind)))
        {
            var bySource = group.DistinctBy(n => n.ExternalId).ToList();
            total += await LockedAsync($"security-notices:{group.Key.System}:{group.Key.Kind}", async ct =>
            {
                var now = time.GetUtcNow();
                var ids = bySource.Select(n => n.ExternalId).ToList();
                var stored = await db.Notices.Where(n => n.System == group.Key.System && n.Kind == group.Key.Kind && ids.Contains(n.ExternalId))
                    .ToDictionaryAsync(n => n.ExternalId, ct);
                int added = 0, updated = 0;
                foreach (var source in bySource)
                {
                    if (stored.TryGetValue(source.ExternalId, out var notice) && source.ReadAt is { } readAt && notice.ReadAt > readAt)
                    {
                        // Read before the stored reading (see the incidents above): left out.
                        continue;
                    }

                    if (notice is not null)
                    {
                        updated += notice.Apply(source, now) ? 1 : 0;
                    }
                    else
                    {
                        db.Notices.Add(Notice.From(source, now));
                        added++;
                    }
                }

                return new SecurityApplyResult(added, updated);
            }, cancellationToken);
        }

        return total;
    }

    public async Task<int> CloseMissingNoticesAsync(string system, NoticeKind kind, IReadOnlyCollection<long> externalIds, CancellationToken cancellationToken)
    {
        if (externalIds.Count == 0)
        {
            return 0;
        }

        var ids = externalIds.Distinct().ToList();
        return await LockedAsync($"security-notices:{system}:{kind}", async ct =>
        {
            var now = time.GetUtcNow();
            var notices = await db.Notices.Where(n => n.System == system && n.Kind == kind && ids.Contains(n.ExternalId)).ToListAsync(ct);
            return notices.Count(n => n.Gone(now));
        }, cancellationToken);
    }

    public async Task<IReadOnlyList<NoticeView>> GetOpenNoticesAsync(string system, NoticeKind kind, CancellationToken cancellationToken)
    {
        var open = Notice.OpenStatuses.ToList();
        var notices = await db.Notices.AsNoTracking().Where(n => n.System == system && n.Kind == kind && open.Contains(n.Status))
            .OrderBy(n => n.ExternalId).ToListAsync(cancellationToken);
        return notices.Select(n => n.ToView()).ToList();
    }

    public async Task<NoticeView?> GetNoticeAsync(string system, NoticeKind kind, long externalId, CancellationToken cancellationToken) =>
        (await db.Notices.AsNoTracking().SingleOrDefaultAsync(n => n.System == system && n.Kind == kind && n.ExternalId == externalId, cancellationToken))?.ToView();

    public async Task<SecurityApplyResult> ApplyReportsAsync(IReadOnlyCollection<ExternalReport> reports, CancellationToken cancellationToken)
    {
        var total = SecurityApplyResult.None;
        foreach (var group in reports.GroupBy(r => r.System, StringComparer.Ordinal))
        {
            var bySource = group.DistinctBy(r => r.ExternalId).ToList();
            total += await LockedAsync("security-reports:" + group.Key, async ct =>
            {
                var now = time.GetUtcNow();
                var ids = bySource.Select(r => r.ExternalId).ToList();
                var stored = await db.SummaryReports.Where(r => r.System == group.Key && ids.Contains(r.ExternalId)).ToDictionaryAsync(r => r.ExternalId, ct);
                int added = 0, updated = 0;
                foreach (var source in bySource)
                {
                    if (stored.TryGetValue(source.ExternalId, out var report))
                    {
                        updated += report.Apply(source, now) ? 1 : 0;
                    }
                    else
                    {
                        db.SummaryReports.Add(SummaryReport.From(source, now));
                        added++;
                    }
                }

                return new SecurityApplyResult(added, updated);
            }, cancellationToken);
        }

        return total;
    }

    public async Task<SecurityApplyResult> ApplyUsageAsync(IReadOnlyCollection<ExternalUsage> usages, CancellationToken cancellationToken)
    {
        var total = SecurityApplyResult.None;
        foreach (var group in usages.GroupBy(u => u.System, StringComparer.Ordinal))
        {
            var bySource = group.DistinctBy(u => u.ExternalOrganizationId).ToList();
            total += await LockedAsync("security-usage:" + group.Key, async ct =>
            {
                var now = time.GetUtcNow();
                var ids = bySource.Select(u => u.ExternalOrganizationId).ToList();
                var stored = await db.ProductUsages.Where(u => u.System == group.Key && ids.Contains(u.ExternalOrganizationId))
                    .ToDictionaryAsync(u => u.ExternalOrganizationId, ct);
                int added = 0, updated = 0;
                foreach (var source in bySource)
                {
                    if (stored.TryGetValue(source.ExternalOrganizationId, out var usage))
                    {
                        updated += usage.Apply(source, now) ? 1 : 0;
                    }
                    else
                    {
                        db.ProductUsages.Add(ProductUsage.From(source, now));
                        added++;
                    }
                }

                return new SecurityApplyResult(added, updated);
            }, cancellationToken);
        }

        return total;
    }

    /// <summary>
    /// One unit of work under an application lock: the reads, the lock and the writes land together, and SQL Server's retry strategy
    /// repeats it as a whole, starting from the database again each time.
    /// </summary>
    private async Task<T> LockedAsync<T>(string resource, Func<CancellationToken, Task<T>> work, CancellationToken cancellationToken) =>
        await db.Database.CreateExecutionStrategy().ExecuteAsync(async ct =>
        {
            db.ChangeTracker.Clear();
            await using var transaction = await db.Database.BeginTransactionAsync(ct);
            await db.Database.ExecuteSqlInterpolatedAsync($"""
                DECLARE @r int; EXEC @r = sys.sp_getapplock @Resource={resource}, @LockMode=N'Exclusive', @LockOwner=N'Transaction', @LockTimeout=30000;
                IF @r < 0 THROW 51000, 'Another read of this security source is being stored.', 1;
                """, ct);
            var result = await work(ct);
            await db.SaveChangesAsync(ct);
            await transaction.CommitAsync(ct);
            return result;
        }, cancellationToken);
}
