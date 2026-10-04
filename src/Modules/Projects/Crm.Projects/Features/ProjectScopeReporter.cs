using Crm.Authorization;
using Crm.Projects.Persistence;
using Crm.SharedKernel.Application;
using Microsoft.EntityFrameworkCore;

namespace Crm.Projects.Features;

/// <summary>Projects per person they are assigned to — manager, team member or task assignee, as <see cref="ProjectAccess"/> (DEV-09).</summary>
internal sealed class ProjectScopeReporter(ProjectsDbContext db) : IRecordScopeReporter
{
    public string Kind => "projects";

    public string ReadPermission => Permissions.ProjectsRead;

    public string EveryRecordPermission => Permissions.ProjectsAll;

    public async Task<RecordScopeCounts> CountAsync(CancellationToken cancellationToken)
    {
        var projects = await db.Projects.AsNoTracking().Select(p => new { p.Id, p.ManagerId }).ToListAsync(cancellationToken);
        var members = await db.ProjectMembers.AsNoTracking().Select(m => new { m.ProjectId, m.UserId }).ToListAsync(cancellationToken);
        var assignees = await db.ProjectPhases.AsNoTracking()
            .SelectMany(phase => phase.Tasks.Where(t => t.AssigneeId != null).Select(t => new { phase.ProjectId, UserId = t.AssigneeId!.Value }))
            .ToListAsync(cancellationToken);

        var live = projects.Select(p => p.Id).ToHashSet();
        var pairs = projects.Where(p => p.ManagerId is not null).Select(p => (p.Id, User: p.ManagerId!.Value))
            .Concat(members.Select(m => (Id: m.ProjectId, User: m.UserId)))
            .Concat(assignees.Select(a => (Id: a.ProjectId, User: a.UserId)))
            .Where(pair => live.Contains(pair.Id))
            .Distinct()
            .ToList();
        return new RecordScopeCounts(
            projects.Count,
            projects.Count - pairs.Select(pair => pair.Id).Distinct().Count(),
            pairs.GroupBy(pair => pair.User).ToDictionary(g => g.Key, g => g.Count()));
    }
}
