using Crm.Authorization;
using Crm.Customers.Contracts;
using Crm.Identity.Contracts;
using Crm.Infrastructure.Http;
using Crm.Infrastructure.Persistence;
using Crm.Sales.Contracts;
using Crm.Sales.Domain;
using Crm.Sales.Persistence;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Results;
using FluentValidation;
using Microsoft.EntityFrameworkCore;

namespace Crm.Sales.Features;

public sealed record RefDto(Guid Id, string Name);

public sealed record Versioned<T>(T Value, string Etag);

public sealed record StageRequest(string Name, int Probability, int Order, bool IsActive = true);

public sealed record StageDto(Guid Id, string Name, int Probability, int Order, bool IsWon, bool IsLost, bool IsActive, int OpenOpportunities, string Etag);

public sealed record LeadRequest(string CompanyName, string? OrgNumber, string? ContactName, string? Email, string? Phone, string? Source, Guid? OwnerId, string? Notes);

public sealed record ConvertLeadRequest(bool CreateOpportunity, string? OpportunityName, Guid? StageId, DateOnly? ExpectedCloseDate, decimal? OneOffAmount, decimal? Mrr, int? TermMonths);

public sealed record DisqualifyRequest(string Reason);

public sealed record LeadDto(
    Guid Id,
    string CompanyName,
    string? OrgNumber,
    string? ContactName,
    string? Email,
    string? Phone,
    string? Source,
    LeadStatus Status,
    RefDto? Owner,
    string? Notes,
    string? DisqualifyReason,
    Guid? OrganizationId,
    Guid? OpportunityId,
    DateTimeOffset CreatedAt,
    string Etag);

public sealed record OpportunityRequest(
    Guid OrganizationId,
    Guid? ContactId,
    string Name,
    BusinessLine BusinessLine,
    Guid StageId,
    int? Probability,
    DateOnly ExpectedCloseDate,
    decimal OneOffAmount,
    decimal Mrr,
    int TermMonths,
    Guid? OwnerId,
    string? Source,
    string? Competitor);

public sealed record MoveStageRequest(Guid StageId, string? LostReason);

public sealed record OpportunityDto(
    Guid Id,
    RefDto Organization,
    Guid? ContactId,
    string? ContactName,
    string Name,
    BusinessLine BusinessLine,
    Guid StageId,
    string StageName,
    int Probability,
    DateOnly ExpectedCloseDate,
    [property: SensitiveData(Permissions.FinanceRead)] decimal OneOffAmount,
    [property: SensitiveData(Permissions.FinanceRead)] decimal Mrr,
    int TermMonths,
    [property: SensitiveData(Permissions.FinanceRead)] decimal ForecastAmount,
    RefDto? Owner,
    string? Source,
    string? Competitor,
    OpportunityStatus Status,
    string? LostReason,
    DateOnly? ClosedOn,
    DateTimeOffset LastActivityAt,
    bool IsStale,
    string Etag);

/// <summary>
/// One stage of the board (DEV-12): <paramref name="Count"/> and <paramref name="Forecast"/> cover every open deal of the filter in
/// the stage; <paramref name="Opportunities"/> are the first cards by expected close date, continued through the deals list with
/// <paramref name="NextCursor"/>.
/// </summary>
public sealed record PipelineColumn(
    Guid StageId, string StageName, int Probability, int Count, [property: SensitiveData(Permissions.FinanceRead)] decimal Forecast,
    IReadOnlyList<OpportunityDto> Opportunities, string? NextCursor);

public sealed record ForecastMonth(int Year, int Month, int Count, [property: SensitiveData(Permissions.FinanceRead)] decimal Weighted, [property: SensitiveData(Permissions.FinanceRead)] decimal Total);

public sealed record PipelineView(IReadOnlyList<PipelineColumn> Columns, IReadOnlyList<ForecastMonth> Forecast, int Stale);

public sealed record OpportunityQuery(
    string? Search, Guid? OrganizationId, Guid? OwnerId, Guid? StageId, OpportunityStatus? Status, bool MineOnly, bool StaleOnly, int? Limit = null, string? Cursor = null);

internal sealed class LeadRequestValidator : AbstractValidator<LeadRequest>
{
    public LeadRequestValidator()
    {
        RuleFor(x => x.CompanyName).NotEmpty().MaximumLength(256);
        RuleFor(x => x.OrgNumber).Must(v => string.IsNullOrWhiteSpace(v) || OrgNumberCheck.IsValid(v))
            .WithErrorCode("CUS_INVALID_ORGNR").WithMessage("Organization number must be 9 digits with a valid check digit.");
        RuleFor(x => x.ContactName).MaximumLength(256);
        RuleFor(x => x.Email).StrictEmail().When(x => !string.IsNullOrWhiteSpace(x.Email));
        RuleFor(x => x.Phone).MaximumLength(32);
        RuleFor(x => x.Source).MaximumLength(64);
        RuleFor(x => x.Notes).MaximumLength(4000);
    }
}

/// <summary>MOD11 check, the same rule the Customers module applies; kept here so Sales does not depend on its internals.</summary>
internal static class OrgNumberCheck
{
    public static bool IsValid(string value)
    {
        var digits = new string(value.Where(char.IsAsciiDigit).ToArray());
        if (digits.Length != 9)
        {
            return false;
        }

        int[] weights = [3, 2, 7, 6, 5, 4, 3, 2];
        var sum = weights.Select((w, i) => w * (digits[i] - '0')).Sum();
        var check = 11 - (sum % 11);
        check = check == 11 ? 0 : check;
        return check != 10 && check == digits[8] - '0';
    }
}

internal sealed class DisqualifyRequestValidator : AbstractValidator<DisqualifyRequest>
{
    // The column holds 256 characters; the domain still answers "reason required" for an empty one (F-G1-06).
    public DisqualifyRequestValidator() => RuleFor(x => x.Reason).MaximumLength(256);
}

internal sealed class MoveStageRequestValidator : AbstractValidator<MoveStageRequest>
{
    public MoveStageRequestValidator()
    {
        RuleFor(x => x.StageId).NotEmpty();
        RuleFor(x => x.LostReason).MaximumLength(256);
    }
}

internal sealed class ConvertLeadRequestValidator : AbstractValidator<ConvertLeadRequest>
{
    public ConvertLeadRequestValidator()
    {
        RuleFor(x => x.OpportunityName).MaximumLength(256);
        RuleFor(x => x.OneOffAmount).InclusiveBetween(0, 100_000_000).When(x => x.OneOffAmount is not null);
        RuleFor(x => x.Mrr).InclusiveBetween(0, 10_000_000).When(x => x.Mrr is not null);
        RuleFor(x => x.TermMonths).InclusiveBetween(0, 120).When(x => x.TermMonths is not null);
    }
}

internal sealed class OpportunityRequestValidator : AbstractValidator<OpportunityRequest>
{
    public OpportunityRequestValidator()
    {
        RuleFor(x => x.OrganizationId).NotEmpty();
        RuleFor(x => x.Name).NotEmpty().MaximumLength(256);
        RuleFor(x => x.BusinessLine).IsInEnum();
        RuleFor(x => x.StageId).NotEmpty();
        RuleFor(x => x.Probability).InclusiveBetween(0, 100).When(x => x.Probability is not null);
        RuleFor(x => x.OneOffAmount).InclusiveBetween(0, 100_000_000);
        RuleFor(x => x.Mrr).InclusiveBetween(0, 10_000_000);
        RuleFor(x => x.TermMonths).InclusiveBetween(0, 120);
        RuleFor(x => x.Source).MaximumLength(64);
        RuleFor(x => x.Competitor).MaximumLength(128);
    }
}

internal sealed class StageRequestValidator : AbstractValidator<StageRequest>
{
    public StageRequestValidator()
    {
        RuleFor(x => x.Name).NotEmpty().MaximumLength(64);
        RuleFor(x => x.Probability).InclusiveBetween(0, 100);
        RuleFor(x => x.Order).InclusiveBetween(1, 99);
    }
}

internal static class SalesErrors
{
    public static Error LeadNotFound(Guid id) => Error.NotFound("SAL_LEAD_NOT_FOUND", $"Lead {id} was not found.");

    public static Error OpportunityNotFound(Guid id) => Error.NotFound("SAL_OPPORTUNITY_NOT_FOUND", $"Deal {id} was not found.");

    public static Error StageNotFound(Guid id) => Error.Validation("SAL_STAGE_NOT_FOUND", $"Pipeline stage {id} does not exist.");

    public static Error InvalidETag => Error.PreconditionFailed("INVALID_ETAG", "The If-Match header is not a valid ETag.");
}
