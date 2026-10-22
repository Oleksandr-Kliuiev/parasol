using System.Globalization;
using System.Text.Json;
using Crm.Backup.Contracts;
using Crm.Integrations.Core;
using Crm.Integrations.Core.Persistence;
using Crm.Service.Contracts;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Crm.Integrations.CloudAlly;

/// <summary>The CloudAlly accounts linked to organizations, loaded once per run.</summary>
public sealed class CloudAllyLinkIndex(IntegrationDbContext db)
{
    public async Task<IReadOnlyDictionary<string, Guid>> AccountsAsync(CancellationToken ct) =>
        await db.ExternalLinks.AsNoTracking()
            .Where(l => l.System == CloudAllyTypes.System && l.ExternalType == CloudAllyTypes.Customer)
            .ToDictionaryAsync(l => l.ExternalId, l => l.EntityId, StringComparer.Ordinal, ct);
}

/// <summary>CloudAlly's answers turned into the backup module's records (M42).</summary>
internal static class CloudAllyBackupMapping
{
    /// <summary>
    /// One task with its entities, each joined to its status by task and name (the statuses carry no entity id). The status's last
    /// backup and last attempt are CloudAlly's own reading; without a status the entity's newest part backup stands, and nothing is
    /// said about an attempt.
    /// </summary>
    public static ExternalBackupTask Task(CaTask task, IReadOnlyDictionary<(string Task, string Name), CaEntityStatus> statuses) => new(
        task.Id,
        CloudAllyMapping.ServiceOf(task.Source),
        task.Source ?? "?",
        task.Alias,
        task.Status,
        Running(task.Progress),
        CloudAllyDates.Newest(task.LastBackupDates) ?? CloudAllyDates.Parse(task.SnapshotDate),
        Text(task.NextBackup),
        task.EntityCount,
        task.BilledEntities,
        task.Size,
        (task.Entities ?? []).Where(e => !string.IsNullOrWhiteSpace(e.Id)).Select(e =>
        {
            var name = string.IsNullOrWhiteSpace(e.Entity) ? e.Id : e.Entity.Trim();
            statuses.TryGetValue((task.Id, name.ToLowerInvariant()), out var status);
            var problem = status?.BackupStatus?.FirstOrDefault(s => !string.IsNullOrWhiteSpace(s.Error));
            return new ExternalBackupEntity(
                e.Id, name, e.FullName, e.ExtId, e.Status, Running(e.Progress),
                CloudAllyDates.Parse(status?.LastBackupDate) ?? CloudAllyDates.Newest(e.LastBackupDates),
                CloudAllyDates.Parse(status?.LastBackupAttemptDate),
                problem?.Error?.Trim(), problem?.ErrorLink, status?.MsLicensing, status?.Size);
        }).ToList());

    /// <summary>The statuses by task and lower-case name; a name reported twice (one row per part) keeps its oldest success and newest attempt.</summary>
    public static Dictionary<(string Task, string Name), CaEntityStatus> Index(IEnumerable<CaEntityStatus> statuses)
    {
        var index = new Dictionary<(string, string), CaEntityStatus>();
        foreach (var status in statuses.Where(s => !string.IsNullOrWhiteSpace(s.TaskId) && !string.IsNullOrWhiteSpace(s.EntityName)))
        {
            var key = (status.TaskId!, status.EntityName!.Trim().ToLowerInvariant());
            index[key] = index.TryGetValue(key, out var earlier) ? Merge(earlier, status) : status;
        }

        return index;
    }

    private static CaEntityStatus Merge(CaEntityStatus a, CaEntityStatus b)
    {
        var success = new[] { a.LastBackupDate, b.LastBackupDate }.OrderBy(d => CloudAllyDates.Parse(d) ?? DateTimeOffset.MinValue).First();
        var attempt = new[] { a.LastBackupAttemptDate, b.LastBackupAttemptDate }.OrderByDescending(d => CloudAllyDates.Parse(d) ?? DateTimeOffset.MinValue).First();
        return a with
        {
            LastBackupDate = success,
            LastBackupAttemptDate = attempt,
            BackupStatus = [.. a.BackupStatus ?? [], .. b.BackupStatus ?? []],
            Size = (a.Size ?? 0) + (b.Size ?? 0),
        };
    }

    /// <summary>A backup runs now: CloudAlly reports a progress with a state, and it was not cancelled.</summary>
    public static bool Running(CaProgress? progress) => progress?.State is { Length: > 0 } && progress.Cancelled != true;

    private static string? Text(JsonElement? value) => value switch
    {
        { ValueKind: JsonValueKind.String } text => text.GetString(),
        { ValueKind: JsonValueKind.Number } number => number.GetRawText(),
        _ => null,
    };
}

/// <summary>
/// The customers' backups (M42, <c>cloudally-backups</c>): every backup task of the linked accounts with its users and sites, joined to
/// CloudAlly's status of each, stored as one snapshot of the organizations the links cover. Every list is read to its end before
/// anything is stored; a page or a task that cannot be read fails the run and changes nothing. A complete read then lets the
/// coverage rules of backups check those organizations.
/// </summary>
public sealed class CloudAllyBackupSyncJob(
    ICloudAllyClient client,
    CloudAllyLinkIndex links,
    IBackupApi backups,
    ICoverageCheck coverage,
    SyncRunner runner,
    IOptions<CloudAllyOptions> options,
    ILogger<CloudAllyBackupSyncJob> logger)
{
    public const string JobId = BackupSources.CloudAllyBackupsJob;

    public async Task RunAsync(CancellationToken cancellationToken)
    {
        if (!options.Value.IsConfigured)
        {
            logger.LogInformation("CloudAlly backup sync skipped: integration not configured.");
            return;
        }

        await runner.RunAsync(CloudAllyTypes.System, JobId, async (progress, ct) =>
        {
            var linked = await links.AccountsAsync(ct);
            var accounts = new Dictionary<string, CaAccount>(StringComparer.Ordinal);
            await foreach (var account in client.GetAccountsAsync(ct))
            {
                accounts[account.Id] = account;
            }

            var tasks = new List<CaTask>();
            var unlinked = 0;
            await foreach (var task in client.GetTasksAsync(ct))
            {
                progress.Read++;
                if (!task.IsBackup || task.UserId is null)
                {
                    continue;
                }

                if (linked.ContainsKey(task.UserId))
                {
                    tasks.Add(task);
                }
                else
                {
                    unlinked++;
                }
            }

            var statuses = new List<CaEntityStatus>();
            await foreach (var status in client.GetStatusesAsync(ct))
            {
                if (status.UserId is { } user && linked.ContainsKey(user))
                {
                    statuses.Add(status);
                }
            }

            var index = CloudAllyBackupMapping.Index(statuses);
            var byAccount = new Dictionary<string, List<ExternalBackupTask>>(StringComparer.Ordinal);
            foreach (var task in tasks)
            {
                // The task's users and sites come with its own read only; a task gone in between is gone.
                if (await client.GetTaskAsync(task.UserId!, task.Id, ct) is not { } detail)
                {
                    continue;
                }

                byAccount.TryAdd(task.UserId!, []);
                byAccount[task.UserId!].Add(CloudAllyBackupMapping.Task(detail with { Source = detail.Source ?? task.Source, Status = detail.Status ?? task.Status }, index));
            }

            // Every linked organization is covered, so an account CloudAlly no longer lists is forgotten there too.
            var organizations = linked.Values.Distinct().ToDictionary(id => id, _ => new List<ExternalBackupAccount>());
            foreach (var (accountId, organizationId) in linked)
            {
                if (!accounts.TryGetValue(accountId, out var account))
                {
                    continue;
                }

                organizations[organizationId].Add(new ExternalBackupAccount(
                    account.Id, CloudAllyMapping.Name(account), account.Email, account.Status, account.Region, byAccount.GetValueOrDefault(account.Id) ?? []));
            }

            var result = await backups.ApplySnapshotAsync(new BackupSnapshot(
                CloudAllyTypes.System, organizations.ToDictionary(o => o.Key, o => (IReadOnlyList<ExternalBackupAccount>)o.Value), IsComplete: true), ct);
            progress.Changed = result.Entities;
            var gaps = await coverage.CheckAsync(CloudAllyTypes.System, organizations.Keys.ToList(), ct);
            progress.Message = string.Create(CultureInfo.InvariantCulture,
                $"accounts {result.Accounts} in {organizations.Count} organizations, tasks {result.Tasks}, users and sites {result.Entities}, forgotten {result.Removed}; "
                + $"skipped (account not linked) {unlinked}; coverage gaps {gaps.Found} found, {gaps.Opened} new, {gaps.Reopened} again, {gaps.Resolved} closed");
        }, cancellationToken);
    }
}

/// <summary>
/// What CloudAlly bills the partner per account (M42, <c>cloudally-bills</c>): its current lines, stored as the reading of the day in
/// Oslo. Cost data: kept for the comparison with the contract (M43), never shown without <c>finance.cost.read</c>.
/// </summary>
public sealed class CloudAllyBillSyncJob(
    ICloudAllyClient client,
    CloudAllyLinkIndex links,
    IBackupApi backups,
    SyncRunner runner,
    TimeProvider time,
    IOptions<CloudAllyOptions> options,
    ILogger<CloudAllyBillSyncJob> logger)
{
    public const string JobId = "cloudally-bills";

    private static readonly TimeZoneInfo Oslo = TimeZoneInfo.FindSystemTimeZoneById("Europe/Oslo");

    public async Task RunAsync(CancellationToken cancellationToken)
    {
        if (!options.Value.IsConfigured)
        {
            logger.LogInformation("CloudAlly bill sync skipped: integration not configured.");
            return;
        }

        await runner.RunAsync(CloudAllyTypes.System, JobId, async (progress, ct) =>
        {
            var linked = await links.AccountsAsync(ct);
            var lines = new List<ExternalBackupBillLine>();
            await foreach (var bill in client.GetBillsAsync(ct))
            {
                progress.Read++;
                if (string.IsNullOrWhiteSpace(bill.UserId))
                {
                    continue;
                }

                var organizationId = linked.TryGetValue(bill.UserId, out var id) ? id : (Guid?)null;
                lines.AddRange((bill.Lines ?? []).Select(line => new ExternalBackupBillLine(
                    bill.UserId, organizationId, line.Type ?? "BACKUP", line.Source ?? "?", line.Service, line.Accounts, line.Seats, line.Price, line.Total,
                    bill.Currency, bill.PaymentType, CloudAllyDates.Parse(bill.NextPaymentDate))));
            }

            var day = DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(time.GetUtcNow(), Oslo).DateTime);
            progress.Changed = await backups.ApplyBillsAsync(CloudAllyTypes.System, day, lines, ct);
            progress.Message = string.Create(CultureInfo.InvariantCulture,
                $"bills {progress.Read}, lines {progress.Changed} on {day:yyyy-MM-dd}, of accounts without a customer {lines.Count(l => l.OrganizationId is null)}");
        }, cancellationToken);
    }
}
