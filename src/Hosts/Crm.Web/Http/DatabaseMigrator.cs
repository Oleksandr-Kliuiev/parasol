using System.Text.RegularExpressions;
using Crm.Infrastructure.DependencyInjection;
using Crm.Infrastructure.Persistence;
using Hangfire.SqlServer;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;

namespace Crm.Web.Http;

/// <summary>
/// Applies module migrations in registry order (Audit first), prepares the Hangfire schema and then the permissions: the
/// database roles and their grants (DEV-04, docs/runbooks/08-database-permissions.md) and the identities that run the
/// application, each in exactly one role. In Azure this runs as the <c>crm-migrate</c> Container Apps job
/// (<c>--migrate-only</c>) under the migrator identity, the only principal with DDL rights.
/// </summary>
public static partial class DatabaseMigrator
{
    public const string MigrateOnlyArgument = "--migrate-only";

    /// <summary>Configuration prefix → database role. "App" is the single identity of older deployments: it runs both hosts.</summary>
    private static readonly (string Prefix, string Role)[] Identities =
    [
        ("Web", DatabaseRoles.Web),
        ("Worker", DatabaseRoles.Worker),
        ("Privacy", DatabaseRoles.Privacy),
        ("App", DatabaseRoles.Worker),
    ];

    public static async Task MigrateAsync(IServiceProvider services, CancellationToken cancellationToken = default)
    {
        await using var scope = services.CreateAsyncScope();
        var registry = scope.ServiceProvider.GetRequiredService<ModuleDbContextRegistry>();
        var configuration = scope.ServiceProvider.GetRequiredService<IConfiguration>();
        var logger = scope.ServiceProvider.GetRequiredService<ILoggerFactory>().CreateLogger(typeof(DatabaseMigrator));

        var schemas = new List<string>();
        foreach (var contextType in registry.Contexts)
        {
            var context = (ModuleDbContext)scope.ServiceProvider.GetRequiredService(contextType);
            await context.Database.MigrateAsync(cancellationToken);
            schemas.Add(context.Schema);
            logger.LogInformation("Migrated {Context}", contextType.Name);
        }

        var connectionString = configuration.GetConnectionString(ModuleRegistration.ConnectionStringName)!;
        await using var connection = new SqlConnection(connectionString);
        await connection.OpenAsync(cancellationToken);
        SqlServerObjectsInstaller.Install(connection, "hangfire", enableHeavyMigrations: true);

        // Roles and grants first and checked, identities afterwards: an identity never ends up without the access it needs.
        await DatabasePermissions.ApplyAsync(connection, schemas, scope.ServiceProvider.GetServices<IDatabasePermissionRules>(), cancellationToken);
        await DatabasePermissions.VerifyAsync(connection, schemas, cancellationToken);
        logger.LogInformation("Applied and verified database roles and grants for {Count} schemas", schemas.Count);

        var separate = !string.IsNullOrEmpty(configuration["Database:WebIdentityName"]) || !string.IsNullOrEmpty(configuration["Database:WorkerIdentityName"]);
        foreach (var (prefix, role) in Identities)
        {
            if (configuration[$"Database:{prefix}IdentityName"] is not { Length: > 0 } identity ||
                !Guid.TryParse(configuration[$"Database:{prefix}IdentityClientId"], out var clientId))
            {
                continue;
            }

            if (prefix == "App")
            {
                // The single identity of older deployments; once web and worker have their own, it is not mapped any more.
                if (separate)
                {
                    logger.LogWarning("Database:AppIdentityName ignored: crm-web and crm-worker have their own identities.");
                    continue;
                }

                logger.LogWarning("Database:AppIdentityName is one identity for crm-web and crm-worker; give each its own (DEV-04).");
            }

            await GrantIdentityAsync(connection, identity, clientId, role, cancellationToken);
            logger.LogInformation("Identity {Identity} runs as {Role}", identity, role);
        }
    }

    /// <summary>
    /// Creates the Entra (managed identity) database user if needed and makes it a member of <paramref name="role"/> only,
    /// taking away db_datareader/db_datawriter an earlier version granted. <c>WITH SID … TYPE = E</c> avoids a directory
    /// lookup, so the SQL server needs no Entra read permissions.
    /// </summary>
    private static async Task GrantIdentityAsync(SqlConnection connection, string identityName, Guid clientId, string role, CancellationToken cancellationToken)
    {
        if (!IdentityNamePattern().IsMatch(identityName))
        {
            throw new InvalidOperationException($"Invalid identity name '{identityName}'.");
        }

        var sql = $"""
            IF N'{identityName}' IN (USER_NAME(), ORIGINAL_LOGIN())
                THROW 51030, N'The migrator does not change its own memberships.', 1;
            IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'{identityName}')
                CREATE USER [{identityName}] WITH SID = 0x{Convert.ToHexString(clientId.ToByteArray())}, TYPE = E;
            {DatabasePermissions.MembershipScript(identityName, role)}
            """;
        await using var command = new SqlCommand(sql, connection);
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    [GeneratedRegex("^[A-Za-z0-9-_]{1,128}\\z")]
    private static partial Regex IdentityNamePattern();
}
