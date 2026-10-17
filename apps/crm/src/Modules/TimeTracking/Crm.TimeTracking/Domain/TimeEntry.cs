using Crm.SharedKernel.Domain;
using Crm.SharedKernel.Results;
using Crm.TimeTracking.Contracts;

namespace Crm.TimeTracking.Domain;

public sealed record ManualTimeEntry(
    Guid OrganizationId,
    Guid TechnicianId,
    DateOnly WorkDate,
    decimal Hours,
    string? WorkType,
    bool Billable,
    bool Onsite,
    bool AfterHours,
    string? Description,
    Guid? TicketId,
    long? ExternalTicketId,
    string? TicketTitle,
    Guid? ProjectId,
    Guid? SourceActivityId = null);

public sealed class TimeEntry : AuditableEntity
{
    private readonly List<TimeAllocation> _allocations = [];

    private TimeEntry() { }

    public TimeSource Source { get; private set; }
    public string? ExternalId { get; private set; }
    public Guid OrganizationId { get; private set; }
    public Guid? TechnicianId { get; private set; }
    public string? TechnicianExternalId { get; private set; }
    public string? TechnicianName { get; private set; }
    public Guid? TicketId { get; private set; }
    public Guid? SourceActivityId { get; private set; }
    public long? ExternalTicketId { get; private set; }
    public string? TicketTitle { get; private set; }
    public DateOnly WorkDate { get; private set; }
    public DateTimeOffset? StartedAt { get; private set; }
    public DateTimeOffset? EndedAt { get; private set; }
    public decimal Hours { get; private set; }
    public string? WorkType { get; private set; }

    /// <summary>Billable as the source reports it; a service lead may correct it before approval.</summary>
    public bool Billable { get; private set; }

    public bool Onsite { get; private set; }
    public bool AfterHours { get; private set; }
    public string? Description { get; private set; }
    public TimeEntryStatus Status { get; private set; }
    public Guid? ContractId { get; private set; }

    /// <summary>The implementation project the hours belong to (FR-PRJ-01); only manual entries carry one.</summary>
    public Guid? ProjectId { get; private set; }

    /// <summary>Total amount of the rate allocations; null until approved.</summary>
    public decimal? Amount { get; private set; }

    public DateTimeOffset? ApprovedAt { get; private set; }
    public Guid? ApprovedBy { get; private set; }

    /// <summary>Counts approvals, so a repeated approval never reuses an hour bank movement key.</summary>
    public int ApprovalCount { get; private set; }

    /// <summary>Set when the source changed after the entry was invoiced or its period closed: Finance corrects it in the next period (BR-TIM-02).</summary>
    public string? ReviewNote { get; private set; }

    public IReadOnlyList<TimeAllocation> Allocations => _allocations;

    /// <summary>Allocations of the current approval; earlier ones stay as soft-deleted history.</summary>
    public IEnumerable<TimeAllocation> CurrentAllocations => _allocations.Where(a => !a.IsDeleted);

    public int Year => WorkDate.Year;

    public int Month => WorkDate.Month;

    public static Result<TimeEntry> CreateManual(ManualTimeEntry details)
    {
        var roundedHours = decimal.Round(details.Hours, 2);
        if (details.Hours is <= 0 or > 24 || roundedHours <= 0)
        {
            return Error.Validation("TIM_INVALID_HOURS", "Hours must round to at least 0.01 and be at most 24.");
        }

        return new TimeEntry
        {
            Source = TimeSource.Crm,
            OrganizationId = details.OrganizationId,
            TechnicianId = details.TechnicianId,
            WorkDate = details.WorkDate,
            Hours = roundedHours,
            WorkType = Clean(details.WorkType),
            Billable = details.Billable,
            Onsite = details.Onsite,
            AfterHours = details.AfterHours,
            Description = Clean(details.Description),
            TicketId = details.TicketId,
            SourceActivityId = details.SourceActivityId,
            ExternalTicketId = details.ExternalTicketId,
            TicketTitle = Clean(details.TicketTitle),
            ProjectId = details.ProjectId,
            Status = TimeEntryStatus.New,
        };
    }

    public static TimeEntry FromSource(ExternalTimeEntry source)
    {
        var entry = new TimeEntry
        {
            Source = Enum.TryParse<TimeSource>(source.System, ignoreCase: true, out var parsed) ? parsed : TimeSource.Atera,
            ExternalId = source.ExternalId,
            Status = TimeEntryStatus.New,
        };
        entry.ApplySource(source);
        return entry;
    }

    /// <summary>Returns true when anything visible changed.</summary>
    public bool ApplySource(ExternalTimeEntry s)
    {
        var before = Signature();
        OrganizationId = s.OrganizationId;
        TicketId = s.TicketId;
        ExternalTicketId = s.ExternalTicketId;
        TicketTitle = Clean(s.TicketTitle);
        TechnicianId = s.TechnicianUserId ?? TechnicianId;
        TechnicianExternalId = s.TechnicianExternalId;
        TechnicianName = s.TechnicianName;
        WorkDate = s.WorkDate;
        StartedAt = s.StartedAt;
        EndedAt = s.EndedAt;
        Hours = decimal.Round(s.Hours, 2);
        WorkType = Clean(s.WorkType);
        Billable = s.Billable;
        Onsite = s.Onsite;
        Description = Clean(s.Description);
        return before != Signature();
    }

    /// <summary>Assigns the CRM user of an external technician once an administrator mapped them.</summary>
    public void AssignTechnician(Guid userId) => TechnicianId = userId;

    public Result Update(ManualTimeEntry details)
    {
        if (Status != TimeEntryStatus.New)
        {
            return Error.Conflict("TIM_NOT_EDITABLE", "Only new entries can be changed; withdraw the approval first.");
        }

        if (Source != TimeSource.Crm)
        {
            return Error.Conflict("TIM_SOURCE_OWNED", "The entry comes from the service desk; change it there.");
        }

        var roundedHours = decimal.Round(details.Hours, 2);
        if (details.Hours is <= 0 or > 24 || roundedHours <= 0)
        {
            return Error.Validation("TIM_INVALID_HOURS", "Hours must round to at least 0.01 and be at most 24.");
        }

        OrganizationId = details.OrganizationId;
        TechnicianId = details.TechnicianId;
        WorkDate = details.WorkDate;
        Hours = roundedHours;
        WorkType = Clean(details.WorkType);
        Billable = details.Billable;
        Onsite = details.Onsite;
        AfterHours = details.AfterHours;
        Description = Clean(details.Description);
        TicketId = details.TicketId;
        SourceActivityId = details.SourceActivityId;
        ExternalTicketId = details.ExternalTicketId;
        TicketTitle = Clean(details.TicketTitle);
        ProjectId = details.ProjectId;
        return Result.Success();
    }

    /// <summary>A service lead corrects what the source said before approving.</summary>
    public Result Adjust(bool billable, string? workType, bool afterHours)
    {
        if (Status is TimeEntryStatus.Approved or TimeEntryStatus.Invoiced)
        {
            return Error.Conflict("TIM_NOT_EDITABLE", "Withdraw the approval before changing the entry.");
        }

        Billable = billable;
        WorkType = Clean(workType);
        AfterHours = afterHours;
        return Result.Success();
    }

    public void Approve(Guid? userId, DateTimeOffset at, Guid? contractId, IReadOnlyCollection<TimeAllocation> allocations)
    {
        // Allocations of an earlier approval stay as soft-deleted rows: removing them from the collection would orphan them in EF.
        _allocations.AddRange(allocations);
        ContractId = contractId;
        Amount = allocations.Sum(a => a.Amount ?? 0);
        Status = allocations.All(a => a.Classification == TimeClassification.NonBillable) ? TimeEntryStatus.NonBillable : TimeEntryStatus.Approved;
        ApprovedAt = at;
        ApprovedBy = userId;
        ApprovalCount++;
        if (Status == TimeEntryStatus.Approved)
        {
            Raise(new TimeEntriesApproved([Id], OrganizationId));
        }
    }

    public Result Withdraw()
    {
        if (Status == TimeEntryStatus.Invoiced)
        {
            return Error.Conflict("TIM_INVOICED", "The entry is already invoiced; correct it in the next period.");
        }

        foreach (var allocation in _allocations.Where(a => !a.IsDeleted))
        {
            allocation.MarkDeleted();
        }

        Status = TimeEntryStatus.New;
        Amount = null;
        ContractId = null;
        ApprovedAt = null;
        ApprovedBy = null;
        return Result.Success();
    }

    /// <summary>The basis carrying this entry was exported (BR-BIL-08); from here on corrections go into the next period.</summary>
    public void MarkInvoiced()
    {
        if (Status == TimeEntryStatus.Approved)
        {
            Status = TimeEntryStatus.Invoiced;
        }
    }

    public void FlagForReview(string note) => ReviewNote = note.Length > 512 ? note[..512] : note;

    public void ClearReview() => ReviewNote = null;

    /// <summary>The key an hour bank movement is booked under; unique per approval so a re-approval cannot collide.</summary>
    public string ConsumptionKey(Guid hourBankId) => $"{Id}:{ApprovalCount + 1}:{hourBankId}";

    public override void MarkDeleted()
    {
        base.MarkDeleted();
        foreach (var allocation in _allocations)
        {
            allocation.MarkDeleted();
        }
    }

    /// <summary>True when the source reports something different from what is stored.</summary>
    public bool DiffersFrom(ExternalTimeEntry s) => Signature() != Signature(
        s.OrganizationId, s.TicketId, s.ExternalTicketId, Clean(s.TicketTitle), s.TechnicianExternalId, s.TechnicianName, s.WorkDate,
        s.StartedAt, s.EndedAt, decimal.Round(s.Hours, 2), Clean(s.WorkType), s.Billable, s.Onsite, Clean(s.Description));

    private string Signature() => Signature(
        OrganizationId, TicketId, ExternalTicketId, TicketTitle, TechnicianExternalId, TechnicianName, WorkDate,
        StartedAt, EndedAt, Hours, WorkType, Billable, Onsite, Description);

    // Formatted invariantly, and hours without trailing zeros: the database returns decimals at column scale, which would
    // otherwise look like a change on every import.
    private static string Signature(
        Guid organizationId, Guid? ticketId, long? externalTicketId, string? ticketTitle, string? technicianExternalId, string? technicianName,
        DateOnly workDate, DateTimeOffset? startedAt, DateTimeOffset? endedAt, decimal hours, string? workType, bool billable, bool onsite, string? description) =>
        string.Join('|', organizationId, ticketId, externalTicketId, ticketTitle, technicianExternalId, technicianName,
            workDate.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture),
            startedAt?.ToUnixTimeSeconds(), endedAt?.ToUnixTimeSeconds(), hours.ToString("0.####", System.Globalization.CultureInfo.InvariantCulture),
            workType, billable, onsite, description);

    private static string? Clean(string? value) => string.IsNullOrWhiteSpace(value) ? null : value.Trim();
}

/// <summary>Part of an entry billed one way; an entry is split when an hour bank only covers part of it (BR-TIM-03).</summary>
public sealed class TimeAllocation : AuditableEntity
{
    private TimeAllocation() { }

    public TimeAllocation(Guid timeEntryId, TimeClassification classification, decimal hours, decimal billedHours, decimal? rate, Guid? hourBankId)
    {
        TimeEntryId = timeEntryId;
        Classification = classification;
        Hours = decimal.Round(hours, 2);
        BilledHours = decimal.Round(billedHours, 2);
        Rate = rate;
        HourBankId = hourBankId;
        Amount = rate is { } r ? decimal.Round(BilledHours * r, 2) : null;
    }

    public Guid TimeEntryId { get; private set; }
    public TimeClassification Classification { get; private set; }
    public decimal Hours { get; private set; }

    /// <summary>Hours actually billed after rounding and the minimum call-out (BR-TIM-04).</summary>
    public decimal BilledHours { get; private set; }

    public decimal? Rate { get; private set; }
    public decimal? Amount { get; private set; }
    public Guid? HourBankId { get; private set; }
}

public sealed class TimePeriod : AuditableEntity
{
    private TimePeriod() { }

    public TimePeriod(int year, int month)
    {
        Year = year;
        Month = month;
    }

    public int Year { get; private set; }
    public int Month { get; private set; }
    public bool IsClosed { get; private set; }
    public DateTimeOffset? ClosedAt { get; private set; }
    public Guid? ClosedBy { get; private set; }
    public string? ReopenReason { get; private set; }
    public DateTimeOffset? ReopenedAt { get; private set; }

    public void Close(Guid? userId, DateTimeOffset at)
    {
        IsClosed = true;
        ClosedAt = at;
        ClosedBy = userId;
        ReopenReason = null;
        Raise(new Contracts.TimePeriodClosed(Year, Month));
    }

    public void Reopen(string reason, DateTimeOffset at)
    {
        IsClosed = false;
        ReopenReason = reason.Length > 512 ? reason[..512] : reason;
        ReopenedAt = at;
    }
}
