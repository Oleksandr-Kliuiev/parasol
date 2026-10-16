using Crm.Catalog.Contracts;
using Crm.Contracts.Contracts;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Results;
using Crm.TimeTracking.Contracts;
using Crm.TimeTracking.Domain;
using Crm.TimeTracking.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Crm.TimeTracking.Features;

public sealed record ApprovalSummary(int Approved, int Skipped, decimal Amount, IReadOnlyList<string> SkippedReasons);

internal sealed class TimeApprovalService(
    TimeTrackingDbContext db,
    IContractsApi contracts,
    ICatalogApi catalog,
    ICurrentUser currentUser,
    TimeProvider time,
    IOptions<TimeTrackingOptions> options)
{
    private static readonly TimeZoneInfo Oslo = TimeZoneInfo.FindSystemTimeZoneById("Europe/Oslo");

    public async Task<Result<ApprovalSummary>> ApproveAsync(IReadOnlyCollection<Guid> entryIds, CancellationToken cancellationToken)
    {
        var entries = await db.TimeEntries.Include(e => e.Allocations)
            .Where(e => entryIds.Contains(e.Id))
            .OrderBy(e => e.WorkDate).ThenBy(e => e.Id)
            .ToListAsync(cancellationToken);
        var closed = await ClosedPeriodsAsync(cancellationToken);
        var now = time.GetUtcNow();
        var coveredUsed = new Dictionary<(Guid Organization, int Year, int Month), decimal>();
        var skipped = new List<string>();
        decimal amount = 0;
        var approved = 0;

        foreach (var entry in entries)
        {
            if (entry.Status is not TimeEntryStatus.New)
            {
                skipped.Add($"{entry.WorkDate:yyyy-MM-dd}: already {entry.Status}.");
                continue;
            }

            if (closed.Contains((entry.Year, entry.Month)))
            {
                skipped.Add($"{entry.WorkDate:yyyy-MM-dd}: the period is closed.");
                continue;
            }

            var terms = await contracts.GetBillingTermsAsync(entry.OrganizationId, entry.WorkDate, cancellationToken);
            var key = (entry.OrganizationId, entry.Year, entry.Month);
            if (!coveredUsed.TryGetValue(key, out var used))
            {
                used = await CoveredHoursAsync(entry.OrganizationId, entry.Year, entry.Month, cancellationToken);
                coveredUsed[key] = used;
            }

            var product = await catalog.FindHourlyProductAsync(entry.WorkType, options.Value.DefaultHourlyProductSku, cancellationToken);
            decimal? catalogRate = null;
            decimal? contractRate = null;
            if (product is not null)
            {
                terms.Contract?.IndividualPrices.TryGetValue(product.Id, out var individual);
                contractRate = terms.Contract is not null && terms.Contract.IndividualPrices.TryGetValue(product.Id, out var price) ? price : null;
                var prices = await catalog.ResolvePricesAsync([product.Id], terms.Contract?.PriceCategory, entry.WorkDate, cancellationToken);
                catalogRate = prices.TryGetValue(product.Id, out var resolved) ? resolved.UnitPrice : null;
            }

            var afterHours = entry.AfterHours || IsAfterHours(entry, terms.Contract?.Coverage);
            var parts = TariffEngine.Classify(
                new TariffInput(entry.Hours, entry.Billable, entry.WorkType, entry.Onsite, afterHours),
                new TariffContext(terms.Contract, used, terms.HourBanks, contractRate, catalogRate, options.Value));

            var allocations = new List<TimeAllocation>();
            foreach (var part in parts)
            {
                if (part.Classification == TimeClassification.HourBank && part.HourBankId is { } bankId)
                {
                    var consumption = await contracts.ConsumeHoursAsync(
                        bankId, part.Hours, entry.WorkDate, Describe(entry), "TimeEntry", entry.ConsumptionKey(bankId), cancellationToken);
                    var fromBank = consumption is null ? 0 : part.Hours - consumption.OverageHours;
                    if (fromBank > 0)
                    {
                        allocations.Add(new TimeAllocation(entry.Id, TimeClassification.HourBank, fromBank, fromBank, null, bankId));
                    }

                    // Someone else emptied the bank in between: the rest is billed by the rate.
                    var rest = part.Hours - fromBank;
                    if (rest > 0)
                    {
                        var rate = terms.HourBanks.FirstOrDefault(b => b.Id == bankId)?.OverageRate ?? contractRate ?? terms.Contract?.SlaOverageRate ?? catalogRate;
                        allocations.Add(new TimeAllocation(entry.Id, TimeClassification.Rate, rest, rest, rate, null));
                    }

                    continue;
                }

                allocations.Add(new TimeAllocation(entry.Id, part.Classification, part.Hours, part.BilledHours, part.Rate, null));
            }

            entry.Approve(currentUser.UserId, now, terms.Contract?.ContractId, allocations);
            entry.ClearReview();
            db.TimeAllocations.AddRange(allocations);
            coveredUsed[key] = used + allocations.Where(a => a.Classification == TimeClassification.Covered).Sum(a => a.Hours);
            amount += entry.Amount ?? 0;
            approved++;
        }

        await db.SaveChangesAsync(cancellationToken);
        return new ApprovalSummary(approved, skipped.Count, decimal.Round(amount, 2), skipped);
    }

    public async Task<Result<int>> WithdrawAsync(IReadOnlyCollection<Guid> entryIds, CancellationToken cancellationToken)
    {
        var entries = await db.TimeEntries.Include(e => e.Allocations).Where(e => entryIds.Contains(e.Id)).ToListAsync(cancellationToken);
        var closed = await ClosedPeriodsAsync(cancellationToken);
        var withdrawn = 0;
        foreach (var entry in entries.Where(e => e.Status is TimeEntryStatus.Approved or TimeEntryStatus.NonBillable))
        {
            if (closed.Contains((entry.Year, entry.Month)))
            {
                return Error.Conflict("TIM_PERIOD_CLOSED", "The period is closed; Finance must reopen it first (BR-TIM-05).");
            }

            await WithdrawAsync(entry, cancellationToken);
            withdrawn++;
        }

        await db.SaveChangesAsync(cancellationToken);
        return withdrawn;
    }

    /// <summary>Withdraws one approval and gives back the hours it took from hour banks.</summary>
    public async Task WithdrawAsync(TimeEntry entry, CancellationToken cancellationToken)
    {
        foreach (var allocation in entry.CurrentAllocations.Where(a => a.HourBankId is not null).ToList())
        {
            await contracts.ReverseConsumptionAsync("TimeEntry", $"{entry.Id}:{entry.ApprovalCount}:{allocation.HourBankId}", cancellationToken);
        }

        entry.Withdraw();
    }

    private async Task<HashSet<(int Year, int Month)>> ClosedPeriodsAsync(CancellationToken cancellationToken) =>
        (await db.TimePeriods.AsNoTracking().Where(p => p.IsClosed).Select(p => new { p.Year, p.Month }).ToListAsync(cancellationToken))
        .Select(p => (p.Year, p.Month)).ToHashSet();

    private async Task<decimal> CoveredHoursAsync(Guid organizationId, int year, int month, CancellationToken cancellationToken)
    {
        var from = new DateOnly(year, month, 1);
        var to = from.AddMonths(1);
        return await db.TimeAllocations.AsNoTracking()
            .Where(a => a.Classification == TimeClassification.Covered)
            .Join(db.TimeEntries.AsNoTracking().Where(e => e.OrganizationId == organizationId && e.WorkDate >= from && e.WorkDate < to),
                a => a.TimeEntryId, e => e.Id, (a, _) => a.Hours)
            .SumAsync(cancellationToken);
    }

    private static bool IsAfterHours(TimeEntry entry, SupportHours? coverage) =>
        coverage is { } hours && entry.StartedAt is { } startedAt &&
        TariffEngine.IsAfterHours(TimeZoneInfo.ConvertTime(startedAt, Oslo), hours);

    private static string Describe(TimeEntry entry) =>
        entry.ExternalTicketId is { } ticket ? $"#{ticket} {entry.Description ?? entry.WorkType}" : entry.Description ?? entry.WorkType ?? "Time entry";
}
