using Crm.SharedKernel.Results;

namespace Crm.TimeTracking.Contracts;

/// <summary>Exact source allocation identities captured in one proposed immutable billing line.</summary>
public sealed record TimeBillingSelection(Guid OrganizationId, IReadOnlyList<Guid> EntryIds,
    IReadOnlyList<Guid> AllocationIds, bool Proven);

public interface ITimeBillingAdmission
{
    /// <summary>
    /// Holds ordered Time admissions until the caller's local Billing save has committed or rolled back.
    /// Never carry the returned lease into a provider call or an inbox handler.
    /// </summary>
    Task<Result<IAsyncDisposable>> HoldAsync(IReadOnlyCollection<TimeBillingSelection> selections, CancellationToken ct);
}

/// <summary>A read cannot prove a historical financial source; callers must surface a review conflict, never recollect it silently.</summary>
public sealed class TimeBillingReviewException : Exception
{
    public TimeBillingReviewException() : base("TIM_BILLING_SOURCE_CHANGED") { }
    public TimeBillingReviewException(string? message) : base(message) { }
    public TimeBillingReviewException(string? message, Exception? innerException) : base(message, innerException) { }
}
