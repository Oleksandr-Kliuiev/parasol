using Crm.SharedKernel.Domain;

namespace Crm.Projects.Contracts;

public enum ProjectType
{
    M365Migration,
    PowerOfficeImplementation,
    AteraRollout,
    Other,
}

public enum ProjectStatus
{
    Planned,
    Active,
    OnHold,
    Completed,
    Cancelled,
}

/// <summary>How the customer pays for the project (docs/02 §4.10).</summary>
public enum ProjectBillingModel
{
    /// <summary>One agreed price; phases carry their share and are invoiced as they close.</summary>
    Fixed,

    /// <summary>Hours are billed through the normal time tracking; the budget is a warning line, not a price.</summary>
    TimeAndMaterial,

    /// <summary>Each phase has its own fee, invoiced when the phase is completed.</summary>
    PerPhase,
}

/// <summary>A project as other modules see it (time entries link to one).</summary>
public sealed record ProjectRef(Guid Id, string Name, Guid OrganizationId, ProjectStatus Status)
{
    public bool AcceptsHours => Status is ProjectStatus.Planned or ProjectStatus.Active or ProjectStatus.OnHold;
}

public interface IProjectsApi
{
    /// <summary>The project as the caller may see it (DEV-09): null when it does not exist or is outside the caller's scope.</summary>
    Task<ProjectRef?> GetProjectAsync(Guid projectId, CancellationToken cancellationToken);

    /// <summary>The organization's projects the caller may see (DEV-09).</summary>
    Task<IReadOnlyList<ProjectRef>> GetProjectsAsync(Guid organizationId, bool openOnly, CancellationToken cancellationToken);

    /// <summary>
    /// Names for project ids another record already carries (a time entry shows the project it was booked on). Not scoped:
    /// it names what the caller's own record points to and lists nothing new.
    /// </summary>
    Task<IReadOnlyDictionary<Guid, string>> GetProjectNamesAsync(IReadOnlyCollection<Guid> projectIds, CancellationToken cancellationToken);

    /// <summary>
    /// Whether a phase is completed now; null when it no longer exists. Billing asks before acting on a phase event that may
    /// have arrived late (a retry, a replay), so it follows the phase as it is, not as it was (DEV-07).
    /// </summary>
    Task<bool?> IsPhaseCompletedAsync(Guid phaseId, CancellationToken cancellationToken);
}

/// <summary>
/// A completed phase that the customer pays for (docs/02 §4.10). Billing turns it into a one-time charge waiting for the
/// next run, the same way an accepted quote does (BR-SAL-07).
/// </summary>
public sealed record ProjectPhaseBillable(
    Guid ProjectId,
    Guid PhaseId,
    Guid OrganizationId,
    Guid? ProductId,
    string Description,
    decimal Amount,
    DateOnly CompletedOn) : DomainEvent;

public sealed record ProjectPhaseBillingCancelled(Guid ProjectId, Guid PhaseId) : DomainEvent;
