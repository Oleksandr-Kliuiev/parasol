using Crm.Authorization;
using Crm.Billing.Contracts;
using Crm.Billing.Domain;
using FluentValidation;

namespace Crm.Billing.Features;

public sealed record RefDto(Guid Id, string Name);

/// <summary><paramref name="Supplementary"/>: a further run for a period already billed and closed; it bills only what no run billed yet (ADR-013).</summary>
public sealed record CreateRunRequest(int Year, int Month, string? Notes, bool Supplementary = false);

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

/// <summary>What Finance found in the accounting system for a basis whose send got no answer (ADR-013).</summary>
public sealed record ReconcileRequest(bool Created, string? OrderNo, string Reason);

internal sealed class ReconcileRequestValidator : AbstractValidator<ReconcileRequest>
{
    public ReconcileRequestValidator()
    {
        RuleFor(x => x.Reason).NotEmpty().MaximumLength(512);
        RuleFor(x => x.OrderNo).NotEmpty().MaximumLength(64).When(x => x.Created);
    }
}

/// <summary>An addition to an exported line, billed by the next run; a negative amount is a credit note in the accounting system.</summary>
public sealed record CorrectionRequest(decimal Amount, string Reason, string? Description = null);

internal sealed class CorrectionRequestValidator : AbstractValidator<CorrectionRequest>
{
    public CorrectionRequestValidator()
    {
        RuleFor(x => x.Amount).NotEqual(0m);
        RuleFor(x => x.Reason).NotEmpty().MaximumLength(512);
        RuleFor(x => x.Description).MaximumLength(512);
    }
}

public sealed record CorrectionResponse(
    Guid Id,
    string Description,
    [property: SensitiveData(Permissions.FinanceRead)] decimal? Amount,
    DateOnly ChargeableFrom,
    Guid CorrectsLineId);

/// <summary>A line billed before the charge register existed that the backfill could not prove (ADR-013, EXT-01).</summary>
public sealed record LegacyChargeItem(
    Guid Id,
    RefDto Organization,
    DateOnly? PeriodStart,
    string? Description,
    [property: SensitiveData(Permissions.FinanceRead)] decimal? Amount,
    string? Reason,
    string Etag);

public sealed record LegacyChargeGroup(string Reason, int Count, [property: SensitiveData(Permissions.FinanceRead)] decimal? Amount);

public sealed record LegacyChargeReport(
    int Count,
    [property: SensitiveData(Permissions.FinanceRead)] decimal? Amount,
    IReadOnlyList<LegacyChargeGroup> ByReason,
    IReadOnlyList<LegacyChargeItem> Items);

public sealed record LegacyDecisionRequest(bool Billed, string Reason);

internal sealed class LegacyDecisionRequestValidator : AbstractValidator<LegacyDecisionRequest>
{
    public LegacyDecisionRequestValidator() => RuleFor(x => x.Reason).NotEmpty().MaximumLength(512);
}

public sealed record RunListItem(
    Guid Id,
    DateOnly PeriodStart,
    DateOnly PeriodEnd,
    BillingRunKind Kind,
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
    BillingRunKind Kind,
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
    int ContentRevision,
    int? ApprovedRevision,
    IReadOnlyList<ApprovalDto> Approvals,
    string Etag);

/// <summary>One approval act; <see cref="Valid"/> is false once a later revision set it aside, with the reason (ADR-012).</summary>
public sealed record ApprovalDto(
    BillingApprovalKind Kind,
    RefDto ApprovedBy,
    DateTimeOffset ApprovedAt,
    int ContentRevision,
    bool Valid,
    DateTimeOffset? InvalidatedAt,
    string? InvalidationReason);

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
    DateTimeOffset SyncedAt,
    IReadOnlyList<InvoiceMovementDto> Movements);

/// <summary>
/// A change of the remaining amount of an invoice as the sync saw it. <paramref name="ObservedOn"/> is the day of the sync, not the
/// day money moved, and a <c>BalanceDecrease</c> is not a ledger payment (it may be a payment, a credit or a write-off).
/// </summary>
public sealed record InvoiceMovementDto(
    InvoiceMovementKind Kind,
    DateOnly ObservedOn,
    [property: SensitiveData(Permissions.FinanceRead)] decimal? Amount,
    string Source);

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
    bool SendStarted,
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

/// <summary>
/// Invoices of a filter (DEV-12): <paramref name="Count"/>, <paramref name="Outstanding"/> and <paramref name="Overdue"/> cover
/// every invoice the filter matches — overdue as of <paramref name="AsOf"/> (Oslo) — while <paramref name="Invoices"/> is one
/// page, continued with <paramref name="NextCursor"/>.
/// </summary>
public sealed record InvoiceSummary(
    int Count,
    [property: SensitiveData(Permissions.FinanceRead)] decimal? Outstanding,
    [property: SensitiveData(Permissions.FinanceRead)] decimal? Overdue,
    IReadOnlyList<InvoiceDto> Invoices,
    string? NextCursor,
    DateOnly AsOf);
