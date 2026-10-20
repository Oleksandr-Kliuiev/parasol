using Crm.Billing.Contracts;
using Crm.SharedKernel.Results;
using Crm.TimeTracking.Domain;

namespace Crm.TimeTracking.Features;

internal sealed class TimeBillingGuard(ITimeBillingReader reader)
{
    internal static Error Committed => Error.Conflict("TIM_BILLING_COMMITTED",
        "Approved billing already includes this work. Finance must cancel the unsent basis or correct it in a later period.");
    internal static Error Changed => Error.Conflict("TIM_BILLING_SOURCE_CHANGED",
        "The billing source no longer matches its exact approved allocations. Reload and collect the draft again; review historical mismatches with Finance.");

    internal Task<IReadOnlyList<TimeBillingClaim>> ReadAsync(IEnumerable<TimeEntry> entries, CancellationToken ct) =>
        reader.ReadAsync(entries.Select(e => new TimeBillingEntry(e.Id, e.OrganizationId)).ToList(), ct);

    internal Task<IReadOnlyList<TimeBillingClaim>> ReadEntriesAsync(IReadOnlyCollection<TimeBillingEntry> entries, CancellationToken ct) => reader.ReadAsync(entries, ct);

    internal async Task<Error?> CheckAsync(IEnumerable<TimeEntry> entries, CancellationToken ct) =>
        (await ReadAsync(entries, ct)).Count == 0 ? null : Committed;
}
