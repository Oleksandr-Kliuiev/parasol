using System.Globalization;
using Crm.Authorization;
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

public sealed record CreateHourBankRequest(
    Guid OrganizationId, Guid? ContractId, string Name, decimal Hours, DateOnly ValidFrom, DateOnly? ValidTo, decimal? OverageRate, decimal? LowBalancePct);

internal sealed class CreateHourBankRequestValidator : AbstractValidator<CreateHourBankRequest>
{
    public CreateHourBankRequestValidator()
    {
        RuleFor(x => x.OrganizationId).NotEmpty();
        RuleFor(x => x.Name).NotEmpty().MaximumLength(128);
        RuleFor(x => x.Hours).GreaterThan(0).LessThanOrEqualTo(10_000);
        RuleFor(x => x.ValidTo).GreaterThanOrEqualTo(x => x.ValidFrom).When(x => x.ValidTo is not null);
        RuleFor(x => x.OverageRate).InclusiveBetween(0, 1_000_000).When(x => x.OverageRate is not null);
        RuleFor(x => x.LowBalancePct).InclusiveBetween(0, 100).When(x => x.LowBalancePct is not null);
    }
}

public sealed record HourBankEntryRequest(HourBankEntryKind Kind, decimal Hours, DateOnly Date, string? Description);

internal sealed class HourBankEntryRequestValidator : AbstractValidator<HourBankEntryRequest>
{
    public HourBankEntryRequestValidator()
    {
        RuleFor(x => x.Kind).IsInEnum();
        RuleFor(x => x.Hours).NotEqual(0).InclusiveBetween(-10_000, 10_000);
        RuleFor(x => x.Hours).GreaterThan(0).When(x => x.Kind != HourBankEntryKind.Adjustment)
            .WithMessage("Purchases and consumption are entered as positive hours.");
        RuleFor(x => x.Description).NotEmpty().When(x => x.Kind == HourBankEntryKind.Adjustment)
            .WithMessage("Explain why the balance is adjusted.");
        RuleFor(x => x.Description).MaximumLength(512);
    }
}

public sealed record HourBankEntryResponse(
    Guid Id, HourBankEntryKind Kind, DateOnly Date, decimal Hours, decimal OverageHours, string? Description, string? SourceType, RefDto? CreatedBy, DateTimeOffset CreatedAt);

public sealed record HourBankResponse(
    Guid Id,
    RefDto Organization,
    Guid? ContractId,
    string? ContractNumber,
    string Name,
    DateOnly ValidFrom,
    DateOnly? ValidTo,
    decimal PurchasedHours,
    decimal UsedHours,
    decimal RemainingHours,
    decimal OverageHours,
    [property: SensitiveData(Permissions.FinanceRead)] decimal? OverageRate,
    decimal LowBalancePct,
    bool IsLow,
    HourBankStatus Status,
    IReadOnlyList<HourBankEntryResponse>? Entries);

internal sealed class HourBankService(ContractsDbContext db, ICustomersApi customers, IUserDirectory users, TimeProvider time)
{
    public async Task<PagedResult<HourBankResponse>> ListAsync(Guid? organizationId, Guid? contractId, bool includeClosed, int? limit, string? cursor, CancellationToken ct)
    {
        var banks = db.HourBanks.AsNoTracking();
        if (organizationId is { } org)
        {
            banks = banks.Where(b => b.OrganizationId == org);
        }

        if (contractId is { } contract)
        {
            banks = banks.Where(b => b.ContractId == contract);
        }

        if (!includeClosed)
        {
            banks = banks.Where(b => b.Status == HourBankStatus.Active);
        }

        // Newest first, then id (DEV-12): a page per request and the count of all, never a silent cut.
        var total = await banks.CountAsync(ct);
        if (KeysetCursor.Decode(cursor) is { } after &&
            DateOnly.TryParseExact(after.SortKey, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var from))
        {
            banks = banks.Where(b => b.ValidFrom < from || (b.ValidFrom == from && b.Id.CompareTo(after.Id) < 0));
        }

        var take = KeysetCursor.ClampLimit(limit);
        var page = await banks.OrderByDescending(b => b.ValidFrom).ThenByDescending(b => b.Id).Take(take + 1).ToListAsync(ct);
        var rows = page.Take(take).ToList();
        var next = page.Count > take ? new KeysetCursor(rows[^1].ValidFrom.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture), rows[^1].Id).Encode() : null;
        return new PagedResult<HourBankResponse>(await ToResponsesAsync(rows, withEntries: false, ct), next, total);
    }

    public async Task<Result<HourBankResponse>> GetAsync(Guid id, CancellationToken ct)
    {
        var bank = await db.HourBanks.AsNoTracking().SingleOrDefaultAsync(b => b.Id == id, ct);
        return bank is null ? NotFound(id) : (await ToResponsesAsync([bank], withEntries: true, ct))[0];
    }

    public async Task<Result<HourBankResponse>> CreateAsync(CreateHourBankRequest request, CancellationToken ct)
    {
        if (await customers.GetOrganizationAsync(request.OrganizationId, ct) is null)
        {
            return CommonErrors.OrganizationNotFound(request.OrganizationId);
        }

        if (request.ContractId is { } contractId &&
            !await db.Contracts.AnyAsync(c => c.Id == contractId && c.OrganizationId == request.OrganizationId, ct))
        {
            return Error.Validation("CON_UNKNOWN_CONTRACT", "The contract does not exist or belongs to another organization.");
        }

        var created = HourBank.Create(request.OrganizationId, request.ContractId, request.Name, request.Hours, request.ValidFrom, request.ValidTo,
            request.OverageRate, request.LowBalancePct);
        if (!created.IsSuccess)
        {
            return created.Error!;
        }

        db.HourBanks.Add(created.Value.Bank);
        db.HourBankEntries.Add(created.Value.Entry);
        await db.SaveChangesAsync(ct);
        return await GetAsync(created.Value.Bank.Id, ct);
    }

    public async Task<Result<HourBankResponse>> AddEntryAsync(Guid id, HourBankEntryRequest request, CancellationToken ct)
    {
        if (await db.HourBanks.SingleOrDefaultAsync(b => b.Id == id, ct) is not { } bank)
        {
            return NotFound(id);
        }

        var result = Record(bank, request.Kind, request.Hours, request.Date, request.Description, null, null);
        if (!result.IsSuccess)
        {
            return result.Error!;
        }

        db.HourBankEntries.Add(result.Value);
        await db.SaveChangesAsync(ct);
        return await GetAsync(id, ct);
    }

    public async Task<Result> CloseAsync(Guid id, CancellationToken ct)
    {
        if (await db.HourBanks.SingleOrDefaultAsync(b => b.Id == id, ct) is not { } bank)
        {
            return NotFound(id);
        }

        bank.Close();
        await db.SaveChangesAsync(ct);
        return Result.Success();
    }

    /// <summary>Idempotent consumption for other modules (time tracking). Retries once when another consumption changed the balance.</summary>
    public async Task<HourBankConsumption?> ConsumeFromSourceAsync(
        Guid id, decimal hours, DateOnly date, string description, string sourceType, string sourceId, CancellationToken ct)
    {
        for (var attempt = 0; ; attempt++)
        {
            if (await db.HourBankEntries.AsNoTracking().SingleOrDefaultAsync(e => e.SourceType == sourceType && e.SourceId == sourceId, ct) is { } existing)
            {
                var existingBank = await db.HourBanks.AsNoTracking().SingleAsync(b => b.Id == existing.HourBankId, ct);
                return new HourBankConsumption(existing.HourBankId, -existing.Hours + existing.OverageHours, existing.OverageHours, existingBank.RemainingHours);
            }

            if (await db.HourBanks.SingleOrDefaultAsync(b => b.Id == id, ct) is not { } bank)
            {
                return null;
            }

            var entry = bank.Consume(hours, date, description, sourceType, sourceId, time.GetUtcNow());
            if (!entry.IsSuccess)
            {
                return null;
            }

            db.HourBankEntries.Add(entry.Value);
            try
            {
                await db.SaveChangesAsync(ct);
                return new HourBankConsumption(bank.Id, hours, entry.Value.OverageHours, bank.RemainingHours);
            }
            catch (DbUpdateException) when (attempt < 2)
            {
                db.ChangeTracker.Clear();
            }
        }
    }

    /// <summary>Gives back what a source consumed (approval withdrawn). Idempotent: a second call finds the reversal and does nothing.</summary>
    public async Task ReverseAsync(string sourceType, string sourceId, CancellationToken ct)
    {
        var reversalType = sourceType + ReversalSuffix;
        if (await db.HourBankEntries.AnyAsync(e => e.SourceType == reversalType && e.SourceId == sourceId, ct))
        {
            return;
        }

        if (await db.HourBankEntries.AsNoTracking().SingleOrDefaultAsync(e => e.SourceType == sourceType && e.SourceId == sourceId, ct) is not { } consumption)
        {
            return;
        }

        if (await db.HourBanks.SingleOrDefaultAsync(b => b.Id == consumption.HourBankId, ct) is not { } bank)
        {
            return;
        }

        var entry = bank.Adjust(-consumption.Hours, consumption.Date, $"Reversal: {consumption.Description ?? sourceId}", time.GetUtcNow());
        entry.AttachSource(reversalType, sourceId);
        db.HourBankEntries.Add(entry);
        await db.SaveChangesAsync(ct);
    }

    private const string ReversalSuffix = "Reversal";

    private Result<HourBankEntry> Record(HourBank bank, HourBankEntryKind kind, decimal hours, DateOnly date, string? description, string? sourceType, string? sourceId) =>
        kind switch
        {
            HourBankEntryKind.Purchase => bank.Status == HourBankStatus.Closed
                ? Error.Conflict("CON_HOUR_BANK_CLOSED", "The hour bank is closed.")
                : bank.Purchase(hours, date, description),
            HourBankEntryKind.Consumption => bank.Consume(hours, date, description, sourceType, sourceId, time.GetUtcNow()),
            _ => bank.Adjust(hours, date, description!, time.GetUtcNow()),
        };

    private async Task<IReadOnlyList<HourBankResponse>> ToResponsesAsync(IReadOnlyList<HourBank> banks, bool withEntries, CancellationToken ct)
    {
        var organizations = await customers.GetOrganizationNamesAsync(banks.Select(b => b.OrganizationId).Distinct().ToList(), ct);
        var contractIds = banks.Where(b => b.ContractId != null).Select(b => b.ContractId!.Value).Distinct().ToList();
        var numbers = await db.Contracts.AsNoTracking().IgnoreQueryFilters().Where(c => contractIds.Contains(c.Id)).ToDictionaryAsync(c => c.Id, c => c.Number, ct);

        List<HourBankEntry> entries = [];
        IReadOnlyDictionary<Guid, UserSummary> authors = new Dictionary<Guid, UserSummary>();
        if (withEntries)
        {
            var ids = banks.Select(b => b.Id).ToList();
            entries = await db.HourBankEntries.AsNoTracking().Where(e => ids.Contains(e.HourBankId))
                .OrderByDescending(e => e.Date).ThenByDescending(e => e.CreatedAt).ToListAsync(ct);
            authors = await users.GetUsersAsync(entries.Where(e => e.CreatedBy != null).Select(e => e.CreatedBy!.Value).Distinct().ToList(), ct);
        }

        return banks.Select(b => new HourBankResponse(
            b.Id, new RefDto(b.OrganizationId, organizations.GetValueOrDefault(b.OrganizationId, "—")), b.ContractId,
            b.ContractId is { } cid ? numbers.GetValueOrDefault(cid) : null, b.Name, b.ValidFrom, b.ValidTo, b.PurchasedHours, b.UsedHours, b.RemainingHours,
            b.OverageHours, b.OverageRate, b.LowBalancePct, b.IsLow, b.Status,
            withEntries
                ? entries.Where(e => e.HourBankId == b.Id).Select(e => new HourBankEntryResponse(
                    e.Id, e.Kind, e.Date, e.Hours, e.OverageHours, e.Description, e.SourceType,
                    e.CreatedBy is { } by && authors.TryGetValue(by, out var u) ? new RefDto(u.Id, u.DisplayName) : null, e.CreatedAt)).ToList()
                : null)).ToList();
    }

    private static Error NotFound(Guid id) => Error.NotFound("CON_HOUR_BANK_NOT_FOUND", $"Hour bank {id} was not found.");
}
