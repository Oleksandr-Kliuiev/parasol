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

public sealed record ManualLineRequest(Guid? ProductId, string Description, decimal Quantity, decimal UnitPrice, decimal? DiscountPct, decimal? VatRate);

internal sealed class ManualLineRequestValidator : AbstractValidator<ManualLineRequest>
{
    public ManualLineRequestValidator()
    {
        RuleFor(x => x.Description).NotEmpty().MaximumLength(512);
        RuleFor(x => x.Quantity).GreaterThan(0);
        RuleFor(x => x.UnitPrice).GreaterThanOrEqualTo(0);
        RuleFor(x => x.DiscountPct).InclusiveBetween(0, 100).When(x => x.DiscountPct is not null);
        RuleFor(x => x.VatRate).InclusiveBetween(0, 100).When(x => x.VatRate is not null);
    }
}

public sealed record AdjustLineRequest(decimal Quantity, decimal UnitPrice, decimal DiscountPct, string Description);

internal sealed class AdjustLineRequestValidator : AbstractValidator<AdjustLineRequest>
{
    public AdjustLineRequestValidator()
    {
        RuleFor(x => x.Quantity).GreaterThanOrEqualTo(0);
        RuleFor(x => x.UnitPrice).GreaterThanOrEqualTo(0);
        RuleFor(x => x.DiscountPct).InclusiveBetween(0, 100);
        RuleFor(x => x.Description).NotEmpty().MaximumLength(512);
    }
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
    DateTimeOffset? ExportedAt);

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
    string? SourceRefs);

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
    string Etag);

public sealed record InvoiceSummary(
    int Count,
    [property: SensitiveData(Permissions.FinanceRead)] decimal? Outstanding,
    [property: SensitiveData(Permissions.FinanceRead)] decimal? Overdue,
    IReadOnlyList<InvoiceDto> Invoices);
