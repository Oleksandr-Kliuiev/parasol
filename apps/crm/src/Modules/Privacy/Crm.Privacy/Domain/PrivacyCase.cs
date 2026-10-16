using Crm.Privacy.Contracts;
using Crm.SharedKernel.Domain;

namespace Crm.Privacy.Domain;

/// <summary>A request from a data subject (GDPR art. 15 or 17).</summary>
public enum PrivacyCaseKind
{
    /// <summary>A copy of the person's data (art. 15).</summary>
    Access,

    /// <summary>Erasure of the person's data, within what the law requires the company to keep (art. 17).</summary>
    Erasure,
}

public enum PrivacyCaseStatus
{
    Received,
    Verified,

    /// <summary>An erasure plan was computed and recorded; carrying it out needs that exact plan.</summary>
    Previewed,

    /// <summary>Started and not finished: a module failed; carrying it out again continues where it stopped.</summary>
    Executing,
    Completed,
    Rejected,
}

public enum RequestChannel
{
    Email,
    Letter,
    Phone,
    InPerson,
    Other,
}

/// <summary>How the requester was confirmed to be the person (art. 12(6)); the evidence itself is not stored.</summary>
public enum VerificationMethod
{
    /// <summary>The request came from an address the CRM already has for the person.</summary>
    KnownEmail,
    InPerson,
    SignedLetter,
    Other,
}

/// <summary>
/// A data subject's request (DEV-11): received → identity verified → (erasure) plan previewed → carried out → receipt. The
/// case keeps ids, steps and counts — never the person's details, so it outlives the erasure without undoing it.
/// </summary>
public sealed class PrivacyCase : AuditableEntity
{
    private PrivacyCase() { }

    public string Number { get; private set; } = string.Empty;

    public PrivacyCaseKind Kind { get; private set; }

    public DataSubjectKind SubjectKind { get; private set; }

    public Guid SubjectId { get; private set; }

    public PrivacyCaseStatus Status { get; private set; }

    public RequestChannel Channel { get; private set; }

    public DateTimeOffset ReceivedAt { get; private set; }

    /// <summary>One month after receipt (art. 12(3)); the page warns before it passes.</summary>
    public DateOnly DueOn { get; private set; }

    /// <summary>What was asked and how it was received, without personal details beyond the request itself.</summary>
    public string? Note { get; private set; }

    public DateTimeOffset? VerifiedAt { get; private set; }

    public Guid? VerifiedBy { get; private set; }

    public VerificationMethod? VerificationMethod { get; private set; }

    public string? VerificationNote { get; private set; }

    /// <summary>The previewed erasure plan: record ids and actions only (JSON), and its SHA-256.</summary>
    public string? PlanJson { get; private set; }

    public string? PlanDigest { get; private set; }

    public DateTimeOffset? PreviewedAt { get; private set; }

    public DateTimeOffset? CompletedAt { get; private set; }

    public Guid? CompletedBy { get; private set; }

    /// <summary>What was done, per module and data class, and what was kept and why (JSON, counts and ids only).</summary>
    public string? ReceiptJson { get; private set; }

    /// <summary>SHA-256 of the last export delivered for this case.</summary>
    public string? ExportSha256 { get; private set; }

    public string? RejectionReason { get; private set; }

    public bool IsClosed => Status is PrivacyCaseStatus.Completed or PrivacyCaseStatus.Rejected;

    public static PrivacyCase Open(
        string number, PrivacyCaseKind kind, DataSubjectKind subjectKind, Guid subjectId, RequestChannel channel,
        DateTimeOffset receivedAt, DateOnly dueOn, string? note) => new()
    {
        Number = number,
        Kind = kind,
        SubjectKind = subjectKind,
        SubjectId = subjectId,
        Channel = channel,
        ReceivedAt = receivedAt,
        DueOn = dueOn,
        Note = note,
        Status = PrivacyCaseStatus.Received,
    };

    public void Verify(VerificationMethod method, string? note, Guid? by, DateTimeOffset at)
    {
        VerificationMethod = method;
        VerificationNote = note;
        VerifiedBy = by;
        VerifiedAt = at;
        Status = PrivacyCaseStatus.Verified;
    }

    /// <summary>Records the plan the person who carries the erasure out has seen; a new preview replaces an older one.</summary>
    public void RecordPlan(string planJson, string digest, DateTimeOffset at)
    {
        PlanJson = planJson;
        PlanDigest = digest;
        PreviewedAt = at;
        Status = PrivacyCaseStatus.Previewed;
    }

    public void StartExecution() => Status = PrivacyCaseStatus.Executing;

    public void CompleteErasure(string receiptJson, Guid? by, DateTimeOffset at)
    {
        ReceiptJson = receiptJson;
        CompletedBy = by;
        CompletedAt = at;
        Status = PrivacyCaseStatus.Completed;
    }

    /// <summary>An access request is answered by delivering the export; delivering it again records the newer file.</summary>
    public void RecordExport(string sha256, Guid? by, DateTimeOffset at)
    {
        ExportSha256 = sha256;
        if (Kind == PrivacyCaseKind.Access && Status != PrivacyCaseStatus.Completed)
        {
            CompletedBy = by;
            CompletedAt = at;
            Status = PrivacyCaseStatus.Completed;
        }
    }

    public void Reject(string reason, Guid? by, DateTimeOffset at)
    {
        RejectionReason = reason;
        CompletedBy = by;
        CompletedAt = at;
        Status = PrivacyCaseStatus.Rejected;
    }

    /// <summary>Recreated from a deletion manifest after a database restore lost the case row (DEV-11-AC06).</summary>
    public static PrivacyCase RestoredFromManifest(Guid id, string number, DataSubjectKind subjectKind, Guid subjectId, DateTimeOffset executedAt, string receiptJson)
    {
        return new PrivacyCase
        {
            Id = id,
            Number = number,
            Kind = PrivacyCaseKind.Erasure,
            SubjectKind = subjectKind,
            SubjectId = subjectId,
            Channel = RequestChannel.Other,
            ReceivedAt = executedAt,
            DueOn = DateOnly.FromDateTime(executedAt.UtcDateTime),
            Note = "Recreated from the deletion manifest after a database restore.",
            ReceiptJson = receiptJson,
            CompletedAt = executedAt,
            Status = PrivacyCaseStatus.Completed,
        };
    }
}
