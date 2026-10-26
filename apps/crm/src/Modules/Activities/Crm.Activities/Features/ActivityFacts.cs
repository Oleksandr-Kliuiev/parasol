using Crm.Activities.Contracts;
using Crm.Activities.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crm.Activities.Features;

/// <summary>
/// The activity side of the customer facts (UX 2026, В6). The predicates are the timeline's own, so the customer list and the
/// customer card cannot disagree: "open" is the <c>open=true</c> filter of <see cref="ActivityService.ListAsync"/> and "overdue" is
/// <see cref="Domain.Activity.IsOverdue"/> (open, with a due time before now — a task or a meeting; only those have one). The
/// timeline applies no record scope beyond <c>activities.read</c>, and neither does this; deleted activities are left out by the
/// context's soft-delete filter, as there.
/// </summary>
internal sealed class ActivityFacts(ActivitiesDbContext db) : IActivityFacts
{
    public async Task<IReadOnlyList<OrganizationWorkFacts>> GetWorkAsync(
        IReadOnlyCollection<Guid> organizationIds, DateTimeOffset now, CancellationToken cancellationToken)
    {
        if (organizationIds.Count == 0)
        {
            return [];
        }

        return await db.Activities.AsNoTracking()
            .Where(a => organizationIds.Contains(a.OrganizationId) && a.Status == ActivityStatus.Open)
            .GroupBy(a => a.OrganizationId)
            .Select(g => new OrganizationWorkFacts(g.Key, g.Count(), g.Count(a => a.DueAt != null && a.DueAt < now)))
            .ToListAsync(cancellationToken);
    }

    public async Task<IReadOnlyList<OrganizationOverdueWork>> GetOverdueWorkAsync(DateTimeOffset now, CancellationToken cancellationToken) =>
        await db.Activities.AsNoTracking()
            .Where(a => a.Status == ActivityStatus.Open && a.DueAt != null && a.DueAt < now)
            .GroupBy(a => a.OrganizationId)
            .Select(g => new OrganizationOverdueWork(g.Key, g.Count()))
            .ToListAsync(cancellationToken);
}
