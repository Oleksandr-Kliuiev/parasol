using System.Globalization;
using System.Linq.Expressions;
using Crm.Customers.Contracts;
using Crm.Identity.Contracts;
using Crm.Infrastructure.Persistence;
using Crm.Service.Contracts;
using Crm.Service.Domain;
using Crm.Service.Persistence;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Operations;
using Crm.SharedKernel.Results;
using Microsoft.EntityFrameworkCore;

namespace Crm.Service.Features;

/// <summary>
/// One alert in a list, with its customer's name and the device it was matched to. <c>CreatedAt</c> is the source's time. A coverage
/// gap the CRM found (M40) names its rule and facts, which the interface words in the reader's language. <c>SourceClosedAt</c> is when
/// the source closed an urgent alert that waits for a person to confirm it (M41).
/// </summary>
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
    string? Url,
    AlertHoldItem? Hidden = null,
    string? Etag = null,
    string? Rule = null,
    IReadOnlyDictionary<string, string>? Facts = null,
    Guid? MachineId = null,
    DateTimeOffset? SourceClosedAt = null);

/// <summary>An alert hidden in Parasoll (M40): until when, why, and by whom.</summary>
public sealed record AlertHoldItem(DateTimeOffset Until, string? Reason, string? ByName, DateTimeOffset? At);

/// <summary>A page of alerts. The counts cover the whole filter, not the page (DEV-12); the reads say how fresh the stored alerts are.</summary>
public sealed record AlertPage(
    IReadOnlyList<AlertListItem> Items, string? NextCursor, int TotalCount, int Critical, int Warning, IReadOnlyList<AlertSourceRead> Reads);

/// <summary>
/// The latest finished read of one alert source: when it started and whether it read everything. A read that failed, stopped
/// part-way or was held by a pause is not complete, so the alerts shown are those of an earlier read. A late read ended longer
/// ago than the source's freshness limit (the connections page calls it late): the next one is overdue.
/// </summary>
public sealed record AlertSourceRead(string System, DateTimeOffset? StartedAt, bool Complete, bool Late);

/// <summary>The open alerts that waited longest at the highest severity, out of <c>TotalCount</c> open ones.</summary>
public sealed record UrgentAlerts(IReadOnlyList<AlertListItem> Items, int TotalCount, int Critical, int Warning, IReadOnlyList<AlertSourceRead> Reads);

/// <summary>Alerts across customers (M38): the queue with its filters and the short urgent list for My day.</summary>
internal sealed class AlertQueries(
    ServiceDbContext db, ICustomersApi customers, IUserDirectory users, IEnumerable<ISyncCompletenessSource> completeness, TimeProvider time)
{
    public const int DefaultLimit = 25;
    public const int MaxLimit = 100;
    public const int UrgentDefaultLimit = 5;
    public const int UrgentMaxLimit = 25;

    /// <summary>The runs that read alerts into the CRM, named as the integrations record them (system, job).</summary>
    private static readonly (string System, string Job)[] Sources = [("atera", "atera-alerts"), ("huntress", "huntress-alerts")];

    /// <summary>The shape other modules read through <see cref="IServiceApi"/>.</summary>
    internal static readonly Expression<Func<Alert, AlertRef>> Ref = a => new AlertRef(
        a.Id, a.OrganizationId, a.System, a.Kind, a.ExternalId, a.ExternalCustomerId, a.Title, a.Severity, a.State, a.DeviceName, a.DeviceId,
        a.CreatedAtSource, a.Url, a.ResolvedAt, a.Rule, a.Facts, a.SourceClosedAt);

    /// <summary>
    /// Alerts in one state (open unless asked otherwise). Open ones come in the order they should be looked at: critical first, and
    /// within a severity the oldest first; resolved ones newest resolved first. An open list leaves out what is hidden in Parasoll
    /// now (M40); <paramref name="hidden"/> lists just those, in the open order. Filters narrow the totals as well as the page; the
    /// cursor carries every sort value, so a cursor of one order is refused by the other.
    /// </summary>
    public async Task<Result<AlertPage>> ListAsync(
        Guid? organizationId, AlertState? state, AlertSeverity? severity, Guid? deviceId, string? search, string? cursor, int? limit,
        CancellationToken ct, bool hidden = false)
    {
        if ((state is { } s && !Enum.IsDefined(s)) || (severity is { } v && !Enum.IsDefined(v)) || (hidden && state == AlertState.Resolved))
        {
            return Error.Validation("SRV_ALERT_FILTER_INVALID", "Unknown alert state or severity.");
        }

        var wanted = state ?? AlertState.Open;
        var resolved = wanted == AlertState.Resolved;
        var after = KeysetCursor.Decode(cursor);
        if (cursor is not null && (after is null || !AlertOrder.TryRead(after, resolved, out _)))
        {
            return Error.Validation("SRV_ALERT_CURSOR_INVALID", "The alert page does not belong to this list.");
        }

        var now = time.GetUtcNow();
        var stored = db.Alerts.AsNoTracking().Include(a => a.Hold);
        var alerts = hidden ? stored.Where(AlertVisibility.HiddenNow(now))
            : wanted == AlertState.Open ? stored.Where(AlertVisibility.OpenNow(now))
            : stored.Where(a => a.State == wanted);
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
        var take = Math.Clamp(limit ?? DefaultLimit, 1, MaxLimit);
        var page = await (resolved ? AlertOrder.Resolved(alerts, after) : AlertOrder.Open(alerts, after)).Take(take + 1).ToListAsync(ct);
        var rows = page.Take(take).ToList();
        var next = page.Count > take ? AlertOrder.Cursor(rows[^1], resolved).Encode() : null;
        return new AlertPage(await ItemsAsync(rows, ct), next, counts.Total, counts.Critical, counts.Warning, await ReadsAsync(ct));
    }

    /// <summary>
    /// One stored alert in any state, with its customer's name: the queue's side panel and a link from My day. The ETag is the one
    /// a person's change of its status in Parasoll must send (M40).
    /// </summary>
    public async Task<Result<AlertListItem>> GetAsync(Guid id, CancellationToken ct)
    {
        var alert = await db.Alerts.Include(a => a.Hold).SingleOrDefaultAsync(a => a.Id == id, ct);
        return alert is null
            ? Error.NotFound("SRV_ALERT_NOT_FOUND", "The alert is not stored in the CRM.")
            : (await ItemsAsync([alert], ct))[0] with { Etag = db.GetETag((object?)alert.Hold ?? alert) };
    }

    /// <summary>
    /// The open alerts to look at first: the most severe, and among those the oldest. The counts are of every open alert, so a
    /// panel can say "5 of 40"; the reads say how fresh the list is.
    /// </summary>
    public async Task<UrgentAlerts> UrgentAsync(int? limit, CancellationToken ct)
    {
        var open = db.Alerts.AsNoTracking().Include(a => a.Hold).Where(AlertVisibility.OpenNow(time.GetUtcNow()));
        var counts = await CountAsync(open, ct);
        var take = Math.Clamp(limit ?? UrgentDefaultLimit, 1, UrgentMaxLimit);
        var rows = await AlertOrder.Open(open, null).Take(take).ToListAsync(ct);
        return new UrgentAlerts(await ItemsAsync(rows, ct), counts.Total, counts.Critical, counts.Warning, await ReadsAsync(ct));
    }

    private static async Task<(int Total, int Critical, int Warning)> CountAsync(IQueryable<Alert> alerts, CancellationToken ct)
    {
        var bySeverity = await alerts.GroupBy(a => a.Severity).Select(g => new { Severity = g.Key, Count = g.Count() }).ToListAsync(ct);
        return (bySeverity.Sum(c => c.Count),
            bySeverity.Where(c => c.Severity == AlertSeverity.Critical).Sum(c => c.Count),
            bySeverity.Where(c => c.Severity == AlertSeverity.Warning).Sum(c => c.Count));
    }

    /// <summary>
    /// The latest finished read of every alert source, one question per source: the same for any filter or page. A source switched
    /// off and never read is left out (M41): it has said nothing about the alerts; one read before and switched off since stays.
    /// </summary>
    private async Task<IReadOnlyList<AlertSourceRead>> ReadsAsync(CancellationToken ct)
    {
        var reads = new List<AlertSourceRead>(Sources.Length);
        foreach (var (system, job) in Sources)
        {
            var read = await LatestReadAsync(system, job, ct);
            if (read.StartedAt is not null || completeness.Any(c => c.IsConnected(system)))
            {
                reads.Add(read);
            }
        }

        return reads;
    }

    private async Task<AlertSourceRead> LatestReadAsync(string system, string job, CancellationToken ct)
    {
        foreach (var source in completeness)
        {
            if (await source.LatestAsync(system, job, ct) is { } latest)
            {
                return new AlertSourceRead(system, latest.StartedAt, latest.Complete, latest.Late);
            }
        }

        return new AlertSourceRead(system, null, false, false);
    }

    private async Task<IReadOnlyList<AlertListItem>> ItemsAsync(List<Alert> rows, CancellationToken ct)
    {
        // One batch each for the page's customer names, the machines of its devices (M40: the device's card) and the people who hid
        // alerts, never a lookup per row.
        var names = rows.Count == 0
            ? new Dictionary<Guid, string>()
            : await customers.GetOrganizationNamesAsync(rows.Select(a => a.OrganizationId).Distinct().ToList(), ct);
        var deviceIds = rows.Select(a => a.DeviceId).OfType<Guid>().Distinct().ToList();
        var machines = deviceIds.Count == 0
            ? new Dictionary<Guid, Guid?>()
            : await db.Devices.AsNoTracking().Where(d => deviceIds.Contains(d.Id)).ToDictionaryAsync(d => d.Id, d => d.MachineId, ct);
        var now = time.GetUtcNow();
        var hiders = rows.Where(a => a.IsHidden(now)).Select(a => a.Hold?.By).OfType<Guid>().Distinct().ToList();
        var people = hiders.Count == 0 ? new Dictionary<Guid, UserSummary>() : await users.GetUsersAsync(hiders, ct);
        return rows.Select(a => new AlertListItem(
            a.Id, a.OrganizationId, names.GetValueOrDefault(a.OrganizationId), a.System, a.Kind, a.ExternalId, a.Severity, a.State, a.Title,
            a.DeviceName, a.DeviceId, a.CreatedAtSource, a.LastSeenAt, a.ResolvedAt, a.Url,
            a.IsHidden(now) && a.Hold is { Until: { } until } hold
                ? new AlertHoldItem(until, hold.Reason, hold.By is { } by ? people.GetValueOrDefault(by)?.DisplayName : null, hold.At)
                : null,
            Rule: a.Rule, Facts: CoverageGaps.ReadFacts(a.Facts),
            MachineId: a.DeviceId is { } device ? machines.GetValueOrDefault(device) : null,
            SourceClosedAt: a.SourceClosedAt)).ToList();
    }
}

/// <summary>
/// The two orders of an alert list (M38) with their keyset continuations, which mirror the order exactly. Open: severity rank (an
/// enum stored as text sorts by a CASE rank, not by its spelling), then the source's time, then the id, all ascending. Resolved:
/// the time it was resolved, then the id, both descending.
/// </summary>
internal static class AlertOrder
{
    public static IQueryable<Alert> Open(IQueryable<Alert> alerts, KeysetCursor? after)
    {
        if (after is not null && TryRead(after, resolved: false, out var key))
        {
            var (rank, created) = (key.Rank, key.At);
            alerts = alerts.Where(a =>
                (a.Severity == AlertSeverity.Critical ? 0 : a.Severity == AlertSeverity.Warning ? 1 : 2) > rank ||
                ((a.Severity == AlertSeverity.Critical ? 0 : a.Severity == AlertSeverity.Warning ? 1 : 2) == rank &&
                 (a.CreatedAtSource > created || (a.CreatedAtSource == created && a.Id.CompareTo(after.Id) > 0))));
        }

        return alerts
            .OrderBy(a => a.Severity == AlertSeverity.Critical ? 0 : a.Severity == AlertSeverity.Warning ? 1 : 2)
            .ThenBy(a => a.CreatedAtSource).ThenBy(a => a.Id);
    }

    /// <summary>A resolved alert always has its time; an older row without one falls back to the source's time.</summary>
    public static IQueryable<Alert> Resolved(IQueryable<Alert> alerts, KeysetCursor? after)
    {
        if (after is not null && TryRead(after, resolved: true, out var key))
        {
            var at = key.At;
            alerts = alerts.Where(a => (a.ResolvedAt ?? a.CreatedAtSource) < at ||
                ((a.ResolvedAt ?? a.CreatedAtSource) == at && a.Id.CompareTo(after.Id) < 0));
        }

        return alerts.OrderByDescending(a => a.ResolvedAt ?? a.CreatedAtSource).ThenByDescending(a => a.Id);
    }

    public static KeysetCursor Cursor(Alert last, bool resolved) => resolved
        ? new KeysetCursor((last.ResolvedAt ?? last.CreatedAtSource).ToString("O", CultureInfo.InvariantCulture), last.Id)
        : new KeysetCursor(Rank(last.Severity).ToString(CultureInfo.InvariantCulture), last.Id,
            last.CreatedAtSource.ToString("O", CultureInfo.InvariantCulture));

    /// <summary>Reads a cursor of one order; a cursor of the other order, or of another list, does not read.</summary>
    public static bool TryRead(KeysetCursor cursor, bool resolved, out (int Rank, DateTimeOffset At) key)
    {
        key = default;
        if (resolved)
        {
            if (cursor.Then is not null || !Time(cursor.SortKey, out var at))
            {
                return false;
            }

            key = (0, at);
            return true;
        }

        if (cursor.SortKey is not ("0" or "1" or "2") || !Time(cursor.Then, out var created))
        {
            return false;
        }

        key = (cursor.SortKey[0] - '0', created);
        return true;
    }

    private static int Rank(AlertSeverity severity) => severity switch
    {
        AlertSeverity.Critical => 0,
        AlertSeverity.Warning => 1,
        _ => 2,
    };

    private static bool Time(string? value, out DateTimeOffset at) =>
        DateTimeOffset.TryParseExact(value, "O", CultureInfo.InvariantCulture, DateTimeStyles.None, out at);
}
