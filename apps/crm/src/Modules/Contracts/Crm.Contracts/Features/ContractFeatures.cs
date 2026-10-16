using Crm.Authorization;
using Crm.Catalog.Contracts;
using Crm.Contracts.Contracts;
using Crm.Contracts.Domain;
using Crm.Contracts.Persistence;
using Crm.Customers.Contracts;
using Crm.Identity.Contracts;
using Crm.Infrastructure.Persistence;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Results;
using FluentValidation;
using Microsoft.EntityFrameworkCore;

namespace Crm.Contracts.Features;

public sealed record ContractRequest(
    Guid OrganizationId,
    string Title,
    ContractType Type,
    DateOnly StartDate,
    DateOnly? EndDate,
    bool AutoRenew,
    int RenewalTermMonths,
    int NoticePeriodDays,
    Guid? SlaPolicyId,
    InvoiceFrequency InvoiceFrequency,
    InvoiceTiming InvoiceTiming,
    string? PriceCategory,
    bool Indexation,
    DateOnly? NextIndexationDate,
    string? CustomerReference,
    Guid? OwnerId,
    string? Notes)
{
    internal ContractTerms ToTerms() => new(
        Title, Type, StartDate, EndDate, AutoRenew, RenewalTermMonths, NoticePeriodDays, SlaPolicyId, InvoiceFrequency, InvoiceTiming, PriceCategory,
        Indexation, NextIndexationDate, CustomerReference, OwnerId, Notes);
}

internal sealed class ContractRequestValidator : AbstractValidator<ContractRequest>
{
    public ContractRequestValidator()
    {
        RuleFor(x => x.OrganizationId).NotEmpty();
        RuleFor(x => x.Title).NotEmpty().MaximumLength(256);
        RuleFor(x => x.Type).IsInEnum();
        RuleFor(x => x.EndDate).GreaterThanOrEqualTo(x => x.StartDate).When(x => x.EndDate is not null)
            .WithErrorCode("CON_INVALID_PERIOD").WithMessage("The end date must be on or after the start date.");
        RuleFor(x => x.EndDate).NotNull().When(x => x.AutoRenew).WithMessage("An automatically renewed contract needs an end date.");
        RuleFor(x => x.RenewalTermMonths).InclusiveBetween(0, 60);
        RuleFor(x => x.RenewalTermMonths).GreaterThan(0).When(x => x.AutoRenew);
        RuleFor(x => x.NoticePeriodDays).InclusiveBetween(0, 730);
        RuleFor(x => x.InvoiceFrequency).IsInEnum();
        RuleFor(x => x.InvoiceTiming).IsInEnum();
        RuleFor(x => x.PriceCategory).MaximumLength(32);
        RuleFor(x => x.CustomerReference).MaximumLength(128);
        RuleFor(x => x.Notes).MaximumLength(4000);
    }
}

public sealed record LineRequest(
    Guid ProductId,
    string? Description,
    QuantityModel QuantityModel,
    DeviceFilter? DeviceFilter,
    decimal Quantity,
    decimal? UnitPrice,
    decimal? DiscountPct,
    DateOnly ValidFrom,
    DateOnly? ValidTo)
{
    internal LineTerms ToTerms() => new(
        ProductId, Description, QuantityModel, DeviceFilter ?? Contracts.DeviceFilter.All, Quantity, UnitPrice, DiscountPct ?? 0, ValidFrom, ValidTo);
}

internal sealed class LineRequestValidator : AbstractValidator<LineRequest>
{
    public LineRequestValidator()
    {
        RuleFor(x => x.ProductId).NotEmpty();
        RuleFor(x => x.Description).MaximumLength(512);
        RuleFor(x => x.QuantityModel).IsInEnum();
        RuleFor(x => x.DeviceFilter).IsInEnum().When(x => x.DeviceFilter is not null);
        RuleFor(x => x.Quantity).InclusiveBetween(0, 1_000_000);
        RuleFor(x => x.UnitPrice).InclusiveBetween(0, 100_000_000).When(x => x.UnitPrice is not null);
        RuleFor(x => x.DiscountPct).InclusiveBetween(0, 100).When(x => x.DiscountPct is not null);
        RuleFor(x => x.ValidTo).GreaterThanOrEqualTo(x => x.ValidFrom).When(x => x.ValidTo is not null);
    }
}

public sealed record ReviseLineRequest(decimal Quantity, decimal? UnitPrice, decimal? DiscountPct, string? Description, DateOnly EffectiveFrom, DeviceFilter? DeviceFilter);

internal sealed class ReviseLineRequestValidator : AbstractValidator<ReviseLineRequest>
{
    public ReviseLineRequestValidator()
    {
        RuleFor(x => x.Quantity).InclusiveBetween(0, 1_000_000);
        RuleFor(x => x.UnitPrice).InclusiveBetween(0, 100_000_000).When(x => x.UnitPrice is not null);
        RuleFor(x => x.DiscountPct).InclusiveBetween(0, 100).When(x => x.DiscountPct is not null);
        RuleFor(x => x.Description).MaximumLength(512);
    }
}

public sealed record NoticeRequest(DateOnly? NoticeDate, DateOnly EndDate);

public sealed record EndRequest(DateOnly? EndDate);

public sealed record EndLineRequest(DateOnly EndDate);

public sealed record ContractListItem(
    Guid Id,
    string Number,
    string Title,
    RefDto Organization,
    ContractType Type,
    ContractStatus Status,
    DateOnly StartDate,
    DateOnly? EndDate,
    bool AutoRenew,
    RefDto? Owner,
    string? SlaName);

public sealed record ContractLineResponse(
    Guid Id,
    Guid SeriesId,
    int Version,
    Guid ProductId,
    string Sku,
    string ProductName,
    ProductUnit Unit,
    BillingPeriod BillingPeriod,
    string? Description,
    QuantityModel QuantityModel,
    DeviceFilter DeviceFilter,
    decimal Quantity,
    [property: SensitiveData(Permissions.FinanceRead)] decimal? UnitPrice,
    [property: SensitiveData(Permissions.FinanceRead)] decimal? EffectiveUnitPrice,
    [property: SensitiveData(Permissions.FinanceRead)] string? PriceSource,
    [property: SensitiveData(Permissions.FinanceRead)] decimal DiscountPct,
    [property: SensitiveData(Permissions.FinanceRead)] decimal? Amount,
    DateOnly ValidFrom,
    DateOnly? ValidTo,
    bool IsCurrent);

public sealed record ContractResponse(
    Guid Id,
    string Number,
    RefDto Organization,
    string Title,
    ContractType Type,
    ContractStatus Status,
    DateOnly StartDate,
    DateOnly? EndDate,
    bool AutoRenew,
    int RenewalTermMonths,
    int NoticePeriodDays,
    DateOnly? NoticeDeadline,
    RefDto? SlaPolicy,
    InvoiceFrequency InvoiceFrequency,
    InvoiceTiming InvoiceTiming,
    string? PriceCategory,
    bool Indexation,
    DateOnly? NextIndexationDate,
    string? CustomerReference,
    RefDto? Owner,
    string? Notes,
    DateOnly? NoticeGivenOn,
    DateOnly? EndedOn,
    int RenewalCount,
    [property: SensitiveData(Permissions.FinanceRead)] decimal? MonthlyValue,
    string Currency,
    IReadOnlyList<ContractLineResponse> Lines,
    DateTimeOffset CreatedAt,
    DateTimeOffset? ModifiedAt);

public sealed record ContractQuery(
    string? Search, Guid? OrganizationId, ContractStatus? Status, Guid? OwnerId, int? EndingWithinDays, string? Cursor, int? Limit);

internal sealed class ContractService(
    ContractsDbContext db,
    ICustomersApi customers,
    ICatalogApi catalog,
    IUserDirectory users,
    TimeProvider time)
{
    public async Task<PagedResult<ContractListItem>> ListAsync(ContractQuery q, CancellationToken ct)
    {
        var limit = KeysetCursor.ClampLimit(q.Limit);
        var contracts = db.Contracts.AsNoTracking();
        if (!string.IsNullOrWhiteSpace(q.Search))
        {
            var term = q.Search.Trim();
            contracts = contracts.Where(c => c.Number.Contains(term) || c.Title.Contains(term) || (c.CustomerReference != null && c.CustomerReference.Contains(term)));
        }

        if (q.OrganizationId is { } organizationId)
        {
            contracts = contracts.Where(c => c.OrganizationId == organizationId);
        }

        if (q.Status is { } status)
        {
            contracts = contracts.Where(c => c.Status == status);
        }

        if (q.OwnerId is { } ownerId)
        {
            contracts = contracts.Where(c => c.OwnerId == ownerId);
        }

        if (q.EndingWithinDays is { } days)
        {
            var until = time.Today().AddDays(days);
            contracts = contracts.Where(c => c.EndDate != null && c.EndDate <= until &&
                                             (c.Status == ContractStatus.Active || c.Status == ContractStatus.Suspended || c.Status == ContractStatus.NoticeGiven));
        }

        // Newest numbers first.
        if (KeysetCursor.Decode(q.Cursor) is { } cursor)
        {
            contracts = contracts.Where(c => c.Number.CompareTo(cursor.SortKey) < 0 || (c.Number == cursor.SortKey && c.Id.CompareTo(cursor.Id) < 0));
        }

        var page = await contracts.OrderByDescending(c => c.Number).ThenByDescending(c => c.Id).Take(limit + 1)
            .Select(c => new
            {
                c.Id, c.Number, c.Title, c.OrganizationId, c.Type, c.Status, c.StartDate, c.EndDate, c.AutoRenew, c.OwnerId,
                SlaName = db.SlaPolicies.Where(p => p.Id == c.SlaPolicyId).Select(p => p.Name).FirstOrDefault(),
            })
            .ToListAsync(ct);
        var items = page.Take(limit).ToList();
        var organizations = await customers.GetOrganizationNamesAsync(items.Select(i => i.OrganizationId).Distinct().ToList(), ct);
        var owners = await users.GetUsersAsync(items.Where(i => i.OwnerId != null).Select(i => i.OwnerId!.Value).Distinct().ToList(), ct);

        var result = items.Select(c => new ContractListItem(
            c.Id, c.Number, c.Title, new RefDto(c.OrganizationId, organizations.GetValueOrDefault(c.OrganizationId, "—")), c.Type, c.Status, c.StartDate, c.EndDate,
            c.AutoRenew, c.OwnerId is { } o && owners.TryGetValue(o, out var u) ? new RefDto(u.Id, u.DisplayName) : null, c.SlaName)).ToList();
        var last = items.LastOrDefault();
        return new PagedResult<ContractListItem>(result, page.Count > limit && last is not null ? new KeysetCursor(last.Number, last.Id).Encode() : null);
    }

    public async Task<Result<Versioned<ContractResponse>>> GetAsync(Guid id, CancellationToken ct)
    {
        var contract = await LoadAsync(id, ct);
        return contract is null ? NotFound(id) : await RespondAsync(contract, ct);
    }

    public async Task<Result<Versioned<ContractResponse>>> CreateAsync(ContractRequest request, CancellationToken ct)
    {
        if (await CheckReferencesAsync(request, ct) is { } error)
        {
            return error;
        }

        var number = await db.NextContractNumberAsync(request.StartDate.Year, ct);
        var created = Contract.Create(number, request.OrganizationId, request.ToTerms());
        if (!created.IsSuccess)
        {
            return created.Error!;
        }

        db.Contracts.Add(created.Value);
        await db.SaveChangesAsync(ct);
        return await RespondAsync(created.Value, ct);
    }

    public async Task<Result<Versioned<ContractResponse>>> UpdateAsync(Guid id, ContractRequest request, string ifMatch, CancellationToken ct)
    {
        if (await LoadAsync(id, ct) is not { } contract)
        {
            return NotFound(id);
        }

        if (!db.ApplyIfMatch(contract, ifMatch))
        {
            return CommonErrors.InvalidETag;
        }

        if (await CheckReferencesAsync(request, ct) is { } error)
        {
            return error;
        }

        var updated = contract.Update(request.OrganizationId, request.ToTerms());
        if (!updated.IsSuccess)
        {
            return updated.Error!;
        }

        await db.SaveChangesAsync(ct);
        return await RespondAsync(contract, ct);
    }

    public Task<Result<Versioned<ContractResponse>>> TransitionAsync(Guid id, Func<Contract, Result> transition, CancellationToken ct) =>
        MutateAsync(id, contract => transition(contract), ct);

    public async Task<Result> DeleteAsync(Guid id, CancellationToken ct)
    {
        if (await LoadAsync(id, ct) is not { } contract)
        {
            return NotFound(id);
        }

        if (contract.Status != ContractStatus.Draft)
        {
            return ContractErrors.OnlyDraftCanBeDeleted;
        }

        contract.MarkDeleted();
        await db.SaveChangesAsync(ct);
        return Result.Success();
    }

    public async Task<Result<Versioned<ContractResponse>>> AddLineAsync(Guid id, LineRequest request, CancellationToken ct)
    {
        if (await CheckProductAsync(request.ProductId, ct) is { } error)
        {
            return error;
        }

        return await MutateAsync(id, contract => contract.AddLine(request.ToTerms()), ct);
    }

    public Task<Result<Versioned<ContractResponse>>> ReviseLineAsync(Guid id, Guid lineId, ReviseLineRequest request, CancellationToken ct) =>
        MutateAsync(id, contract =>
        {
            if (contract.Lines.SingleOrDefault(l => l.Id == lineId) is not { } line)
            {
                return ContractErrors.LineNotFound(lineId);
            }

            var terms = new LineTerms(line.ProductId, request.Description ?? line.Description, line.QuantityModel, request.DeviceFilter ?? line.DeviceFilter,
                request.Quantity, request.UnitPrice, request.DiscountPct ?? 0, line.ValidFrom, line.ValidTo);
            return contract.ReviseLine(lineId, terms, request.EffectiveFrom);
        }, ct);

    public Task<Result<Versioned<ContractResponse>>> EndLineAsync(Guid id, Guid lineId, DateOnly endDate, CancellationToken ct) =>
        MutateAsync(id, contract => contract.EndLine(lineId, endDate), ct);

    public Task<Result<Versioned<ContractResponse>>> RemoveLineAsync(Guid id, Guid lineId, CancellationToken ct) =>
        MutateAsync(id, contract => contract.RemoveLine(lineId), ct);

    private async Task<Result<Versioned<ContractResponse>>> MutateAsync(Guid id, Func<Contract, Result> change, CancellationToken ct)
    {
        if (await LoadAsync(id, ct) is not { } contract)
        {
            return NotFound(id);
        }

        var result = change(contract);
        if (!result.IsSuccess)
        {
            return result.Error!;
        }

        // Line changes also bump the contract's row version, so an open edit form notices them.
        db.Entry(contract).Property(c => c.ModifiedAt).IsModified = true;
        await db.SaveChangesAsync(ct);
        return await RespondAsync(contract, ct);
    }

    private Task<Contract?> LoadAsync(Guid id, CancellationToken ct) =>
        db.Contracts.Include(c => c.Lines).SingleOrDefaultAsync(c => c.Id == id, ct);

    private async Task<Error?> CheckReferencesAsync(ContractRequest request, CancellationToken ct)
    {
        if (await customers.GetOrganizationAsync(request.OrganizationId, ct) is null)
        {
            return CommonErrors.OrganizationNotFound(request.OrganizationId);
        }

        if (request.SlaPolicyId is { } slaId && !await db.SlaPolicies.AnyAsync(p => p.Id == slaId, ct))
        {
            return Error.Validation("CON_UNKNOWN_SLA", $"SLA policy {slaId} does not exist.");
        }

        return null;
    }

    private async Task<Error?> CheckProductAsync(Guid productId, CancellationToken ct)
    {
        var products = await catalog.GetProductsAsync([productId], ct);
        return products.TryGetValue(productId, out var product) && product.IsActive
            ? null
            : Error.Validation("CON_UNKNOWN_PRODUCT", "The product does not exist or is inactive.");
    }

    private async Task<Result<Versioned<ContractResponse>>> RespondAsync(Contract c, CancellationToken ct)
    {
        var today = time.Today();
        var lines = c.Lines.Where(l => !l.IsDeleted).OrderBy(l => l.SeriesId).ThenBy(l => l.Version).ToList();
        var productIds = lines.Select(l => l.ProductId).Distinct().ToList();
        var products = await catalog.GetProductsAsync(productIds, ct);
        var prices = await catalog.ResolvePricesAsync(productIds, c.PriceCategory, today, ct);
        var organizations = await customers.GetOrganizationNamesAsync([c.OrganizationId], ct);
        var owner = c.OwnerId is { } ownerId ? (await users.GetUsersAsync([ownerId], ct)).GetValueOrDefault(ownerId) : null;
        var sla = c.SlaPolicyId is { } slaId
            ? await db.SlaPolicies.AsNoTracking().Where(p => p.Id == slaId).Select(p => new RefDto(p.Id, p.Name)).SingleOrDefaultAsync(ct)
            : null;

        decimal monthly = 0;
        var lineResponses = new List<ContractLineResponse>();
        foreach (var line in lines)
        {
            var product = products.GetValueOrDefault(line.ProductId);
            var resolved = prices.GetValueOrDefault(line.ProductId);
            decimal? effective = line.UnitPrice ?? resolved?.UnitPrice;
            var source = line.UnitPrice is not null ? "Contract" : resolved?.PriceListId is not null ? "PriceList" : resolved is not null ? "ListPrice" : null;
            decimal? amount = effective is { } price ? ContractLine.Amount(line.Quantity, price, line.DiscountPct) : null;
            var current = line.Covers(today) || (line.ValidFrom > today && c.Status == ContractStatus.Draft);
            if (current && amount is { } a && product is not null && c.Status != ContractStatus.Ended)
            {
                monthly += product.BillingPeriod switch
                {
                    BillingPeriod.Monthly => a,
                    BillingPeriod.Quarterly => a / 3m,
                    BillingPeriod.Yearly => a / 12m,
                    _ => 0,
                };
            }

            lineResponses.Add(new ContractLineResponse(
                line.Id, line.SeriesId, line.Version, line.ProductId, product?.Sku ?? "?", product?.Name ?? "?", product?.Unit ?? ProductUnit.Piece,
                product?.BillingPeriod ?? BillingPeriod.Monthly, line.Description, line.QuantityModel, line.DeviceFilter, line.Quantity, line.UnitPrice,
                effective, source, line.DiscountPct, amount, line.ValidFrom, line.ValidTo, current));
        }

        var response = new ContractResponse(
            c.Id, c.Number, new RefDto(c.OrganizationId, organizations.GetValueOrDefault(c.OrganizationId, "—")), c.Title, c.Type, c.Status, c.StartDate, c.EndDate,
            c.AutoRenew, c.RenewalTermMonths, c.NoticePeriodDays, c.EndDate?.AddDays(-c.NoticePeriodDays), sla, c.InvoiceFrequency, c.InvoiceTiming,
            c.PriceCategory, c.Indexation, c.NextIndexationDate, c.CustomerReference, owner is null ? null : new RefDto(owner.Id, owner.DisplayName), c.Notes,
            c.NoticeGivenOn, c.EndedOn, c.RenewalCount, decimal.Round(monthly, 2), "NOK", lineResponses, c.CreatedAt, c.ModifiedAt);
        return new Versioned<ContractResponse>(response, db.GetETag(c));
    }

    private static Error NotFound(Guid id) => Error.NotFound("CON_CONTRACT_NOT_FOUND", $"Contract {id} was not found.");
}
