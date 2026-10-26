using Crm.TimeTracking.Contracts;

namespace Crm.TimeTracking.Features;

public enum FinancialFindingLevel { Info, Review }
public sealed record FinancialReviewFinding(string Code, FinancialFindingLevel Level);
public sealed record FinancialBankReview(Guid BankId, string? Name, string State, bool Available,
    decimal AllocatedHours, decimal ConsumedHours, decimal ReturnedHours, decimal NetHours, int Receipts);
public sealed record FinancialBillingReview(Guid BasisId, bool Exported, bool Proven, bool CurrentRevision, int MatchedAllocations);

/// <summary>Observed facts for one entry. Read-only diagnosis, never a repair plan or permission to mutate.</summary>
public sealed record TimeFinancialReview(
    int SchemaVersion, Guid EntryId, Guid OrganizationId, string? OrganizationName, DateOnly WorkDate,
    decimal Hours, TimeEntryStatus Status, int ApprovalCount, string? ReviewNote, bool PeriodClosed,
    string Etag, DateTimeOffset CheckedAt, bool RequiresReview, IReadOnlyList<FinancialReviewFinding> Findings,
    IReadOnlyList<FinancialBankReview> Banks, IReadOnlyList<FinancialBillingReview> Billing);
