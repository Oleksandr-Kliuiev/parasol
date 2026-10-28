using Crm.Backup.Contracts;
using Crm.Backup.Domain;
using Crm.Backup.Persistence;
using Crm.Service.Contracts;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Operations;
using Crm.SharedKernel.Results;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Crm.Backup.Features;

/// <summary>When the source was last read for the tab: never (null), part-way, or completely, and whether the next read is overdue.</summary>
public sealed record BackupRead(string System, DateTimeOffset? StartedAt, bool Complete, bool Late);

/// <summary>A backup account of the customer; <paramref name="OutsideRegion"/> marks one stored outside the expected data center (EU).</summary>
public sealed record BackupAccountItem(Guid Id, string ExternalId, string Name, string? Email, string? Status, string? Region, bool OutsideRegion, int Tasks);

/// <summary>One service of the customer's backups with its entities counted by state, and the newest and oldest last backups.</summary>
public sealed record BackupServiceItem(
    BackupService Service, int Total, int Ok, int Failed, int Late, int Paused, int NotInBackup, int Waiting,
    DateTimeOffset? NewestBackupAt, DateTimeOffset? OldestBackupAt);

public sealed record BackupTaskItem(
    Guid Id, string ExternalId, string AccountExternalId, string AccountName, BackupService Service, string Source, string? Alias, string? Status,
    bool Paused, bool Running, DateTimeOffset? LastBackupAt, string? NextBackup, int Entities, int Problems);

/// <summary>
/// The check of licensed users (M42). <paramref name="State"/> Checked: <paramref name="Licensed"/> users hold a licence with a
/// mailbox (Partner Center), <paramref name="BackedUp"/> mailboxes are in backup; Marked: Partner Center has no licence reading of the
/// customer, and CloudAlly marks <paramref name="Licensed"/> of its mailboxes as licensed, <paramref name="BackedUp"/> of them in
/// backup; NoData: neither, so nothing is said about who is missing.
/// </summary>
public sealed record BackupLicenceCheck(string State, int? Licensed, int BackedUp, int? Missing, DateOnly? ReadOn);

/// <summary>A customer's backups for the Sikkerhetskopi tab (M42): the read, the accounts, each service's counts, the tasks, the licence check.</summary>
public sealed record BackupOverview(
    Guid OrganizationId, BackupRead Read, int LateAfterHours, IReadOnlyList<BackupAccountItem> Accounts, IReadOnlyList<BackupServiceItem> Services,
    IReadOnlyList<BackupTaskItem> Tasks, BackupLicenceCheck Licences);

/// <summary>One mailbox, OneDrive, site or team of the customer with its state; the error is the source's short words.</summary>
public sealed record BackupEntityItem(
    Guid Id, string ExternalId, string TaskExternalId, string AccountExternalId, BackupService Service, string Name, string? FullName,
    BackupEntityState State, string? Status, bool Running, DateTimeOffset? LastBackupAt, DateTimeOffset? LastAttemptAt, string? Error,
    string? ErrorLink, string? Licensing);

/// <summary>
/// The reads of the Sikkerhetskopi tab (M42), from the saved copy only. States are worked out in SQL with the same rules as
/// <see cref="BackupStates.Of"/>, late by the limit of the coverage rule in force, so the tab and the alerts never disagree.
/// </summary>
internal sealed class BackupQueries(
    BackupDbContext db, ICoverageLimits limits, IEnumerable<ISyncCompletenessSource> completeness, LicensedUsers licences,
    IOptions<BackupOptions> options, TimeProvider time)
{
    public const int DefaultLimit = 50;
    public const int MaxLimit = 100;

    public async Task<BackupOverview> OverviewAsync(Guid organizationId, CancellationToken ct)
    {
        var lateHours = await LateHoursAsync(ct);
        var now = time.GetUtcNow();
        var accounts = (await db.Accounts.AsNoTracking().Where(a => a.OrganizationId == organizationId && a.System == BackupSources.CloudAlly)
            .OrderBy(a => a.Name).ThenBy(a => a.Id)
            .Select(a => new { a.Id, a.ExternalId, a.Name, a.Email, a.Status, a.Region, Tasks = a.Tasks.Count })
            .ToListAsync(ct))
            .Select(a => new BackupAccountItem(a.Id, a.ExternalId, a.Name, a.Email, a.Status, a.Region, options.Value.IsOutside(a.Region), a.Tasks))
            .ToList();
        var states = Rows(organizationId, now, TimeSpan.FromHours(lateHours));
        var byService = await states.GroupBy(r => new { r.Service, r.Rank })
            .Select(g => new { g.Key.Service, g.Key.Rank, Count = g.Count(), Newest = g.Max(r => r.LastBackupAt), Oldest = g.Min(r => r.LastBackupAt) })
            .ToListAsync(ct);
        var services = byService.GroupBy(r => r.Service).OrderBy(g => g.Key).Select(g =>
        {
            int Of(BackupEntityState state) => g.Where(r => r.Rank == (int)state).Sum(r => r.Count);
            var watched = g.Where(r => r.Rank is not ((int)BackupEntityState.NotInBackup or (int)BackupEntityState.Aside)).ToList();
            return new BackupServiceItem(g.Key, watched.Sum(r => r.Count), Of(BackupEntityState.Ok), Of(BackupEntityState.Failed), Of(BackupEntityState.Late),
                Of(BackupEntityState.Paused), Of(BackupEntityState.NotInBackup), Of(BackupEntityState.Waiting),
                watched.Max(r => r.Newest), watched.Min(r => r.Oldest));
        }).ToList();
        var problems = await states.Where(r => r.Rank <= (int)BackupEntityState.NotInBackup)
            .GroupBy(r => r.TaskId).Select(g => new { TaskId = g.Key, Count = g.Count() })
            .ToDictionaryAsync(g => g.TaskId, g => g.Count, ct);
        var tasks = await (from t in db.Tasks.AsNoTracking()
                           join a in db.Accounts.AsNoTracking() on t.AccountId equals a.Id
                           where a.OrganizationId == organizationId && a.System == BackupSources.CloudAlly
                           orderby t.Service, a.Name, t.Id
                           select new { t, a.ExternalId, a.Name, Entities = t.Entities.Count })
            .ToListAsync(ct);
        var taskItems = tasks.Select(x => new BackupTaskItem(
            x.t.Id, x.t.ExternalId, x.ExternalId, x.Name, x.t.Service, x.t.Source, x.t.Alias, x.t.Status, x.t.IsPaused, x.t.Running, x.t.LastBackupAt,
            x.t.NextBackup, x.Entities, problems.GetValueOrDefault(x.t.Id))).ToList();
        return new BackupOverview(organizationId, await ReadAsync(ct), lateHours, accounts, services, taskItems,
            accounts.Count == 0 ? new BackupLicenceCheck("NoAccount", null, 0, null, null) : await LicencesAsync(organizationId, ct));
    }

    /// <summary>
    /// A page of the customer's entities: the ones that need someone first (failed, late, paused, not backed up), then by name and id.
    /// <paramref name="state"/> "problems" keeps only those; a state's name keeps that state.
    /// </summary>
    public async Task<Result<PagedResult<BackupEntityItem>>> EntitiesAsync(
        Guid organizationId, BackupService? service, string? state, string? search, string? cursor, int? limit, CancellationToken ct)
    {
        if (service is { } s && !Enum.IsDefined(s))
        {
            return Error.Validation("BKP_FILTER_INVALID", "Unknown service.");
        }

        BackupEntityState? only = null;
        if (state is not (null or "" or "all" or "problems"))
        {
            if (!Enum.TryParse<BackupEntityState>(state, ignoreCase: true, out var parsed) || !Enum.IsDefined(parsed))
            {
                return Error.Validation("BKP_FILTER_INVALID", "Unknown state.");
            }

            only = parsed;
        }

        var after = KeysetCursor.Decode(cursor);
        if (cursor is not null && (after is null || !int.TryParse(after.SortKey, out _) || after.Then is null))
        {
            return Error.Validation("BKP_CURSOR_INVALID", "The page does not belong to this list.");
        }

        var rows = Rows(organizationId, time.GetUtcNow(), TimeSpan.FromHours(await LateHoursAsync(ct)));
        if (service is { } wanted)
        {
            rows = rows.Where(r => r.Service == wanted);
        }

        if (only is { } exact)
        {
            rows = rows.Where(r => r.Rank == (int)exact);
        }
        else if (state == "problems")
        {
            rows = rows.Where(r => r.Rank <= (int)BackupEntityState.NotInBackup);
        }

        if (search?.Trim() is { Length: > 0 } term)
        {
            rows = rows.Where(r => r.Name.Contains(term) || (r.FullName != null && r.FullName.Contains(term)));
        }

        var total = await rows.CountAsync(ct);
        if (after is not null)
        {
            var rank = int.Parse(after.SortKey, System.Globalization.CultureInfo.InvariantCulture);
            var name = after.Then!;
            rows = rows.Where(r => r.Rank > rank || (r.Rank == rank && (r.Name.CompareTo(name) > 0 || (r.Name == name && r.Id.CompareTo(after.Id) > 0))));
        }

        var take = Math.Clamp(limit ?? DefaultLimit, 1, MaxLimit);
        var page = await rows.OrderBy(r => r.Rank).ThenBy(r => r.Name).ThenBy(r => r.Id).Take(take + 1).ToListAsync(ct);
        var items = page.Take(take).Select(r => new BackupEntityItem(
            r.Id, r.ExternalId, r.TaskExternalId, r.AccountExternalId, r.Service, r.Name, r.FullName, (BackupEntityState)r.Rank, r.Status, r.Running,
            r.LastBackupAt, r.LastAttemptAt, r.Error, r.ErrorLink, r.Licensing)).ToList();
        var next = page.Count > take
            ? new KeysetCursor(page[take - 1].Rank.ToString(System.Globalization.CultureInfo.InvariantCulture), page[take - 1].Id, page[take - 1].Name).Encode()
            : null;
        return new PagedResult<BackupEntityItem>(items, next, total);
    }

    private async Task<int> LateHoursAsync(CancellationToken ct) =>
        await limits.LimitAsync(BackupLateRule.RuleCode, ct) ?? BackupStates.DefaultLateHours;

    private async Task<BackupRead> ReadAsync(CancellationToken ct)
    {
        foreach (var source in completeness)
        {
            if (await source.LatestAsync(BackupSources.CloudAlly, BackupSources.CloudAllyBackupsJob, ct) is { } latest)
            {
                return new BackupRead(BackupSources.CloudAlly, latest.StartedAt, latest.Complete, latest.Late);
            }
        }

        return new BackupRead(BackupSources.CloudAlly, null, false, false);
    }

    private async Task<BackupLicenceCheck> LicencesAsync(Guid organizationId, CancellationToken ct)
    {
        var counts = await licences.CountAsync([organizationId], ct);
        if (counts.TryGetValue(organizationId, out var count))
        {
            return new BackupLicenceCheck("Checked", count.Licensed, count.BackedUp, count.Missing, count.ReadOn);
        }

        // Without Partner Center, CloudAlly's own mark on each mailbox: the same count the coverage rule takes.
        var marked = await licences.MarkedAsync([organizationId], ct);
        return marked.TryGetValue(organizationId, out var mark)
            ? new BackupLicenceCheck("Marked", mark.Licensed, mark.BackedUp, mark.Missing, null)
            : new BackupLicenceCheck("NoData", null, 0, null, null);
    }

    /// <summary>
    /// The organization's entities with their state as a rank in SQL — the order of <see cref="BackupEntityState"/>, the same tests in
    /// the same order as <see cref="BackupStates.Of"/> (a unit of the SQL tests holds the two together).
    /// </summary>
    private IQueryable<EntityRow> Rows(Guid organizationId, DateTimeOffset now, TimeSpan lateAfter)
    {
        var lateBefore = now - lateAfter;
        var tolerance = BackupStates.AttemptTolerance.TotalSeconds;
        return from e in db.Entities.AsNoTracking()
               join t in db.Tasks.AsNoTracking() on e.TaskId equals t.Id
               join a in db.Accounts.AsNoTracking() on t.AccountId equals a.Id
               where a.OrganizationId == organizationId && a.System == BackupSources.CloudAlly
               select new EntityRow
               {
                   Id = e.Id,
                   TaskId = t.Id,
                   ExternalId = e.ExternalId,
                   TaskExternalId = t.ExternalId,
                   AccountExternalId = a.ExternalId,
                   Service = t.Service,
                   Name = e.Name,
                   FullName = e.FullName,
                   Status = e.Status,
                   Running = e.Running,
                   LastBackupAt = e.LastBackupAt,
                   LastAttemptAt = e.LastAttemptAt,
                   Error = e.Error,
                   ErrorLink = e.ErrorLink,
                   Licensing = e.Licensing,
                   Rank = e.Status == "IN_ANOTHER" || e.Status == "ARCHIVED" || e.Status == "SKIPPED" || e.Status == "ON_PREMISE" ? (int)BackupEntityState.Aside
                       : e.Status == "NOTACTIVE" ? (int)BackupEntityState.NotInBackup
                       : t.Status == "PAUSED" || e.Status == "PAUSED" ? (int)BackupEntityState.Paused
                       : e.Error != null || (!e.Running && e.LastAttemptAt != null && (e.LastBackupAt == null || e.LastAttemptAt > e.LastBackupAt.Value.AddSeconds(tolerance)))
                           ? (int)BackupEntityState.Failed
                       : e.LastBackupAt == null ? (e.FirstSeenAt < lateBefore ? (int)BackupEntityState.Late : (int)BackupEntityState.Waiting)
                       : e.LastBackupAt < lateBefore ? (int)BackupEntityState.Late
                       : (int)BackupEntityState.Ok,
               };
    }

    private sealed class EntityRow
    {
        public Guid Id { get; init; }
        public Guid TaskId { get; init; }
        public string ExternalId { get; init; } = string.Empty;
        public string TaskExternalId { get; init; } = string.Empty;
        public string AccountExternalId { get; init; } = string.Empty;
        public BackupService Service { get; init; }
        public string Name { get; init; } = string.Empty;
        public string? FullName { get; init; }
        public string? Status { get; init; }
        public bool Running { get; init; }
        public DateTimeOffset? LastBackupAt { get; init; }
        public DateTimeOffset? LastAttemptAt { get; init; }
        public string? Error { get; init; }
        public string? ErrorLink { get; init; }
        public string? Licensing { get; init; }
        public int Rank { get; init; }
    }
}
