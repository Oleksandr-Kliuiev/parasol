namespace Crm.Billing.Contracts;

public sealed record TimeBillingEntry(Guid EntryId, Guid OrganizationId);

/// <summary>One nonexcluded source line of an immutable basis, including informational prepaid work.</summary>
public sealed record TimeBillingClaim(Guid BasisId, Guid OrganizationId, IReadOnlyList<Guid> EntryIds,
    IReadOnlyList<Guid> AllocationIds, bool Proven, bool Exported);

/// <summary>Read-only financial admission facts. No provider call, financial amount or billing write.</summary>
public interface ITimeBillingReader
{
    Task<IReadOnlyList<TimeBillingClaim>> ReadAsync(IReadOnlyCollection<TimeBillingEntry> entries, CancellationToken ct);
    Task<IReadOnlyList<TimeBillingClaim>> ReadExportedBasisAsync(Guid basisId, CancellationToken ct);
}
