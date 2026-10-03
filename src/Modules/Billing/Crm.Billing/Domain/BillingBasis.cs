using System.Globalization;
using System.Text.Json;
using Crm.Billing.Contracts;
using Crm.SharedKernel.Domain;
using Crm.SharedKernel.Results;

namespace Crm.Billing.Domain;

/// <summary>One reason a basis needs a look before approval (BR-BIL-03).</summary>
public sealed record BillingAnomaly(string Code, string Message);

public sealed record LineDraft(
    BillingGroup Group,
    Guid? ProductId,
    string Description,
    decimal Quantity,
    decimal UnitPrice,
    decimal DiscountPct,
    decimal VatRate,
    string? SourceRefs);

/// <summary>
/// What one customer is invoiced for one period (docs/04 §5). Collected lines are replaced on every re-collect; manual lines
/// survive it (BR-BIL-02). After approval the basis and its lines never change again (BR-BIL-10).
/// </summary>
public sealed class BillingBasis : AuditableEntity
{
    private readonly List<BillingLine> _lines = [];
    private readonly List<BillingExportAttempt> _attempts = [];

    private BillingBasis() { }

    public Guid RunId { get; private set; }
    public Guid OrganizationId { get; private set; }

    /// <summary>`{period}-{organizationId}-{runId}`, sent to the accounting system so a repeated export cannot duplicate (BR-BIL-05).</summary>
    public string IdempotencyKey { get; private set; } = string.Empty;

    public decimal TotalExVat { get; private set; }
    public decimal PreviousPeriodTotal { get; private set; }
    public string? AnomaliesJson { get; private set; }
    public BillingBasisStatus Status { get; private set; }
    public string? ExportSystem { get; private set; }
    public string? OrderNo { get; private set; }
    public string? CustomerReference { get; private set; }
    public DateTimeOffset? ExportedAt { get; private set; }

    public IReadOnlyList<BillingLine> Lines => _lines;

    public IReadOnlyList<BillingExportAttempt> Attempts => _attempts;

    public IEnumerable<BillingLine> CurrentLines => _lines.Where(l => !l.IsDeleted);

    public bool IsLocked => Status is not BillingBasisStatus.Draft;

    public bool HasAnomalies => Anomalies.Count > 0;

    public IReadOnlyList<BillingAnomaly> Anomalies => AnomaliesJson is null
        ? []
        : JsonSerializer.Deserialize<List<BillingAnomaly>>(AnomaliesJson) ?? [];

    public static BillingBasis Create(BillingRun run, Guid organizationId, string? customerReference) => new()
    {
        RunId = run.Id,
        OrganizationId = organizationId,
        IdempotencyKey = string.Create(CultureInfo.InvariantCulture, $"{run.PeriodStart:yyyy-MM}-{organizationId:N}-{run.Id:N}"),
        Status = BillingBasisStatus.Draft,
        CustomerReference = Clean(customerReference),
    };

    /// <summary>Replaces the collected lines and keeps the manual ones (BR-BIL-02).</summary>
    public Result ReplaceCollectedLines(IReadOnlyCollection<LineDraft> drafts, string? customerReference)
    {
        if (IsLocked)
        {
            return BillingErrors.BasisLocked;
        }

        foreach (var line in _lines.Where(l => !l.IsDeleted && !l.ManuallyAdjusted))
        {
            line.MarkDeleted();
        }

        foreach (var draft in drafts)
        {
            _lines.Add(BillingLine.Create(Id, draft, manual: false));
        }

        CustomerReference = Clean(customerReference) ?? CustomerReference;
        Recalculate();
        return Result.Success();
    }

    public Result<BillingLine> AddManualLine(LineDraft draft)
    {
        if (IsLocked)
        {
            return BillingErrors.BasisLocked;
        }

        var line = BillingLine.Create(Id, draft, manual: true);
        _lines.Add(line);
        Recalculate();
        return line;
    }

    public Result UpdateLine(Guid lineId, decimal quantity, decimal unitPrice, decimal discountPct, string description)
    {
        if (IsLocked)
        {
            return BillingErrors.BasisLocked;
        }

        if (CurrentLines.SingleOrDefault(l => l.Id == lineId) is not { } line)
        {
            return BillingErrors.LineNotFound(lineId);
        }

        line.Adjust(quantity, unitPrice, discountPct, description);
        Recalculate();
        return Result.Success();
    }

    public Result RemoveLine(Guid lineId)
    {
        if (IsLocked)
        {
            return BillingErrors.BasisLocked;
        }

        if (CurrentLines.SingleOrDefault(l => l.Id == lineId) is not { } line)
        {
            return BillingErrors.LineNotFound(lineId);
        }

        line.MarkDeleted();
        Recalculate();
        return Result.Success();
    }

    public void SetPreviousTotal(decimal total) => PreviousPeriodTotal = decimal.Round(total, 2);

    public void SetAnomalies(IReadOnlyCollection<BillingAnomaly> anomalies) =>
        AnomaliesJson = anomalies.Count == 0 ? null : JsonSerializer.Serialize(anomalies);

    public Result Approve()
    {
        if (Status != BillingBasisStatus.Draft)
        {
            return Result.Success();
        }

        if (CurrentLines.All(l => l.Group == BillingGroup.Info))
        {
            // Nothing to invoice: information-only bases are cancelled instead of exported.
            Status = BillingBasisStatus.Cancelled;
            return Result.Success();
        }

        Status = BillingBasisStatus.Approved;
        Raise(new BillingBasisApproved(Id, RunId, OrganizationId, IdempotencyKey));
        return Result.Success();
    }

    public void MarkExported(string system, string orderNo, DateTimeOffset at, string? correlationId)
    {
        if (Status == BillingBasisStatus.Exported && OrderNo == orderNo)
        {
            return;
        }

        ExportSystem = system;
        OrderNo = orderNo;
        ExportedAt = at;
        Status = BillingBasisStatus.Exported;
        _attempts.Add(BillingExportAttempt.Create(Id, at, "Exported", $"Order {orderNo}", correlationId));
        Raise(new BillingBasisExported(Id, OrganizationId, system, orderNo));
    }

    public void MarkFailed(string system, string message, DateTimeOffset at, string? correlationId)
    {
        ExportSystem = system;
        Status = BillingBasisStatus.Failed;
        _attempts.Add(BillingExportAttempt.Create(Id, at, "Failed", message, correlationId));
    }

    /// <summary>Puts a failed basis back in the export queue.</summary>
    public Result Retry()
    {
        if (Status != BillingBasisStatus.Failed)
        {
            return Error.Conflict("BIL_NOT_FAILED", "Only a failed basis can be sent again.");
        }

        Status = BillingBasisStatus.Approved;
        Raise(new BillingBasisApproved(Id, RunId, OrganizationId, IdempotencyKey));
        return Result.Success();
    }

    public Result Cancel(DateTimeOffset at, string reason)
    {
        if (Status == BillingBasisStatus.Exported)
        {
            return Error.Conflict("BIL_ALREADY_EXPORTED", "The order is already in the accounting system; credit it there (BR-BIL-09).");
        }

        Status = BillingBasisStatus.Cancelled;
        _attempts.Add(BillingExportAttempt.Create(Id, at, "Cancelled", reason, null));
        return Result.Success();
    }

    public override void MarkDeleted()
    {
        base.MarkDeleted();
        foreach (var line in _lines)
        {
            line.MarkDeleted();
        }
    }

    private void Recalculate() => TotalExVat = decimal.Round(CurrentLines.Sum(l => l.LineTotal), 2);

    private static string? Clean(string? value) => string.IsNullOrWhiteSpace(value) ? null : value.Trim();
}

public sealed class BillingLine : AuditableEntity
{
    private BillingLine() { }

    public Guid BasisId { get; private set; }
    public BillingGroup Group { get; private set; }
    public Guid? ProductId { get; private set; }

    /// <summary>Product code of the accounting system, filled in at export time.</summary>
    public string? ProductCode { get; private set; }

    public string Description { get; private set; } = string.Empty;
    public decimal Quantity { get; private set; }
    public decimal UnitPrice { get; private set; }
    public decimal DiscountPct { get; private set; }
    public decimal VatRate { get; private set; }
    public decimal LineTotal { get; private set; }

    /// <summary>JSON with the contract line, subscription or time entry ids behind the line.</summary>
    public string? SourceRefs { get; private set; }

    public bool ManuallyAdjusted { get; private set; }

    internal static BillingLine Create(Guid basisId, LineDraft draft, bool manual)
    {
        var line = new BillingLine
        {
            BasisId = basisId,
            Group = draft.Group,
            ProductId = draft.ProductId,
            Description = Trim(draft.Description),
            Quantity = decimal.Round(draft.Quantity, 2),
            UnitPrice = decimal.Round(draft.UnitPrice, 4),
            DiscountPct = draft.DiscountPct,
            VatRate = draft.VatRate,
            SourceRefs = draft.SourceRefs,
            ManuallyAdjusted = manual,
        };
        line.LineTotal = Amount(line.Quantity, line.UnitPrice, line.DiscountPct);
        return line;
    }

    internal void Adjust(decimal quantity, decimal unitPrice, decimal discountPct, string description)
    {
        Quantity = decimal.Round(quantity, 2);
        UnitPrice = decimal.Round(unitPrice, 4);
        DiscountPct = discountPct;
        Description = Trim(description);
        LineTotal = Amount(Quantity, UnitPrice, DiscountPct);
        ManuallyAdjusted = true;
    }

    internal void SetProductCode(string? code) => ProductCode = code;

    public static decimal Amount(decimal quantity, decimal unitPrice, decimal discountPct) =>
        decimal.Round(quantity * unitPrice * (1 - (discountPct / 100m)), 2, MidpointRounding.AwayFromZero);

    private static string Trim(string value) => value.Length > 512 ? value[..509] + "…" : value.Trim();
}

/// <summary>One attempt to send a basis to the accounting system, kept for the export log.</summary>
public sealed class BillingExportAttempt : AuditableEntity
{
    private BillingExportAttempt() { }

    public Guid BasisId { get; private set; }
    public DateTimeOffset At { get; private set; }
    public string Result { get; private set; } = string.Empty;
    public string? Message { get; private set; }
    public string? CorrelationId { get; private set; }

    internal static BillingExportAttempt Create(Guid basisId, DateTimeOffset at, string result, string? message, string? correlationId) => new()
    {
        BasisId = basisId,
        At = at,
        Result = result,
        Message = message is { Length: > 1024 } ? message[..1024] : message,
        CorrelationId = correlationId,
    };
}
