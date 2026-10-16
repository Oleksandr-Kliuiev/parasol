using Crm.Authorization;
using Crm.Catalog.Contracts;
using Crm.Contracts.Contracts;
using Crm.Contracts.Domain;
using Crm.Contracts.Persistence;
using Crm.Customers.Contracts;
using Crm.Infrastructure.Persistence;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Results;
using FluentValidation;
using Microsoft.EntityFrameworkCore;

namespace Crm.Contracts.Features;

public sealed record IndexationRequest(decimal Percent, DateOnly EffectiveFrom, IReadOnlyList<Guid> ContractIds);

internal sealed class IndexationRequestValidator : AbstractValidator<IndexationRequest>
{
    public IndexationRequestValidator()
    {
        // A yearly KPI adjustment; anything outside this is a mistake, not an index.
        RuleFor(x => x.Percent).InclusiveBetween(-20m, 20m).NotEqual(0m);
        RuleFor(x => x.ContractIds).NotEmpty().Must(ids => ids.Count <= 5000).WithMessage("At most 5000 contracts are indexed at a time.");
    }
}

public sealed record IndexationLine(
    Guid SeriesId,
    string ProductName,
    string? Description,
    decimal Quantity,
    [property: SensitiveData(Permissions.FinanceRead)] decimal PriceBefore,
    [property: SensitiveData(Permissions.FinanceRead)] decimal PriceAfter);

/// <summary>One contract in the indexation preview: what it costs today and what it costs after (BR-CON-06).</summary>
public sealed record IndexationCandidate(
    Guid ContractId,
    string Number,
    string Title,
    RefDto Organization,
    DateOnly? NextIndexationDate,
    [property: SensitiveData(Permissions.FinanceRead)] decimal MonthlyBefore,
    [property: SensitiveData(Permissions.FinanceRead)] decimal MonthlyAfter,
    int PriceListLines,
    IReadOnlyList<IndexationLine> Lines);

/// <summary>The monthly amount of a set of contracts before and after the index, summed on the server (DEV-12).</summary>
public sealed record IndexationTotals(
    int Contracts,
    [property: SensitiveData(Permissions.FinanceRead)] decimal MonthlyBefore,
    [property: SensitiveData(Permissions.FinanceRead)] decimal MonthlyAfter);

/// <summary>Every contract due for indexation on the date — none left out — and their totals (DEV-12).</summary>
public sealed record IndexationPreview(decimal Percent, DateOnly EffectiveFrom, IReadOnlyList<IndexationCandidate> Contracts, IndexationTotals Totals);

/// <summary>
/// What was changed, and who has to be told about it (BR-CON-06). <paramref name="Skipped"/> are requested contracts the preview
/// would not offer on that date (no indexation clause, not yet due, not in force): they are left alone, never indexed.
/// </summary>
public sealed record IndexationResult(int Contracts, int Lines, IReadOnlyList<IndexationCandidate> Changed, IndexationTotals Totals, IReadOnlyList<Guid> Skipped);

/// <summary>
/// Yearly price indexation of contracts (FR-CON-05). The preview and the real thing walk the same contracts and compute the
/// same prices; only lines with an own price move, because a line that follows the price list is indexed with the list.
/// </summary>
internal sealed class IndexationService(
    ContractsDbContext db,
    ICustomersApi customers,
    ICatalogApi catalog,
    ICurrentUser currentUser,
    IRequestContext requestContext,
    TimeProvider time)
{
    public async Task<IndexationPreview> PreviewAsync(decimal percent, DateOnly effectiveFrom, Guid? organizationId, CancellationToken ct)
    {
        var contracts = await LoadCandidatesAsync(effectiveFrom, organizationId, null, ct);
        var products = await catalog.GetProductsAsync(
            contracts.SelectMany(c => c.Lines).Select(l => l.ProductId).Distinct().ToList(), ct);
        var organizations = await customers.GetOrganizationNamesAsync(contracts.Select(c => c.OrganizationId).Distinct().ToList(), ct);

        var candidates = contracts
            .Select(contract => Describe(contract, percent, effectiveFrom, products, organizations))
            .Where(candidate => candidate.Lines.Count > 0 || candidate.PriceListLines > 0)
            .OrderBy(candidate => candidate.Organization.Name, StringComparer.CurrentCultureIgnoreCase)
            .ToList();
        return new IndexationPreview(percent, effectiveFrom, candidates, TotalsOf(candidates));
    }

    private static IndexationTotals TotalsOf(List<IndexationCandidate> candidates) =>
        new(candidates.Count, candidates.Sum(c => c.MonthlyBefore), candidates.Sum(c => c.MonthlyAfter));

    public async Task<Result<IndexationResult>> ApplyAsync(IndexationRequest request, CancellationToken ct)
    {
        // The preview's rules apply to the request too: a contract the preview would not offer is never indexed (DEV-12).
        var contracts = await LoadCandidatesAsync(request.EffectiveFrom, null, request.ContractIds, ct);
        var skipped = request.ContractIds.Distinct().Except(contracts.Select(c => c.Id)).ToList();
        if (contracts.Count == 0)
        {
            return Error.Validation("CON_NOTHING_TO_INDEX", "None of the selected contracts can be indexed on that date.");
        }

        var products = await catalog.GetProductsAsync(contracts.SelectMany(c => c.Lines).Select(l => l.ProductId).Distinct().ToList(), ct);
        var organizations = await customers.GetOrganizationNamesAsync(contracts.Select(c => c.OrganizationId).Distinct().ToList(), ct);

        var changed = new List<IndexationCandidate>();
        var lines = 0;
        foreach (var contract in contracts)
        {
            var before = Describe(contract, request.Percent, request.EffectiveFrom, products, organizations);
            var indexed = contract.Index(request.Percent, request.EffectiveFrom);
            if (!indexed.IsSuccess || indexed.Value.Count == 0)
            {
                continue;
            }

            lines += indexed.Value.Count;
            changed.Add(before with { Lines = before.Lines.Where(l => indexed.Value.Any(i => i.SeriesId == l.SeriesId)).ToList() });
            db.RecordAudit(currentUser, requestContext, time, "Index", "Contract", contract.Id, new
            {
                request.Percent,
                request.EffectiveFrom,
                Lines = indexed.Value.Count,
            });
        }

        if (changed.Count == 0)
        {
            return Error.Validation("CON_NOTHING_TO_INDEX", "The selected contracts have no lines with their own price.");
        }

        await db.SaveChangesAsync(ct);
        return new IndexationResult(changed.Count, lines, changed, TotalsOf(changed), skipped);
    }

    private async Task<List<Contract>> LoadCandidatesAsync(
        DateOnly effectiveFrom, Guid? organizationId, IReadOnlyList<Guid>? ids, CancellationToken ct)
    {
        var query = db.Contracts.Include(c => c.Lines).AsQueryable()
            .Where(c => c.Status == ContractStatus.Active || c.Status == ContractStatus.NoticeGiven || c.Status == ContractStatus.Suspended)
            .Where(c => c.StartDate <= effectiveFrom && (c.EndDate == null || c.EndDate >= effectiveFrom));
        // Only contracts that agreed to indexation and are due — for the preview and for an explicit selection alike.
        query = query.Where(c => c.Indexation && (c.NextIndexationDate == null || c.NextIndexationDate <= effectiveFrom));
        if (ids is { Count: > 0 })
        {
            query = query.Where(c => ids.Contains(c.Id));
        }

        if (organizationId is { } organization)
        {
            query = query.Where(c => c.OrganizationId == organization);
        }

        // Every due contract: the preview leaves none out, so its totals and its selection cover them all (DEV-12).
        return await query.OrderBy(c => c.Number).ToListAsync(ct);
    }

    private static IndexationCandidate Describe(
        Contract contract,
        decimal percent,
        DateOnly effectiveFrom,
        IReadOnlyDictionary<Guid, ProductRef> products,
        IReadOnlyDictionary<Guid, string> organizations)
    {
        var inForce = contract.Lines.Where(l => l.Covers(effectiveFrom)).ToList();
        // A line's amount covers one invoice period, so a quarterly or yearly contract is divided down to a month.
        var months = BillingMonths(contract.InvoiceFrequency);
        var lines = new List<IndexationLine>();
        decimal before = 0, after = 0;
        foreach (var line in inForce)
        {
            if (line.UnitPrice is not { } price)
            {
                continue;
            }

            var next = decimal.Round(price * (1 + (percent / 100m)), 2);
            before += ContractLine.Amount(line.Quantity, price, line.DiscountPct);
            after += ContractLine.Amount(line.Quantity, next, line.DiscountPct);
            if (next != price)
            {
                lines.Add(new IndexationLine(
                    line.SeriesId,
                    products.GetValueOrDefault(line.ProductId)?.Name ?? "—",
                    line.Description,
                    line.Quantity,
                    price,
                    next));
            }
        }

        return new IndexationCandidate(
            contract.Id,
            contract.Number,
            contract.Title,
            new RefDto(contract.OrganizationId, organizations.GetValueOrDefault(contract.OrganizationId, "—")),
            contract.NextIndexationDate,
            decimal.Round(before / months, 2),
            decimal.Round(after / months, 2),
            inForce.Count(l => l.UnitPrice is null),
            lines);
    }

    /// <summary>A quarterly or yearly contract is shown per month, so amounts compare across contracts.</summary>
    private static decimal BillingMonths(InvoiceFrequency frequency) => frequency switch
    {
        InvoiceFrequency.Quarterly => 3,
        InvoiceFrequency.Yearly => 12,
        _ => 1,
    };
}
