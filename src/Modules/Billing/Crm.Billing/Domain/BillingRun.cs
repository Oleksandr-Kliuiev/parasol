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

    public static Error BasisLocked => Error.Conflict("BIL_BASIS_LOCKED", "The basis is approved; corrections belong in the next period (BR-BIL-10).");

    public static Error PeriodBusy(DateOnly periodStart) => Error.Conflict(
        "BIL_PERIOD_BUSY", $"A run for {periodStart:yyyy-MM} is already open; close it first (BR-BIL-01).",
        new Dictionary<string, object?> { ["periodStart"] = periodStart.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture) });
}

/// <summary>A monthly billing run (docs/02 §4.9). One run per period may be open at a time (BR-BIL-01).</summary>
public sealed class BillingRun : AuditableEntity
{
    private BillingRun() { }

    public DateOnly PeriodStart { get; private set; }
    public DateOnly PeriodEnd { get; private set; }
    public BillingRunStatus Status { get; private set; }
    public DateTimeOffset? CollectedAt { get; private set; }
    public Guid? ApprovedBy { get; private set; }
    public Guid? SecondApprovedBy { get; private set; }
    public DateTimeOffset? ApprovedAt { get; private set; }

    /// <summary>Set while collecting when a basis is above the threshold and Management has to approve as well (BR-BIL-04).</summary>
    public bool RequiresSecondApproval { get; private set; }

    public DateTimeOffset? ExportedAt { get; private set; }
    public DateTimeOffset? ClosedAt { get; private set; }
    public string? Notes { get; private set; }

    public bool IsOpen => Status != BillingRunStatus.Closed;

    /// <summary>Nothing about the run or its bases changes any more.</summary>
    public bool IsLocked => Status is BillingRunStatus.Approved or BillingRunStatus.Exporting or BillingRunStatus.Exported
        or BillingRunStatus.ExportedWithErrors or BillingRunStatus.Closed;

    public static BillingRun Create(int year, int month, string? notes)
    {
        var start = new DateOnly(year, month, 1);
        return new BillingRun
        {
            PeriodStart = start,
            PeriodEnd = start.AddMonths(1).AddDays(-1),
            Status = BillingRunStatus.Draft,
            Notes = Clean(notes),
        };
    }

    public Result MarkCollected(DateTimeOffset at, bool requiresSecondApproval)
    {
        if (Status is not (BillingRunStatus.Draft or BillingRunStatus.Collected or BillingRunStatus.InReview))
        {
            return BillingErrors.InvalidStatus(Status, "collected again");
        }

        Status = BillingRunStatus.Collected;
        CollectedAt = at;
        RequiresSecondApproval = requiresSecondApproval;
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

    /// <summary>Finance approves the run; above the threshold it waits for a second approval by Management (BR-BIL-04).</summary>
    public Result Approve(Guid? userId, DateTimeOffset at)
    {
        if (Status is not (BillingRunStatus.Collected or BillingRunStatus.InReview))
        {
            return BillingErrors.InvalidStatus(Status, "approved");
        }

        ApprovedBy = userId;
        if (RequiresSecondApproval && SecondApprovedBy is null)
        {
            Status = BillingRunStatus.InReview;
            return Result.Success();
        }

        Status = BillingRunStatus.Approved;
        ApprovedAt = at;
        Raise(new BillingRunApproved(Id, PeriodStart, PeriodEnd));
        return Result.Success();
    }

    public Result SecondApprove(Guid? userId, DateTimeOffset at)
    {
        if (Status is not (BillingRunStatus.Collected or BillingRunStatus.InReview))
        {
            return BillingErrors.InvalidStatus(Status, "approved");
        }

        if (!RequiresSecondApproval)
        {
            return Error.Conflict("BIL_NO_SECOND_APPROVAL", "This run does not need a second approval.");
        }

        if (userId is not null && userId == ApprovedBy)
        {
            return Error.Conflict("BIL_SAME_APPROVER", "The second approval must come from another user.");
        }

        SecondApprovedBy = userId;
        if (ApprovedBy is null)
        {
            Status = BillingRunStatus.InReview;
            return Result.Success();
        }

        Status = BillingRunStatus.Approved;
        ApprovedAt = at;
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

    private static string? Clean(string? value) => string.IsNullOrWhiteSpace(value) ? null : value.Trim();
}
