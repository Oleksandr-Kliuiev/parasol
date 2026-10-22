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
        var changed = 0;
        foreach (var desk in tickets.GroupBy(t => t.System))
        {
            var batch = desk.DistinctBy(t => t.ExternalId).ToList();
            try
            {
                changed += await TicketWriteLock.RunAsync(db, desk.Key, ct => UpsertTicketsOnceAsync(desk.Key, batch, ct), cancellationToken);
            }
            catch (DbUpdateConcurrencyException)
            {
                // A writer outside the reads (a merge, an erasure) changed one of the tickets in between: read them again, once.
                db.ChangeTracker.Clear();
                changed += await TicketWriteLock.RunAsync(db, desk.Key, ct => UpsertTicketsOnceAsync(desk.Key, batch, ct), cancellationToken);
            }
        }

        return changed;
    }

    private async Task<int> UpsertTicketsOnceAsync(string system, IReadOnlyCollection<ExternalTicket> tickets, CancellationToken cancellationToken)
    {
        var now = time.GetUtcNow();
        var changed = 0;
        var ids = tickets.Select(t => t.ExternalId).ToList();
        var existing = await db.Tickets.Where(t => t.System == system && ids.Contains(t.ExternalId)).ToDictionaryAsync(t => t.ExternalId, cancellationToken);
        foreach (var source in tickets)
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

        await db.SaveChangesAsync(cancellationToken);
        return changed;
    }

    public async Task ReplaceDevicesAsync(Guid organizationId, string system, IReadOnlyCollection<ExternalDevice> devices, CancellationToken cancellationToken)
    {
        var moved = new HashSet<Guid>();
        // The devices and the machines they make land together (M40), under the customer's lock.
        await new MachineLinks(db, time).RunAsync(organizationId, async ct =>
        {
            moved.Clear();
            var now = time.GetUtcNow();
            var ids = devices.Select(d => d.ExternalId).ToList();
            var known = await db.Devices.Where(d => d.System == system && (d.OrganizationId == organizationId || ids.Contains(d.ExternalId))).ToListAsync(ct);
            var byId = known.ToDictionary(d => d.ExternalId, StringComparer.Ordinal);
            foreach (var source in devices.DistinctBy(d => d.ExternalId))
            {
                if (byId.TryGetValue(source.ExternalId, out var device))
                {
                    if (device.OrganizationId != organizationId)
                    {
                        moved.Add(device.OrganizationId);
                    }

                    device.Apply(organizationId, source);
                }
                else
                {
                    db.Devices.Add(Device.From(system, organizationId, source, now));
                }
            }

            var gone = known.Where(d => d.OrganizationId == organizationId && !ids.Contains(d.ExternalId) && d.RemovedAt == null).ToList();
            foreach (var device in gone)
            {
                device.MarkRemoved(now);
            }

            // M40: the updates of a device no longer reported tell nothing any more.
            var goneIds = gone.Select(d => d.Id).ToList();
            if (goneIds.Count > 0)
            {
                await db.DevicePatches.Where(p => goneIds.Contains(p.DeviceId)).ExecuteDeleteAsync(ct);
            }
        }, cancellationToken);

        // A device that moved from another customer leaves a machine there that has to be matched again.
        await new MachineLinks(db, time).RelinkAsync(moved, cancellationToken);
    }

    public async Task<IReadOnlyList<DeviceRef>> GetCurrentDevicesAsync(string system, CancellationToken cancellationToken) =>
        await db.Devices.AsNoTracking().Where(d => d.System == system && d.RemovedAt == null)
            .OrderBy(d => d.FirstSeenAt).ThenBy(d => d.Id)
            .Select(d => new DeviceRef(d.Id, d.OrganizationId, d.ExternalId, d.AlternateId, d.MachineName, d.Os))
            .ToListAsync(cancellationToken);

    public async Task<bool> ApplyDevicePatchesAsync(Guid deviceId, DevicePatchSnapshot snapshot, CancellationToken cancellationToken)
    {
        // The delete, the inserts and the read time land together, and the SQL Server retry strategy needs the transaction inside it.
        return await db.Database.CreateExecutionStrategy().ExecuteAsync(async ct =>
        {
            db.ChangeTracker.Clear();
            await using var transaction = await db.Database.BeginTransactionAsync(ct);
            if (await db.Devices.SingleOrDefaultAsync(d => d.Id == deviceId && d.RemovedAt == null, ct) is not { } device)
            {
                return false;
            }

            await db.DevicePatches.Where(p => p.DeviceId == deviceId).ExecuteDeleteAsync(ct);
            db.DevicePatches.AddRange(Patches(deviceId, true, snapshot.Installed).Concat(Patches(deviceId, false, snapshot.Available)));
            device.PatchesRead(time.GetUtcNow(), snapshot.CollectedAt);
            await db.SaveChangesAsync(ct);
            await transaction.CommitAsync(ct);
            return true;
        }, cancellationToken);

        // The newest installed first: a card shows what changed lately, and the cap keeps those.
        static IEnumerable<DevicePatch> Patches(Guid deviceId, bool installed, IReadOnlyList<DevicePatchReading> readings) =>
            readings.Where(r => !string.IsNullOrWhiteSpace(r.Name))
                .OrderByDescending(r => r.InstalledAt ?? DateTimeOffset.MinValue).ThenBy(r => r.KbId, StringComparer.Ordinal)
                .Take(DevicePatch.MaxPerKind)
                .Select(r => DevicePatch.From(deviceId, installed, r));
    }

    public Task<AlertSnapshotResult> ApplyAlertSnapshotAsync(AlertSnapshot snapshot, CancellationToken cancellationToken) =>
        new AlertSnapshots(db, time).ApplyAsync(snapshot, cancellationToken);

    public Task<bool> ResolveAlertAsync(string system, string externalId, CancellationToken cancellationToken) =>
        new AlertSnapshots(db, time).ResolveOneAsync(system, externalId, cancellationToken);

    public async Task<AlertRef?> GetAlertAsync(Guid alertId, CancellationToken cancellationToken) =>
        await db.Alerts.AsNoTracking().Where(a => a.Id == alertId).Select(AlertQueries.Ref).SingleOrDefaultAsync(cancellationToken);

    public async Task<AlertRef?> GetAlertAsync(string system, string externalId, CancellationToken cancellationToken) =>
        await db.Alerts.AsNoTracking().Where(a => a.System == system && a.ExternalId == externalId).Select(AlertQueries.Ref)
            .SingleOrDefaultAsync(cancellationToken);

    public async Task<IReadOnlyDictionary<Guid, AlertRef>> GetAlertsAsync(IReadOnlyCollection<Guid> alertIds, CancellationToken cancellationToken)
    {
        var ids = alertIds.Distinct().ToList();
        return ids.Count == 0
            ? new Dictionary<Guid, AlertRef>()
            : await db.Alerts.AsNoTracking().Where(a => ids.Contains(a.Id)).Select(AlertQueries.Ref).ToDictionaryAsync(a => a.Id, cancellationToken);
    }

    public async Task<int> TakeDeviceSnapshotAsync(DateOnly date, CancellationToken cancellationToken)
    {
        var counts = await db.Devices.AsNoTracking()
            .Where(d => d.System == DeviceCounting.BilledSystem && d.RemovedAt == null)
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
            .GroupBy(t => 1)
            .Select(g => new { Open = g.Count(), Unassigned = g.Count(t => t.TechnicianUserId == null) })
            .SingleOrDefaultAsync(cancellationToken);
        // Resolved alerts stay as history and acknowledged ones are in hand; only open alerts count.
        var alerts = await db.Alerts.AsNoTracking()
            .Where(a => a.State == AlertState.Open)
            .GroupBy(a => a.Severity)
            .Select(g => new { g.Key, Count = g.Count() })
            .ToListAsync(cancellationToken);
        // One computer is one machine, however many sources watch it (M40).
        var devices = await db.Machines.AsNoTracking()
            .Where(m => m.RemovedAt == null)
            .GroupBy(m => m.Online)
            .Select(g => new { Online = g.Key, Count = g.Count() })
            .ToListAsync(cancellationToken);

        return new ServiceLoad(
            tickets?.Open ?? 0,
            tickets?.Unassigned ?? 0,
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
            .Where(d => d.OrganizationId == organizationId && d.System == DeviceCounting.BilledSystem && d.RemovedAt == null)
            .GroupBy(d => d.Type)
            .ToDictionaryAsync(g => g.Key, g => g.Count(), cancellationToken);
    }

    public async Task<IReadOnlyDictionary<Guid, IReadOnlyDictionary<DeviceType, int>>> GetDeviceCountsAsync(
        IReadOnlyCollection<Guid> organizationIds, DateOnly date, CancellationToken cancellationToken) =>
        (await GetDeviceCountReadingsAsync(organizationIds, date, cancellationToken)).ToDictionary(r => r.Key, r => r.Value.Counts);

    public async Task<IReadOnlyDictionary<Guid, DeviceCountReading>> GetDeviceCountReadingsAsync(
        IReadOnlyCollection<Guid> organizationIds, DateOnly date, CancellationToken cancellationToken)
    {
        if (organizationIds.Count == 0)
        {
            return new Dictionary<Guid, DeviceCountReading>();
        }

        var latest = db.DeviceCountSnapshots.AsNoTracking()
            .Where(s => organizationIds.Contains(s.OrganizationId) && s.Date <= date)
            .GroupBy(s => s.OrganizationId)
            .Select(g => new { OrganizationId = g.Key, Date = g.Max(s => s.Date) });
        var snapshots = await (
                from snapshot in db.DeviceCountSnapshots.AsNoTracking()
                join day in latest on new { snapshot.OrganizationId, snapshot.Date } equals new { day.OrganizationId, day.Date }
                select new { snapshot.OrganizationId, snapshot.Date, snapshot.Type, snapshot.Count })
            .ToListAsync(cancellationToken);
        var result = snapshots.GroupBy(s => s.OrganizationId)
            .ToDictionary(
                g => g.Key,
                g => new DeviceCountReading(g.ToDictionary(s => s.Type, s => s.Count), g.Max(s => s.Date)));
        var withoutSnapshot = organizationIds.Where(id => !result.ContainsKey(id)).Distinct().ToList();
        if (withoutSnapshot.Count > 0)
        {
            var live = await db.Devices.AsNoTracking()
                .Where(d => withoutSnapshot.Contains(d.OrganizationId) && d.System == DeviceCounting.BilledSystem && d.RemovedAt == null)
                .GroupBy(d => new { d.OrganizationId, d.Type })
                .Select(g => new { g.Key.OrganizationId, g.Key.Type, Count = g.Count() })
                .ToListAsync(cancellationToken);
            foreach (var group in live.GroupBy(d => d.OrganizationId))
            {
                result[group.Key] = new DeviceCountReading(group.ToDictionary(d => d.Type, d => d.Count), null);
            }

            foreach (var id in withoutSnapshot)
            {
                result.TryAdd(id, new DeviceCountReading(new Dictionary<DeviceType, int>(), null));
            }
        }

        return result;
    }

    public async Task<IReadOnlyList<TicketRef>> GetActiveTicketsAsync(string system, DateTimeOffset since, CancellationToken cancellationToken) =>
        await db.Tickets.AsNoTracking()
            .Where(t => t.System == system && (t.IsOpen || t.CreatedAtSource >= since || t.ResolvedAt >= since || t.LastActivityAt >= since))
            .OrderByDescending(t => t.ExternalId)
            .Select(t => new TicketRef(t.Id, t.System, t.ExternalId, t.OrganizationId, t.Title, t.Status, t.Url))
            .ToListAsync(cancellationToken);

    public async Task<IReadOnlyDictionary<long, TicketRef>> GetTicketsAsync(string system, IReadOnlyCollection<long> externalIds, CancellationToken cancellationToken) =>
        await db.Tickets.AsNoTracking()
            .Where(t => t.System == system && externalIds.Contains(t.ExternalId))
            .ToDictionaryAsync(t => t.ExternalId, t => new TicketRef(t.Id, t.System, t.ExternalId, t.OrganizationId, t.Title, t.Status, t.Url), cancellationToken);

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

    public Task<TicketView?> GetTicketAsync(string system, long externalId, CancellationToken cancellationToken) =>
        new TicketConversations(db, time).GetAsync(system, externalId, cancellationToken);

    public Task<TicketConversationResult> ApplyTicketConversationAsync(
        string system, long ticketExternalId, IReadOnlyCollection<ExternalTicketComment> comments, bool withheld, CancellationToken cancellationToken) =>
        new TicketConversations(db, time).ApplyAsync(system, ticketExternalId, comments, withheld, cancellationToken);

    public Task<IReadOnlyList<TicketRef>> GetStaleConversationsAsync(string system, DateTimeOffset readBefore, int limit, CancellationToken cancellationToken) =>
        new TicketConversations(db, time).StaleAsync(system, readBefore, limit, cancellationToken);

    public async Task<IReadOnlyList<TicketRef>> GetTicketsOfPersonAsync(Guid? contactId, IReadOnlyCollection<string> emails, CancellationToken cancellationToken) =>
        await Features.Privacy.ServicePersonalData.TicketsOfPerson(db.Tickets.AsNoTracking(), contactId, emails)
            .OrderBy(t => t.Id)
            .Select(t => new TicketRef(t.Id, t.System, t.ExternalId, t.OrganizationId, t.Title, t.Status, t.Url))
            .ToListAsync(cancellationToken);
}

/// <summary>
/// Tickets, devices and alerts follow an organization into a merge. The mirror is rebuilt by the next sync, so an undo needs
/// nothing; an alert keeps its id either way.
/// </summary>
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
        // M40: the machines go with their devices; the next device read matches the two customers' machines as one customer's.
        await db.Machines.Where(m => m.OrganizationId == domainEvent.SourceOrganizationId)
            .ExecuteUpdateAsync(u => u.SetProperty(m => m.OrganizationId, domainEvent.TargetOrganizationId), cancellationToken);
        await db.MachineLinkDecisions.IgnoreQueryFilters().Where(d => d.OrganizationId == domainEvent.SourceOrganizationId)
            .ExecuteUpdateAsync(u => u.SetProperty(d => d.OrganizationId, domainEvent.TargetOrganizationId), cancellationToken);
        await db.MachineProposals.Where(p => p.OrganizationId == domainEvent.SourceOrganizationId)
            .ExecuteUpdateAsync(u => u.SetProperty(p => p.OrganizationId, domainEvent.TargetOrganizationId), cancellationToken);
        await db.Alerts.Where(a => a.OrganizationId == domainEvent.SourceOrganizationId)
            .ExecuteUpdateAsync(u => u.SetProperty(a => a.OrganizationId, domainEvent.TargetOrganizationId), cancellationToken);
        await db.TicketRequests.Where(r => r.OrganizationId == domainEvent.SourceOrganizationId)
            .ExecuteUpdateAsync(u => u.SetProperty(r => r.OrganizationId, domainEvent.TargetOrganizationId), cancellationToken);
    }

}

/// <summary>
/// Which devices a bill counts (M40). A contract line priced per Atera device (<c>PerAteraDevice</c>) and the daily count it reads
/// take only Atera's agents: the Huntress agent on the same computer (M41) is the same machine, not another device to bill.
/// </summary>
internal static class DeviceCounting
{
    public const string BilledSystem = "atera";
}
