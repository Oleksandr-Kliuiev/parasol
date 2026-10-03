using Crm.Authorization;
using Crm.Contracts.Contracts;
using Crm.Contracts.Domain;
using Crm.Contracts.Persistence;
using Crm.Infrastructure.Persistence;
using Crm.SharedKernel.Results;
using FluentValidation;
using Microsoft.EntityFrameworkCore;

namespace Crm.Contracts.Features;

public sealed record PriorityTargetDto(int ResponseMinutes, int ResolutionMinutes)
{
    internal PriorityTarget ToDomain() => new(ResponseMinutes, ResolutionMinutes);

    internal static PriorityTargetDto From(PriorityTarget t) => new(t.ResponseMinutes, t.ResolutionMinutes);
}

public sealed record SlaPolicyRequest(
    string Name,
    SupportCoverage Coverage,
    PriorityTargetDto P1,
    PriorityTargetDto P2,
    PriorityTargetDto P3,
    PriorityTargetDto P4,
    decimal IncludedHoursPerMonth,
    decimal? OverageRate,
    decimal AfterHoursMultiplier,
    string? CoveredWorkTypes,
    string? AteraValue,
    bool IsActive = true)
{
    internal SlaPolicyDetails ToDetails() => new(
        Name, Coverage, P1.ToDomain(), P2.ToDomain(), P3.ToDomain(), P4.ToDomain(), IncludedHoursPerMonth, OverageRate, AfterHoursMultiplier, CoveredWorkTypes, AteraValue);
}

internal sealed class SlaPolicyRequestValidator : AbstractValidator<SlaPolicyRequest>
{
    public SlaPolicyRequestValidator()
    {
        RuleFor(x => x.Name).NotEmpty().MaximumLength(128);
        RuleFor(x => x.Coverage).IsInEnum();
        RuleFor(x => x.P1).NotNull().SetValidator(new PriorityTargetValidator());
        RuleFor(x => x.P2).NotNull().SetValidator(new PriorityTargetValidator());
        RuleFor(x => x.P3).NotNull().SetValidator(new PriorityTargetValidator());
        RuleFor(x => x.P4).NotNull().SetValidator(new PriorityTargetValidator());
        RuleFor(x => x).Must(x => x.P1.ResponseMinutes <= x.P2.ResponseMinutes && x.P2.ResponseMinutes <= x.P3.ResponseMinutes && x.P3.ResponseMinutes <= x.P4.ResponseMinutes)
            .When(x => x.P1 is not null && x.P2 is not null && x.P3 is not null && x.P4 is not null)
            .WithErrorCode("CON_SLA_PRIORITY_ORDER").WithMessage("A higher priority cannot have a longer response time than a lower one.");
        RuleFor(x => x.IncludedHoursPerMonth).InclusiveBetween(0, 10_000);
        RuleFor(x => x.OverageRate).InclusiveBetween(0, 1_000_000).When(x => x.OverageRate is not null);
        RuleFor(x => x.AfterHoursMultiplier).InclusiveBetween(1, 5);
        RuleFor(x => x.CoveredWorkTypes).MaximumLength(512);
        RuleFor(x => x.AteraValue).MaximumLength(128);
    }
}

internal sealed class PriorityTargetValidator : AbstractValidator<PriorityTargetDto>
{
    public PriorityTargetValidator()
    {
        RuleFor(v => v.ResponseMinutes).InclusiveBetween(1, 60 * 24 * 30);
        RuleFor(v => v.ResolutionMinutes).InclusiveBetween(1, 60 * 24 * 90).GreaterThanOrEqualTo(v => v.ResponseMinutes)
            .WithMessage("Resolution time cannot be shorter than response time.");
    }
}

public sealed record SlaPolicyResponse(
    Guid Id,
    string Name,
    SupportCoverage Coverage,
    PriorityTargetDto P1,
    PriorityTargetDto P2,
    PriorityTargetDto P3,
    PriorityTargetDto P4,
    decimal IncludedHoursPerMonth,
    [property: SensitiveData(Permissions.FinanceRead)] decimal? OverageRate,
    decimal AfterHoursMultiplier,
    string? CoveredWorkTypes,
    string? AteraValue,
    bool IsActive,
    int ContractCount,
    string Etag);

internal sealed class SlaPolicyService(ContractsDbContext db)
{
    public async Task<IReadOnlyList<SlaPolicyResponse>> ListAsync(bool includeInactive, CancellationToken ct)
    {
        // Tracked on purpose: every row carries its ETag. There are only a handful of policies.
        var policies = await db.SlaPolicies.Where(p => includeInactive || p.IsActive).OrderBy(p => p.Name).ToListAsync(ct);
        var counts = await db.Contracts.AsNoTracking()
            .Where(c => c.SlaPolicyId != null && c.Status != ContractStatus.Ended)
            .GroupBy(c => c.SlaPolicyId!.Value)
            .Select(g => new { g.Key, Count = g.Count() })
            .ToDictionaryAsync(x => x.Key, x => x.Count, ct);
        return policies.Select(p => ToResponse(p, counts.GetValueOrDefault(p.Id))).ToList();
    }

    public async Task<Result<SlaPolicyResponse>> SaveAsync(Guid? id, SlaPolicyRequest request, string? ifMatch, CancellationToken ct)
    {
        SlaPolicy policy;
        if (id is null)
        {
            policy = SlaPolicy.Create(request.ToDetails());
            db.SlaPolicies.Add(policy);
        }
        else
        {
            if (await db.SlaPolicies.SingleOrDefaultAsync(p => p.Id == id, ct) is not { } existing)
            {
                return Error.NotFound("CON_SLA_NOT_FOUND", $"SLA policy {id} was not found.");
            }

            if (ifMatch is null || !db.ApplyIfMatch(existing, ifMatch))
            {
                return CommonErrors.InvalidETag;
            }

            policy = existing;
            policy.Update(request.ToDetails());
        }

        policy.SetActive(request.IsActive);
        var name = policy.Name;
        if (await db.SlaPolicies.AnyAsync(p => p.Name == name && p.Id != policy.Id, ct))
        {
            return Error.Conflict("CON_DUPLICATE_SLA", "An SLA policy with this name already exists.");
        }

        await db.SaveChangesAsync(ct);
        return ToResponse(policy, await db.Contracts.CountAsync(c => c.SlaPolicyId == policy.Id && c.Status != ContractStatus.Ended, ct));
    }

    private SlaPolicyResponse ToResponse(SlaPolicy p, int contracts) => new(
        p.Id, p.Name, p.Coverage, PriorityTargetDto.From(p.P1), PriorityTargetDto.From(p.P2), PriorityTargetDto.From(p.P3), PriorityTargetDto.From(p.P4),
        p.IncludedHoursPerMonth, p.OverageRate, p.AfterHoursMultiplier, p.CoveredWorkTypes, p.AteraValue, p.IsActive, contracts, db.GetETag(p));
}
