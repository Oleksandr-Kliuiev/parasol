using Microsoft.Data.SqlClient;

namespace Crm.Infrastructure.Persistence;

/// <summary>
/// The database roles the application runs under (DEV-04, docs/runbooks/08-database-permissions.md). Nothing gets
/// <c>db_datawriter</c>: the runtime roles get data access per module schema, the audit table is insert-only, the migration
/// history is read-only and modules deny what their records must never undergo. Only the migrator (database owner) changes
/// the schema.
/// </summary>
public static class DatabaseRoles
{
    /// <summary>What crm-web and crm-worker share: data access per module schema, no DDL.</summary>
    public const string Runtime = "crm_runtime";

    /// <summary>crm-web: the runtime role, minus processing the outbox (the worker does that).</summary>
    public const string Web = "crm_web";

    /// <summary>crm-worker: the runtime role; it processes the outbox and runs the jobs.</summary>
    public const string Worker = "crm_worker";

    /// <summary>The retention operator: executes the retention procedure and nothing else (DEC-03, EXT-07).</summary>
    public const string Privacy = "crm_privacy";

    public static readonly IReadOnlyList<string> All = [Runtime, Web, Worker, Privacy];
}

/// <summary>
/// A module's own permission rules on top of the generic ones, e.g. tables whose rows the application never deletes.
/// Statements are idempotent T-SQL; the migrator runs them after every migration, so new tables are covered as they come.
/// </summary>
public interface IDatabasePermissionRules
{
    IEnumerable<string> Statements { get; }
}

public static class DatabasePermissions
{
    /// <summary>
    /// Creates the roles if needed and (re)applies every grant and deny: per module schema SELECT/INSERT/UPDATE/DELETE for
    /// the runtime role, insert-only audit, read-only migration history, the web role without outbox processing, Hangfire
    /// for both, and the modules' own rules. Idempotent; run by the migrator with owner rights.
    /// </summary>
    public static string Script(IReadOnlyCollection<string> moduleSchemas, IEnumerable<IDatabasePermissionRules> rules)
    {
        var statements = new List<string>();
        foreach (var role in DatabaseRoles.All)
        {
            statements.Add($"IF DATABASE_PRINCIPAL_ID(N'{role}') IS NULL CREATE ROLE [{role}];");
        }

        foreach (var member in new[] { DatabaseRoles.Web, DatabaseRoles.Worker })
        {
            statements.Add(AddMember(DatabaseRoles.Runtime, member));
        }

        foreach (var schema in moduleSchemas.Distinct(StringComparer.OrdinalIgnoreCase))
        {
            Guard(schema);
            statements.Add(schema == "audit"
                // The audit trail is written in the business transaction and never rewritten by the application.
                ? $"GRANT SELECT, INSERT ON SCHEMA::[{schema}] TO [{DatabaseRoles.Runtime}];"
                : $"GRANT SELECT, INSERT, UPDATE, DELETE ON SCHEMA::[{schema}] TO [{DatabaseRoles.Runtime}];");
            statements.Add(IfTable(schema, "__EFMigrationsHistory",
                $"DENY INSERT, UPDATE, DELETE ON OBJECT::[{schema}].[__EFMigrationsHistory] TO [{DatabaseRoles.Runtime}];"));
            statements.Add(IfTable(schema, "OutboxMessages",
                $"DENY UPDATE, DELETE ON OBJECT::[{schema}].[OutboxMessages] TO [{DatabaseRoles.Web}];"));
            // DEV-07: handlers run only in the worker, so the web host writes no receipts; it files replay requests and the
            // worker applies them — the web host can neither mark a request applied nor take one back.
            statements.Add(IfTable(schema, "InboxReceipts",
                $"DENY INSERT, UPDATE, DELETE ON OBJECT::[{schema}].[InboxReceipts] TO [{DatabaseRoles.Web}];"));
            statements.Add(IfTable(schema, "OutboxReplayRequests",
                $"DENY UPDATE, DELETE ON OBJECT::[{schema}].[OutboxReplayRequests] TO [{DatabaseRoles.Web}];"));
        }

        statements.Add(IfTable("audit", "AuditEntries", $"DENY UPDATE, DELETE ON OBJECT::[audit].[AuditEntries] TO [{DatabaseRoles.Runtime}];"));
        statements.Add($"IF SCHEMA_ID(N'hangfire') IS NOT NULL GRANT SELECT, INSERT, UPDATE, DELETE, EXECUTE ON SCHEMA::[hangfire] TO [{DatabaseRoles.Runtime}];");
        statements.AddRange(rules.SelectMany(r => r.Statements));
        return string.Join(Environment.NewLine, statements);
    }

    /// <summary>The fixed roles that would undo the narrow grants: data writer and reader, DDL, ownership, security.</summary>
    public static readonly IReadOnlyList<string> BroadRoles =
        ["db_owner", "db_datawriter", "db_datareader", "db_ddladmin", "db_securityadmin", "db_accessadmin", "db_backupoperator"];

    public const string NarrowRolesTrigger = "trg_ApplicationRolesStayNarrow";

    /// <summary>
    /// A database DDL trigger that refuses to put a member of an application role into a broad fixed role. An older version's
    /// migrator granted db_datareader/db_datawriter on every run; a rollback that runs it again fails here instead of quietly
    /// widening the rights (DEV-04). Undoing this is a deliberate act of the database owner: DROP TRIGGER … ON DATABASE.
    /// </summary>
    public static string NarrowRolesTriggerScript()
    {
        var broad = string.Join(", ", BroadRoles.Select(r => $"N'{r}'"));
        var application = string.Join(", ", DatabaseRoles.All.Select(r => $"N'{r}'"));
        return $"""
            CREATE OR ALTER TRIGGER [{NarrowRolesTrigger}] ON DATABASE FOR ADD_ROLE_MEMBER AS
            BEGIN
                SET NOCOUNT ON;
                DECLARE @role sysname = EVENTDATA().value('(/EVENT_INSTANCE/RoleName)[1]', 'sysname');
                DECLARE @member sysname = EVENTDATA().value('(/EVENT_INSTANCE/ObjectName)[1]', 'sysname');
                IF @role IN ({broad}) AND EXISTS (
                    SELECT 1 FROM sys.database_role_members m
                    JOIN sys.database_principals r ON r.principal_id = m.role_principal_id
                    JOIN sys.database_principals u ON u.principal_id = m.member_principal_id
                    WHERE u.name = @member AND r.name IN ({application}))
                    THROW 51031, N'APPLICATION_ROLE_STAYS_NARROW: an identity of the application does not get a broad fixed role (DEV-04, runbook 08).', 1;
            END
            """;
    }

    /// <summary>
    /// Checks that the runtime role has what the application needs on every module schema before any identity is switched to
    /// it: an identity never loses db_datawriter for a role that turned out to be incomplete.
    /// </summary>
    public static async Task VerifyAsync(SqlConnection connection, IReadOnlyCollection<string> moduleSchemas, CancellationToken ct)
    {
        var missing = new List<string>();
        foreach (var schema in moduleSchemas.Distinct(StringComparer.OrdinalIgnoreCase))
        {
            Guard(schema);
            var required = schema == "audit" ? new[] { "SELECT", "INSERT" } : ["SELECT", "INSERT", "UPDATE", "DELETE"];
            await using var command = new SqlCommand(
                """
                SELECT p.permission_name FROM sys.database_permissions p
                WHERE p.class = 3 AND p.major_id = SCHEMA_ID(@schema) AND p.state = 'G' AND p.grantee_principal_id = DATABASE_PRINCIPAL_ID(@role)
                """, connection);
            command.Parameters.AddWithValue("@schema", schema);
            command.Parameters.AddWithValue("@role", DatabaseRoles.Runtime);
            var granted = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            await using (var reader = await command.ExecuteReaderAsync(ct))
            {
                while (await reader.ReadAsync(ct))
                {
                    granted.Add(reader.GetString(0));
                }
            }

            missing.AddRange(required.Where(r => !granted.Contains(r)).Select(r => $"{r} on {schema}"));
        }

        if (missing.Count > 0)
        {
            throw new InvalidOperationException($"The role {DatabaseRoles.Runtime} lacks {string.Join(", ", missing)}; no identity was switched.");
        }
    }

    public static async Task ApplyAsync(SqlConnection connection, IReadOnlyCollection<string> moduleSchemas, IEnumerable<IDatabasePermissionRules> rules, CancellationToken ct)
    {
        await using (var command = new SqlCommand(Script(moduleSchemas, rules), connection))
        {
            await command.ExecuteNonQueryAsync(ct);
        }

        // CREATE TRIGGER has to be the only statement of its batch.
        await using (var trigger = new SqlCommand(NarrowRolesTriggerScript(), connection))
        {
            await trigger.ExecuteNonQueryAsync(ct);
        }
    }

    /// <summary>
    /// Makes <paramref name="userName"/> a member of exactly <paramref name="role"/> among the application roles and takes away
    /// the broad fixed roles an earlier version gave it, so a narrowed identity does not keep db_datawriter.
    /// </summary>
    public static string MembershipScript(string userName, string role)
    {
        Guard(userName);
        Guard(role);
        var statements = new List<string> { AddMember(role, userName) };
        foreach (var other in DatabaseRoles.All.Where(r => r != role).Concat(BroadRoles))
        {
            statements.Add($"IF EXISTS (SELECT 1 FROM sys.database_role_members m JOIN sys.database_principals r ON r.principal_id = m.role_principal_id " +
                           $"JOIN sys.database_principals u ON u.principal_id = m.member_principal_id WHERE r.name = N'{other}' AND u.name = N'{userName}') " +
                           $"ALTER ROLE [{other}] DROP MEMBER [{userName}];");
        }

        return string.Join(Environment.NewLine, statements);
    }

    /// <summary>Wraps a statement so it runs only when the table exists (a module may not have created it yet).</summary>
    public static string IfTable(string schema, string table, string statement)
    {
        Guard(schema);
        Guard(table);
        return $"IF OBJECT_ID(N'[{schema}].[{table}]', N'U') IS NOT NULL {statement}";
    }

    private static string AddMember(string role, string member) =>
        $"IF NOT EXISTS (SELECT 1 FROM sys.database_role_members m JOIN sys.database_principals r ON r.principal_id = m.role_principal_id " +
        $"JOIN sys.database_principals u ON u.principal_id = m.member_principal_id WHERE r.name = N'{role}' AND u.name = N'{member}') " +
        $"ALTER ROLE [{role}] ADD MEMBER [{member}];";

    /// <summary>Names end up in T-SQL: only letters, digits, '-' and '_' are accepted.</summary>
    internal static void Guard(string name)
    {
        if (name.Length is 0 or > 128 || !name.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_'))
        {
            throw new InvalidOperationException($"Invalid database object name '{name}'.");
        }
    }
}
