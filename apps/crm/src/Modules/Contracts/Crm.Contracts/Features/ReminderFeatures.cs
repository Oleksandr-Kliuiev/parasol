using System.Globalization;
using Crm.Catalog.Contracts;
using Crm.Contracts.Contracts;
using Crm.Contracts.Domain;
using Crm.Contracts.Persistence;
using Crm.Customers.Contracts;
using Crm.Identity.Contracts;
using Crm.Infrastructure.Persistence;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Domain;
using Crm.SharedKernel.Results;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace Crm.Contracts.Features;

public sealed record ReminderContractDto(Guid Id, string Number, string Title, DateOnly? EndDate, bool AutoRenew, DateOnly? NoticeDeadline);

public sealed record ReminderHourBankDto(Guid Id, string Name, decimal RemainingHours, decimal PurchasedHours);

public sealed record ReminderItem(
    Guid Id,
    ReminderKind Kind,
    RefDto Organization,
    ReminderContractDto? Contract,
    ReminderHourBankDto? HourBank,
    DateOnly DueDate,
    int? DaysBefore,
    RefDto? Assignee,
    DateTimeOffset? AcknowledgedAt);

internal sealed class ReminderService(ContractsDbContext db, ICustomersApi customers, IUserDirectory users, ICurrentUser currentUser, TimeProvider time)
{
    public async Task<PagedResult<ReminderItem>> ListAsync(bool mine, bool includeAcknowledged, Guid? organizationId, int? limit, string? cursor, CancellationToken ct)
    {
        var reminders = db.Reminders.AsNoTracking();
        if (mine)
        {
            var userId = currentUser.UserId;
            reminders = reminders.Where(r => r.AssigneeId == userId);
        }

        if (organizationId is { } org)
        {
            reminders = reminders.Where(r => r.OrganizationId == org);
        }

        if (!includeAcknowledged)
        {
            reminders = reminders.Where(r => r.AcknowledgedAt == null);
        }

        // Soonest first, then id (DEV-12).
        var total = await reminders.CountAsync(ct);
        if (KeysetCursor.Decode(cursor) is { } after &&
            DateOnly.TryParseExact(after.SortKey, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var due))
        {
            reminders = reminders.Where(r => r.DueDate > due || (r.DueDate == due && r.Id.CompareTo(after.Id) > 0));
        }

        var take = KeysetCursor.ClampLimit(limit);
        var page = await reminders.OrderBy(r => r.DueDate).ThenBy(r => r.Id).Take(take + 1).ToListAsync(ct);
        var rows = page.Take(take).ToList();
        var next = page.Count > take ? new KeysetCursor(rows[^1].DueDate.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture), rows[^1].Id).Encode() : null;
        var contractIds = rows.Where(r => r.ContractId != null).Select(r => r.ContractId!.Value).Distinct().ToList();
        var bankIds = rows.Where(r => r.HourBankId != null).Select(r => r.HourBankId!.Value).Distinct().ToList();
        var contracts = await db.Contracts.AsNoTracking().IgnoreQueryFilters().Where(c => contractIds.Contains(c.Id)).ToDictionaryAsync(c => c.Id, ct);
        var banks = await db.HourBanks.AsNoTracking().IgnoreQueryFilters().Where(b => bankIds.Contains(b.Id)).ToDictionaryAsync(b => b.Id, ct);
        var organizations = await customers.GetOrganizationNamesAsync(rows.Select(r => r.OrganizationId).Distinct().ToList(), ct);
        var assignees = await users.GetUsersAsync(rows.Where(r => r.AssigneeId != null).Select(r => r.AssigneeId!.Value).Distinct().ToList(), ct);

        return new PagedResult<ReminderItem>(rows.Select(r => new ReminderItem(
            r.Id,
            r.Kind,
            new RefDto(r.OrganizationId, organizations.GetValueOrDefault(r.OrganizationId, "—")),
            r.ContractId is { } cid && contracts.TryGetValue(cid, out var c)
                ? new ReminderContractDto(c.Id, c.Number, c.Title, c.EndDate, c.AutoRenew, c.EndDate?.AddDays(-c.NoticePeriodDays))
                : null,
            r.HourBankId is { } bid && banks.TryGetValue(bid, out var b) ? new ReminderHourBankDto(b.Id, b.Name, b.RemainingHours, b.PurchasedHours) : null,
            r.DueDate,
            r.DaysBefore,
            r.AssigneeId is { } aid && assignees.TryGetValue(aid, out var u) ? new RefDto(u.Id, u.DisplayName) : null,
            r.AcknowledgedAt)).ToList(), next, total);
    }

    public async Task<Result> AcknowledgeAsync(Guid id, CancellationToken ct)
    {
        if (await db.Reminders.SingleOrDefaultAsync(r => r.Id == id, ct) is not { } reminder)
        {
            return Error.NotFound("CON_REMINDER_NOT_FOUND", $"Reminder {id} was not found.");
        }

        reminder.Acknowledge(currentUser.UserId, time.GetUtcNow());
        await db.SaveChangesAsync(ct);
        return Result.Success();
    }
}

/// <summary>
/// Daily: renews or ends contracts at their end date (BR-CON-04) and creates the 60/30/7-day and notice-deadline reminders (FR-CON-04).
/// Safe to run repeatedly on the same day.
/// </summary>
public sealed class ContractLifecycleJob(ContractsDbContext db, ICustomersApi customers, TimeProvider time, ILogger<ContractLifecycleJob> logger)
{
    public const string JobId = "contract-lifecycle";

    public Task<ContractLifecycleResult> RunAsync(CancellationToken cancellationToken) =>
        db.Database.CreateExecutionStrategy().ExecuteAsync(async () =>
        {
            // Two worker replicas may start the same daily scan before either has written its reminders. Serialize the
            // read/decide/write cycle in SQL, including renewals and their domain events; a retry starts from clean state.
            db.ChangeTracker.Clear();
            await using var transaction = await db.Database.BeginTransactionAsync(cancellationToken);
            await db.Database.ExecuteSqlRawAsync("""
                DECLARE @result int;
                EXEC @result = sp_getapplock @Resource=N'contracts:lifecycle', @LockMode=N'Exclusive', @LockOwner=N'Transaction', @LockTimeout=60000;
                IF @result < 0 THROW 51000, N'CONTRACT_LIFECYCLE_BUSY', 1;
                """, cancellationToken);
            var result = await RunInTransactionAsync(cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            return result;
        });

    private async Task<ContractLifecycleResult> RunInTransactionAsync(CancellationToken cancellationToken)
    {
        var today = time.Today();
        int renewed = 0, ended = 0, reminders = 0;

        var due = await db.Contracts
            .Where(c => (c.Status == ContractStatus.Active || c.Status == ContractStatus.Suspended || c.Status == ContractStatus.NoticeGiven) &&
                        c.EndDate != null && c.EndDate < today)
            .Include(c => c.Lines)
            .ToListAsync(cancellationToken);
        foreach (var contract in due)
        {
            var wasNotice = contract.Status == ContractStatus.NoticeGiven || !contract.AutoRenew;
            if (contract.ApplyEndOfTerm(today))
            {
                if (wasNotice)
                {
                    ended++;
                }
                else
                {
                    renewed++;
                }
            }
        }

        await db.SaveChangesAsync(cancellationToken);

        var horizon = today.AddDays(RenewalSchedule.ReminderDays.Max());
        var upcoming = await db.Contracts
            .Where(c => (c.Status == ContractStatus.Active || c.Status == ContractStatus.Suspended || c.Status == ContractStatus.NoticeGiven) &&
                        c.EndDate != null && c.EndDate >= today &&
                        (c.EndDate <= horizon || (c.AutoRenew && c.EndDate <= today.AddDays(c.NoticePeriodDays + 30))))
            .ToListAsync(cancellationToken);
        var keys = upcoming.SelectMany(c => new[]
        {
            RenewalSchedule.DueStep(c.EndDate!.Value, today) is { } step ? Key(ReminderKind.ContractEnding, c, $"{step}@{c.EndDate:yyyy-MM-dd}") : null,
            RenewalSchedule.NoticeTaskDue(c, today) ? Key(ReminderKind.NoticeDeadline, c, $"{c.EndDate:yyyy-MM-dd}") : null,
        }).OfType<string>().ToList();
        var existing = (await db.Reminders.AsNoTracking().Where(r => keys.Contains(r.DeduplicationKey)).Select(r => r.DeduplicationKey).ToListAsync(cancellationToken))
            .ToHashSet(StringComparer.Ordinal);

        var pending = new List<(Contract Contract, ReminderKind Kind, DateOnly DueDate, int? DaysBefore, string Reference)>();
        foreach (var contract in upcoming)
        {
            var end = contract.EndDate!.Value;
            if (RenewalSchedule.DueStep(end, today) is { } step)
            {
                var reference = $"{step}@{end:yyyy-MM-dd}";
                if (existing.Add(Key(ReminderKind.ContractEnding, contract, reference)))
                {
                    pending.Add((contract, ReminderKind.ContractEnding, end, step, reference));
                }
            }

            if (RenewalSchedule.NoticeTaskDue(contract, today) && existing.Add(Key(ReminderKind.NoticeDeadline, contract, $"{end:yyyy-MM-dd}")))
            {
                pending.Add((contract, ReminderKind.NoticeDeadline, end.AddDays(-contract.NoticePeriodDays), null, $"{end:yyyy-MM-dd}"));
            }
        }

        // A repeated scan has no pending work. Resolve only new reminders without a contract owner, once per batch.
        var organizationIds = pending.Where(p => p.Contract.OwnerId == null).Select(p => p.Contract.OrganizationId).Distinct().ToList();
        var managers = await customers.GetAccountManagerIdsAsync(organizationIds, cancellationToken);
        foreach (var item in pending)
        {
            var assignee = item.Contract.OwnerId ?? managers.GetValueOrDefault(item.Contract.OrganizationId);
            var reminder = Reminder.ForContract(item.Kind, item.Contract, item.DueDate, item.DaysBefore, item.Reference, assignee);
            if (item.Kind == ReminderKind.ContractEnding)
            {
                reminder.RaiseEnding(item.DueDate.DayNumber - today.DayNumber);
            }
            db.Reminders.Add(reminder);
            reminders++;
        }

        await db.SaveChangesAsync(cancellationToken);
        logger.LogInformation("Contract lifecycle for {Today}: {Renewed} renewed, {Ended} ended, {Reminders} reminders.", today, renewed, ended, reminders);
        return new ContractLifecycleResult(renewed, ended, reminders);
    }

    private static string Key(ReminderKind kind, Contract contract, string reference) => $"{kind}:{contract.Id}:{reference}";
}

public sealed record ContractLifecycleResult(int Renewed, int Ended, int Reminders);

/// <summary>Turns a low hour bank into a reminder for the contract owner, or the account manager (BR-CON-05).</summary>
internal sealed class HourBankLowHandler(ContractsDbContext db, ICustomersApi customers, TimeProvider time) : IDomainEventHandler<HourBankLow>
{
    public async Task HandleAsync(HourBankLow domainEvent, CancellationToken cancellationToken)
    {
        var bank = await db.HourBanks.AsNoTracking().SingleOrDefaultAsync(b => b.Id == domainEvent.HourBankId, cancellationToken);
        if (bank?.LowBalanceNotifiedAt is not { } notifiedAt)
        {
            return;
        }

        var key = $"{ReminderKind.HourBankLow}:{bank.Id}:{notifiedAt.ToUnixTimeSeconds()}";
        if (await db.Reminders.AnyAsync(r => r.DeduplicationKey == key, cancellationToken))
        {
            return;
        }

        var ownerId = bank.ContractId is { } contractId
            ? await db.Contracts.AsNoTracking().Where(c => c.Id == contractId).Select(c => c.OwnerId).SingleOrDefaultAsync(cancellationToken)
            : null;
        ownerId ??= (await customers.GetOrganizationAsync(bank.OrganizationId, cancellationToken))?.AccountManagerId;
        db.Reminders.Add(Reminder.ForHourBank(bank, ownerId, time.Today(), notifiedAt));
        await db.SaveChangesAsync(cancellationToken);
    }
}

/// <summary>Contracts, hour banks and reminders follow an organization into a merge and back on undo.</summary>
internal sealed class OrganizationMergeHandler(ContractsDbContext db, ICustomersApi customers) :
    IDomainEventHandler<OrganizationsMerged>,
    IDomainEventHandler<OrganizationMergeUndone>
{
    public async Task HandleAsync(OrganizationsMerged domainEvent, CancellationToken cancellationToken)
    {
        // A merge delivered after its undo (retried, or replayed by a person) would move everything again and stay moved:
        // the undo already ran and found nothing to move back (DEV-07).
        if (await customers.IsMergeUndoneAsync(domainEvent.MergeId, cancellationToken))
        {
            return;
        }

        foreach (var contract in await db.Contracts.Where(c => c.OrganizationId == domainEvent.SourceOrganizationId).ToListAsync(cancellationToken))
        {
            contract.MoveToOrganization(domainEvent.TargetOrganizationId, domainEvent.MergeId);
        }

        foreach (var bank in await db.HourBanks.Where(b => b.OrganizationId == domainEvent.SourceOrganizationId).ToListAsync(cancellationToken))
        {
            bank.MoveToOrganization(domainEvent.TargetOrganizationId, domainEvent.MergeId);
        }

        await db.Reminders.Where(r => r.OrganizationId == domainEvent.SourceOrganizationId)
            .ExecuteUpdateAsync(u => u.SetProperty(r => r.OrganizationId, domainEvent.TargetOrganizationId), cancellationToken);
        await db.SaveChangesAsync(cancellationToken);
    }

    public async Task HandleAsync(OrganizationMergeUndone domainEvent, CancellationToken cancellationToken)
    {
        var contracts = await db.Contracts.Where(c => c.MovedByMergeId == domainEvent.MergeId).ToListAsync(cancellationToken);
        var banks = await db.HourBanks.Where(b => b.MovedByMergeId == domainEvent.MergeId).ToListAsync(cancellationToken);
        foreach (var contract in contracts)
        {
            contract.UndoMove();
        }

        foreach (var bank in banks)
        {
            bank.UndoMove();
        }

        var contractIds = contracts.Select(c => c.Id).ToList();
        var bankIds = banks.Select(b => b.Id).ToList();
        await db.Reminders
            .Where(r => (r.ContractId != null && contractIds.Contains(r.ContractId.Value)) || (r.HourBankId != null && bankIds.Contains(r.HourBankId.Value)))
            .ExecuteUpdateAsync(u => u.SetProperty(r => r.OrganizationId, domainEvent.SourceOrganizationId), cancellationToken);
        await db.SaveChangesAsync(cancellationToken);
    }
}

internal sealed class ContractProductUsage(ContractsDbContext db) : IProductUsage
{
    public Task<bool> IsUsedAsync(Guid productId, CancellationToken cancellationToken) =>
        db.ContractLines.IgnoreQueryFilters().AnyAsync(l => l.ProductId == productId, cancellationToken);
}
