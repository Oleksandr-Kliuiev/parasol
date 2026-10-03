using Crm.Authorization;
using Crm.Billing.Contracts;
using Crm.Billing.Domain;
using FluentValidation;

namespace Crm.Billing.Features;

public sealed record RefDto(Guid Id, string Name);

public sealed record CreateRunRequest(int Year, int Month, string? Notes);

internal sealed class CreateRunRequestValidator : AbstractValidator<CreateRunRequest>
{
    public CreateRunRequestValidator()
    {
        RuleFor(x => x.Year).InclusiveBetween(2020, 2100);
        RuleFor(x => x.Month).InclusiveBetween(1, 12);
        RuleFor(x => x.Notes).MaximumLength(1024);
    }
}

public sealed record ManualLineRequest(
    Guid? ProductId, string Description, decimal Quantity, decimal UnitPrice, decimal? DiscountPct, decimal? VatRate, string? Reason = null);

internal sealed class ManualLineRequestValidator : AbstractValidator<ManualLineRequest>
{
    public ManualLineRequestValidator()
    {
        RuleFor(x => x.Description).NotEmpty().MaximumLength(512);
        RuleFor(x => x.Quantity).GreaterThan(0);
        RuleFor(x => x.UnitPrice).GreaterThanOrEqualTo(0);
        RuleFor(x => x.DiscountPct).InclusiveBetween(0, 100).When(x => x.DiscountPct is not null);
        RuleFor(x => x.VatRate).InclusiveBetween(0, 100).When(x => x.VatRate is not null);
        RuleFor(x => x.Reason).MaximumLength(512);
    }
}

/// <summary>Quantity, price, discount and text of a line; <see cref="Reason"/> is required when the line came from a source.</summary>
public sealed record AdjustLineRequest(decimal Quantity, decimal UnitPrice, decimal DiscountPct, string Description, string? Reason = null);

internal sealed class AdjustLineRequestValidator : AbstractValidator<AdjustLineRequest>
{
    public AdjustLineRequestValidator()
    {
        RuleFor(x => x.Quantity).GreaterThanOrEqualTo(0);
        RuleFor(x => x.UnitPrice).GreaterThanOrEqualTo(0);
        RuleFor(x => x.DiscountPct).InclusiveBetween(0, 100);
        RuleFor(x => x.Description).NotEmpty().MaximumLength(512);
        RuleFor(x => x.Reason).MaximumLength(512);
    }
}

/// <summary>Excluding a collected line or confirming a decision against a changed source; both need a reason.</summary>
public sealed record LineDecisionRequest(string Reason);

internal sealed class LineDecisionRequestValidator : AbstractValidator<LineDecisionRequest>
{
    public LineDecisionRequestValidator() => RuleFor(x => x.Reason).NotEmpty().MaximumLength(512);
}

public sealed record CancelBasisRequest(string Reason);

internal sealed class CancelBasisRequestValidator : AbstractValidator<CancelBasisRequest>
{
    public CancelBasisRequestValidator() => RuleFor(x => x.Reason).NotEmpty().MaximumLength(512);
}

public sealed record RunListItem(
    Guid Id,
    DateOnly PeriodStart,
    DateOnly PeriodEnd,
    BillingRunStatus Status,
    int Organizations,
    int WithAnomalies,
    [property: SensitiveData(Permissions.FinanceRead)] decimal? TotalExVat,
    bool RequiresSecondApproval,
    DateTimeOffset? CollectedAt,
    DateTimeOffset? ApprovedAt,
    DateTimeOffset? ExportedAt,
    DateTimeOffset? ClosedAt);

public sealed record RunResponse(
    Guid Id,
    DateOnly PeriodStart,
    DateOnly PeriodEnd,
    BillingRunStatus Status,
    int Organizations,
    int WithAnomalies,
    int Exported,
    int Failed,
    [property: SensitiveData(Permissions.FinanceRead)] decimal? TotalExVat,
    bool RequiresSecondApproval,
    RefDto? ApprovedBy,
    RefDto? SecondApprovedBy,
    DateTimeOffset? CollectedAt,
    DateTimeOffset? ApprovedAt,
    DateTimeOffset? ExportedAt,
    DateTimeOffset? ClosedAt,
    string? Notes,
    int Conflicts,
    string Etag);

public sealed record BasisListItem(
    Guid Id,
    RefDto Organization,
    BillingBasisStatus Status,
    [property: SensitiveData(Permissions.FinanceRead)] decimal? TotalExVat,
    [property: SensitiveData(Permissions.FinanceRead)] decimal? PreviousPeriodTotal,
    IReadOnlyList<BillingAnomaly> Anomalies,
    int Lines,
    string? OrderNo,
    DateTimeOffset? ExportedAt,
    int Conflicts);

/// <summary>
/// A line of a basis. Quantity, prices and text are what is invoiced; the <c>Source*</c> fields are what the source said at
/// the last collect, so an override or a conflict can be read next to it (ADR-011).
/// </summary>
public sealed record BasisLineDto(
    Guid Id,
    BillingGroup Group,
    Guid? ProductId,
    string? ProductName,
    string? ProductCode,
    string Description,
    decimal Quantity,
    [property: SensitiveData(Permissions.FinanceRead)] decimal? UnitPrice,
    [property: SensitiveData(Permissions.FinanceRead)] decimal? DiscountPct,
    decimal VatRate,
    [property: SensitiveData(Permissions.FinanceRead)] decimal? LineTotal,
    bool ManuallyAdjusted,
    string? SourceRefs,
    BillingLineOrigin Origin,
    string? SourceKey,
    RefDto? SourceOrganization,
    BillingLineDecision Decision,
    BillingLineConflict Conflict,
    string? SourceDescription,
    decimal? SourceQuantity,
    [property: SensitiveData(Permissions.FinanceRead)] decimal? SourceUnitPrice,
    [property: SensitiveData(Permissions.FinanceRead)] decimal? SourceDiscountPct,
    [property: SensitiveData(Permissions.FinanceRead)] decimal? SourceLineTotal,
    string? ChangeReason,
    RefDto? ChangedBy,
    DateTimeOffset? ChangedAt);

public sealed record ExportAttemptDto(DateTimeOffset At, string Result, string? Message, string? CorrelationId);

public sealed record InvoiceDto(
    Guid Id,
    string System,
    string InvoiceNo,
    string? OrderNo,
    RefDto? Organization,
    Guid? BasisId,
    DateOnly InvoiceDate,
    DateOnly? DueDate,
    [property: SensitiveData(Permissions.FinanceRead)] decimal? TotalIncVat,
    [property: SensitiveData(Permissions.FinanceRead)] decimal? Outstanding,
    InvoiceStatus Status,
    bool IsOverdue,
    string? Url,
    DateTimeOffset SyncedAt);

public sealed record BasisResponse(
    Guid Id,
    Guid RunId,
    DateOnly PeriodStart,
    DateOnly PeriodEnd,
    BillingRunStatus RunStatus,
    RefDto Organization,
    BillingBasisStatus Status,
    [property: SensitiveData(Permissions.FinanceRead)] decimal? TotalExVat,
    [property: SensitiveData(Permissions.FinanceRead)] decimal? PreviousPeriodTotal,
    IReadOnlyList<BillingAnomaly> Anomalies,
    string? CustomerReference,
    string? OrderNo,
    DateTimeOffset? ExportedAt,
    IReadOnlyList<BasisLineDto> Lines,
    IReadOnlyList<ExportAttemptDto> Attempts,
    IReadOnlyList<InvoiceDto> Invoices,
    int Revision,
    int Conflicts,
    string Etag);

/// <summary>
/// How lines collected before charge keys existed will be treated (DEV-01 dry run): plain lines of open bases are replaced by
/// keyed lines on the next collect, corrected ones are flagged for Finance, and lines of approved bases stay as they are.
/// </summary>
public sealed record LegacyLinesReport(
    int OpenPlainLines,
    int OpenCorrectedLines,
    [property: SensitiveData(Permissions.FinanceRead)] decimal? OpenCorrectedAmount,
    int ClosedLines,
    [property: SensitiveData(Permissions.FinanceRead)] decimal? ClosedAmount);

public sealed record InvoiceSummary(
    int Count,
    [property: SensitiveData(Permissions.FinanceRead)] decimal? Outstanding,
    [property: SensitiveData(Permissions.FinanceRead)] decimal? Overdue,
    IReadOnlyList<InvoiceDto> Invoices);
