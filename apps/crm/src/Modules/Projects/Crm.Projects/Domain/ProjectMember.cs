using Crm.SharedKernel.Domain;

namespace Crm.Projects.Domain;

/// <summary>
/// A person on a project's team (DEV-09). With the manager and the assignees of its tasks, the team are the people a project is
/// assigned to — the only projects a technician sees in the Restricted mode. Leaving the team is a soft delete, so the audit
/// log keeps who could see the project and when.
/// </summary>
public sealed class ProjectMember : AuditableEntity
{
    private ProjectMember() { }

    public Guid ProjectId { get; private set; }

    public Guid UserId { get; private set; }

    internal static ProjectMember Add(Guid projectId, Guid userId) => new() { ProjectId = projectId, UserId = userId };
}
