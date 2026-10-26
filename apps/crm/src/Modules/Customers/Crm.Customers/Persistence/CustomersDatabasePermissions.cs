using Crm.Infrastructure.Persistence;

namespace Crm.Customers.Persistence;

/// <summary>
/// The migration import's manifest is evidence of what a batch did (DEV-20): the application writes outcomes and batch
/// markers once and never rewrites or deletes them, and deletes no run. A run itself is updated while it works. A stored document
/// (M43) is filed once: its row names bytes that never change, so neither the row nor the object is rewritten or removed.
/// </summary>
internal sealed class CustomersDatabasePermissions : IDatabasePermissionRules
{
    public IEnumerable<string> Statements =>
    [
        DatabasePermissions.IfTable(CustomersDbContext.SchemaName, "StoredDocuments",
            $"DENY UPDATE, DELETE ON OBJECT::[customers].[StoredDocuments] TO [{DatabaseRoles.Runtime}];"),
        DatabasePermissions.IfTable(CustomersDbContext.SchemaName, "ImportRowOutcomes",
            $"DENY UPDATE, DELETE ON OBJECT::[customers].[ImportRowOutcomes] TO [{DatabaseRoles.Runtime}];"),
        DatabasePermissions.IfTable(CustomersDbContext.SchemaName, "ImportRunEntities",
            $"DENY UPDATE, DELETE ON OBJECT::[customers].[ImportRunEntities] TO [{DatabaseRoles.Runtime}];"),
        DatabasePermissions.IfTable(CustomersDbContext.SchemaName, "ImportRuns",
            $"DENY DELETE ON OBJECT::[customers].[ImportRuns] TO [{DatabaseRoles.Runtime}];"),
    ];
}
