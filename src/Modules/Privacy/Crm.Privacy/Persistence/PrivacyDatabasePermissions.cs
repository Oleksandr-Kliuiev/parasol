using Crm.Infrastructure.Persistence;

namespace Crm.Privacy.Persistence;

/// <summary>
/// Privacy records are evidence (DEV-11, runbook 08 §3): cases, holds, suppressions and manifests are added and change status,
/// never disappear; the records an erasure covered are only added; retention policies are approved data and the suppression
/// key a secret the migration created — the application can write neither. The privacy operator runs the procedures that
/// clear what the application may not change.
/// </summary>
internal sealed class PrivacyDatabasePermissions : IDatabasePermissionRules
{
    private const string Schema = PrivacyDbContext.SchemaName;

    public IEnumerable<string> Statements =>
    [
        Deny("Cases", "DELETE"),
        Deny("LegalHolds", "DELETE"),
        Deny("Suppressions", "DELETE"),
        Deny("ErasureManifests", "DELETE"),
        Deny("ErasedRecords", "UPDATE, DELETE"),
        Deny("RetentionPolicies", "INSERT, UPDATE, DELETE"),
        Deny("Keys", "INSERT, UPDATE, DELETE"),
    ];

    private static string Deny(string table, string actions) =>
        DatabasePermissions.IfTable(Schema, table, $"DENY {actions} ON OBJECT::[{Schema}].[{table}] TO [{DatabaseRoles.Runtime}];");
}
