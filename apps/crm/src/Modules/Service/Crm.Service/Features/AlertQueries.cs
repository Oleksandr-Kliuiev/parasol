using System.Globalization;
using System.Linq.Expressions;
using Crm.Customers.Contracts;
using Crm.Service.Contracts;
using Crm.Service.Domain;
using Crm.Service.Persistence;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Operations;
using Crm.SharedKernel.Results;
using Microsoft.EntityFrameworkCore;

namespace Crm.Service.Features;

/// <summary>One alert in a list, with its customer's name and the device it was matched to. <c>CreatedAt</c> is the source's time.</summary>
public sealed record AlertListItem(
    Guid Id,
    Guid OrganizationId,
    string? OrganizationName,
    string System,
    AlertKind Kind,
    string ExternalId,
    AlertSeverity Severity,
    AlertState State,
    string Title,
    string? DeviceName,
    Guid? DeviceId,
    DateTimeOffset CreatedAt,
    DateTimeOffset? LastSeenAt,
    DateTimeOffset? ResolvedAt,
    string? Url);

/// <summary>A page of alerts. The counts cover the whole filter, not the page (DEV-12).</summary>
public sealed record AlertPage(IReadOnlyList<AlertListItem> Items, string? NextCursor, int TotalCount, int Critical, int Warning);

/// <summary>
/// The latest finished read of one alert source: when it started and whether it read everything. A read that failed, stopped
/// part-way or was held by a pause is not complete, so the alerts shown are those of an earlier read.
/// </summary>
public sealed record AlertSourceRead(string System, DateTimeOffset? StartedAt, bool Complete);

/// <summary>The open alerts that waited longest at the highest severity, out of <c>TotalCount</c> open ones.</summary>
public sealed record UrgentAlerts(IReadOnlyList<AlertListItem> Items, int TotalCount, int Critical, int Warning, IReadOnlyList<AlertSourceRead> Reads);

/// <summary>Alerts across customers (M38): the queue with its filters and the short urgent list for My day.</summary>
internal sealed class AlertQueries(ServiceDbContext db, ICustomersApi customers, IEnumerable<ISyncCompletenessSource> completeness)
{
    public const int DefaultLimit = 25;
    public const int MaxLimit = 100;
    public const int UrgentDefaultLimit = 5;
    public const int UrgentMaxLimit = 25;

    /// <summary>The runs that read alerts into the CRM, named as the integrations record them (system, job).</summary>
    private static readonly (string System, string Job)[] Sources = [("atera", "atera-alerts")];

    /// <summary>The shape other modules read through <see cref="IServiceApi"/>.</summary>
    internal static readonly Expression<Func<Alert, AlertRef>> Ref = a => new AlertRef(
        a.Id, a.OrganizationId, a.System, a.Kind, a.ExternalId, a.ExternalCustomerId, a.Title, a.Severity, a.State, a.DeviceName, a.DeviceId,
        a.CreatedAtSource, a.Url);

    /// <summary>
    /// Alerts in one state (open unless asked otherwise), newest first by the source's time, then by id. Filters narrow the
    /// totals as well as the page; the cursor carries both sort values.
    /// </summary>
    public async Task<Result<AlertPage>> ListAsync(
        Guid? organizationId, AlertState? state, AlertSeverity? severity, Guid? deviceId, string? search, string? cursor, int? limit,
        CancellationToken ct)
    {
        if ((state is { } s && !Enum.IsDefined(s)) || (severity is { } v && !Enum.IsDefined(v)))
        {
            return Error.Validation("SRV_ALERT_FILTER_INVALID", "Unknown alert state or severity.");
        }

        var after = KeysetCursor.Decode(cursor);
        var created = default(DateTimeOffset);
        if (cursor is not null &&
            (after is null || !DateTimeOffset.TryParseExact(after.SortKey, "O", CultureInfo.InvariantCulture, DateTimeStyles.None, out created)))
        {
            return Error.Validation("SRV_ALERT_CURSOR_INVALID", "The alert page does not belong to this list.");
        }

        var wanted = state ?? AlertState.Open;
        var alerts = db.Alerts.AsNoTracking().Where(a => a.State == wanted);
        if (organizationId is { } organization)
        {
            alerts = alerts.Where(a => a.OrganizationId == organization);
        }

        if (severity is { } level)
        {
            alerts = alerts.Where(a => a.Severity == level);
        }

        if (deviceId is { } device)
        {
            alerts = alerts.Where(a => a.DeviceId == device);
        }

        if (search?.Trim() is { Length: > 0 } term)
        {
            alerts = alerts.Where(a => a.Title.Contains(term) || (a.DeviceName != null && a.DeviceName.Contains(term)));
        }

        var counts = await CountAsync(alerts, ct);
        if (after is not null)
        {
            alerts = alerts.Where(a => a.CreatedAtSource < created || (a.CreatedAtSource == created && a.Id.CompareTo(after.Id) < 0));
        }

        var take = Math.Clamp(limit ?? DefaultLimit, 1, MaxLimit);
        var page = await alerts.OrderByDescending(a => a.CreatedAtSource).ThenByDescending(a => a.Id).Take(take + 1).ToListAsync(ct);
        var rows = page.Take(take).ToList();
        var next = page.Count > take ? new KeysetCursor(rows[^1].CreatedAtSource.ToString("O", CultureInfo.InvariantCulture), rows[^1].Id).Encode() : null;
        return new AlertPage(await ItemsAsync(rows, ct), next, counts.Total, counts.Critical, counts.Warning);
    }

    /// <summary>
    /// The open alerts to look at first: the most severe, and among those the oldest. The counts are of every open alert, so a
    /// panel can say "5 of 40"; the reads say how fresh the list is.
    /// </summary>
    public async Task<UrgentAlerts> UrgentAsync(int? limit, CancellationToken ct)
    {
        var open = db.Alerts.AsNoTracking().Where(a => a.State == AlertState.Open);
        var counts = await CountAsync(open, ct);
        var take = Math.Clamp(limit ?? UrgentDefaultLimit, 1, UrgentMaxLimit);
        // An enum stored as text sorts by a CASE rank, not by its spelling.
        var rows = await open
            .OrderBy(a => a.Severity == AlertSeverity.Critical ? 0 : a.Severity == AlertSeverity.Warning ? 1 : 2)
            .ThenBy(a => a.CreatedAtSource).ThenBy(a => a.Id)
            .Take(take).ToListAsync(ct);
        var reads = new List<AlertSourceRead>(Sources.Length);
        foreach (var (system, job) in Sources)
        {
            reads.Add(await LatestReadAsync(system, job, ct));
        }

        return new UrgentAlerts(await ItemsAsync(rows, ct), counts.Total, counts.Critical, counts.Warning, reads);
    }

    private static async Task<(int Total, int Critical, int Warning)> CountAsync(IQueryable<Alert> alerts, CancellationToken ct)
    {
        var bySeverity = await alerts.GroupBy(a => a.Severity).Select(g => new { Severity = g.Key, Count = g.Count() }).ToListAsync(ct);
        return (bySeverity.Sum(c => c.Count),
            bySeverity.Where(c => c.Severity == AlertSeverity.Critical).Sum(c => c.Count),
            bySeverity.Where(c => c.Severity == AlertSeverity.Warning).Sum(c => c.Count));
    }

    private async Task<AlertSourceRead> LatestReadAsync(string system, string job, CancellationToken ct)
    {
        foreach (var source in completeness)
        {
            if (await source.LatestAsync(system, job, ct) is { } latest)
            {
                return new AlertSourceRead(system, latest.StartedAt, latest.Complete);
            }
        }

        return new AlertSourceRead(system, null, false);
    }

    private async Task<IReadOnlyList<AlertListItem>> ItemsAsync(List<Alert> rows, CancellationToken ct)
    {
        // One batch for the page's customer names, never a lookup per row.
        var names = rows.Count == 0
            ? new Dictionary<Guid, string>()
            : await customers.GetOrganizationNamesAsync(rows.Select(a => a.OrganizationId).Distinct().ToList(), ct);
        return rows.Select(a => new AlertListItem(
            a.Id, a.OrganizationId, names.GetValueOrDefault(a.OrganizationId), a.System, a.Kind, a.ExternalId, a.Severity, a.State, a.Title,
            a.DeviceName, a.DeviceId, a.CreatedAtSource, a.LastSeenAt, a.ResolvedAt, a.Url)).ToList();
    }
}
