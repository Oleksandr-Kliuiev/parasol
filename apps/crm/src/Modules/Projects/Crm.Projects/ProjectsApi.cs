using Crm.Projects.Contracts;
using Crm.Projects.Domain;
using Crm.Projects.Features;
using Crm.Projects.Persistence;
using Crm.SharedKernel.Application;
using Microsoft.EntityFrameworkCore;

namespace Crm.Projects;

/// <summary>
/// What other modules may ask about a project: time entries link to one, and the timesheet shows its name. The project
/// lookups answer as the caller may see projects (DEV-09); background work sees them all.
/// </summary>
internal sealed class ProjectsApi(ProjectsDbContext db, IRecordScope scope) : IProjectsApi
{
    public async Task<ProjectRef?> GetProjectAsync(Guid projectId, CancellationToken cancellationToken) =>
        await db.Projects.AsNoTracking().InScope(db, scope)
            .Where(p => p.Id == projectId)
            .Select(p => new ProjectRef(p.Id, p.Name, p.OrganizationId, p.Status))
            .SingleOrDefaultAsync(cancellationToken);

    public async Task<IReadOnlyList<ProjectRef>> GetProjectsAsync(Guid organizationId, bool openOnly, CancellationToken cancellationToken) =>
        await db.Projects.AsNoTracking().InScope(db, scope)
            .Where(p => p.OrganizationId == organizationId &&
                        (!openOnly || (p.Status != ProjectStatus.Completed && p.Status != ProjectStatus.Cancelled)))
            .OrderByDescending(p => p.Number)
            .Select(p => new ProjectRef(p.Id, p.Name, p.OrganizationId, p.Status))
            .ToListAsync(cancellationToken);

    public async Task<IReadOnlyDictionary<Guid, string>> GetProjectNamesAsync(
        IReadOnlyCollection<Guid> projectIds, CancellationToken cancellationToken) =>
        projectIds.Count == 0
            ? new Dictionary<Guid, string>()
            : await db.Projects.AsNoTracking()
                .Where(p => projectIds.Contains(p.Id))
                .ToDictionaryAsync(p => p.Id, p => p.Name, cancellationToken);

    public async Task<bool?> IsPhaseCompletedAsync(Guid phaseId, CancellationToken cancellationToken)
    {
        var status = await db.ProjectPhases.AsNoTracking()
            .Where(p => p.Id == phaseId)
            .Select(p => (ProjectPhaseStatus?)p.Status)
            .SingleOrDefaultAsync(cancellationToken);
        return status is null ? null : status == ProjectPhaseStatus.Completed;
    }
}
