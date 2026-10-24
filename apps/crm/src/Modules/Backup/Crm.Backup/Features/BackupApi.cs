using Crm.Backup.Contracts;
using Crm.Backup.Domain;
using Crm.Backup.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crm.Backup.Features;

/// <summary>
/// The backup module's public API (M42): stores what the integrations read of the customers' backups and answers the previews of
/// actions from the saved copy. Writes of one source wait for each other (an app lock per source in the transaction), and every
/// write is one unit of work that SQL Server's retry strategy repeats as a whole.
/// </summary>
internal sealed class BackupApi(BackupDbContext db, TimeProvider time) : IBackupApi
{
    public async Task<BackupSnapshotResult> ApplySnapshotAsync(BackupSnapshot snapshot, CancellationToken cancellationToken)
    {
        if (!snapshot.IsComplete || snapshot.Organizations.Count == 0)
        {
            return new BackupSnapshotResult(0, 0, 0, 0);
        }

        return await LockedAsync(snapshot.System, async ct =>
        {
            var now = time.GetUtcNow();
            var organizations = snapshot.Organizations.Keys.ToList();
            // An account is the source's: listed under one organization at a time, the first one when a read names it twice.
            var listed = snapshot.Organizations
                .SelectMany(o => o.Value.Select(account => (Organization: o.Key, Account: account)))
                .DistinctBy(x => x.Account.ExternalId, StringComparer.Ordinal)
                .ToList();
            var listedIds = listed.Select(x => x.Account.ExternalId).ToList();
            var stored = await db.Accounts.Include(a => a.Tasks).ThenInclude(t => t.Entities)
                .Where(a => a.System == snapshot.System && (organizations.Contains(a.OrganizationId) || listedIds.Contains(a.ExternalId)))
                .AsSplitQuery()
                .ToListAsync(ct);
            var byId = stored.ToDictionary(a => a.ExternalId, StringComparer.Ordinal);
            int tasks = 0, entities = 0, removed = 0;
            foreach (var (organizationId, source) in listed)
            {
                if (byId.TryGetValue(source.ExternalId, out var account))
                {
                    account.Apply(organizationId, source, now);
                }
                else
                {
                    account = BackupAccount.From(snapshot.System, organizationId, source, now);
                    db.Accounts.Add(account);
                    byId[source.ExternalId] = account;
                }

                (var t, var e, var r) = MergeTasks(account, source.Tasks, now);
                tasks += t;
                entities += e;
                removed += r;
            }

            // The covered organizations' accounts the read no longer lists are forgotten with their tasks and entities.
            var listedSet = listedIds.ToHashSet(StringComparer.Ordinal);
            foreach (var gone in stored.Where(a => !listedSet.Contains(a.ExternalId)))
            {
                db.Accounts.Remove(gone);
                removed++;
            }

            return new BackupSnapshotResult(listed.Count, tasks, entities, removed);
        }, cancellationToken);
    }

    public async Task ApplyTaskAsync(string system, ExternalBackupTask task, CancellationToken cancellationToken) =>
        await LockedAsync(system, async ct =>
        {
            var stored = await db.Tasks.Include(t => t.Entities)
                .Where(t => t.ExternalId == task.ExternalId && db.Accounts.Any(a => a.Id == t.AccountId && a.System == system))
                .SingleOrDefaultAsync(ct);
            if (stored is null)
            {
                return 0;
            }

            var now = time.GetUtcNow();
            stored.Apply(task, now);
            foreach (var source in task.Entities.DistinctBy(e => e.ExternalId, StringComparer.Ordinal))
            {
                if (stored.Entities.FirstOrDefault(e => e.ExternalId == source.ExternalId) is { } entity)
                {
                    entity.ApplyLive(source, now);
                }
                else
                {
                    db.Entities.Add(BackupEntity.From(stored.Id, source, now));
                }
            }

            return 1;
        }, cancellationToken);

    public async Task<int> ApplyBillsAsync(string system, DateOnly day, IReadOnlyCollection<ExternalBackupBillLine> lines, CancellationToken cancellationToken) =>
        await LockedAsync(system, async ct =>
        {
            var now = time.GetUtcNow();
            var accounts = lines.Select(l => l.AccountExternalId).Distinct(StringComparer.Ordinal).ToList();
            var stored = await db.BillLines.Where(b => b.System == system && b.Day == day && accounts.Contains(b.AccountExternalId)).ToListAsync(ct);
            var byKey = stored.ToDictionary(b => b.LineKey, StringComparer.Ordinal);
            var keys = new HashSet<string>(StringComparer.Ordinal);
            foreach (var line in lines)
            {
                var key = BackupBillLine.KeyOf(system, day, line);
                if (!keys.Add(key))
                {
                    continue;
                }

                if (byKey.TryGetValue(key, out var bill))
                {
                    bill.Apply(line, now);
                }
                else
                {
                    db.BillLines.Add(BackupBillLine.From(system, day, line, now));
                }
            }

            // A line of the day the new read no longer has (a service the account dropped) goes; other days are history.
            db.BillLines.RemoveRange(stored.Where(b => !keys.Contains(b.LineKey)));
            return keys.Count;
        }, cancellationToken);

    public async Task<IReadOnlyDictionary<Guid, SeatCountReading>> GetSeatCountReadingsAsync(
        string system, IReadOnlyCollection<Guid> organizationIds, DateOnly date, CancellationToken cancellationToken)
    {
        if (organizationIds.Count == 0)
        {
            return new Dictionary<Guid, SeatCountReading>();
        }

        var ids = organizationIds.Distinct().Select(id => (Guid?)id).ToList();
        var latest = await db.BillLines.AsNoTracking()
            .Where(b => b.System == system && ids.Contains(b.OrganizationId) && b.Day <= date)
            .GroupBy(b => b.OrganizationId)
            .Select(g => new { OrganizationId = g.Key!.Value, Day = g.Max(b => b.Day) })
            .ToListAsync(cancellationToken);
        var days = latest.Select(l => l.Day).Distinct().ToList();
        var lines = await db.BillLines.AsNoTracking()
            .Where(b => b.System == system && ids.Contains(b.OrganizationId) && days.Contains(b.Day))
            .Select(b => new { OrganizationId = b.OrganizationId!.Value, b.Day, b.AccountExternalId, b.Seats, b.Accounts })
            .ToListAsync(cancellationToken);
        return latest.ToDictionary(l => l.OrganizationId, l =>
        {
            var accounts = lines.Where(b => b.OrganizationId == l.OrganizationId && b.Day == l.Day)
                .GroupBy(b => b.AccountExternalId, StringComparer.Ordinal)
                .Select(g => g.Max(b => b.Seats ?? b.Accounts))
                .ToList();
            return new SeatCountReading(accounts.Any(seats => seats is null) ? null : accounts.Sum(seats => seats!.Value), l.Day, accounts.Count);
        });
    }

    public async Task<IReadOnlyList<BackupBillLineView>> GetBillLinesAsync(string system, Guid organizationId, DateOnly date, CancellationToken cancellationToken)
    {
        var day = await db.BillLines.AsNoTracking()
            .Where(b => b.System == system && b.OrganizationId == organizationId && b.Day <= date)
            .MaxAsync(b => (DateOnly?)b.Day, cancellationToken);
        return day is null
            ? []
            : await (from b in db.BillLines.AsNoTracking()
                     where b.System == system && b.OrganizationId == organizationId && b.Day == day
                     orderby b.AccountExternalId, b.Service, b.Source
                     select new BackupBillLineView(b.Day, b.AccountExternalId,
                         db.Accounts.Where(a => a.System == system && a.ExternalId == b.AccountExternalId).Select(a => a.Name).FirstOrDefault(),
                         b.Type, b.Source, b.Service, b.Accounts, b.Seats, b.Price, b.Total, b.Currency, b.PaymentType, b.NextPaymentAt))
                .ToListAsync(cancellationToken);
    }

    public async Task<IReadOnlyCollection<Guid>> GetOrganizationsAsync(string system, CancellationToken cancellationToken) =>
        await db.Accounts.AsNoTracking().Where(a => a.System == system).Select(a => a.OrganizationId).Distinct().ToListAsync(cancellationToken);

    public async Task<BackupAccountRef?> GetAccountAsync(string system, string externalId, CancellationToken cancellationToken) =>
        await db.Accounts.AsNoTracking().Where(a => a.System == system && a.ExternalId == externalId)
            .Select(a => new BackupAccountRef(a.Id, a.System, a.ExternalId, a.OrganizationId, a.Name, a.Email, a.Status, a.Region))
            .SingleOrDefaultAsync(cancellationToken);

    public async Task<BackupTaskRef?> GetTaskAsync(string system, string externalId, CancellationToken cancellationToken) =>
        await (from t in db.Tasks.AsNoTracking()
               join a in db.Accounts.AsNoTracking() on t.AccountId equals a.Id
               where a.System == system && t.ExternalId == externalId
               select new BackupTaskRef(t.Id, t.ExternalId, t.Service, t.Source, t.Alias, t.Status, t.Running, t.LastBackupAt, t.Entities.Count(e => e.Status != "NOTACTIVE"),
                   new BackupAccountRef(a.Id, a.System, a.ExternalId, a.OrganizationId, a.Name, a.Email, a.Status, a.Region)))
            .FirstOrDefaultAsync(cancellationToken);

    public async Task<BackupEntityRef?> GetEntityAsync(string system, string taskExternalId, string entityExternalId, CancellationToken cancellationToken) =>
        await (from e in db.Entities.AsNoTracking()
               join t in db.Tasks.AsNoTracking() on e.TaskId equals t.Id
               join a in db.Accounts.AsNoTracking() on t.AccountId equals a.Id
               where a.System == system && t.ExternalId == taskExternalId && e.ExternalId == entityExternalId
               select new BackupEntityRef(e.Id, e.ExternalId, e.Name, e.FullName, e.ExtId, e.Status, e.LastBackupAt, e.FirstSeenAt,
                   new BackupTaskRef(t.Id, t.ExternalId, t.Service, t.Source, t.Alias, t.Status, t.Running, t.LastBackupAt, t.Entities.Count(e => e.Status != "NOTACTIVE"),
                       new BackupAccountRef(a.Id, a.System, a.ExternalId, a.OrganizationId, a.Name, a.Email, a.Status, a.Region))))
            .FirstOrDefaultAsync(cancellationToken);

    /// <summary>Brings an account's stored tasks to what the read listed; returns the tasks and entities written and those forgotten.</summary>
    private (int Tasks, int Entities, int Removed) MergeTasks(BackupAccount account, IReadOnlyList<ExternalBackupTask> sources, DateTimeOffset now)
    {
        int entities = 0, removed = 0;
        var listed = sources.DistinctBy(t => t.ExternalId, StringComparer.Ordinal).ToList();
        foreach (var source in listed)
        {
            var task = account.Tasks.FirstOrDefault(t => t.ExternalId == source.ExternalId);
            if (task is null)
            {
                task = BackupTask.From(account.Id, source, now);
                account.Tasks.Add(task);
            }
            else
            {
                task.Apply(source, now);
            }

            var entityIds = new HashSet<string>(StringComparer.Ordinal);
            foreach (var entitySource in source.Entities)
            {
                if (!entityIds.Add(entitySource.ExternalId))
                {
                    continue;
                }

                if (task.Entities.FirstOrDefault(e => e.ExternalId == entitySource.ExternalId) is { } entity)
                {
                    entity.Apply(entitySource, now);
                }
                else
                {
                    task.Entities.Add(BackupEntity.From(task.Id, entitySource, now));
                }

                entities++;
            }

            foreach (var gone in task.Entities.Where(e => !entityIds.Contains(e.ExternalId)).ToList())
            {
                task.Entities.Remove(gone);
                db.Entities.Remove(gone);
                removed++;
            }
        }

        var taskIds = listed.Select(t => t.ExternalId).ToHashSet(StringComparer.Ordinal);
        foreach (var gone in account.Tasks.Where(t => !taskIds.Contains(t.ExternalId)).ToList())
        {
            account.Tasks.Remove(gone);
            db.Tasks.Remove(gone);
            removed++;
        }

        return (listed.Count, entities, removed);
    }

    /// <summary>
    /// One unit of work on one source's backups: reads, the lock and the writes land together, and the retry strategy repeats it from
    /// the database again.
    /// </summary>
    private async Task<T> LockedAsync<T>(string system, Func<CancellationToken, Task<T>> work, CancellationToken cancellationToken) =>
        await db.Database.CreateExecutionStrategy().ExecuteAsync(async ct =>
        {
            db.ChangeTracker.Clear();
            await using var transaction = await db.Database.BeginTransactionAsync(ct);
            var resource = "backup:" + system;
            await db.Database.ExecuteSqlInterpolatedAsync($"""
                DECLARE @r int; EXEC @r = sys.sp_getapplock @Resource={resource}, @LockMode=N'Exclusive', @LockOwner=N'Transaction', @LockTimeout=30000;
                IF @r < 0 THROW 51000, 'Another read of the backups is being stored.', 1;
                """, ct);
            var result = await work(ct);
            await db.SaveChangesAsync(ct);
            await transaction.CommitAsync(ct);
            return result;
        }, cancellationToken);
}
