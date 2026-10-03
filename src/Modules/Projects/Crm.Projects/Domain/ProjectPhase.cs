using Crm.SharedKernel.Domain;
using Crm.SharedKernel.Results;

namespace Crm.Projects.Domain;

public enum ProjectPhaseStatus
{
    Planned,
    Active,
    Completed,
    Cancelled,
}

public enum ProjectTaskStatus
{
    Open,
    InProgress,
    Done,
    Cancelled,
}

public sealed record PhaseDetails(
    string Name,
    DateOnly? PlannedStart,
    DateOnly? PlannedEnd,
    decimal PlannedHours,
    decimal Fee,
    bool BillOnCompletion,
    Guid? ProductId);

public sealed record TaskDetails(string Title, Guid? AssigneeId, DateOnly? DueDate, decimal EstimatedHours, string? Notes);

/// <summary>A stage of a project. Its fee, if it has one, is invoiced when the phase is completed.</summary>
public sealed class ProjectPhase : Entity
{
    private readonly List<ProjectTask> _tasks = [];

    private ProjectPhase() { }

    public Guid ProjectId { get; private set; }
    public int Order { get; private set; }
    public string Name { get; private set; } = string.Empty;
    public ProjectPhaseStatus Status { get; private set; }
    public DateOnly? PlannedStart { get; private set; }
    public DateOnly? PlannedEnd { get; private set; }
    public decimal PlannedHours { get; private set; }
    public decimal Fee { get; private set; }
    public bool BillOnCompletion { get; private set; }
    public Guid? ProductId { get; private set; }
    public DateOnly? CompletedOn { get; private set; }

    public IReadOnlyList<ProjectTask> Tasks => _tasks;

    internal static ProjectPhase Create(Guid projectId, int order, PhaseDetails details)
    {
        var phase = new ProjectPhase { ProjectId = projectId, Order = order, Status = ProjectPhaseStatus.Planned };
        phase.Update(details);
        return phase;
    }

    internal Result Update(PhaseDetails details)
    {
        Name = details.Name.Trim();
        PlannedStart = details.PlannedStart;
        PlannedEnd = details.PlannedEnd;
        PlannedHours = decimal.Round(details.PlannedHours, 2);
        Fee = decimal.Round(details.Fee, 2);
        BillOnCompletion = details.BillOnCompletion && Fee > 0;
        ProductId = details.ProductId;
        return PlannedEnd is { } end && PlannedStart is { } start && end < start
            ? ProjectErrors.InvalidPeriod
            : Result.Success();
    }

    internal Result SetStatus(ProjectPhaseStatus status, DateOnly today)
    {
        if (status == ProjectPhaseStatus.Completed && _tasks.Exists(t => t.Status is ProjectTaskStatus.Open or ProjectTaskStatus.InProgress))
        {
            return Error.Conflict("PRJ_OPEN_TASKS", "The phase still has open tasks.");
        }

        Status = status;
        CompletedOn = status == ProjectPhaseStatus.Completed ? today : null;
        return Result.Success();
    }

    internal Result<ProjectTask> AddTask(TaskDetails details)
    {
        var task = ProjectTask.Create(Id, details);
        _tasks.Add(task);
        return task;
    }

    internal void RemoveTask(ProjectTask task) => _tasks.Remove(task);
}

public sealed class ProjectTask : Entity
{
    private ProjectTask() { }

    public Guid PhaseId { get; private set; }
    public string Title { get; private set; } = string.Empty;
    public Guid? AssigneeId { get; private set; }
    public DateOnly? DueDate { get; private set; }
    public decimal EstimatedHours { get; private set; }
    public ProjectTaskStatus Status { get; private set; }
    public string? Notes { get; private set; }

    internal static ProjectTask Create(Guid phaseId, TaskDetails details)
    {
        var task = new ProjectTask { PhaseId = phaseId, Status = ProjectTaskStatus.Open };
        task.Update(details, null);
        return task;
    }

    internal void Update(TaskDetails details, ProjectTaskStatus? status)
    {
        Title = details.Title.Trim();
        AssigneeId = details.AssigneeId;
        DueDate = details.DueDate;
        EstimatedHours = decimal.Round(details.EstimatedHours, 2);
        Notes = string.IsNullOrWhiteSpace(details.Notes) ? null : details.Notes.Trim();
        Status = status ?? Status;
    }
}
