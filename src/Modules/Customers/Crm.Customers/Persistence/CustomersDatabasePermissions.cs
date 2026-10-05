using Crm.Infrastructure.Persistence;

namespace Crm.Customers.Persistence;

/// <summary>
/// The migration import's manifest is evidence of what a batch did (DEV-20): the application writes outcomes and batch
/// markers once and never rewrites or deletes them, and deletes no run. A run itself is updated while it works.
/// </summary>
internal sealed class CustomersDatabasePermissions : IDatabasePermissionRules
{
    public IEnumerable<string> Statements =>
    [
        DatabasePermissions.IfTable(CustomersDbContext.SchemaName, "ImportRowOutcomes",
            $"DENY UPDATE, DELETE ON OBJECT::[customers].[ImportRowOutcomes] TO [{DatabaseRoles.Runtime}];"),
        DatabasePermissions.IfTable(CustomersDbContext.SchemaName, "ImportRunEntities",
            $"DENY UPDATE, DELETE ON OBJECT::[customers].[ImportRunEntities] TO [{DatabaseRoles.Runtime}];"),
        DatabasePermissions.IfTable(CustomersDbContext.SchemaName, "ImportRuns",
            $"DENY DELETE ON OBJECT::[customers].[ImportRuns] TO [{DatabaseRoles.Runtime}];"),
    ];
}
