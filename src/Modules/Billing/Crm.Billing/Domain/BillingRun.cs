using Crm.Billing.Contracts;
using Crm.SharedKernel.Domain;
using Crm.SharedKernel.Results;

namespace Crm.Billing.Domain;

internal static class BillingErrors
{
    public static Error RunNotFound(Guid id) => Error.NotFound("BIL_RUN_NOT_FOUND", $"Billing run {id} was not found.");

    public static Error BasisNotFound(Guid id) => Error.NotFound("BIL_BASIS_NOT_FOUND", $"Billing basis {id} was not found.");

    public static Error LineNotFound(Guid id) => Error.NotFound("BIL_LINE_NOT_FOUND", $"Billing line {id} was not found.");

    public static Error InvalidStatus(BillingRunStatus status, string action) => Error.Conflict(
        "BIL_INVALID_STATUS", $"A run in status {status} cannot be {action}.", new Dictionary<string, object?> { ["status"] = status.ToString() });

    public static Error InvalidBasisStatus(BillingBasisStatus status, string action) => Error.Conflict(
        "BIL_INVALID_BASIS_STATUS", $"A basis in status {status} cannot be {action}.", new Dictionary<string, object?> { ["status"] = status.ToString() });

    public static Error BasisLocked => Error.Conflict("BIL_BASIS_LOCKED", "The basis is approved; corrections belong in the next period (BR-BIL-10).");

    public static Error ReasonRequired => Error.Validation(
        "BIL_REASON_REQUIRED", "Say why: a collected line is corrected or left out only with a reason (BR-BIL-02).");

    public static Error LineExcluded => Error.Conflict("BIL_LINE_EXCLUDED", "The line is excluded from the basis; include it again first.");

    public static Error NotCollected => Error.Conflict("BIL_NOT_COLLECTED", "A line added by hand has no source to go back to; edit or remove it.");

    public static Error NothingToRevert => Error.Conflict("BIL_NOTHING_TO_REVERT", "The line already shows what its source says.");

    public static Error NoConflict => Error.Conflict("BIL_NO_CONFLICT", "The line has no conflict to resolve.");

    public static Error UnresolvedConflicts(int count) => Error.Conflict(
        "BIL_UNRESOLVED_CONFLICTS", $"{count} lines changed at their source after Finance decided about them; resolve them before approval.",
        new Dictionary<string, object?> { ["count"] = count });

    public static Error MissingSourceKey(string description) => Error.Conflict(
        "BIL_MISSING_SOURCE_KEY", $"The collected line “{description}” has no charge key.");

    public static Error DuplicateSourceKey(string key) => Error.Conflict(
        "BIL_DUPLICATE_SOURCE_KEY", $"Two collected lines claim the same charge {key}.", new Dictionary<string, object?> { ["sourceKey"] = key });

    /// <summary>The same code a row version conflict gets at SaveChanges, so the interface handles both alike.</summary>
    public static Error RunChanged => Error.PreconditionFailed(
        "CONCURRENCY_CONFLICT", "The run changed since you looked at it (a collect, a change of lines or an approval). Reload it and look again.");

    public static Error CollectBusy => Error.Conflict(
        "BIL_COLLECT_BUSY", "Another run is being collected right now; try again in a moment (ADR-013).");

    public static Error NotExported => Error.Conflict(
        "BIL_NOT_EXPORTED", "Only an exported basis is corrected with a new charge; an open basis is changed directly.");

    public static Error CreditNotEnabled => Error.Conflict(
        "BIL_CREDIT_NOT_ENABLED", "A negative correction is a credit note: it is made in the accounting system until Finance decides otherwise (DEC-02).");

    public static Error ChargeNotFound(Guid id) => Error.NotFound("BIL_CHARGE_NOT_FOUND", $"Charge {id} was not found.");

    public static Error ApproverRequired => Error.Forbidden("BIL_APPROVER_REQUIRED", "An approval needs a signed-in CRM user.");

    public static Error ApproverInactive => Error.Forbidden("BIL_APPROVER_INACTIVE", "The approver's CRM account is not active.");

    public static Error SameApprover => Error.Conflict(
        "BIL_SAME_APPROVER", "The two approvals of a run must come from two different people, in whichever order they sign (BR-BIL-04).");

    public static Error AlreadyApproved(BillingApprovalKind kind) => Error.Conflict(
        "BIL_ALREADY_APPROVED", $"The {kind.ToString().ToLowerInvariant()} approval of this revision is already given.",
        new Dictionary<string, object?> { ["kind"] = kind.ToString() });

    public static Error NoSecondApproval => Error.Conflict("BIL_NO_SECOND_APPROVAL", "This run does not need a second approval.");

    public static Error PeriodAlreadyBilled(DateOnly periodStart) => Error.Conflict(
        "BIL_PERIOD_ALREADY_BILLED", $"{periodStart:yyyy-MM} is already billed and closed; a further run for it is a supplementary run, which bills only what was not billed yet.",
        new Dictionary<string, object?> { ["periodStart"] = periodStart.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture) });

    public static Error NothingToSupplement(DateOnly periodStart) => Error.Conflict(
        "BIL_NOTHING_TO_SUPPLEMENT", $"{periodStart:yyyy-MM} has no closed run yet; bill it with a regular run first.",
        new Dictionary<string, object?> { ["periodStart"] = periodStart.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture) });

    public static Error PeriodBusy(DateOnly periodStart) => Error.Conflict(
        "BIL_PERIOD_BUSY", $"A run for {periodStart:yyyy-MM} is already open; close it first (BR-BIL-01).",
        new Dictionary<string, object?> { ["periodStart"] = periodStart.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture) });
}

/// <summary>A regular run bills a period; a supplementary run bills what no earlier run of the closed period billed (ADR-013).</summary>
public enum BillingRunKind
{
    Regular,
    Supplementary,
}

/// <summary>The first approval is Finance's (billing.approve), the second Management's (billing.approve.second).</summary>
public enum BillingApprovalKind
{
    First,
    Second,
}

/// <summary>Why the approvals of a run were set aside; the interface explains each one (docs/adr/ADR-012).</summary>
public static class ApprovalResetReasons
{
    public const string Recollected = "Recollected";
    public const string LinesChanged = "LinesChanged";
    public const string BasisCancelled = "BasisCancelled";
    public const string ContentChanged = "ContentChanged";
    public const string RuleChanged = "RuleChanged";
    public const string Migrated = "Migrated";
}

/// <summary>
/// A monthly billing run (docs/02 §4.9). One run per period may be open at a time (BR-BIL-01). Approvals are acts about one
/// content revision: any collect or change of the lines starts a new revision and sets earlier approvals aside, and the two
/// approvals of a run above the threshold come from two different people in either order (BR-BIL-04, ADR-012).
/// </summary>
public sealed class BillingRun : AuditableEntity
{
    private readonly List<BillingApproval> _approvals = [];

    private BillingRun() { }

    public DateOnly PeriodStart { get; private set; }
    public DateOnly PeriodEnd { get; private set; }
    public BillingRunKind Kind { get; private set; }
    public BillingRunStatus Status { get; private set; }
    public DateTimeOffset? CollectedAt { get; private set; }

    /// <summary>The valid first approval of the current revision; kept on the run for readers of the old schema.</summary>
    public Guid? ApprovedBy { get; private set; }

    /// <summary>The valid second approval of the current revision.</summary>
    public Guid? SecondApprovedBy { get; private set; }

    public DateTimeOffset? ApprovedAt { get; private set; }

    /// <summary>Whether a basis of the current content is above the threshold, as last evaluated (BR-BIL-04).</summary>
    public bool RequiresSecondApproval { get; private set; }

    /// <summary>Goes up with every collect and every change of the lines; an approval is about one revision.</summary>
    public int ContentRevision { get; private set; }

    /// <summary>The revision and content digest the run was released with.</summary>
    public int? ApprovedRevision { get; private set; }

    public string? ApprovedDigest { get; private set; }

    public DateTimeOffset? ExportedAt { get; private set; }
    public DateTimeOffset? ClosedAt { get; private set; }
    public string? Notes { get; private set; }

    /// <summary>Every approval ever given on the run, including those set aside, with the reason.</summary>
    public IReadOnlyList<BillingApproval> Approvals => _approvals;

    public IEnumerable<BillingApproval> CurrentApprovals =>
        _approvals.Where(a => a.InvalidatedAt is null && a.ContentRevision == ContentRevision);

    public bool IsOpen => Status != BillingRunStatus.Closed;

    /// <summary>Nothing about the run or its bases changes any more.</summary>
    public bool IsLocked => Status is BillingRunStatus.Approved or BillingRunStatus.Exporting or BillingRunStatus.Exported
        or BillingRunStatus.ExportedWithErrors or BillingRunStatus.Closed;

    public static BillingRun Create(int year, int month, string? notes, BillingRunKind kind = BillingRunKind.Regular)
    {
        var start = new DateOnly(year, month, 1);
        return new BillingRun
        {
            PeriodStart = start,
            PeriodEnd = start.AddMonths(1).AddDays(-1),
            Kind = kind,
            Status = BillingRunStatus.Draft,
            Notes = Clean(notes),
        };
    }

    /// <summary>The rule BR-BIL-04 applies: a single customer basis strictly above the threshold, excluding VAT.</summary>
    public static bool NeedsSecondApproval(IEnumerable<BillingBasis> bases, decimal threshold) =>
        bases.Any(b => !b.IsDeleted && b.Status != BillingBasisStatus.Cancelled && b.TotalExVat > threshold);

    public static string ApprovalPolicy(decimal threshold) =>
        string.Create(System.Globalization.CultureInfo.InvariantCulture, $"basis-total-ex-vat>{threshold:0.####}");

    /// <summary>A collect is a new revision even when nothing changed: whatever was approved before is approved again (DEV-02).</summary>
    public Result MarkCollected(DateTimeOffset at, bool requiresSecondApproval)
    {
        if (Status is not (BillingRunStatus.Draft or BillingRunStatus.Collected or BillingRunStatus.InReview))
        {
            return BillingErrors.InvalidStatus(Status, "collected again");
        }

        NewRevision(ApprovalResetReasons.Recollected, at);
        Status = BillingRunStatus.Collected;
        CollectedAt = at;
        RequiresSecondApproval = requiresSecondApproval;
        return Result.Success();
    }

    /// <summary>The lines of a basis changed: a new revision, and earlier approvals no longer count.</summary>
    public Result ContentChanged(string reason, DateTimeOffset at)
    {
        if (IsLocked)
        {
            return BillingErrors.InvalidStatus(Status, "changed");
        }

        NewRevision(reason, at);
        if (Status == BillingRunStatus.InReview)
        {
            Status = BillingRunStatus.Collected;
        }

        return Result.Success();
    }

    public Result StartReview()
    {
        if (Status is not (BillingRunStatus.Collected or BillingRunStatus.InReview))
        {
            return BillingErrors.InvalidStatus(Status, "put in review");
        }

        Status = BillingRunStatus.InReview;
        return Result.Success();
    }

    /// <summary>
    /// Records one approval of the current content. The need for a second approval and the content digest are computed here,
    /// from the bases as they are now, so neither can come from a stale screen. The run is released once Finance has approved
    /// and, above the threshold, Management as well, both for this revision and by two different people (BR-BIL-04).
    /// </summary>
    public Result Approve(BillingApprovalKind kind, Guid? userId, DateTimeOffset at, IReadOnlyCollection<BillingBasis> bases, decimal threshold)
    {
        if (Status is not (BillingRunStatus.Collected or BillingRunStatus.InReview))
        {
            return BillingErrors.InvalidStatus(Status, "approved");
        }

        if (userId is not { } approver || approver == Guid.Empty)
        {
            return BillingErrors.ApproverRequired;
        }

        var ownBases = bases.Where(b => b.RunId == Id).ToList();
        var conflicts = ownBases.Where(b => !b.IsDeleted).Sum(b => b.ConflictCount);
        if (conflicts > 0)
        {
            return BillingErrors.UnresolvedConflicts(conflicts);
        }

        var digest = BillingContentDigest.Compute(ownBases);
        var policy = ApprovalPolicy(threshold);
        var requiresSecond = NeedsSecondApproval(ownBases, threshold);

        // Defence in depth: an approval of this revision whose content or rule no longer matches does not count. Every check
        // comes before the first change, so a refused approval leaves the run exactly as it was.
        var stale = CurrentApprovals.Where(a => a.ContentDigest != digest || a.Policy != policy).ToList();
        var current = CurrentApprovals.Except(stale).ToList();
        if (kind == BillingApprovalKind.Second && !requiresSecond)
        {
            return BillingErrors.NoSecondApproval;
        }

        if (current.Any(a => a.ApprovedBy == approver))
        {
            return BillingErrors.SameApprover;
        }

        if (current.Any(a => a.Kind == kind))
        {
            return BillingErrors.AlreadyApproved(kind);
        }

        foreach (var approvalOfOtherContent in stale)
        {
            approvalOfOtherContent.Invalidate(
                approvalOfOtherContent.ContentDigest != digest ? ApprovalResetReasons.ContentChanged : ApprovalResetReasons.RuleChanged, at);
        }

        var approval = BillingApproval.Create(Id, kind, approver, at, ContentRevision, digest, policy, requiresSecond);
        _approvals.Add(approval);
        current.Add(approval);
        RequiresSecondApproval = requiresSecond;
        Mirror();

        var released = current.Any(a => a.Kind == BillingApprovalKind.First) &&
                       (!requiresSecond || current.Any(a => a.Kind == BillingApprovalKind.Second));
        if (!released)
        {
            Status = BillingRunStatus.InReview;
            return Result.Success();
        }

        Status = BillingRunStatus.Approved;
        ApprovedAt = at;
        ApprovedRevision = ContentRevision;
        ApprovedDigest = digest;
        Raise(new BillingRunApproved(Id, PeriodStart, PeriodEnd));
        return Result.Success();
    }

    public Result StartExport()
    {
        if (Status is not (BillingRunStatus.Approved or BillingRunStatus.ExportedWithErrors))
        {
            return BillingErrors.InvalidStatus(Status, "exported");
        }

        Status = BillingRunStatus.Exporting;
        return Result.Success();
    }

    /// <summary>Called when no basis is waiting any more: the run is exported, or exported with errors.</summary>
    public void FinishExport(bool hasFailures, DateTimeOffset at)
    {
        if (Status is BillingRunStatus.Closed)
        {
            return;
        }

        Status = hasFailures ? BillingRunStatus.ExportedWithErrors : BillingRunStatus.Exported;
        ExportedAt = at;
    }

    public Result Close(DateTimeOffset at)
    {
        if (Status is not (BillingRunStatus.Exported or BillingRunStatus.ExportedWithErrors))
        {
            return BillingErrors.InvalidStatus(Status, "closed");
        }

        Status = BillingRunStatus.Closed;
        ClosedAt = at;
        return Result.Success();
    }

    public Result Discard()
    {
        if (Status is not (BillingRunStatus.Draft or BillingRunStatus.Collected or BillingRunStatus.InReview))
        {
            return BillingErrors.InvalidStatus(Status, "discarded");
        }

        MarkDeleted();
        return Result.Success();
    }

    private void NewRevision(string reason, DateTimeOffset at)
    {
        ContentRevision++;
        foreach (var approval in _approvals.Where(a => a.InvalidatedAt is null))
        {
            approval.Invalidate(reason, at);
        }

        Mirror();
    }

    private void Mirror()
    {
        var current = CurrentApprovals.ToList();
        ApprovedBy = current.FirstOrDefault(a => a.Kind == BillingApprovalKind.First)?.ApprovedBy;
        SecondApprovedBy = current.FirstOrDefault(a => a.Kind == BillingApprovalKind.Second)?.ApprovedBy;
    }

    private static string? Clean(string? value) => string.IsNullOrWhiteSpace(value) ? null : value.Trim();
}

/// <summary>One approval of one content revision of a run. Never deleted: a later revision sets it aside with the reason.</summary>
public sealed class BillingApproval : AuditableEntity
{
    private BillingApproval() { }

    public Guid RunId { get; private set; }
    public BillingApprovalKind Kind { get; private set; }
    public Guid ApprovedBy { get; private set; }
    public DateTimeOffset ApprovedAt { get; private set; }
    public int ContentRevision { get; private set; }

    /// <summary>SHA-256 of the canonical content the approver saw (<see cref="BillingContentDigest"/>); "legacy" for approvals before DEV-02.</summary>
    public string ContentDigest { get; private set; } = string.Empty;

    /// <summary>The approval rule in force, e.g. <c>basis-total-ex-vat&gt;200000</c>.</summary>
    public string Policy { get; private set; } = string.Empty;

    public bool RequiredSecond { get; private set; }
    public DateTimeOffset? InvalidatedAt { get; private set; }
    public string? InvalidationReason { get; private set; }

    internal static BillingApproval Create(
        Guid runId, BillingApprovalKind kind, Guid approvedBy, DateTimeOffset at, int revision, string digest, string policy, bool requiredSecond) => new()
    {
        RunId = runId,
        Kind = kind,
        ApprovedBy = approvedBy,
        ApprovedAt = at,
        ContentRevision = revision,
        ContentDigest = digest,
        Policy = policy,
        RequiredSecond = requiredSecond,
    };

    internal void Invalidate(string reason, DateTimeOffset at)
    {
        if (InvalidatedAt is not null)
        {
            return;
        }

        InvalidatedAt = at;
        InvalidationReason = reason;
    }
}
