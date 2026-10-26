using System.Linq.Expressions;
using Crm.Contracts.Contracts;
using Crm.Contracts.Domain;
using Crm.Contracts.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crm.Contracts.Features;

/// <summary>
/// The contract side of the customer facts (UX 2026, В6), with the filters of the lists on the customer card: contracts are those of
/// <c>GET /api/v1/contracts?status=Active</c> (<see cref="ContractService.ListAsync"/>), hour banks those of the hour-bank list
/// without closed ones (<see cref="HourBankService.ListAsync"/>). Neither list applies a record scope beyond <c>contracts.read</c>;
/// deleted rows are left out by the context's soft-delete filter, as there.
/// </summary>
internal sealed class ContractFacts(ContractsDbContext db) : IContractFacts
{
    /// <summary>
    /// One hour bank's balance in SQL. <see cref="HourBank.RemainingHours"/> and <see cref="HourBank.IsLow"/> are computed, not
    /// stored, so their formulas are repeated here; a unit test holds this projection to the domain's answers.
    /// </summary>
    internal static readonly Expression<Func<HourBank, HourBankFactsRow>> Balance = b => new HourBankFactsRow
    {
        OrganizationId = b.OrganizationId,
        PurchasedHours = b.PurchasedHours,
        RemainingHours = b.PurchasedHours - b.UsedHours > 0m ? b.PurchasedHours - b.UsedHours : 0m,
        IsLow = b.PurchasedHours > 0m &&
                (b.PurchasedHours - b.UsedHours > 0m ? b.PurchasedHours - b.UsedHours : 0m) < b.PurchasedHours * b.LowBalancePct / 100m,
    };

    public async Task<IReadOnlyList<OrganizationAgreementFacts>> GetAgreementsAsync(
        IReadOnlyCollection<Guid> organizationIds, CancellationToken cancellationToken)
    {
        if (organizationIds.Count == 0)
        {
            return [];
        }

        return await db.Contracts.AsNoTracking()
            .Where(c => organizationIds.Contains(c.OrganizationId) && c.Status == ContractStatus.Active)
            .GroupBy(c => c.OrganizationId)
            .Select(g => new OrganizationAgreementFacts(g.Key, g.Count(), g.Min(c => c.EndDate)))
            .ToListAsync(cancellationToken);
    }

    public async Task<IReadOnlyList<OrganizationHourBankFacts>> GetHourBanksAsync(
        IReadOnlyCollection<Guid> organizationIds, CancellationToken cancellationToken)
    {
        if (organizationIds.Count == 0)
        {
            return [];
        }

        var rows = await db.HourBanks.AsNoTracking()
            .Where(b => organizationIds.Contains(b.OrganizationId) && b.Status == HourBankStatus.Active)
            .Select(Balance)
            .GroupBy(b => b.OrganizationId)
            .Select(g => new
            {
                g.Key,
                Active = g.Count(),
                Remaining = g.Sum(b => b.RemainingHours),
                Purchased = g.Sum(b => b.PurchasedHours),
                Low = g.Count(b => b.IsLow),
            })
            .ToListAsync(cancellationToken);
        return rows.Select(r => new OrganizationHourBankFacts(r.Key, r.Active, r.Remaining, r.Purchased, r.Low > 0)).ToList();
    }

    public async Task<IReadOnlyList<OrganizationAgreementEnding>> GetAgreementsEndingAsync(DateOnly from, DateOnly to, CancellationToken cancellationToken) =>
        await db.Contracts.AsNoTracking()
            .Where(c => c.Status == ContractStatus.Active && c.EndDate != null && c.EndDate >= from && c.EndDate <= to)
            .GroupBy(c => c.OrganizationId)
            .Select(g => new OrganizationAgreementEnding(g.Key, g.Min(c => c.EndDate!.Value), g.Count()))
            .ToListAsync(cancellationToken);

    public async Task<IReadOnlyList<OrganizationLowHourBanks>> GetLowHourBanksAsync(CancellationToken cancellationToken) =>
        await db.HourBanks.AsNoTracking()
            .Where(b => b.Status == HourBankStatus.Active)
            .Select(Balance)
            .Where(b => b.IsLow)
            .GroupBy(b => b.OrganizationId)
            .Select(g => new OrganizationLowHourBanks(g.Key, g.Count()))
            .ToListAsync(cancellationToken);
}

/// <summary>An hour bank reduced to what the facts add up; see <see cref="ContractFacts.Balance"/>.</summary>
internal sealed class HourBankFactsRow
{
    public Guid OrganizationId { get; init; }

    public decimal PurchasedHours { get; init; }

    public decimal RemainingHours { get; init; }

    public bool IsLow { get; init; }
}
