using Crm.SharedKernel.Domain;

namespace Crm.TimeTracking.Contracts;

public enum TimeSource
{
    /// <summary>Work hours imported from the service desk.</summary>
    Atera,

    /// <summary>Entered in the CRM.</summary>
    Crm,
}

public enum TimeEntryStatus
{
    New,
    Approved,
    NonBillable,
    Invoiced,
}

/// <summary>How approved hours are billed (BR-TIM-03).</summary>
public enum TimeClassification
{
    NonBillable,
    Covered,
    HourBank,
    Rate,
}

/// <summary>Work hours as the service desk reports them.</summary>
public sealed record ExternalTimeEntry(
    string System,
    string ExternalId,
    Guid OrganizationId,
    Guid? TicketId,
    long? ExternalTicketId,
    string? TicketTitle,
    Guid? TechnicianUserId,
    string? TechnicianExternalId,
    string? TechnicianName,
    DateOnly WorkDate,
    DateTimeOffset? StartedAt,
    DateTimeOffset? EndedAt,
    decimal Hours,
    string? WorkType,
    bool Billable,
    bool Onsite,
    string? Description);

public sealed record TimeImportResult(int Created, int Updated, int Unchanged, int NeedsReview);

/// <summary>
/// One approved allocation of an entry, as billing reads it (BR-TIM-03). <paramref name="Invoiced"/>: the entry already left
/// with an exported order; billing never collects it again, also where its charge predates the charge register (ADR-013).
/// </summary>
public sealed record BillableTime(
    Guid EntryId,
    Guid AllocationId,
    Guid OrganizationId,
    TimeClassification Classification,
    DateOnly WorkDate,
    decimal Hours,
    decimal BilledHours,
    decimal? Rate,
    decimal? Amount,
    Guid? HourBankId,
    string? WorkType,
    bool AfterHours,
    bool Onsite,
    string? Description,
    long? ExternalTicketId,
    string? TicketTitle,
    string? TechnicianName,
    bool Invoiced = false);

/// <summary>Hours of one technician in a month, split the way approval classified them (FR-RPT-01).</summary>
public sealed record TechnicianUtilization(
    Guid? TechnicianId, string TechnicianName, decimal BilledHours, decimal CoveredHours, decimal HourBankHours, decimal NonBillableHours, decimal TotalHours);

/// <summary>Public API of the TimeTracking module: work hours arrive from integrations, approved hours are billed later.</summary>
public interface ITimeTrackingApi
{
    Task<TimeImportResult> ImportAsync(IReadOnlyCollection<ExternalTimeEntry> entries, CancellationToken cancellationToken);

    /// <summary>Approved allocations with a work date in the period, including the covered and hour-bank ones billing shows for information.</summary>
    Task<IReadOnlyList<BillableTime>> GetBillableTimeAsync(DateOnly periodStart, DateOnly periodEnd, CancellationToken cancellationToken);

    /// <summary>Hours per technician for a month, busiest first; entries still waiting for approval count as non-billable.</summary>
    Task<IReadOnlyList<TechnicianUtilization>> GetUtilizationAsync(int year, int month, CancellationToken cancellationToken);

    /// <summary>Approved hours per customer in a period, for the margin report (FR-RPT-02).</summary>
    Task<IReadOnlyList<HoursByOrganization>> GetHoursByOrganizationAsync(
        DateOnly periodStart, DateOnly periodEnd, CancellationToken cancellationToken);

    /// <summary>Hours booked on implementation projects, for their plan-against-actual report (FR-PRJ-01).</summary>
    Task<IReadOnlyList<ProjectHours>> GetProjectHoursAsync(IReadOnlyCollection<Guid> projectIds, CancellationToken cancellationToken);
}

/// <summary>Hours a customer used in a period, and what they were billed for them (FR-RPT-02).</summary>
public sealed record HoursByOrganization(Guid OrganizationId, decimal Hours, decimal BilledHours, decimal Amount);

/// <summary>What a project has actually used: hours booked, the billable part of them, and what they were worth.</summary>
public sealed record ProjectHours(Guid ProjectId, decimal Hours, decimal BillableHours, decimal Amount);

public sealed record TimeEntriesApproved(IReadOnlyList<Guid> EntryIds, Guid OrganizationId) : DomainEvent;

public sealed record TimePeriodClosed(int Year, int Month) : DomainEvent;
