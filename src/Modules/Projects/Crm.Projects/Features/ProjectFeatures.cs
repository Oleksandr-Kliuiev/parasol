using Crm.Authorization;
using Crm.Catalog.Contracts;
using Crm.Customers.Contracts;
using Crm.Identity.Contracts;
using Crm.Infrastructure.Persistence;
using Crm.Projects.Contracts;
using Crm.Projects.Domain;
using Crm.Projects.Persistence;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Results;
using Crm.TimeTracking.Contracts;
using FluentValidation;
using Microsoft.EntityFrameworkCore;

namespace Crm.Projects.Features;

public sealed record RefDto(Guid Id, string Name);

public sealed record ProjectRequest(
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
    string? Notes)
{
    internal ProjectDetails ToDetails() => new(
        OrganizationId, Name, Type, BillingModel, ManagerId, StartDate, EndDate, BudgetHours, BudgetAmount, ContractId, OpportunityId, Notes);
}

internal sealed class ProjectRequestValidator : AbstractValidator<ProjectRequest>
{
    public ProjectRequestValidator()
    {
        RuleFor(x => x.OrganizationId).NotEmpty();
        RuleFor(x => x.Name).NotEmpty().MaximumLength(256);
        RuleFor(x => x.BudgetHours).InclusiveBetween(0, 100_000);
        RuleFor(x => x.BudgetAmount).InclusiveBetween(0, 100_000_000);
        RuleFor(x => x.Notes).MaximumLength(4000);
    }
}

public sealed record PhaseRequest(
    string Name, DateOnly? PlannedStart, DateOnly? PlannedEnd, decimal PlannedHours, decimal Fee, bool BillOnCompletion, Guid? ProductId)
{
    internal PhaseDetails ToDetails() => new(Name, PlannedStart, PlannedEnd, PlannedHours, Fee, BillOnCompletion, ProductId);
}

internal sealed class PhaseRequestValidator : AbstractValidator<PhaseRequest>
{
    public PhaseRequestValidator()
    {
        RuleFor(x => x.Name).NotEmpty().MaximumLength(256);
        RuleFor(x => x.PlannedHours).InclusiveBetween(0, 100_000);
        RuleFor(x => x.Fee).InclusiveBetween(0, 100_000_000);
    }
}

public sealed record TaskRequest(string Title, Guid? AssigneeId, DateOnly? DueDate, decimal EstimatedHours, string? Notes, ProjectTaskStatus? Status)
{
    internal TaskDetails ToDetails() => new(Title, AssigneeId, DueDate, EstimatedHours, Notes);
}

internal sealed class TaskRequestValidator : AbstractValidator<TaskRequest>
{
    public TaskRequestValidator()
    {
        RuleFor(x => x.Title).NotEmpty().MaximumLength(256);
        RuleFor(x => x.EstimatedHours).InclusiveBetween(0, 10_000);
        RuleFor(x => x.Notes).MaximumLength(2000);
    }
}

public sealed record StatusRequest(ProjectStatus Status);

/// <summary>Adds a person to the project's team (DEV-09).</summary>
public sealed record ProjectMemberRequest(Guid UserId);

internal sealed class ProjectMemberRequestValidator : AbstractValidator<ProjectMemberRequest>
{
    public ProjectMemberRequestValidator() => RuleFor(x => x.UserId).NotEmpty();
}

public sealed record PhaseStatusRequest(ProjectPhaseStatus Status);

public sealed record ProjectTaskDto(
    Guid Id, string Title, RefDto? Assignee, DateOnly? DueDate, decimal EstimatedHours, ProjectTaskStatus Status, string? Notes);

public sealed record ProjectPhaseDto(
    Guid Id,
    int Order,
    string Name,
    ProjectPhaseStatus Status,
    DateOnly? PlannedStart,
    DateOnly? PlannedEnd,
    decimal PlannedHours,
    [property: SensitiveData(Permissions.FinanceRead)] decimal Fee,
    bool BillOnCompletion,
    Guid? ProductId,
    string? ProductName,
    DateOnly? CompletedOn,
    IReadOnlyList<ProjectTaskDto> Tasks);

/// <summary>Plan against actual for a project (FR-PRJ-01): the budget, the hours booked and what they are worth.</summary>
public sealed record ProjectProgressDto(
    decimal BudgetHours,
    decimal Hours,
    decimal BillableHours,
    [property: SensitiveData(Permissions.FinanceRead)] decimal BudgetAmount,
    [property: SensitiveData(Permissions.FinanceRead)] decimal Amount,
    [property: SensitiveData(Permissions.FinanceRead)] decimal PhaseFeesCompleted,
    int PhasesDone,
    int Phases,
    int OpenTasks);

public sealed record ProjectResponse(
    Guid Id,
    string Number,
    string Name,
    RefDto Organization,
    ProjectType Type,
    ProjectStatus Status,
    ProjectBillingModel BillingModel,
    RefDto? Manager,
    DateOnly StartDate,
    DateOnly? EndDate,
    DateOnly? CompletedOn,
    Guid? ContractId,
    Guid? OpportunityId,
    string? Notes,
    ProjectProgressDto Progress,
    IReadOnlyList<ProjectPhaseDto> Phases,
    IReadOnlyList<RefDto> Members,
    string Etag);

public sealed record ProjectListItem(
    Guid Id,
    string Number,
    string Name,
    RefDto Organization,
    ProjectType Type,
    ProjectStatus Status,
    RefDto? Manager,
    DateOnly StartDate,
    DateOnly? EndDate,
    decimal BudgetHours,
    decimal Hours,
    int PhasesDone,
    int Phases);

public sealed record ProjectQuery(string? Search, Guid? OrganizationId, ProjectStatus? Status, Guid? ManagerId, bool OpenOnly);

internal static class ProjectApiErrors
{
    public static Error NotFound(Guid id) => Error.NotFound("PRJ_NOT_FOUND", $"Project {id} was not found.");

    public static Error OrganizationNotFound(Guid id) => Error.Validation("PRJ_ORGANIZATION_NOT_FOUND", $"Organization {id} was not found.");

    public static Error UnknownUser(Guid id) => Error.Validation("PRJ_MEMBER_UNKNOWN", $"User {id} is not an active CRM user.");

    public static Error InvalidETag => Error.PreconditionFailed("INVALID_ETAG", "The If-Match header is not a valid ETag.");
}

/// <summary>
/// Implementation projects (FR-PRJ-01). Hours come from the time module — the project owns the plan, never the hours —
/// and a completed phase with a fee is handed to billing as a one-time charge.
/// </summary>
internal sealed class ProjectService(
    ProjectsDbContext db,
    ICustomersApi customers,
    ICatalogApi catalog,
    ITimeTrackingApi timeTracking,
    IUserDirectory users,
    IRecordScope scope,
    TimeProvider time)
{
    private static readonly TimeZoneInfo Oslo = TimeZoneInfo.FindSystemTimeZoneById("Europe/Oslo");

    private DateOnly Today => DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(time.GetUtcNow(), Oslo).DateTime);

    public async Task<IReadOnlyList<ProjectListItem>> ListAsync(ProjectQuery query, CancellationToken ct)
    {
        // The scope comes first; the manager filter and the rest only narrow what the caller may see (DEV-09).
        var projects = db.Projects.AsNoTracking().Include(p => p.Phases).InScope(db, scope);
        if (!string.IsNullOrWhiteSpace(query.Search))
        {
            var term = query.Search.Trim();
            projects = projects.Where(p => p.Name.Contains(term) || p.Number.Contains(term));
        }

        if (query.OrganizationId is { } organizationId)
        {
            projects = projects.Where(p => p.OrganizationId == organizationId);
        }

        if (query.Status is { } status)
        {
            projects = projects.Where(p => p.Status == status);
        }

        if (query.ManagerId is { } managerId)
        {
            projects = projects.Where(p => p.ManagerId == managerId);
        }

        if (query.OpenOnly)
        {
            projects = projects.Where(p => p.Status != ProjectStatus.Completed && p.Status != ProjectStatus.Cancelled);
        }

        var rows = await projects.OrderByDescending(p => p.Number).Take(200).ToListAsync(ct);
        var organizations = await customers.GetOrganizationNamesAsync(rows.Select(p => p.OrganizationId).Distinct().ToList(), ct);
        var managers = await users.GetUsersAsync(rows.Where(p => p.ManagerId != null).Select(p => p.ManagerId!.Value).Distinct().ToList(), ct);
        var hours = (await timeTracking.GetProjectHoursAsync(rows.ConvertAll(p => p.Id), ct)).ToDictionary(h => h.ProjectId);

        return rows.ConvertAll(p => new ProjectListItem(
            p.Id,
            p.Number,
            p.Name,
            new RefDto(p.OrganizationId, organizations.GetValueOrDefault(p.OrganizationId, "—")),
            p.Type,
            p.Status,
            p.ManagerId is { } m && managers.TryGetValue(m, out var user) ? new RefDto(user.Id, user.DisplayName) : null,
            p.StartDate,
            p.EndDate,
            p.BudgetHours,
            hours.GetValueOrDefault(p.Id)?.Hours ?? 0m,
            p.Phases.Count(f => f.Status == ProjectPhaseStatus.Completed),
            p.Phases.Count));
    }

    public async Task<Result<ProjectResponse>> GetAsync(Guid id, CancellationToken ct)
    {
        var project = await LoadAsync(id, ct);
        return project is null ? ProjectApiErrors.NotFound(id) : await ToResponseAsync(project, ct);
    }

    public async Task<Result<ProjectResponse>> CreateAsync(ProjectRequest request, CancellationToken ct)
    {
        if (await customers.GetOrganizationAsync(request.OrganizationId, ct) is null)
        {
            return ProjectApiErrors.OrganizationNotFound(request.OrganizationId);
        }

        var number = await db.NextProjectNumberAsync(Today.Year, ct);
        var created = Project.Create(number, request.ToDetails());
        if (!created.IsSuccess)
        {
            return created.Error!;
        }

        db.Projects.Add(created.Value);
        await db.SaveChangesAsync(ct);
        return await ToResponseAsync(created.Value, ct);
    }

    public Task<Result<ProjectResponse>> UpdateAsync(Guid id, ProjectRequest request, string ifMatch, CancellationToken ct) =>
        MutateAsync(id, ifMatch, project => project.Update(request.ToDetails()), ct);

    public Task<Result<ProjectResponse>> SetStatusAsync(Guid id, ProjectStatus status, CancellationToken ct) =>
        MutateAsync(id, null, project => project.SetStatus(status, Today), ct);

    public Task<Result<ProjectResponse>> AddPhaseAsync(Guid id, PhaseRequest request, CancellationToken ct) =>
        MutateAsync(id, null, project => project.AddPhase(request.ToDetails()), ct);

    public Task<Result<ProjectResponse>> UpdatePhaseAsync(Guid id, Guid phaseId, PhaseRequest request, CancellationToken ct) =>
        MutateAsync(id, null, project => project.UpdatePhase(phaseId, request.ToDetails()), ct);

    public Task<Result<ProjectResponse>> SetPhaseStatusAsync(Guid id, Guid phaseId, ProjectPhaseStatus status, CancellationToken ct) =>
        MutateAsync(id, null, project => project.SetPhaseStatus(phaseId, status, Today), ct);

    public Task<Result<ProjectResponse>> RemovePhaseAsync(Guid id, Guid phaseId, CancellationToken ct) =>
        MutateAsync(id, null, project => project.RemovePhase(phaseId), ct);

    public Task<Result<ProjectResponse>> AddTaskAsync(Guid id, Guid phaseId, TaskRequest request, CancellationToken ct) =>
        MutateAsync(id, null, project => project.AddTask(phaseId, request.ToDetails()), ct);

    public Task<Result<ProjectResponse>> UpdateTaskAsync(Guid id, Guid taskId, TaskRequest request, CancellationToken ct) =>
        MutateAsync(id, null, project => project.UpdateTask(taskId, request.ToDetails(), request.Status), ct);

    public Task<Result<ProjectResponse>> RemoveTaskAsync(Guid id, Guid taskId, CancellationToken ct) =>
        MutateAsync(id, null, project => project.RemoveTask(taskId), ct);

    public async Task<Result> DeleteAsync(Guid id, CancellationToken ct)
    {
        if (await db.Projects.InScope(db, scope).SingleOrDefaultAsync(p => p.Id == id, ct) is not { } project)
        {
            return ProjectApiErrors.NotFound(id);
        }

        if (project.Status != ProjectStatus.Planned)
        {
            return Error.Conflict("PRJ_STARTED", "A project that has started is cancelled, not deleted.");
        }

        project.MarkDeleted();
        await db.SaveChangesAsync(ct);
        return Result.Success();
    }

    private async Task<Result<ProjectResponse>> MutateAsync(Guid id, string? ifMatch, Func<Project, Result> change, CancellationToken ct)
    {
        if (await LoadAsync(id, ct) is not { } project)
        {
            return ProjectApiErrors.NotFound(id);
        }

        if (ifMatch is not null && !db.ApplyIfMatch(project, ifMatch))
        {
            return ProjectApiErrors.InvalidETag;
        }

        var changed = change(project);
        if (!changed.IsSuccess)
        {
            return changed.Error!;
        }

        await db.SaveChangesAsync(ct);
        return await ToResponseAsync(project, ct);
    }

    /// <summary>
    /// Adds someone to the team (DEV-09), in any project status: access to a closed project's history is still managed.
    /// Adding a member twice changes nothing.
    /// </summary>
    public async Task<Result<ProjectResponse>> AddMemberAsync(Guid id, ProjectMemberRequest request, CancellationToken ct)
    {
        if (await LoadAsync(id, ct) is not { } project)
        {
            return ProjectApiErrors.NotFound(id);
        }

        if (await users.GetProfileAsync(request.UserId, ct) is not { IsActive: true })
        {
            return ProjectApiErrors.UnknownUser(request.UserId);
        }

        if (!await db.ProjectMembers.AnyAsync(m => m.ProjectId == id && m.UserId == request.UserId, ct))
        {
            db.ProjectMembers.Add(ProjectMember.Add(id, request.UserId));
            try
            {
                await db.SaveChangesAsync(ct);
            }
            catch (DbUpdateException ex) when (ex.IsUniqueViolation())
            {
                // Added by someone else at the same moment: the person is on the team either way.
                db.ChangeTracker.Clear();
                project = (await LoadAsync(id, ct))!;
            }
        }

        return await ToResponseAsync(project, ct);
    }

    /// <summary>Takes someone off the team (DEV-09); the row stays, soft-deleted, so the audit log shows who had access when.</summary>
    public async Task<Result<ProjectResponse>> RemoveMemberAsync(Guid id, Guid userId, CancellationToken ct)
    {
        if (await LoadAsync(id, ct) is not { } project)
        {
            return ProjectApiErrors.NotFound(id);
        }

        foreach (var member in await db.ProjectMembers.Where(m => m.ProjectId == id && m.UserId == userId).ToListAsync(ct))
        {
            member.MarkDeleted();
        }

        await db.SaveChangesAsync(ct);
        return await ToResponseAsync(project, ct);
    }

    // Every load by id goes through the caller's scope: a project outside it does not exist for them (404), so ids reveal
    // nothing (DEV-09).
    private Task<Project?> LoadAsync(Guid id, CancellationToken ct) =>
        db.Projects.InScope(db, scope).Include(p => p.Phases).ThenInclude(p => p.Tasks).SingleOrDefaultAsync(p => p.Id == id, ct);

    private async Task<ProjectResponse> ToResponseAsync(Project project, CancellationToken ct)
    {
        var organizations = await customers.GetOrganizationNamesAsync([project.OrganizationId], ct);
        var assigneeIds = project.Phases.SelectMany(p => p.Tasks).Where(t => t.AssigneeId != null).Select(t => t.AssigneeId!.Value);
        var memberIds = await db.ProjectMembers.AsNoTracking().Where(m => m.ProjectId == project.Id).Select(m => m.UserId).ToListAsync(ct);
        var userIds = assigneeIds.Concat(memberIds).Concat(project.ManagerId is { } m ? [m] : Array.Empty<Guid>()).Distinct().ToList();
        var people = await users.GetUsersAsync(userIds, ct);
        var productIds = project.Phases.Where(p => p.ProductId != null).Select(p => p.ProductId!.Value).Distinct().ToList();
        var products = productIds.Count > 0 ? await catalog.GetProductsAsync(productIds, ct) : new Dictionary<Guid, ProductRef>();
        var booked = await timeTracking.GetProjectHoursAsync([project.Id], ct);
        var hours = booked.Count > 0 ? booked[0] : null;

        RefDto? Person(Guid? id) => id is { } value && people.TryGetValue(value, out var user) ? new RefDto(user.Id, user.DisplayName) : null;

        var phases = project.Phases.OrderBy(p => p.Order).Select(phase => new ProjectPhaseDto(
            phase.Id,
            phase.Order,
            phase.Name,
            phase.Status,
            phase.PlannedStart,
            phase.PlannedEnd,
            phase.PlannedHours,
            phase.Fee,
            phase.BillOnCompletion,
            phase.ProductId,
            phase.ProductId is { } productId ? products.GetValueOrDefault(productId)?.Name : null,
            phase.CompletedOn,
            phase.Tasks.Select(task => new ProjectTaskDto(
                task.Id, task.Title, Person(task.AssigneeId), task.DueDate, task.EstimatedHours, task.Status, task.Notes)).ToList())).ToList();

        var progress = new ProjectProgressDto(
            project.BudgetHours,
            hours?.Hours ?? 0m,
            hours?.BillableHours ?? 0m,
            project.BudgetAmount,
            hours?.Amount ?? 0m,
            project.Phases.Where(p => p.Status == ProjectPhaseStatus.Completed && p.BillOnCompletion).Sum(p => p.Fee),
            project.Phases.Count(p => p.Status == ProjectPhaseStatus.Completed),
            project.Phases.Count,
            project.Phases.SelectMany(p => p.Tasks).Count(t => t.Status is ProjectTaskStatus.Open or ProjectTaskStatus.InProgress));

        return new ProjectResponse(
            project.Id,
            project.Number,
            project.Name,
            new RefDto(project.OrganizationId, organizations.GetValueOrDefault(project.OrganizationId, "—")),
            project.Type,
            project.Status,
            project.BillingModel,
            Person(project.ManagerId),
            project.StartDate,
            project.EndDate,
            project.CompletedOn,
            project.ContractId,
            project.OpportunityId,
            project.Notes,
            progress,
            phases,
            memberIds.Select(id => Person(id)).OfType<RefDto>().OrderBy(p => p.Name, StringComparer.CurrentCulture).ToList(),
            db.GetETag(project));
    }
}
