using Crm.Projects.Contracts;
using Crm.SharedKernel.Domain;
using Crm.SharedKernel.Results;

namespace Crm.Projects.Domain;

public sealed record ProjectDetails(
    Guid OrganizationId,
    string Name,
    ProjectType Type,
    ProjectBillingModel BillingModel,
    Guid? ManagerId,
    DateOnly StartDate,
    DateOnly? EndDate,
    decimal BudgetHours,
    decimal BudgetAmount,
    Guid? ContractId,
    Guid? OpportunityId,
    string? Notes);

internal static class ProjectErrors
{
    public static Error NotFound(Guid id) => Error.NotFound("PRJ_NOT_FOUND", $"Project {id} was not found.");

    public static Error PhaseNotFound(Guid id) => Error.NotFound("PRJ_PHASE_NOT_FOUND", $"Phase {id} was not found.");

    public static Error TaskNotFound(Guid id) => Error.NotFound("PRJ_TASK_NOT_FOUND", $"Task {id} was not found.");

    public static Error Closed(ProjectStatus status) => Error.Conflict(
        "PRJ_CLOSED", $"A {status} project cannot be changed; reopen it first.", new Dictionary<string, object?> { ["status"] = status.ToString() });

    public static Error InvalidPeriod => Error.Validation("PRJ_INVALID_PERIOD", "The project must end on or after it starts.");

    public static Error OpenPhases => Error.Conflict("PRJ_OPEN_PHASES", "Complete or cancel the phases before completing the project.");
}

/// <summary>
/// An implementation project (FR-PRJ-01): phases and tasks, a budget in hours and kroner, and the hours booked against it.
/// A phase with a fee turns into a one-time charge for the next billing run when it is completed (docs/02 §4.10).
/// </summary>
public sealed class Project : AuditableEntity
{
    private readonly List<ProjectPhase> _phases = [];

    private Project() { }

    public string Number { get; private set; } = string.Empty;
    public Guid OrganizationId { get; private set; }
    public string Name { get; private set; } = string.Empty;
    public ProjectType Type { get; private set; }
    public ProjectStatus Status { get; private set; }
    public ProjectBillingModel BillingModel { get; private set; }
    public Guid? ManagerId { get; private set; }
    public DateOnly StartDate { get; private set; }
    public DateOnly? EndDate { get; private set; }
    public decimal BudgetHours { get; private set; }
    public decimal BudgetAmount { get; private set; }
    public Guid? ContractId { get; private set; }
    public Guid? OpportunityId { get; private set; }
    public string? Notes { get; private set; }
    public DateOnly? CompletedOn { get; private set; }

    public IReadOnlyList<ProjectPhase> Phases => _phases;

    public bool IsOpen => Status is ProjectStatus.Planned or ProjectStatus.Active or ProjectStatus.OnHold;

    public static Result<Project> Create(string number, ProjectDetails details)
    {
        var project = new Project { Number = number, Status = ProjectStatus.Planned };
        var applied = project.Update(details);
        return applied.IsSuccess ? project : applied.Error!;
    }

    public Result Update(ProjectDetails details)
    {
        if (!IsOpen)
        {
            return ProjectErrors.Closed(Status);
        }

        if (details.EndDate is { } end && end < details.StartDate)
        {
            return ProjectErrors.InvalidPeriod;
        }

        OrganizationId = details.OrganizationId;
        Name = details.Name.Trim();
        Type = details.Type;
        BillingModel = details.BillingModel;
        ManagerId = details.ManagerId;
        StartDate = details.StartDate;
        EndDate = details.EndDate;
        BudgetHours = decimal.Round(details.BudgetHours, 2);
        BudgetAmount = decimal.Round(details.BudgetAmount, 2);
        ContractId = details.ContractId;
        OpportunityId = details.OpportunityId;
        Notes = string.IsNullOrWhiteSpace(details.Notes) ? null : details.Notes.Trim();
        return Result.Success();
    }

    public Result SetStatus(ProjectStatus status, DateOnly today)
    {
        if (status == Status)
        {
            return Result.Success();
        }

        if (status == ProjectStatus.Completed && _phases.Exists(p => p.Status is ProjectPhaseStatus.Planned or ProjectPhaseStatus.Active))
        {
            return ProjectErrors.OpenPhases;
        }

        Status = status;
        CompletedOn = status == ProjectStatus.Completed ? today : null;
        return Result.Success();
    }

    public Result<ProjectPhase> AddPhase(PhaseDetails details)
    {
        if (!IsOpen)
        {
            return ProjectErrors.Closed(Status);
        }

        var phase = ProjectPhase.Create(Id, _phases.Count == 0 ? 1 : _phases.Max(p => p.Order) + 1, details);
        _phases.Add(phase);
        return phase;
    }

    public Result<ProjectPhase> UpdatePhase(Guid phaseId, PhaseDetails details)
    {
        if (!IsOpen)
        {
            return ProjectErrors.Closed(Status);
        }

        if (_phases.SingleOrDefault(p => p.Id == phaseId) is not { } phase)
        {
            return ProjectErrors.PhaseNotFound(phaseId);
        }

        var applied = phase.Update(details);
        return applied.IsSuccess ? phase : applied.Error!;
    }

    /// <summary>Completing a phase that carries a fee queues it for the next billing run (docs/02 §4.10).</summary>
    public Result<ProjectPhase> SetPhaseStatus(Guid phaseId, ProjectPhaseStatus status, DateOnly today)
    {
        if (_phases.SingleOrDefault(p => p.Id == phaseId) is not { } phase)
        {
            return ProjectErrors.PhaseNotFound(phaseId);
        }

        var before = phase.Status;
        var applied = phase.SetStatus(status, today);
        if (!applied.IsSuccess)
        {
            return applied.Error!;
        }

        if (status == ProjectPhaseStatus.Completed && before != ProjectPhaseStatus.Completed && phase.BillOnCompletion && phase.Fee > 0)
        {
            Raise(new ProjectPhaseBillable(
                Id, phase.Id, OrganizationId, phase.ProductId, $"{Name} — {phase.Name}", phase.Fee, phase.CompletedOn ?? today));
        }
        else if (before == ProjectPhaseStatus.Completed && status != ProjectPhaseStatus.Completed && phase.BillOnCompletion && phase.Fee > 0)
        {
            // Reopening a phase takes the charge back, as long as no run has picked it up yet.
            Raise(new ProjectPhaseBillingCancelled(Id, phase.Id));
        }

        return phase;
    }

    public Result RemovePhase(Guid phaseId)
    {
        if (_phases.SingleOrDefault(p => p.Id == phaseId) is not { } phase)
        {
            return ProjectErrors.PhaseNotFound(phaseId);
        }

        if (phase.Status == ProjectPhaseStatus.Completed)
        {
            return Error.Conflict("PRJ_PHASE_COMPLETED", "A completed phase is kept for the record; cancel it instead.");
        }

        _phases.Remove(phase);
        return Result.Success();
    }

    public Result<ProjectTask> AddTask(Guid phaseId, TaskDetails details)
    {
        if (!IsOpen)
        {
            return ProjectErrors.Closed(Status);
        }

        if (_phases.SingleOrDefault(p => p.Id == phaseId) is not { } phase)
        {
            return ProjectErrors.PhaseNotFound(phaseId);
        }

        return phase.AddTask(details);
    }

    public Result<ProjectTask> UpdateTask(Guid taskId, TaskDetails details, ProjectTaskStatus? status)
    {
        foreach (var phase in _phases)
        {
            if (phase.Tasks.SingleOrDefault(t => t.Id == taskId) is { } task)
            {
                task.Update(details, status);
                return task;
            }
        }

        return ProjectErrors.TaskNotFound(taskId);
    }

    public Result RemoveTask(Guid taskId)
    {
        foreach (var phase in _phases)
        {
            if (phase.Tasks.SingleOrDefault(t => t.Id == taskId) is { } task)
            {
                phase.RemoveTask(task);
                return Result.Success();
            }
        }

        return ProjectErrors.TaskNotFound(taskId);
    }
}
