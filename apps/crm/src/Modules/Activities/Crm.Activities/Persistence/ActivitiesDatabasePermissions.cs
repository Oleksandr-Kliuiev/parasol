using Crm.Infrastructure.Persistence;

namespace Crm.Activities.Persistence;

/// <summary>
/// A source-task receipt is permanent under both application runtime identities: a deleted task never frees its alert for a second
/// task, and nothing rewrites what the task was made from.
/// </summary>
internal sealed class ActivitiesDatabasePermissions : IDatabasePermissionRules
{
    public IEnumerable<string> Statements =>
    [
        DatabasePermissions.IfTable(ActivitiesDbContext.SchemaName, "SourceTaskLinks",
            $"DENY UPDATE, DELETE ON OBJECT::[activities].[SourceTaskLinks] TO [{DatabaseRoles.Runtime}];"),
    ];
}
