using Crm.Service.Contracts;
using Crm.Service.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crm.Service.Features;

/// <summary>
/// A customer's alerts and tickets of a period, counted in SQL (M43). An alert resolved and opened again counts by its last resolution;
/// a hidden alert counts like any other: the summary says what happened, not what was shown.
/// </summary>
internal sealed class ServiceMonthFacts(ServiceDbContext db) : IServiceMonthFacts
{
    public async Task<IReadOnlyList<Guid>> GetServicedOrganizationsAsync(DateTimeOffset from, DateTimeOffset to, CancellationToken cancellationToken)
    {
        var devices = db.Devices.AsNoTracking().Where(d => d.RemovedAt == null).Select(d => d.OrganizationId);
        var alerts = db.Alerts.AsNoTracking().Where(a => a.CreatedAtSource < to && (a.ResolvedAt == null || a.ResolvedAt >= from)).Select(a => a.OrganizationId);
        var tickets = db.Tickets.AsNoTracking().Where(t => t.CreatedAtSource < to && (t.ResolvedAt == null || t.ResolvedAt >= from)).Select(t => t.OrganizationId);
        return await devices.Union(alerts).Union(tickets).Distinct().ToListAsync(cancellationToken);
    }

    public async Task<ServiceMonth> GetMonthAsync(Guid organizationId, DateTimeOffset from, DateTimeOffset to, CancellationToken cancellationToken)
    {
        var alerts = await db.Alerts.AsNoTracking()
            .Where(a => a.OrganizationId == organizationId && a.CreatedAtSource < to && (a.ResolvedAt == null || a.ResolvedAt >= from))
            .GroupBy(a => new { a.System, a.Severity })
            .Select(g => new
            {
                g.Key.System,
                g.Key.Severity,
                Opened = g.Count(a => a.CreatedAtSource >= from),
                Resolved = g.Count(a => a.ResolvedAt >= from && a.ResolvedAt < to),
                OpenAtEnd = g.Count(a => a.ResolvedAt == null || a.ResolvedAt >= to),
            })
            .ToListAsync(cancellationToken);
        var tickets = await db.Tickets.AsNoTracking()
            .Where(t => t.OrganizationId == organizationId && t.CreatedAtSource < to && (t.ResolvedAt == null || t.ResolvedAt >= from))
            .GroupBy(_ => 1)
            .Select(g => new
            {
                Created = g.Count(t => t.CreatedAtSource >= from),
                Resolved = g.Count(t => t.ResolvedAt >= from && t.ResolvedAt < to),
                OpenAtEnd = g.Count(t => t.ResolvedAt == null || t.ResolvedAt >= to),
            })
            .SingleOrDefaultAsync(cancellationToken);
        return new ServiceMonth(
            alerts.OrderBy(a => a.System, StringComparer.Ordinal).ThenBy(a => a.Severity)
                .Select(a => new AlertMonthCount(a.System, a.Severity, a.Opened, a.Resolved, a.OpenAtEnd)).ToList(),
            tickets?.Created ?? 0, tickets?.Resolved ?? 0, tickets?.OpenAtEnd ?? 0);
    }
}
