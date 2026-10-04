using Crm.Infrastructure.Persistence;

namespace Crm.Audit.Persistence;

/// <summary>
/// The audit trail is insert-only for the application (DatabasePermissions); retention policies are approved data the
/// application cannot write; integrity checkpoints are added by the worker only; the privacy operator executes the retention
/// procedure and nothing else (DEV-04, EXT-07).
/// </summary>
internal sealed class AuditDatabasePermissions : IDatabasePermissionRules
{
    public IEnumerable<string> Statements =>
    [
        DatabasePermissions.IfTable(AuditDbContext.SchemaName, "RetentionPolicies",
            $"DENY INSERT, UPDATE, DELETE ON OBJECT::[audit].[RetentionPolicies] TO [{DatabaseRoles.Runtime}];"),
        DatabasePermissions.IfTable(AuditDbContext.SchemaName, "IntegrityCheckpoints",
            $"DENY UPDATE, DELETE ON OBJECT::[audit].[IntegrityCheckpoints] TO [{DatabaseRoles.Runtime}];"),
        DatabasePermissions.IfTable(AuditDbContext.SchemaName, "IntegrityCheckpoints",
            $"DENY INSERT ON OBJECT::[audit].[IntegrityCheckpoints] TO [{DatabaseRoles.Web}];"),
        $"IF OBJECT_ID(N'[audit].[ApplyRetention]', N'P') IS NOT NULL GRANT EXECUTE ON OBJECT::[audit].[ApplyRetention] TO [{DatabaseRoles.Privacy}];",
    ];
}
