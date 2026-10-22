using Crm.Service.Contracts;
using Crm.Service.Domain;
using Crm.Service.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crm.Service.Features;

/// <summary>A device an alert may name: its id, its customer, its machine name and the source's ids of it.</summary>
internal sealed record AlertDeviceCandidate(Guid Id, Guid OrganizationId, string MachineName, string? ExternalId = null, string? AlternateId = null);

/// <summary>
/// Finds the CRM device an alert is about. An alert that names the source's agent (M40: Atera's AgentId or DeviceGuid) gets that
/// agent when it is a current device of the same customer. Otherwise a name counts only when exactly one current device of the
/// same customer and source carries it, ignoring case; two devices with one name, or none, leave the alert without a device
/// rather than with a guess.
/// </summary>
internal sealed class AlertDeviceIndex
{
    private readonly Dictionary<Guid, Dictionary<string, Guid?>> byOrganization = [];
    private readonly Dictionary<(Guid, string), Guid> byExternalId = [];
    private readonly Dictionary<(Guid, string), Guid> byAlternateId = [];

    public AlertDeviceIndex(IEnumerable<AlertDeviceCandidate> devices)
    {
        foreach (var device in devices)
        {
            if (device.ExternalId is { Length: > 0 } externalId)
            {
                byExternalId[(device.OrganizationId, externalId)] = device.Id;
            }

            if (device.AlternateId is { Length: > 0 } alternateId)
            {
                byAlternateId[(device.OrganizationId, alternateId.ToUpperInvariant())] = device.Id;
            }

            var name = device.MachineName.Trim();
            if (name.Length == 0)
            {
                continue;
            }

            if (!byOrganization.TryGetValue(device.OrganizationId, out var names))
            {
                byOrganization[device.OrganizationId] = names = new Dictionary<string, Guid?>(StringComparer.OrdinalIgnoreCase);
            }

            // A second device with the name makes it ambiguous for good.
            names[name] = names.ContainsKey(name) ? null : device.Id;
        }
    }

    public Guid? Find(Guid organizationId, string? deviceName) =>
        deviceName?.Trim() is { Length: > 0 } name && byOrganization.TryGetValue(organizationId, out var names) && names.TryGetValue(name, out var id)
            ? id
            : null;

    /// <summary>The device an alert is about: the agent it names, else the one device of the customer with its name.</summary>
    public Guid? Find(ExternalAlert alert) =>
        alert.DeviceExternalId is { Length: > 0 } externalId && byExternalId.TryGetValue((alert.OrganizationId, externalId), out var byAgent) ? byAgent
        : alert.DeviceAlternateId is { Length: > 0 } alternateId && byAlternateId.TryGetValue((alert.OrganizationId, alternateId.ToUpperInvariant()), out var byGuid) ? byGuid
        : Find(alert.OrganizationId, alert.DeviceName);
}

/// <summary>The rules of one alert read (M38), kept apart from the database so they can be checked on their own.</summary>
internal static class AlertSnapshotRules
{
    /// <summary>
    /// Applies <paramref name="snapshot"/> to the alerts stored for its source: every alert the read lists and every alert of the
    /// source that is not resolved. Changes the stored alerts in place and returns the new ones. An incomplete snapshot changes
    /// nothing: an alert it does not list may be on a page that was never read.
    /// </summary>
    public static (IReadOnlyList<Alert> Added, AlertSnapshotResult Result) Apply(
        AlertSnapshot snapshot, IReadOnlyCollection<Alert> stored, AlertDeviceIndex devices, DateTimeOffset now)
    {
        if (!snapshot.IsComplete)
        {
            return ([], AlertSnapshotResult.NotApplied);
        }

        var byExternalId = stored.ToDictionary(a => a.ExternalId, StringComparer.Ordinal);
        var added = new List<Alert>();
        int opened = 0, reopened = 0, updated = 0, resolved = 0;
        foreach (var source in snapshot.Alerts.DistinctBy(a => a.ExternalId, StringComparer.Ordinal))
        {
            var deviceId = devices.Find(source);
            if (byExternalId.TryGetValue(source.ExternalId, out var alert))
            {
                switch (alert.Observe(snapshot.Kind, source, deviceId, now))
                {
                    case AlertChange.Reopened:
                        reopened++;
                        break;
                    case AlertChange.Updated:
                        updated++;
                        break;
                }
            }
            else
            {
                added.Add(Alert.Open(snapshot.System, snapshot.Kind, source, deviceId, now));
                opened++;
            }
        }

        // Not listed by a complete read: no longer open in the source. An alert the source still reports open but the read could
        // not map (its customer lost the link to the organization) is in OpenExternalIds and stays exactly as it is.
        var open = snapshot.OpenExternalIds.Concat(snapshot.Alerts.Select(a => a.ExternalId)).ToHashSet(StringComparer.Ordinal);
        foreach (var alert in stored.Where(a => a.Kind == snapshot.Kind && a.State != AlertState.Resolved && !open.Contains(a.ExternalId)))
        {
            resolved += alert.Resolve(now) ? 1 : 0;
        }

        return (added, new AlertSnapshotResult(true, opened, reopened, updated, resolved));
    }
}

/// <summary>Stores an alert read: one transaction per snapshot, and one snapshot of a source at a time.</summary>
internal sealed class AlertSnapshots(ServiceDbContext db, TimeProvider time)
{
    public async Task<AlertSnapshotResult> ApplyAsync(AlertSnapshot snapshot, CancellationToken cancellationToken)
    {
        if (!snapshot.IsComplete)
        {
            return AlertSnapshotResult.NotApplied;
        }

        var now = time.GetUtcNow();
        var listed = snapshot.Alerts.Select(a => a.ExternalId).Distinct(StringComparer.Ordinal).ToList();
        var organizations = snapshot.Alerts
            .Where(a => !string.IsNullOrWhiteSpace(a.DeviceName) || a.DeviceExternalId is not null || a.DeviceAlternateId is not null)
            .Select(a => a.OrganizationId).Distinct().ToList();
        var resource = "service-alerts:" + snapshot.System;
        // The reads, the lock and the writes land together, and the SQL Server retry strategy needs the transaction inside it.
        return await db.Database.CreateExecutionStrategy().ExecuteAsync(async ct =>
        {
            // A retried attempt starts from the database again, not from the alerts the failed attempt had changed or added.
            foreach (var entry in db.ChangeTracker.Entries<Alert>().ToList())
            {
                entry.State = EntityState.Detached;
            }

            await using var transaction = await db.Database.BeginTransactionAsync(ct);
            // A run started by hand beside the scheduled one waits instead of inserting the same new alert twice.
            await db.Database.ExecuteSqlInterpolatedAsync($"""
                DECLARE @r int; EXEC @r = sys.sp_getapplock @Resource={resource}, @LockMode=N'Exclusive', @LockOwner=N'Transaction', @LockTimeout=30000;
                IF @r < 0 THROW 51000, 'Another read of these alerts is being stored.', 1;
                """, ct);
            // Resolved alerts stay as history; only those the read lists again are loaded, to be opened again.
            var stored = await db.Alerts
                .Where(a => a.System == snapshot.System && (a.State != AlertState.Resolved || listed.Contains(a.ExternalId)))
                .ToListAsync(ct);
            var devices = organizations.Count == 0
                ? []
                : await db.Devices.AsNoTracking()
                    .Where(d => d.System == snapshot.System && d.RemovedAt == null && organizations.Contains(d.OrganizationId))
                    .Select(d => new AlertDeviceCandidate(d.Id, d.OrganizationId, d.MachineName, d.ExternalId, d.AlternateId))
                    .ToListAsync(ct);
            var (added, result) = AlertSnapshotRules.Apply(snapshot, stored, new AlertDeviceIndex(devices), now);
            db.Alerts.AddRange(added);
            await db.SaveChangesAsync(ct);
            await transaction.CommitAsync(ct);
            return result;
        }, cancellationToken);
    }
}
