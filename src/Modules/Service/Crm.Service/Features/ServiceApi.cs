using Crm.Customers.Contracts;
using Crm.Service.Contracts;
using Crm.Service.Domain;
using Crm.Service.Persistence;
using Crm.SharedKernel.Domain;
using Microsoft.EntityFrameworkCore;

namespace Crm.Service.Features;

internal sealed class ServiceApi(ServiceDbContext db, TimeProvider time) : IServiceApi
{
    public async Task<int> UpsertTicketsAsync(IReadOnlyCollection<ExternalTicket> tickets, CancellationToken cancellationToken)
    {
        var now = time.GetUtcNow();
        var changed = 0;
        foreach (var system in tickets.GroupBy(t => t.System))
        {
            var ids = system.Select(t => t.ExternalId).Distinct().ToList();
            var existing = await db.Tickets.Where(t => t.System == system.Key && ids.Contains(t.ExternalId)).ToDictionaryAsync(t => t.ExternalId, cancellationToken);
            foreach (var source in system.DistinctBy(t => t.ExternalId))
            {
                if (existing.TryGetValue(source.ExternalId, out var ticket))
                {
                    changed += ticket.Apply(source, now) ? 1 : 0;
                }
                else
                {
                    db.Tickets.Add(Ticket.From(source, now));
                    changed++;
                }
            }
        }

        await db.SaveChangesAsync(cancellationToken);
        return changed;
    }

    public async Task ReplaceDevicesAsync(Guid organizationId, string system, IReadOnlyCollection<ExternalDevice> devices, CancellationToken cancellationToken)
    {
        var now = time.GetUtcNow();
        var ids = devices.Select(d => d.ExternalId).ToList();
        var known = await db.Devices.Where(d => d.System == system && (d.OrganizationId == organizationId || ids.Contains(d.ExternalId))).ToListAsync(cancellationToken);
        var byId = known.ToDictionary(d => d.ExternalId, StringComparer.Ordinal);
        foreach (var source in devices.DistinctBy(d => d.ExternalId))
        {
            if (byId.TryGetValue(source.ExternalId, out var device))
            {
                device.Apply(organizationId, source);
            }
            else
            {
                db.Devices.Add(Device.From(system, organizationId, source, now));
            }
        }

        foreach (var gone in known.Where(d => d.OrganizationId == organizationId && !ids.Contains(d.ExternalId)))
        {
            gone.MarkRemoved(now);
        }

        await db.SaveChangesAsync(cancellationToken);
    }

    public async Task ReplaceOpenAlertsAsync(string system, IReadOnlyDictionary<Guid, IReadOnlyCollection<ExternalAlert>> alertsByOrganization, CancellationToken cancellationToken)
    {
        // Delete and insert must land together, and the SQL Server retry strategy needs the transaction inside it.
        await db.Database.CreateExecutionStrategy().ExecuteAsync(async ct =>
        {
            await using var transaction = await db.Database.BeginTransactionAsync(ct);
            await db.Alerts.Where(a => a.System == system).ExecuteDeleteAsync(ct);
            foreach (var (organizationId, alerts) in alertsByOrganization)
            {
                db.Alerts.AddRange(alerts.DistinctBy(a => a.ExternalId).Select(a => new Alert(system, organizationId, a)));
            }

            await db.SaveChangesAsync(ct);
            await transaction.CommitAsync(ct);
        }, cancellationToken);
    }

    public async Task<int> TakeDeviceSnapshotAsync(DateOnly date, CancellationToken cancellationToken)
    {
        var counts = await db.Devices.AsNoTracking()
            .Where(d => d.RemovedAt == null)
            .GroupBy(d => new { d.OrganizationId, d.Type })
            .Select(g => new { g.Key.OrganizationId, g.Key.Type, Count = g.Count() })
            .ToListAsync(cancellationToken);
        var existing = await db.DeviceCountSnapshots.Where(s => s.Date == date).ToListAsync(cancellationToken);

        foreach (var count in counts)
        {
            if (existing.FirstOrDefault(s => s.OrganizationId == count.OrganizationId && s.Type == count.Type) is { } snapshot)
            {
                snapshot.Count = count.Count;
            }
            else
            {
                db.DeviceCountSnapshots.Add(new DeviceCountSnapshot(count.OrganizationId, date, count.Type, count.Count));
            }
        }

        // Devices of a type that disappeared entirely count as zero for the day.
        foreach (var stale in existing.Where(s => !counts.Any(c => c.OrganizationId == s.OrganizationId && c.Type == s.Type)))
        {
            stale.Count = 0;
        }

        await db.SaveChangesAsync(cancellationToken);
        return counts.Select(c => c.OrganizationId).Distinct().Count();
    }

    public async Task<ServiceLoad> GetLoadAsync(CancellationToken cancellationToken)
    {
        var tickets = await db.Tickets.AsNoTracking()
            .Where(t => t.IsOpen)
            .Select(t => new { t.TechnicianUserId })
            .ToListAsync(cancellationToken);
        var alerts = await db.Alerts.AsNoTracking()
            .GroupBy(a => a.Severity)
            .Select(g => new { g.Key, Count = g.Count() })
            .ToListAsync(cancellationToken);
        var devices = await db.Devices.AsNoTracking()
            .Where(d => d.RemovedAt == null)
            .GroupBy(d => d.Online)
            .Select(g => new { Online = g.Key, Count = g.Count() })
            .ToListAsync(cancellationToken);

        return new ServiceLoad(
            tickets.Count,
            tickets.Count(t => t.TechnicianUserId is null),
            alerts.FirstOrDefault(a => a.Key == AlertSeverity.Critical)?.Count ?? 0,
            alerts.FirstOrDefault(a => a.Key == AlertSeverity.Warning)?.Count ?? 0,
            devices.Sum(d => d.Count),
            devices.FirstOrDefault(d => !d.Online)?.Count ?? 0);
    }

    public async Task<IReadOnlyDictionary<DeviceType, int>> GetDeviceCountsAsync(Guid organizationId, DateOnly date, CancellationToken cancellationToken)
    {
        var latest = await db.DeviceCountSnapshots.AsNoTracking()
            .Where(s => s.OrganizationId == organizationId && s.Date <= date)
            .MaxAsync(s => (DateOnly?)s.Date, cancellationToken);
        if (latest is { } day)
        {
            return await db.DeviceCountSnapshots.AsNoTracking()
                .Where(s => s.OrganizationId == organizationId && s.Date == day)
                .ToDictionaryAsync(s => s.Type, s => s.Count, cancellationToken);
        }

        return await db.Devices.AsNoTracking()
            .Where(d => d.OrganizationId == organizationId && d.RemovedAt == null)
            .GroupBy(d => d.Type)
            .ToDictionaryAsync(g => g.Key, g => g.Count(), cancellationToken);
    }

    public async Task<IReadOnlyList<TicketRef>> GetActiveTicketsAsync(string system, DateTimeOffset since, CancellationToken cancellationToken) =>
        await db.Tickets.AsNoTracking()
            .Where(t => t.System == system && (t.IsOpen || t.CreatedAtSource >= since || t.ResolvedAt >= since || t.LastActivityAt >= since))
            .OrderByDescending(t => t.ExternalId)
            .Select(t => new TicketRef(t.Id, t.System, t.ExternalId, t.OrganizationId, t.Title, t.Status))
            .ToListAsync(cancellationToken);

    public async Task<IReadOnlyDictionary<long, TicketRef>> GetTicketsAsync(string system, IReadOnlyCollection<long> externalIds, CancellationToken cancellationToken) =>
        await db.Tickets.AsNoTracking()
            .Where(t => t.System == system && externalIds.Contains(t.ExternalId))
            .ToDictionaryAsync(t => t.ExternalId, t => new TicketRef(t.Id, t.System, t.ExternalId, t.OrganizationId, t.Title, t.Status), cancellationToken);

    public async Task<TicketRequestView?> GetTicketRequestAsync(Guid requestId, CancellationToken cancellationToken) =>
        await db.TicketRequests.AsNoTracking().Where(r => r.Id == requestId)
            .Select(r => new TicketRequestView(r.Id, r.OrganizationId, r.ContactId, r.Title, r.Description, r.Priority, r.Type, r.Status, r.CreatedBy))
            .SingleOrDefaultAsync(cancellationToken);

    public async Task CompleteTicketRequestAsync(Guid requestId, long externalTicketId, string? url, CancellationToken cancellationToken)
    {
        if (await db.TicketRequests.SingleOrDefaultAsync(r => r.Id == requestId, cancellationToken) is { } request)
        {
            request.Complete(externalTicketId, url);
            await db.SaveChangesAsync(cancellationToken);
        }
    }

    public async Task FailTicketRequestAsync(Guid requestId, string message, CancellationToken cancellationToken)
    {
        if (await db.TicketRequests.SingleOrDefaultAsync(r => r.Id == requestId, cancellationToken) is { } request)
        {
            request.Fail(message);
            await db.SaveChangesAsync(cancellationToken);
        }
    }
}

/// <summary>Tickets, devices and alerts follow an organization into a merge. The mirror is rebuilt by the next sync, so an undo needs nothing.</summary>
internal sealed class ServiceMergeHandler(ServiceDbContext db, ICustomersApi customers) : IDomainEventHandler<OrganizationsMerged>
{
    public async Task HandleAsync(OrganizationsMerged domainEvent, CancellationToken cancellationToken)
    {
        // Delivered late (retried or replayed) after the merge was undone: the organizations are apart again (DEV-07). The
        // four updates commit together with the handler's receipt (DEV-07).
        if (await customers.IsMergeUndoneAsync(domainEvent.MergeId, cancellationToken))
        {
            return;
        }

        await db.Tickets.Where(t => t.OrganizationId == domainEvent.SourceOrganizationId)
            .ExecuteUpdateAsync(u => u.SetProperty(t => t.OrganizationId, domainEvent.TargetOrganizationId), cancellationToken);
        await db.Devices.Where(d => d.OrganizationId == domainEvent.SourceOrganizationId)
            .ExecuteUpdateAsync(u => u.SetProperty(d => d.OrganizationId, domainEvent.TargetOrganizationId), cancellationToken);
        await db.Alerts.Where(a => a.OrganizationId == domainEvent.SourceOrganizationId)
            .ExecuteUpdateAsync(u => u.SetProperty(a => a.OrganizationId, domainEvent.TargetOrganizationId), cancellationToken);
        await db.TicketRequests.Where(r => r.OrganizationId == domainEvent.SourceOrganizationId)
            .ExecuteUpdateAsync(u => u.SetProperty(r => r.OrganizationId, domainEvent.TargetOrganizationId), cancellationToken);
    }
}
