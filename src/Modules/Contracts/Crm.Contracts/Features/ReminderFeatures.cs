using Crm.Catalog.Contracts;
using Crm.Contracts.Contracts;
using Crm.Contracts.Domain;
using Crm.Contracts.Persistence;
using Crm.Customers.Contracts;
using Crm.Identity.Contracts;
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
    public async Task<IReadOnlyList<ReminderItem>> ListAsync(bool mine, bool includeAcknowledged, Guid? organizationId, CancellationToken ct)
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

        var rows = await reminders.OrderBy(r => r.DueDate).Take(200).ToListAsync(ct);
        var contractIds = rows.Where(r => r.ContractId != null).Select(r => r.ContractId!.Value).Distinct().ToList();
        var bankIds = rows.Where(r => r.HourBankId != null).Select(r => r.HourBankId!.Value).Distinct().ToList();
        var contracts = await db.Contracts.AsNoTracking().IgnoreQueryFilters().Where(c => contractIds.Contains(c.Id)).ToDictionaryAsync(c => c.Id, ct);
        var banks = await db.HourBanks.AsNoTracking().IgnoreQueryFilters().Where(b => bankIds.Contains(b.Id)).ToDictionaryAsync(b => b.Id, ct);
        var organizations = await customers.GetOrganizationNamesAsync(rows.Select(r => r.OrganizationId).Distinct().ToList(), ct);
        var assignees = await users.GetUsersAsync(rows.Where(r => r.AssigneeId != null).Select(r => r.AssigneeId!.Value).Distinct().ToList(), ct);

        return rows.Select(r => new ReminderItem(
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
            r.AcknowledgedAt)).ToList();
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

    public async Task<ContractLifecycleResult> RunAsync(CancellationToken cancellationToken)
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

        foreach (var contract in upcoming)
        {
            var end = contract.EndDate!.Value;
            var assignee = contract.OwnerId ?? (await customers.GetOrganizationAsync(contract.OrganizationId, cancellationToken))?.AccountManagerId;
            if (RenewalSchedule.DueStep(end, today) is { } step)
            {
                var reference = $"{step}@{end:yyyy-MM-dd}";
                if (existing.Add(Key(ReminderKind.ContractEnding, contract, reference)))
                {
                    var reminder = Reminder.ForContract(ReminderKind.ContractEnding, contract, end, step, reference, assignee);
                    reminder.RaiseEnding(end.DayNumber - today.DayNumber);
                    db.Reminders.Add(reminder);
                    reminders++;
                }
            }

            if (RenewalSchedule.NoticeTaskDue(contract, today) && existing.Add(Key(ReminderKind.NoticeDeadline, contract, $"{end:yyyy-MM-dd}")))
            {
                db.Reminders.Add(Reminder.ForContract(ReminderKind.NoticeDeadline, contract, end.AddDays(-contract.NoticePeriodDays), null, $"{end:yyyy-MM-dd}", assignee));
                reminders++;
            }
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

internal sealed class ContractsApi(ContractsDbContext db, HourBankService hourBanks, ICatalogApi catalog, TimeProvider time) : IContractsApi
{
    public async Task<OrganizationSla> GetOrganizationSlaAsync(Guid organizationId, CancellationToken cancellationToken)
    {
        var today = time.Today();
        var current = await (
                from contract in db.Contracts.AsNoTracking()
                join policy in db.SlaPolicies.AsNoTracking() on contract.SlaPolicyId equals policy.Id
                where contract.OrganizationId == organizationId && contract.StartDate <= today &&
                      (contract.Status == ContractStatus.Active || contract.Status == ContractStatus.NoticeGiven)
                orderby contract.StartDate descending
                select new { contract.Id, policy.Name, policy.AteraValue })
            .FirstOrDefaultAsync(cancellationToken);
        return current is null
            ? new OrganizationSla(organizationId, null, null, null)
            : new OrganizationSla(organizationId, current.Id, current.Name, current.AteraValue ?? current.Name);
    }

    public Task<HourBankConsumption?> ConsumeHoursAsync(
        Guid hourBankId, decimal hours, DateOnly date, string description, string sourceType, string sourceId, CancellationToken cancellationToken) =>
        hourBanks.ConsumeFromSourceAsync(hourBankId, hours, date, description, sourceType, sourceId, cancellationToken);

    public Task ReverseConsumptionAsync(string sourceType, string sourceId, CancellationToken cancellationToken) =>
        hourBanks.ReverseAsync(sourceType, sourceId, cancellationToken);

    public async Task<IReadOnlySet<Guid>> GetContractedProductsAsync(Guid organizationId, DateOnly date, CancellationToken cancellationToken)
    {
        var products = await (
                from line in db.ContractLines.AsNoTracking()
                join contract in db.Contracts.AsNoTracking() on line.ContractId equals contract.Id
                where contract.OrganizationId == organizationId &&
                      (contract.Status == ContractStatus.Active || contract.Status == ContractStatus.NoticeGiven || contract.Status == ContractStatus.Suspended) &&
                      line.ValidFrom <= date && (line.ValidTo == null || line.ValidTo >= date)
                select line.ProductId)
            .Distinct()
            .ToListAsync(cancellationToken);
        return products.ToHashSet();
    }

    public async Task<OrganizationBillingTerms> GetBillingTermsAsync(Guid organizationId, DateOnly date, CancellationToken cancellationToken)
    {
        // The contract that decides how time is billed: the running one with an SLA, otherwise the latest running one.
        var contracts = await db.Contracts.AsNoTracking()
            .Where(c => c.OrganizationId == organizationId && c.StartDate <= date && (c.EndDate == null || c.EndDate >= date) &&
                        (c.Status == ContractStatus.Active || c.Status == ContractStatus.NoticeGiven || c.Status == ContractStatus.Suspended))
            .OrderByDescending(c => c.SlaPolicyId != null).ThenByDescending(c => c.StartDate)
            .Take(1)
            .Select(c => new { c.Id, c.Number, c.PriceCategory, c.SlaPolicyId })
            .ToListAsync(cancellationToken);

        ContractBillingTerms? terms = null;
        if (contracts.FirstOrDefault() is { } contract)
        {
            var sla = contract.SlaPolicyId is { } slaId
                ? await db.SlaPolicies.AsNoTracking().SingleOrDefaultAsync(p => p.Id == slaId, cancellationToken)
                : null;
            var prices = await db.ContractLines.AsNoTracking()
                .Where(l => l.ContractId == contract.Id && l.UnitPrice != null && l.ValidFrom <= date && (l.ValidTo == null || l.ValidTo >= date))
                .Select(l => new { l.ProductId, Price = l.UnitPrice!.Value })
                .ToListAsync(cancellationToken);
            terms = new ContractBillingTerms(
                contract.Id,
                contract.Number,
                contract.PriceCategory,
                sla is null ? null : (SupportHours)sla.Coverage,
                sla?.IncludedHoursPerMonth ?? 0,
                SlaPolicy.ParseWorkTypes(sla?.CoveredWorkTypes),
                sla?.AfterHoursMultiplier ?? 1m,
                sla?.OverageRate,
                prices.GroupBy(p => p.ProductId).ToDictionary(g => g.Key, g => g.Min(x => x.Price)));
        }

        var banks = await db.HourBanks.AsNoTracking()
            .Where(b => b.OrganizationId == organizationId && b.Status == HourBankStatus.Active && b.ValidFrom <= date && (b.ValidTo == null || b.ValidTo >= date))
            .OrderBy(b => b.ValidTo == null).ThenBy(b => b.ValidTo).ThenBy(b => b.ValidFrom)
            .ToListAsync(cancellationToken);

        return new OrganizationBillingTerms(
            terms,
            banks.Where(b => b.RemainingHours > 0).Select(b => new HourBankBalance(b.Id, b.Name, b.RemainingHours, b.OverageRate, b.ValidFrom, b.ValidTo)).ToList());
    }

    public async Task<IReadOnlyList<BillableContractLine>> GetBillableLinesAsync(DateOnly periodStart, DateOnly periodEnd, CancellationToken cancellationToken)
    {
        var rows = await (
                from line in db.ContractLines.AsNoTracking()
                join contract in db.Contracts.AsNoTracking() on line.ContractId equals contract.Id
                where (contract.Status == ContractStatus.Active || contract.Status == ContractStatus.NoticeGiven || contract.Status == ContractStatus.Suspended) &&
                      contract.StartDate <= periodEnd && (contract.EndDate == null || contract.EndDate >= periodStart) &&
                      line.ValidFrom <= periodEnd && (line.ValidTo == null || line.ValidTo >= periodStart)
                select new
                {
                    contract.Id,
                    contract.Number,
                    contract.OrganizationId,
                    contract.PriceCategory,
                    contract.InvoiceFrequency,
                    contract.InvoiceTiming,
                    contract.StartDate,
                    contract.CustomerReference,
                    LineId = line.Id,
                    line.SeriesId,
                    line.Version,
                    line.ProductId,
                    line.Description,
                    line.QuantityModel,
                    line.DeviceFilter,
                    line.Quantity,
                    line.UnitPrice,
                    line.DiscountPct,
                    line.ValidFrom,
                    line.ValidTo,
                })
            .ToListAsync(cancellationToken);

        // A revision ends the previous version and starts a new one (BR-CON-03), so the versions of a series never overlap:
        // every version that touches the period is returned and the run prorates each by its own days (FR-BIL-05).
        return rows
            .OrderBy(r => r.ValidFrom).ThenBy(r => r.Version)
            .Select(r => new BillableContractLine(
                r.Id, r.Number, r.OrganizationId, r.LineId, r.SeriesId, r.ProductId, r.Description, r.QuantityModel, r.DeviceFilter, r.Quantity,
                r.UnitPrice, r.DiscountPct, r.PriceCategory, r.InvoiceFrequency, r.InvoiceTiming, r.StartDate, r.ValidFrom, r.ValidTo,
                r.CustomerReference))
            .ToList();
    }

    public async Task<IReadOnlyList<SlaTargets>> GetSlaTargetsAsync(DateOnly date, CancellationToken cancellationToken)
    {
        var rows = await (
                from contract in db.Contracts.AsNoTracking()
                join policy in db.SlaPolicies.AsNoTracking() on contract.SlaPolicyId equals policy.Id
                where (contract.Status == ContractStatus.Active || contract.Status == ContractStatus.NoticeGiven || contract.Status == ContractStatus.Suspended) &&
                      contract.StartDate <= date && (contract.EndDate == null || contract.EndDate >= date)
                select new
                {
                    contract.OrganizationId,
                    ContractId = contract.Id,
                    contract.Number,
                    PolicyName = policy.Name,
                    policy.Coverage,
                    policy.P1,
                    policy.P2,
                    policy.P3,
                    policy.P4,
                })
            .ToListAsync(cancellationToken);

        // A customer with several contracts is measured against the strictest promise they hold.
        return rows
            .GroupBy(r => r.OrganizationId)
            .Select(g => g.OrderBy(r => r.P1.ResponseMinutes).ThenBy(r => r.Number, StringComparer.Ordinal).First())
            .Select(r => new SlaTargets(
                r.OrganizationId,
                r.ContractId,
                r.Number,
                r.PolicyName,
                (SupportHours)r.Coverage,
                new SlaPriorityTarget(r.P1.ResponseMinutes, r.P1.ResolutionMinutes),
                new SlaPriorityTarget(r.P2.ResponseMinutes, r.P2.ResolutionMinutes),
                new SlaPriorityTarget(r.P3.ResponseMinutes, r.P3.ResolutionMinutes),
                new SlaPriorityTarget(r.P4.ResponseMinutes, r.P4.ResolutionMinutes)))
            .ToList();
    }

    public async Task<RecurringRevenue> GetRecurringRevenueAsync(DateOnly date, CancellationToken cancellationToken)
    {
        var rows = await (
                from line in db.ContractLines.AsNoTracking()
                join contract in db.Contracts.AsNoTracking() on line.ContractId equals contract.Id
                where (contract.Status == ContractStatus.Active || contract.Status == ContractStatus.NoticeGiven || contract.Status == ContractStatus.Suspended) &&
                      contract.StartDate <= date && (contract.EndDate == null || contract.EndDate >= date) &&
                      line.ValidFrom <= date && (line.ValidTo == null || line.ValidTo >= date)
                select new
                {
                    contract.Id,
                    contract.Type,
                    contract.PriceCategory,
                    line.SeriesId,
                    line.Version,
                    line.ProductId,
                    line.Quantity,
                    line.UnitPrice,
                    line.DiscountPct,
                })
            .ToListAsync(cancellationToken);

        var current = rows.GroupBy(r => r.SeriesId).Select(g => g.OrderByDescending(r => r.Version).First()).ToList();
        var defaultCategory = await catalog.GetDefaultCategoryAsync(cancellationToken);
        var productIds = current.Select(r => r.ProductId).Distinct().ToList();
        var products = await catalog.GetProductsAsync(productIds, cancellationToken);
        var pricesByCategory = new Dictionary<string, IReadOnlyDictionary<Guid, ResolvedPrice>>(StringComparer.OrdinalIgnoreCase);
        foreach (var category in current.Select(r => r.PriceCategory ?? defaultCategory).Distinct(StringComparer.OrdinalIgnoreCase))
        {
            pricesByCategory[category] = await catalog.ResolvePricesAsync(productIds, category, date, cancellationToken);
        }

        var byType = new Dictionary<ContractType, decimal>();
        decimal total = 0;
        foreach (var line in current)
        {
            if (!products.TryGetValue(line.ProductId, out var product))
            {
                continue;
            }

            var prices = pricesByCategory[line.PriceCategory ?? defaultCategory];
            var unitPrice = line.UnitPrice ?? (prices.TryGetValue(line.ProductId, out var resolved) ? resolved.UnitPrice : 0m);
            var amount = ContractLine.Amount(line.Quantity, unitPrice, line.DiscountPct);
            // A quarterly or yearly line contributes its share of a month, so MRR and ARR are comparable across contracts.
            var monthly = product.BillingPeriod switch
            {
                BillingPeriod.Monthly => amount,
                BillingPeriod.Quarterly => amount / 3m,
                BillingPeriod.Yearly => amount / 12m,
                _ => 0m,
            };
            if (monthly == 0)
            {
                continue;
            }

            total += monthly;
            byType[line.Type] = byType.GetValueOrDefault(line.Type) + monthly;
        }

        return new RecurringRevenue(
            decimal.Round(total, 2),
            byType.ToDictionary(x => x.Key, x => decimal.Round(x.Value, 2)),
            current.Select(r => r.Id).Distinct().Count());
    }

    public async Task<IReadOnlyList<RenewalDue>> GetRenewalsAsync(DateOnly from, int days, CancellationToken cancellationToken)
    {
        var horizon = from.AddDays(Math.Clamp(days, 1, 365));
        var contracts = await db.Contracts.AsNoTracking()
            .Where(c => (c.Status == ContractStatus.Active || c.Status == ContractStatus.NoticeGiven || c.Status == ContractStatus.Suspended) &&
                        c.EndDate != null && c.EndDate >= from && c.EndDate <= horizon)
            .OrderBy(c => c.EndDate)
            .Take(200)
            .Select(c => new { c.Id, c.Number, c.Title, c.OrganizationId, c.EndDate, c.AutoRenew, c.NoticePeriodDays, c.OwnerId })
            .ToListAsync(cancellationToken);

        return contracts
            .Select(c => new RenewalDue(
                c.Id, c.Number, c.Title, c.OrganizationId, c.EndDate!.Value, c.EndDate!.Value.DayNumber - from.DayNumber, c.AutoRenew,
                c.NoticePeriodDays > 0 ? c.EndDate!.Value.AddDays(-c.NoticePeriodDays) : null, c.OwnerId))
            .ToList();
    }

    public async Task<IReadOnlyList<HourBankPurchase>> GetHourBankPurchasesAsync(DateOnly periodStart, DateOnly periodEnd, CancellationToken cancellationToken)
    {
        var rows = await (
                from entry in db.HourBankEntries.AsNoTracking()
                join bank in db.HourBanks.AsNoTracking() on entry.HourBankId equals bank.Id
                where entry.Kind == HourBankEntryKind.Purchase && entry.Date >= periodStart && entry.Date <= periodEnd && entry.Hours > 0
                select new { EntryId = entry.Id, bank.Id, bank.OrganizationId, bank.ContractId, bank.Name, bank.OverageRate, entry.Date, entry.Hours, entry.Description })
            .ToListAsync(cancellationToken);

        return rows
            .Select(r => new HourBankPurchase(r.EntryId, r.Id, r.OrganizationId, r.ContractId, r.Name, r.Date, r.Hours, r.OverageRate, r.Description))
            .ToList();
    }
}
