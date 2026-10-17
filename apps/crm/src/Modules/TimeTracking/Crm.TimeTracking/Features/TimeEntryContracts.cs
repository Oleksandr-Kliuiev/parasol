using Crm.Authorization;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Results;
using Crm.TimeTracking.Contracts;
using FluentValidation;

namespace Crm.TimeTracking.Features;

public sealed record TimeEntryRequest(
    Guid OrganizationId,
    Guid? TechnicianId,
    DateOnly WorkDate,
    decimal Hours,
    string? WorkType,
    bool Billable,
    bool Onsite,
    bool AfterHours,
    string? Description,
    long? ExternalTicketId,
    string? TicketTitle,
    Guid? ProjectId,
    Guid? TicketId = null,
    Guid? SourceActivityId = null,
    Guid? ClientRequestId = null);

internal sealed class TimeEntryRequestValidator : AbstractValidator<TimeEntryRequest>
{
    public TimeEntryRequestValidator()
    {
        RuleFor(x => x.OrganizationId).NotEmpty();
        RuleFor(x => x.Hours).GreaterThan(0).LessThanOrEqualTo(24);
        RuleFor(x => x.WorkType).MaximumLength(128);
        RuleFor(x => x.Description).MaximumLength(2000);
        RuleFor(x => x.TicketTitle).MaximumLength(512);
        RuleFor(x => x.TicketId).NotEqual(Guid.Empty).When(x => x.TicketId.HasValue);
        RuleFor(x => x.SourceActivityId).NotEqual(Guid.Empty).When(x => x.SourceActivityId.HasValue);
        RuleFor(x => x.ClientRequestId).NotEqual(Guid.Empty).When(x => x.ClientRequestId.HasValue);
        RuleFor(x => x.TicketId).NotNull().When(x => x.SourceActivityId.HasValue);
    }
}

public sealed record AdjustTimeEntryRequest(bool Billable, string? WorkType, bool AfterHours);

internal sealed class AdjustTimeEntryRequestValidator : AbstractValidator<AdjustTimeEntryRequest>
{
    public AdjustTimeEntryRequestValidator() => RuleFor(x => x.WorkType).MaximumLength(128);
}

public sealed record ApproveRequest(IReadOnlyList<Guid> EntryIds);

internal sealed class ApproveRequestValidator : AbstractValidator<ApproveRequest>
{
    /// <summary>One request approves or withdraws at most this many entries; the list screen works in pages of 200.</summary>
    public const int MaxEntries = 1000;

    public ApproveRequestValidator() => RuleFor(x => x.EntryIds).NotNull().Must(ids => ids is null || ids.Count <= MaxEntries)
        .WithMessage($"Send at most {MaxEntries} entries at a time.");
}

public sealed record ReopenPeriodRequest(string Reason);

internal sealed class ReopenPeriodRequestValidator : AbstractValidator<ReopenPeriodRequest>
{
    // TimePeriods.ReopenReason is 512 characters; an empty reason keeps its coded answer from the service (F-G1-06).
    public ReopenPeriodRequestValidator() => RuleFor(x => x.Reason).MaximumLength(512);
}

public sealed record AllocationDto(
    TimeClassification Classification,
    decimal Hours,
    decimal BilledHours,
    [property: SensitiveData(Permissions.FinanceRead)] decimal? Rate,
    [property: SensitiveData(Permissions.FinanceRead)] decimal? Amount,
    Guid? HourBankId);

public sealed record TimeEntryDto(
    Guid Id,
    TimeSource Source,
    Guid OrganizationId,
    string? OrganizationName,
    Guid? TechnicianId,
    string? TechnicianName,
    long? ExternalTicketId,
    string? TicketTitle,
    DateOnly WorkDate,
    DateTimeOffset? StartedAt,
    decimal Hours,
    string? WorkType,
    bool Billable,
    bool Onsite,
    bool AfterHours,
    string? Description,
    Guid? ProjectId,
    string? ProjectName,
    TimeEntryStatus Status,
    [property: SensitiveData(Permissions.FinanceRead)] decimal? Amount,
    string? ReviewNote,
    bool IsLocked,
    IReadOnlyList<AllocationDto> Allocations,
    string Etag,
    Guid? TicketId = null,
    Guid? SourceActivityId = null);

public sealed record TimeSummaryDto(decimal Hours, decimal BillableHours, decimal ApprovedHours, decimal NewHours, [property: SensitiveData(Permissions.FinanceRead)] decimal Amount);

/// <summary>
/// One page of time entries and the summary of every entry the filter matches (DEV-12): <paramref name="TotalCount"/> and
/// <paramref name="Summary"/> never depend on the page size.
/// </summary>
public sealed record TimeEntryPage(IReadOnlyList<TimeEntryDto> Items, TimeSummaryDto Summary, bool PeriodClosed, string? NextCursor, int TotalCount);

public sealed record PeriodDto(int Year, int Month, bool IsClosed, DateTimeOffset? ClosedAt, string? ClosedByName, string? ReopenReason, int NewEntries, decimal Hours);

public sealed record TimeQuery(
    int? Year, int? Month, DateOnly? From, DateOnly? To, Guid? OrganizationId, Guid? TechnicianId, TimeEntryStatus? Status, TimeSource? Source, bool MineOnly,
    int? Limit = null, string? Cursor = null);

internal static class TimeErrors
{
    public static Error NotFound(Guid id) => Error.NotFound("TIM_ENTRY_NOT_FOUND", $"Time entry {id} was not found.");

    public static Error PeriodClosed => Error.Conflict("TIM_PERIOD_CLOSED", "The period is closed; Finance must reopen it first (BR-TIM-05).");

    public static Error Forbidden => new("TIM_NOT_OWNER", "You can only change your own time entries.", ErrorType.Forbidden);

    public static Error InvalidETag => Error.PreconditionFailed("INVALID_ETAG", "The If-Match header is not a valid ETag.");

    public static Error ProjectNotAvailable => Error.Validation(
        "TIM_PROJECT_NOT_AVAILABLE", "The project does not exist or is not one you are assigned to (DEV-09).");

    public static Error ProjectOtherOrganization => Error.Validation(
        "TIM_PROJECT_OTHER_ORGANIZATION", "The project belongs to another organization than the time entry.");

    public static Error ProjectClosed => Error.Conflict("TIM_PROJECT_CLOSED", "The project is completed or cancelled and takes no more hours.");
}

