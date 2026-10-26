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

internal sealed partial class ContractsApi(ContractsDbContext db, HourBankService hourBanks, ICatalogApi catalog, TimeProvider time, TimeBankTransaction financial) : IContractsApi
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

    public async Task<IReadOnlyDictionary<Guid, IReadOnlySet<Guid>>> GetContractedProductsAsync(
        IReadOnlyCollection<Guid> organizationIds, DateOnly date, CancellationToken cancellationToken)
    {
        if (organizationIds.Count == 0)
        {
            return new Dictionary<Guid, IReadOnlySet<Guid>>();
        }

        var pairs = await (
                from line in db.ContractLines.AsNoTracking()
                join contract in db.Contracts.AsNoTracking() on line.ContractId equals contract.Id
                where organizationIds.Contains(contract.OrganizationId) &&
                      (contract.Status == ContractStatus.Active || contract.Status == ContractStatus.NoticeGiven || contract.Status == ContractStatus.Suspended) &&
                      line.ValidFrom <= date && (line.ValidTo == null || line.ValidTo >= date)
                select new { contract.OrganizationId, line.ProductId })
            .Distinct()
            .ToListAsync(cancellationToken);
        return pairs.GroupBy(p => p.OrganizationId)
            .ToDictionary(g => g.Key, g => (IReadOnlySet<Guid>)g.Select(p => p.ProductId).ToHashSet());
    }

    public async Task<OrganizationBillingTerms> GetBillingTermsAsync(Guid organizationId, DateOnly date, CancellationToken cancellationToken)
    {
        await using var joined = await financial.JoinAsync(db, options => new ContractsDbContext(options), cancellationToken);
        var read = joined ?? db;
        // The contract that decides how time is billed: the running one with an SLA, otherwise the latest running one.
        var contracts = await read.Contracts.AsNoTracking()
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
                ? await read.SlaPolicies.AsNoTracking().SingleOrDefaultAsync(p => p.Id == slaId, cancellationToken)
                : null;
            var prices = await read.ContractLines.AsNoTracking()
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

        var banks = await read.HourBanks.AsNoTracking()
            .Where(b => b.OrganizationId == organizationId && b.Status == HourBankStatus.Active && b.ValidFrom <= date && (b.ValidTo == null || b.ValidTo >= date))
            .OrderBy(b => b.ValidTo == null).ThenBy(b => b.ValidTo).ThenBy(b => b.ValidFrom)
            .ToListAsync(cancellationToken);

        return new OrganizationBillingTerms(
            terms,
            banks.Where(b => b.RemainingHours > 0).Select(b => new HourBankBalance(b.Id, b.Name, b.RemainingHours, b.OverageRate, b.ValidFrom, b.ValidTo)).ToList());
    }

    public Task<IReadOnlyList<BillableContractLine>> GetBillableLinesAsync(DateOnly periodStart, DateOnly periodEnd, CancellationToken cancellationToken) =>
        BillableLinesAsync(null, periodStart, periodEnd, cancellationToken);

    public Task<IReadOnlyList<BillableContractLine>> GetBillableLinesAsync(Guid organizationId, DateOnly periodStart, DateOnly periodEnd, CancellationToken cancellationToken) =>
        BillableLinesAsync(organizationId, periodStart, periodEnd, cancellationToken);

    private async Task<IReadOnlyList<BillableContractLine>> BillableLinesAsync(Guid? organizationId, DateOnly periodStart, DateOnly periodEnd, CancellationToken cancellationToken)
    {
        var rows = await (
                from line in db.ContractLines.AsNoTracking()
                join contract in db.Contracts.AsNoTracking() on line.ContractId equals contract.Id
                // An ended contract still owes what it delivered until its end date: the monthly job that marks it Ended runs before the
                // run for its last period is collected, and dropping it then would lose the final invoice. The date window below bounds it.
                where contract.Status != ContractStatus.Draft && (organizationId == null || contract.OrganizationId == organizationId) &&
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
            // Every contract of the window (DEV-12): the dashboard shows the soonest and counts the rest, the mart exports them all.
            .OrderBy(c => c.EndDate).ThenBy(c => c.Id)
            .Select(c => new { c.Id, c.Number, c.Title, c.OrganizationId, c.EndDate, c.AutoRenew, c.NoticePeriodDays, c.OwnerId })
            .ToListAsync(cancellationToken);

        return contracts
            .Select(c => new RenewalDue(
                c.Id, c.Number, c.Title, c.OrganizationId, c.EndDate!.Value, c.EndDate!.Value.DayNumber - from.DayNumber, c.AutoRenew,
                c.NoticePeriodDays > 0 ? c.EndDate!.Value.AddDays(-c.NoticePeriodDays) : null, c.OwnerId))
            .ToList();
    }

    public Task<int> CountOverdueRemindersAsync(DateOnly today, CancellationToken cancellationToken) =>
        db.Reminders.AsNoTracking().CountAsync(r => r.AcknowledgedAt == null && r.DueDate < today, cancellationToken);

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
