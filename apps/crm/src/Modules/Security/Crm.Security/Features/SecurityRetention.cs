using Crm.Privacy.Contracts;
using Crm.Security.Domain;
using Crm.Security.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crm.Security.Features;

/// <summary>
/// Retention of closed security records (M41, class <c>security.closed-incidents</c>): an incident the source closed, with its plan and
/// comments, and an escalation or platform action it resolved, once older than the approved period. Their texts may name the
/// customer's staff (the SOC's summary, accounts in a plan, identities of an access escalation). Open ones are never removed. Until a
/// period is approved (EXT-07) the nightly job only counts.
/// </summary>
internal sealed class SecurityRetention(SecurityDbContext db) : IRetentionContributor
{
    public const string Class = "security.closed-incidents";

    public string DataClass => Class;

    public async Task<int> CountAsync(DateTimeOffset olderThan, CancellationToken cancellationToken) =>
        await DueIncidents(olderThan).CountAsync(cancellationToken) + await DueNotices(olderThan).CountAsync(cancellationToken);

    public async Task<int> ApplyAsync(DateTimeOffset olderThan, int batchSize, CancellationToken cancellationToken)
    {
        var incidents = await DueIncidents(olderThan).OrderBy(i => i.Id).Select(i => i.Id).Take(batchSize).ToListAsync(cancellationToken);
        // The plan and the comments go with their incident (cascade).
        var removed = incidents.Count == 0 ? 0 : await DueIncidents(olderThan).Where(i => incidents.Contains(i.Id)).ExecuteDeleteAsync(cancellationToken);
        var left = batchSize - removed;
        if (left <= 0)
        {
            return removed;
        }

        var notices = await DueNotices(olderThan).OrderBy(n => n.Id).Select(n => n.Id).Take(left).ToListAsync(cancellationToken);
        return removed + (notices.Count == 0 ? 0 : await DueNotices(olderThan).Where(n => notices.Contains(n.Id)).ExecuteDeleteAsync(cancellationToken));
    }

    private IQueryable<Incident> DueIncidents(DateTimeOffset olderThan)
    {
        var open = Incident.OpenStatuses.ToList();
        return db.Incidents.Where(i => !open.Contains(i.Status) && (i.ClosedAt ?? i.StatusUpdatedAt ?? i.ReadAt) < olderThan);
    }

    private IQueryable<Notice> DueNotices(DateTimeOffset olderThan)
    {
        var open = Notice.OpenStatuses.ToList();
        return db.Notices.Where(n => !open.Contains(n.Status) && (n.ResolvedAtSource ?? n.ReadAt) < olderThan);
    }
}
