using System.Globalization;
using Crm.Backup.Contracts;
using Crm.Backup.Domain;
using Crm.Backup.Persistence;
using Crm.Service.Contracts;
using Microsoft.EntityFrameworkCore;

namespace Crm.Backup.Features;

/// <summary>
/// What the backup rules share (M42): the stored backups of the organizations a complete CloudAlly read covered, each entity with
/// its state at the check's time. A rule finds one gap per task (a service of an account) or per customer, never one per mailbox,
/// so a tenant whose consent lapsed is one alert per service, not one per user; the tab names the users.
/// </summary>
internal abstract class BackupRule(BackupDbContext db) : ICoverageRule
{
    public abstract string Code { get; }

    public string System => BackupSources.CloudAlly;

    public AlertKind Kind => AlertKind.Backup;

    public virtual CoverageThreshold? Threshold => null;

    public abstract Task<IReadOnlyList<CoverageFinding>> FindAsync(CoverageCheck check, CancellationToken cancellationToken);

    /// <summary>The tasks of the covered organizations with their entities' states, late after <paramref name="lateAfter"/>.</summary>
    protected async Task<IReadOnlyList<CheckedTask>> TasksAsync(CoverageCheck check, TimeSpan lateAfter, CancellationToken ct)
    {
        var organizations = check.Organizations.Distinct().ToList();
        if (organizations.Count == 0)
        {
            return [];
        }

        var accounts = await db.Accounts.AsNoTracking().Include(a => a.Tasks).ThenInclude(t => t.Entities)
            .Where(a => a.System == BackupSources.CloudAlly && organizations.Contains(a.OrganizationId))
            .OrderBy(a => a.Id)
            .AsSplitQuery()
            .ToListAsync(ct);
        return accounts.SelectMany(a => a.Tasks.OrderBy(t => t.Id).Select(t => new CheckedTask(a, t,
                t.Entities.Select(e => BackupStates.Of(t.Status, BackupEntityFacts.Of(e), check.Now, lateAfter)).ToList())))
            .ToList();
    }

    protected static Dictionary<string, string> Facts(CheckedTask task, params (string Key, string Value)[] more)
    {
        var facts = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["service"] = task.Task.Service.ToString(),
            ["account"] = task.Account.Name,
            ["total"] = Number(task.Watched),
        };
        foreach (var (key, value) in more)
        {
            facts[key] = value;
        }

        return facts;
    }

    protected static string Number(int value) => value.ToString(CultureInfo.InvariantCulture);

    protected static string Time(DateTimeOffset value) => value.ToString("O", CultureInfo.InvariantCulture);

    /// <summary>One task with the states of its entities.</summary>
    protected sealed record CheckedTask(BackupAccount Account, BackupTask Task, IReadOnlyList<BackupEntityState> States)
    {
        /// <summary>The entities the task backs up: neither waiting to be added nor another task's.</summary>
        public int Watched => States.Count(s => s is not (BackupEntityState.NotInBackup or BackupEntityState.Aside));

        public int Count(BackupEntityState state) => States.Count(s => s == state);
    }
}

/// <summary>
/// A backup that failed (M42): the last attempt of one or more of a task's entities is later than its last success, or CloudAlly
/// reported an error. Critical when every entity the task backs up failed (the whole service is not backed up), else a warning.
/// </summary>
internal sealed class BackupFailedRule(BackupDbContext db) : BackupRule(db)
{
    public const string RuleCode = "cloudally.backup-failed";

    public override string Code => RuleCode;

    public override async Task<IReadOnlyList<CoverageFinding>> FindAsync(CoverageCheck check, CancellationToken cancellationToken) =>
        (await TasksAsync(check, TimeSpan.FromHours(BackupStates.DefaultLateHours), cancellationToken))
            .Where(t => t.Count(BackupEntityState.Failed) > 0)
            .Select(t => new CoverageFinding(
                t.Task.Id.ToString("N"), t.Account.OrganizationId,
                t.Count(BackupEntityState.Failed) == t.Watched ? AlertSeverity.Critical : AlertSeverity.Warning,
                string.Create(CultureInfo.InvariantCulture,
                    $"The CloudAlly backup of {t.Task.Service} failed for {t.Count(BackupEntityState.Failed)} of {t.Watched} at {t.Account.Name}"),
                null, null, Facts(t, ("failed", Number(t.Count(BackupEntityState.Failed))))))
            .ToList();
}

/// <summary>
/// A backup older than the limit (M42, 26 hours unless a person sets another): entities whose last successful backup is older,
/// or that were never backed up since the CRM first saw them that long ago, while nothing reports a failure — the backup did not
/// run. Failures are the other rule's, so one cause is one alert. Critical when every entity of the task is late.
/// </summary>
internal sealed class BackupLateRule(BackupDbContext db) : BackupRule(db)
{
    public const string RuleCode = "cloudally.backup-late";

    public override string Code => RuleCode;

    public override CoverageThreshold? Threshold { get; } = new(BackupStates.DefaultLateHours, 2, 168, CoverageUnit.Hours);

    public override async Task<IReadOnlyList<CoverageFinding>> FindAsync(CoverageCheck check, CancellationToken cancellationToken)
    {
        var hours = check.Threshold ?? Threshold!.Default;
        return (await TasksAsync(check, TimeSpan.FromHours(hours), cancellationToken))
            .Where(t => t.Count(BackupEntityState.Late) > 0)
            .Select(t => new CoverageFinding(
                t.Task.Id.ToString("N"), t.Account.OrganizationId,
                t.Count(BackupEntityState.Late) == t.Watched ? AlertSeverity.Critical : AlertSeverity.Warning,
                string.Create(CultureInfo.InvariantCulture,
                    $"The CloudAlly backup of {t.Task.Service} is older than {hours} hours for {t.Count(BackupEntityState.Late)} of {t.Watched} at {t.Account.Name}"),
                null, null,
                Facts(t, ("late", Number(t.Count(BackupEntityState.Late))), ("hours", Number(hours)),
                    ("lastBackupAt", t.Task.LastBackupAt is { } last ? Time(last) : string.Empty))))
            .ToList();
    }
}

/// <summary>
/// A paused backup (M42): the task is paused at CloudAlly, or some of its entities are; nothing of them is backed up until someone
/// activates it again. A warning: a pause is somebody's decision, but one that is easy to forget.
/// </summary>
internal sealed class BackupPausedRule(BackupDbContext db) : BackupRule(db)
{
    public const string RuleCode = "cloudally.backup-paused";

    public override string Code => RuleCode;

    public override async Task<IReadOnlyList<CoverageFinding>> FindAsync(CoverageCheck check, CancellationToken cancellationToken) =>
        (await TasksAsync(check, TimeSpan.FromHours(BackupStates.DefaultLateHours), cancellationToken))
            .Where(t => t.Task.IsPaused || t.Count(BackupEntityState.Paused) > 0)
            .Select(t => new CoverageFinding(
                t.Task.Id.ToString("N"), t.Account.OrganizationId, AlertSeverity.Warning,
                t.Task.IsPaused
                    ? $"The CloudAlly backup of {t.Task.Service} is paused at {t.Account.Name}"
                    : string.Create(CultureInfo.InvariantCulture,
                        $"The CloudAlly backup of {t.Task.Service} is paused for {t.Count(BackupEntityState.Paused)} of {t.Watched} at {t.Account.Name}"),
                null, null,
                Facts(t, ("paused", Number(t.Count(BackupEntityState.Paused))), ("whole", t.Task.IsPaused ? "true" : "false"))))
            .ToList();
}

/// <summary>
/// Licensed users without a backup (M42): more of a customer's users hold a Microsoft 365 licence with a mailbox (Partner Center's
/// reading in the Licensing module) than mailboxes are in the customer's mail backup. A customer without a licence reading is
/// checked by CloudAlly's own mark on each mailbox instead — mailboxes it marks as licensed that are not in the backup — so an
/// installation without Partner Center still hears of a licensed user nobody added. One warning per customer, with the counts and,
/// for CloudAlly's count, <c>by</c>. A customer with neither is not checked — there is nothing to compare — and the backup tab says
/// so; it is never a clean check of something nobody read.
/// </summary>
internal sealed class LicensedUserNotBackedUpRule(BackupDbContext db, LicensedUsers licences) : BackupRule(db)
{
    public const string RuleCode = "cloudally.user-not-backed-up";

    /// <summary>The <c>by</c> fact of a gap CloudAlly's marks counted; a gap of Partner Center's count has none.</summary>
    public const string ByCloudAlly = "cloudally";

    public override string Code => RuleCode;

    public override async Task<IReadOnlyList<CoverageFinding>> FindAsync(CoverageCheck check, CancellationToken cancellationToken)
    {
        var organizations = check.Organizations.Distinct().ToList();
        var counts = await licences.CountAsync(organizations, cancellationToken);
        var marked = await licences.MarkedAsync(organizations.Where(o => !counts.ContainsKey(o)).ToList(), cancellationToken);
        var byPartnerCenter = counts.Where(c => c.Value.Missing > 0)
            .Select(c => new CoverageFinding(
                c.Key.ToString("N"), c.Key, AlertSeverity.Warning,
                string.Create(CultureInfo.InvariantCulture,
                    $"{c.Value.Missing} licensed Microsoft 365 users have no mailbox backup ({c.Value.Licensed} licensed, {c.Value.BackedUp} in backup)"),
                null, null,
                new Dictionary<string, string>(StringComparer.Ordinal)
                {
                    ["licensed"] = Number(c.Value.Licensed),
                    ["backedUp"] = Number(c.Value.BackedUp),
                    ["missing"] = Number(c.Value.Missing),
                    ["readOn"] = c.Value.ReadOn.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
                }));
        var byCloudAlly = marked.Where(m => m.Value.Missing > 0)
            .Select(m => new CoverageFinding(
                m.Key.ToString("N"), m.Key, AlertSeverity.Warning,
                string.Create(CultureInfo.InvariantCulture,
                    $"{m.Value.Missing} mailboxes CloudAlly marks as licensed are not in the backup ({m.Value.Licensed} licensed, {m.Value.BackedUp} in backup)"),
                null, null,
                new Dictionary<string, string>(StringComparer.Ordinal)
                {
                    ["licensed"] = Number(m.Value.Licensed),
                    ["backedUp"] = Number(m.Value.BackedUp),
                    ["missing"] = Number(m.Value.Missing),
                    ["by"] = ByCloudAlly,
                }));
        return byPartnerCenter.Concat(byCloudAlly).OrderBy(f => f.OrganizationId).ToList();
    }
}
