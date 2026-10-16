using System.Globalization;
using System.Text.Json;
using Crm.Billing.Contracts;
using Crm.SharedKernel.Domain;
using Crm.SharedKernel.Results;

namespace Crm.Billing.Domain;

/// <summary>
/// One reason a basis needs a look before approval (BR-BIL-03). <paramref name="Args"/> carries the values of the message (a
/// date, a product name) so the interface can say it in the reader's language; the English <paramref name="Message"/> stays the fallback.
/// </summary>
public sealed record BillingAnomaly(string Code, string Message, IReadOnlyDictionary<string, string>? Args = null);

/// <summary>
/// A line as a source produced it. <paramref name="SourceKey"/> is the charge identity of a collected line: the same
/// service, source and covered interval always give the same key, whatever the run or the collect (docs/adr/ADR-011).
/// <paramref name="SourceOrganizationId"/> is the customer the service was delivered to, which differs from the payer
/// when a subsidiary is billed through its group parent. <paramref name="Claims"/> are the economic obligations the line
/// bills, as registered across runs (docs/adr/ADR-013); a summarised line claims one per approved time allocation.
/// </summary>
public sealed record LineDraft(
    BillingGroup Group,
    Guid? ProductId,
    string Description,
    decimal Quantity,
    decimal UnitPrice,
    decimal DiscountPct,
    decimal VatRate,
    string? SourceRefs,
    string? SourceKey = null,
    Guid? SourceOrganizationId = null,
    IReadOnlyList<ChargeClaim>? Claims = null);

/// <summary>What one collect changed on a basis.</summary>
public sealed record CollectChanges(int Added, int Updated, int Removed, int Conflicts)
{
    public bool Changed => Added + Updated + Removed > 0;
}

/// <summary>A collected line comes from a source; a manual line was added by Finance and has none.</summary>
public enum BillingLineOrigin
{
    Collected,
    Manual,
}

/// <summary>What Finance decided about a collected line; the decision outlives every later collect.</summary>
public enum BillingLineDecision
{
    None,

    /// <summary>Quantity, price, discount or text replaced; the source values are kept next to it.</summary>
    Override,

    /// <summary>Not billed in this basis, on purpose; the line stays as a record so a collect cannot bring it back.</summary>
    Exclusion,
}

/// <summary>Why a line needs Finance before the basis can be approved.</summary>
public enum BillingLineConflict
{
    None,

    /// <summary>The source changed after Finance decided about the line.</summary>
    SourceChanged,

    /// <summary>The source of an overridden line no longer exists.</summary>
    SourceRemoved,

    /// <summary>A line corrected before charge keys existed: it cannot be matched to its source safely.</summary>
    LegacyUnmatched,
}

/// <summary>
/// What one customer is invoiced for one period (docs/04 §5). A collect matches source lines by charge key: it updates
/// them, keeps Finance's decisions once and flags those whose source has changed or gone (BR-BIL-02, ADR-011). Manual
/// lines are never touched by a collect. After approval the basis and its lines never change again (BR-BIL-10).
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

    /// <summary>
    /// Set just before an order is sent and cleared when the accounting system rejected it: while it is set and the basis is
    /// not exported, the order may exist, so the basis is neither sent blindly again nor cancelled (ADR-013).
    /// </summary>
    public DateTimeOffset? SendStartedAt { get; private set; }

    /// <summary>Goes up with every change to the lines, so a decision is always about a known version of the basis.</summary>
    public int Revision { get; private set; }

    public IReadOnlyList<BillingLine> Lines => _lines;

    public IReadOnlyList<BillingExportAttempt> Attempts => _attempts;

    public IEnumerable<BillingLine> CurrentLines => _lines.Where(l => !l.IsDeleted);

    /// <summary>The lines that are invoiced: current and not excluded.</summary>
    public IEnumerable<BillingLine> BilledLines => CurrentLines.Where(l => l.Decision != BillingLineDecision.Exclusion);

    public int ConflictCount => CurrentLines.Count(l => l.Conflict != BillingLineConflict.None);

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

    /// <summary>
    /// Applies what the sources say now. Lines are matched by charge key: a line without a decision takes the source
    /// values, a decided line keeps Finance's values and is flagged when its source changed or went away, and a line whose
    /// source is gone disappears unless Finance decided about it (BR-BIL-02).
    /// </summary>
    public Result<CollectChanges> ApplyCollected(IReadOnlyCollection<LineDraft> drafts, string? customerReference)
    {
        if (IsLocked)
        {
            return BillingErrors.BasisLocked;
        }

        if (drafts.FirstOrDefault(d => string.IsNullOrWhiteSpace(d.SourceKey)) is { } unkeyed)
        {
            return BillingErrors.MissingSourceKey(unkeyed.Description);
        }

        if (drafts.GroupBy(d => d.SourceKey!, StringComparer.Ordinal).FirstOrDefault(g => g.Count() > 1) is { } duplicate)
        {
            return BillingErrors.DuplicateSourceKey(duplicate.Key);
        }

        var sources = drafts.ToDictionary(d => d.SourceKey!, StringComparer.Ordinal);
        int added = 0, updated = 0, removed = 0;
        foreach (var line in CurrentLines.Where(l => l.Origin == BillingLineOrigin.Collected).ToList())
        {
            if (line.SourceKey is null)
            {
                // Collected before charge keys existed: a plain line is replaced by its keyed successor, a corrected one
                // cannot be matched safely and waits for Finance instead of being dropped or billed twice. A line without
                // source references never came from a source: the previous version wrote manual lines that way.
                if (line.SourceRefs is null && line.ManuallyAdjusted)
                {
                    line.AdoptAsManual();
                    updated++;
                }
                else if (line.ManuallyAdjusted)
                {
                    updated += line.FlagLegacy() ? 1 : 0;
                }
                else
                {
                    line.MarkDeleted();
                    removed++;
                }

                continue;
            }

            if (sources.Remove(line.SourceKey, out var source))
            {
                updated += line.ApplySource(source) ? 1 : 0;
            }
            else
            {
                var before = line.Conflict;
                if (line.SourceGone())
                {
                    removed++;
                }
                else if (line.Conflict != before)
                {
                    updated++;
                }
            }
        }

        foreach (var draft in drafts.Where(d => sources.ContainsKey(d.SourceKey!)))
        {
            _lines.Add(BillingLine.Collected(Id, draft));
            added++;
        }

        var reference = Clean(customerReference) ?? CustomerReference;
        var changes = new CollectChanges(added, updated, removed, ConflictCount);
        if (changes.Changed || reference != CustomerReference)
        {
            CustomerReference = reference;
            Changed();
        }

        return changes;
    }

    public Result<BillingLine> AddManualLine(LineDraft draft, Guid? userId, DateTimeOffset at, string? reason = null)
    {
        if (IsLocked)
        {
            return BillingErrors.BasisLocked;
        }

        var line = BillingLine.Manual(Id, OrganizationId, draft, userId, at, reason);
        _lines.Add(line);
        Changed();
        return line;
    }

    /// <summary>A manual line is edited; a collected line gets Finance's values over its source values, with a reason.</summary>
    public Result UpdateLine(Guid lineId, decimal quantity, decimal unitPrice, decimal discountPct, string description, string? reason, Guid? userId, DateTimeOffset at)
    {
        var found = Find(lineId);
        if (!found.IsSuccess)
        {
            return found.Error!;
        }

        var line = found.Value;
        if (line.Decision == BillingLineDecision.Exclusion)
        {
            return BillingErrors.LineExcluded;
        }

        if (line.Origin == BillingLineOrigin.Collected && string.IsNullOrWhiteSpace(reason))
        {
            return BillingErrors.ReasonRequired;
        }

        line.Change(quantity, unitPrice, discountPct, description, reason, userId, at);
        Changed();
        return Result.Success();
    }

    /// <summary>A manual line is deleted; a collected line is excluded with a reason, so the next collect cannot bring it back.</summary>
    public Result RemoveLine(Guid lineId, string? reason, Guid? userId, DateTimeOffset at)
    {
        var found = Find(lineId);
        if (!found.IsSuccess)
        {
            return found.Error!;
        }

        var line = found.Value;
        if (line.Origin == BillingLineOrigin.Manual)
        {
            line.MarkDeleted();
        }
        else if (string.IsNullOrWhiteSpace(reason))
        {
            return BillingErrors.ReasonRequired;
        }
        else if (line.Decision == BillingLineDecision.Exclusion)
        {
            return BillingErrors.LineExcluded;
        }
        else
        {
            line.Exclude(reason, userId, at);
        }

        Changed();
        return Result.Success();
    }

    /// <summary>Undoes Finance's decision about a collected line: it takes the current source values again, or goes if the source is gone.</summary>
    public Result RevertLine(Guid lineId, Guid? userId, DateTimeOffset at)
    {
        var found = Find(lineId);
        if (!found.IsSuccess)
        {
            return found.Error!;
        }

        var line = found.Value;
        if (line.Origin == BillingLineOrigin.Manual)
        {
            return BillingErrors.NotCollected;
        }

        if (line.Decision == BillingLineDecision.None && line.Conflict == BillingLineConflict.None)
        {
            return BillingErrors.NothingToRevert;
        }

        line.Revert(userId, at);
        Changed();
        return Result.Success();
    }

    /// <summary>Confirms Finance's decision against what the source says now, which clears the conflict.</summary>
    public Result KeepLine(Guid lineId, string? reason, Guid? userId, DateTimeOffset at)
    {
        var found = Find(lineId);
        if (!found.IsSuccess)
        {
            return found.Error!;
        }

        var line = found.Value;
        if (line.Conflict == BillingLineConflict.None)
        {
            return BillingErrors.NoConflict;
        }

        if (string.IsNullOrWhiteSpace(reason))
        {
            return BillingErrors.ReasonRequired;
        }

        line.Keep(reason, userId, at);
        Changed();
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

        if (ConflictCount > 0)
        {
            return BillingErrors.UnresolvedConflicts(ConflictCount);
        }

        if (BilledLines.All(l => l.Group == BillingGroup.Info))
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

    /// <summary>
    /// Recorded before the order is sent, in its own transaction: from here on an unknown outcome means the order may
    /// exist (ADR-013). Refused unless the basis waits to be sent, so a cancelled basis is never sent.
    /// </summary>
    public Result MarkSending(string system, DateTimeOffset at, string? correlationId)
    {
        if (Status != BillingBasisStatus.Approved)
        {
            return Error.Conflict("BIL_NOT_WAITING", "Only an approved basis that waits to be sent can be sent.");
        }

        ExportSystem = system;
        SendStartedAt = at;
        _attempts.Add(BillingExportAttempt.Create(Id, at, "Sending", null, correlationId));
        return Result.Success();
    }

    /// <summary>The order was not created: a check before sending failed, or the accounting system rejected the order.</summary>
    public void MarkFailed(string system, string message, DateTimeOffset at, string? correlationId)
    {
        ExportSystem = system;
        Status = BillingBasisStatus.Failed;
        SendStartedAt = null;
        _attempts.Add(BillingExportAttempt.Create(Id, at, "Failed", message, correlationId));
    }

    /// <summary>A send may have created the order and a lookup by the basis key does not find it: a person checks (ADR-013).</summary>
    public Result RequireReconciliation(string system, string message, DateTimeOffset at, string? correlationId)
    {
        if (Status == BillingBasisStatus.ReconciliationRequired)
        {
            return Result.Success();
        }

        if (Status != BillingBasisStatus.Approved)
        {
            return BillingErrors.InvalidBasisStatus(Status, "held for reconciliation");
        }

        ExportSystem = system;
        Status = BillingBasisStatus.ReconciliationRequired;
        _attempts.Add(BillingExportAttempt.Create(Id, at, "ReconciliationRequired", message, correlationId));
        return Result.Success();
    }

    /// <summary>
    /// Finance checked the accounting system: the order exists (its number is recorded as if the send had reported it) or it
    /// does not (the basis can be sent again or cancelled). An order made by hand outside the CRM — during an incident, say —
    /// is recorded the same way on a basis that is not being sent, so its charges count as billed (runbook 07). The reason
    /// is kept with the attempt.
    /// </summary>
    public Result Reconcile(bool created, string? orderNo, string reason, string system, DateTimeOffset at, string? correlationId)
    {
        var allowed = created
            ? Status is BillingBasisStatus.ReconciliationRequired or BillingBasisStatus.Failed || (Status == BillingBasisStatus.Approved && SendStartedAt is null)
            : Status == BillingBasisStatus.ReconciliationRequired;
        if (!allowed)
        {
            return BillingErrors.InvalidBasisStatus(Status, "reconciled");
        }

        if (string.IsNullOrWhiteSpace(reason))
        {
            return BillingErrors.ReasonRequired;
        }

        if (created)
        {
            if (string.IsNullOrWhiteSpace(orderNo))
            {
                return Error.Validation("BIL_ORDER_NO_REQUIRED", "Give the number of the order found in the accounting system.");
            }

            _attempts.Add(BillingExportAttempt.Create(Id, at, BillingExportAttempt.Reconciled, $"Order {orderNo.Trim()} exists: {reason.Trim()}", correlationId));
            MarkExported(system, orderNo.Trim(), at, correlationId);
            return Result.Success();
        }

        Status = BillingBasisStatus.Failed;
        SendStartedAt = null;
        _attempts.Add(BillingExportAttempt.Create(Id, at, BillingExportAttempt.Reconciled, $"No order: {reason.Trim()}", correlationId));
        return Result.Success();
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

        // An order may exist: cancelling would free its charges for another run and bill them twice (ADR-013).
        if (Status == BillingBasisStatus.ReconciliationRequired || (Status == BillingBasisStatus.Approved && SendStartedAt is not null))
        {
            return Error.Conflict(
                "BIL_RECONCILE_FIRST", "An order may already exist in the accounting system; check it and reconcile the basis before cancelling it.");
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

    private Result<BillingLine> Find(Guid lineId)
    {
        if (IsLocked)
        {
            return BillingErrors.BasisLocked;
        }

        return CurrentLines.SingleOrDefault(l => l.Id == lineId) is { } line ? line : BillingErrors.LineNotFound(lineId);
    }

    private void Changed()
    {
        TotalExVat = decimal.Round(BilledLines.Sum(l => l.LineTotal), 2);
        Revision++;
    }

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

    /// <summary>Kept for readers of the old schema: a manual line or a collected line Finance overrode.</summary>
    public bool ManuallyAdjusted { get; private set; }

    public BillingLineOrigin Origin { get; private set; }

    /// <summary>Charge identity of a collected line (ADR-011); null for manual lines and for lines collected before keys existed.</summary>
    public string? SourceKey { get; private set; }

    /// <summary>The customer the service was delivered to; the payer is the basis organization.</summary>
    public Guid? SourceOrganizationId { get; private set; }

    /// <summary>The economic values of the source at the last collect, see <see cref="Signature"/>; null once the source is gone.</summary>
    public string? SourceSignature { get; private set; }

    public string? SourceDescription { get; private set; }
    public decimal? SourceQuantity { get; private set; }
    public decimal? SourceUnitPrice { get; private set; }
    public decimal? SourceDiscountPct { get; private set; }

    public BillingLineDecision Decision { get; private set; }

    /// <summary>The source signature Finance's decision was made against; a collect that finds another one flags a conflict.</summary>
    public string? DecisionSignature { get; private set; }

    public BillingLineConflict Conflict { get; private set; }

    /// <summary>Who added, overrode, excluded or confirmed the line last, when and why.</summary>
    public Guid? ChangedBy { get; private set; }

    public DateTimeOffset? ChangedAt { get; private set; }
    public string? ChangeReason { get; private set; }

    public decimal? SourceLineTotal => SourceQuantity is { } quantity && SourceUnitPrice is { } price
        ? Amount(quantity, price, SourceDiscountPct ?? 0)
        : null;

    internal static BillingLine Collected(Guid basisId, LineDraft draft)
    {
        var line = new BillingLine
        {
            BasisId = basisId,
            Origin = BillingLineOrigin.Collected,
            SourceKey = draft.SourceKey,
        };
        line.ApplySource(draft);
        return line;
    }

    internal static BillingLine Manual(Guid basisId, Guid organizationId, LineDraft draft, Guid? userId, DateTimeOffset at, string? reason)
    {
        var line = new BillingLine
        {
            BasisId = basisId,
            Origin = BillingLineOrigin.Manual,
            Group = draft.Group,
            ProductId = draft.ProductId,
            VatRate = draft.VatRate,
            SourceRefs = draft.SourceRefs,
            SourceOrganizationId = organizationId,
            ManuallyAdjusted = true,
        };
        line.SetValues(draft.Quantity, draft.UnitPrice, draft.DiscountPct, draft.Description);
        line.Stamp(reason, userId, at);
        return line;
    }

    /// <summary>The economic values that decide what a line costs; text is not part of it (CLAUDE.md "Signature()").</summary>
    public static string Signature(BillingGroup group, Guid? productId, decimal quantity, decimal unitPrice, decimal discountPct, decimal vatRate) =>
        string.Join('|',
            group.ToString(),
            productId?.ToString("N") ?? "-",
            decimal.Round(quantity, 2).ToString("0.####", CultureInfo.InvariantCulture),
            decimal.Round(unitPrice, 4).ToString("0.####", CultureInfo.InvariantCulture),
            discountPct.ToString("0.####", CultureInfo.InvariantCulture),
            vatRate.ToString("0.####", CultureInfo.InvariantCulture));

    /// <summary>Returns true when anything about the line changed.</summary>
    internal bool ApplySource(LineDraft draft)
    {
        var before = State();
        Group = draft.Group;
        ProductId = draft.ProductId;
        VatRate = draft.VatRate;
        SourceRefs = draft.SourceRefs;
        SourceOrganizationId = draft.SourceOrganizationId;
        SourceDescription = Trim(draft.Description);
        SourceQuantity = decimal.Round(draft.Quantity, 2);
        SourceUnitPrice = decimal.Round(draft.UnitPrice, 4);
        SourceDiscountPct = draft.DiscountPct;
        SourceSignature = Signature(draft.Group, draft.ProductId, draft.Quantity, draft.UnitPrice, draft.DiscountPct, draft.VatRate);
        if (Decision == BillingLineDecision.None)
        {
            SetValues(draft.Quantity, draft.UnitPrice, draft.DiscountPct, draft.Description);
            Conflict = BillingLineConflict.None;
        }
        else
        {
            Conflict = SourceSignature == DecisionSignature ? BillingLineConflict.None : BillingLineConflict.SourceChanged;
        }

        return State() != before;
    }

    /// <summary>The source produced nothing for this key any more. Returns true when the line is gone with it.</summary>
    internal bool SourceGone()
    {
        SourceSignature = null;
        switch (Decision)
        {
            case BillingLineDecision.None:
                MarkDeleted();
                return true;
            case BillingLineDecision.Exclusion:
                // Excluded and gone agree: nothing is billed. The record stays so the source cannot come back unnoticed.
                Conflict = BillingLineConflict.None;
                return false;
            default:
                Conflict = DecisionSignature is null ? BillingLineConflict.None : BillingLineConflict.SourceRemoved;
                return false;
        }
    }

    internal void AdoptAsManual() => Origin = BillingLineOrigin.Manual;

    internal bool FlagLegacy()
    {
        if (Conflict == BillingLineConflict.LegacyUnmatched)
        {
            return false;
        }

        Conflict = BillingLineConflict.LegacyUnmatched;
        return true;
    }

    internal void Change(decimal quantity, decimal unitPrice, decimal discountPct, string description, string? reason, Guid? userId, DateTimeOffset at)
    {
        SetValues(quantity, unitPrice, discountPct, description);
        if (Origin == BillingLineOrigin.Collected && SourceKey is not null)
        {
            Decision = BillingLineDecision.Override;
            DecisionSignature = SourceSignature;
            Conflict = BillingLineConflict.None;
        }

        ManuallyAdjusted = true;
        Stamp(reason, userId, at);
    }

    internal void Exclude(string reason, Guid? userId, DateTimeOffset at)
    {
        Decision = BillingLineDecision.Exclusion;
        DecisionSignature = SourceSignature;
        Conflict = BillingLineConflict.None;
        Stamp(reason, userId, at);
    }

    internal void Revert(Guid? userId, DateTimeOffset at)
    {
        Decision = BillingLineDecision.None;
        DecisionSignature = null;
        Conflict = BillingLineConflict.None;
        ManuallyAdjusted = false;
        Stamp(null, userId, at);
        if (SourceKey is null || SourceSignature is null)
        {
            // A legacy correction, or a source that is gone: nothing is left to bill on this line.
            MarkDeleted();
            return;
        }

        SetValues(SourceQuantity ?? 0, SourceUnitPrice ?? 0, SourceDiscountPct ?? 0, SourceDescription ?? Description);
    }

    internal void Keep(string reason, Guid? userId, DateTimeOffset at)
    {
        if (Conflict == BillingLineConflict.LegacyUnmatched)
        {
            // Finance keeps an old correction as a line of its own; the keyed source line bills the source.
            Origin = BillingLineOrigin.Manual;
        }
        else
        {
            DecisionSignature = SourceSignature;
        }

        Conflict = BillingLineConflict.None;
        Stamp(reason, userId, at);
    }

    internal void SetProductCode(string? code) => ProductCode = code;

    public static decimal Amount(decimal quantity, decimal unitPrice, decimal discountPct) =>
        decimal.Round(quantity * unitPrice * (1 - (discountPct / 100m)), 2, MidpointRounding.AwayFromZero);

    private void SetValues(decimal quantity, decimal unitPrice, decimal discountPct, string description)
    {
        Quantity = decimal.Round(quantity, 2);
        UnitPrice = decimal.Round(unitPrice, 4);
        DiscountPct = discountPct;
        Description = Trim(description);
        LineTotal = Amount(Quantity, UnitPrice, DiscountPct);
    }

    private void Stamp(string? reason, Guid? userId, DateTimeOffset at)
    {
        ChangeReason = string.IsNullOrWhiteSpace(reason) ? null : Trim(reason);
        ChangedBy = userId;
        ChangedAt = at;
    }

    private (BillingGroup, Guid?, decimal, string, decimal, decimal, decimal, string?, Guid?, string?, BillingLineConflict) State() =>
        (Group, ProductId, VatRate, Description, Quantity, UnitPrice, DiscountPct, SourceRefs, SourceOrganizationId, SourceSignature, Conflict);

    private static string Trim(string value) => value.Length > 512 ? value[..509] + "…" : value.Trim();
}

/// <summary>One attempt to send a basis to the accounting system, kept for the export log.</summary>
public sealed class BillingExportAttempt : AuditableEntity
{
    /// <summary>The result of Finance's decision after checking the accounting system (<see cref="BillingBasis.Reconcile"/>).</summary>
    public const string Reconciled = "Reconciled";

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
