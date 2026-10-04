using Crm.Authorization;
using Crm.Projects.Domain;
using Crm.Projects.Persistence;
using Crm.SharedKernel.Application;

namespace Crm.Projects.Features;

/// <summary>
/// Which projects the caller may see (DEV-09). A role without <see cref="Permissions.ProjectsAll"/> — in the Restricted mode,
/// the technician — sees the projects it is assigned to: as manager, as a member of the team, or as the assignee of a task.
/// No assignment means no access, never all of them. Every path that reads projects for a user goes through here.
/// </summary>
internal static class ProjectAccess
{
    public static IQueryable<Project> InScope(this IQueryable<Project> projects, ProjectsDbContext db, IRecordScope scope) =>
        scope.LimitedTo(Permissions.ProjectsAll) is { } userId
            ? projects.Where(p => p.ManagerId == userId
                || db.ProjectMembers.Any(m => m.ProjectId == p.Id && m.UserId == userId)
                || p.Phases.Any(phase => phase.Tasks.Any(t => t.AssigneeId == userId)))
            : projects;
}
