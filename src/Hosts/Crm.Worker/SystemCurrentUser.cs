using Crm.SharedKernel.Application;

namespace Crm.Worker;

/// <summary>Identity of background jobs; recorded in the audit log as "system".</summary>
internal sealed class SystemCurrentUser : ICurrentUser
{
    public Guid? UserId => null;

    public string DisplayName => "system";

    public bool IsAuthenticated => true;

    public bool HasPermission(string permission) => true;
}
