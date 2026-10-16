using Crm.SharedKernel.Domain;

namespace Crm.Contracts.Domain;

public enum SupportCoverage
{
    Business8x5,
    Extended12x5,
    Always24x7,
}

/// <summary>Response and resolution targets for one ticket priority, in minutes.</summary>
public sealed record PriorityTarget(int ResponseMinutes, int ResolutionMinutes);

public sealed record SlaPolicyDetails(
    string Name,
    SupportCoverage Coverage,
    PriorityTarget P1,
    PriorityTarget P2,
    PriorityTarget P3,
    PriorityTarget P4,
    decimal IncludedHoursPerMonth,
    decimal? OverageRate,
    decimal AfterHoursMultiplier,
    string? CoveredWorkTypes,
    string? AteraValue);

public sealed class SlaPolicy : AuditableEntity
{
    private SlaPolicy() { }

    public string Name { get; private set; } = string.Empty;
    public SupportCoverage Coverage { get; private set; }
    public PriorityTarget P1 { get; private set; } = new(0, 0);
    public PriorityTarget P2 { get; private set; } = new(0, 0);
    public PriorityTarget P3 { get; private set; } = new(0, 0);
    public PriorityTarget P4 { get; private set; } = new(0, 0);
    public decimal IncludedHoursPerMonth { get; private set; }
    public decimal? OverageRate { get; private set; }
    public decimal AfterHoursMultiplier { get; private set; } = 1m;
    public string? CoveredWorkTypes { get; private set; }

    /// <summary>Value written to the Atera customer custom field (e.g. "Gold"); defaults to the name.</summary>
    public string? AteraValue { get; private set; }

    public bool IsActive { get; private set; } = true;

    public static SlaPolicy Create(SlaPolicyDetails details)
    {
        var policy = new SlaPolicy();
        policy.Update(details);
        return policy;
    }

    public void Update(SlaPolicyDetails d)
    {
        Name = d.Name.Trim();
        Coverage = d.Coverage;
        P1 = d.P1;
        P2 = d.P2;
        P3 = d.P3;
        P4 = d.P4;
        IncludedHoursPerMonth = d.IncludedHoursPerMonth;
        OverageRate = d.OverageRate;
        AfterHoursMultiplier = d.AfterHoursMultiplier;
        CoveredWorkTypes = string.IsNullOrWhiteSpace(d.CoveredWorkTypes) ? null : d.CoveredWorkTypes.Trim();
        AteraValue = string.IsNullOrWhiteSpace(d.AteraValue) ? null : d.AteraValue.Trim();
    }

    public void SetActive(bool active) => IsActive = active;

    /// <summary>Covered work types are stored as a comma-separated list; empty means the SLA covers every kind of work.</summary>
    public static IReadOnlyList<string> ParseWorkTypes(string? coveredWorkTypes) =>
        string.IsNullOrWhiteSpace(coveredWorkTypes)
            ? []
            : coveredWorkTypes.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).ToList();
}
