using System.Text.RegularExpressions;
using Crm.Infrastructure.DependencyInjection;
using Crm.Infrastructure.Persistence;
using Hangfire.SqlServer;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;

namespace Crm.Web.Http;

/// <summary>
/// Applies module migrations in registry order (Audit first) and prepares the Hangfire schema.
/// In Azure this runs as the <c>crm-migrate</c> Container Apps job (<c>--migrate-only</c>) under the migrator identity,
/// which is the only principal with DDL rights; crm-web and crm-worker run with data-only permissions.
/// </summary>
public static partial class DatabaseMigrator
{
    public const string MigrateOnlyArgument = "--migrate-only";

    public static async Task MigrateAsync(IServiceProvider services, CancellationToken cancellationToken = default)
    {
        await using var scope = services.CreateAsyncScope();
        var registry = scope.ServiceProvider.GetRequiredService<ModuleDbContextRegistry>();
        var configuration = scope.ServiceProvider.GetRequiredService<IConfiguration>();
        var logger = scope.ServiceProvider.GetRequiredService<ILoggerFactory>().CreateLogger(typeof(DatabaseMigrator));

        foreach (var contextType in registry.Contexts)
        {
            var context = (ModuleDbContext)scope.ServiceProvider.GetRequiredService(contextType);
            await context.Database.MigrateAsync(cancellationToken);
            logger.LogInformation("Migrated {Context}", contextType.Name);
        }

        var connectionString = configuration.GetConnectionString(ModuleRegistration.ConnectionStringName)!;
        await using var connection = new SqlConnection(connectionString);
        await connection.OpenAsync(cancellationToken);
        SqlServerObjectsInstaller.Install(connection, "hangfire", enableHeavyMigrations: true);

        if (configuration["Database:AppIdentityName"] is { Length: > 0 } appIdentity &&
            Guid.TryParse(configuration["Database:AppIdentityClientId"], out var appClientId))
        {
            await GrantAppIdentityAsync(connection, appIdentity, appClientId, cancellationToken);
            logger.LogInformation("Granted data access to {Identity}", appIdentity);
        }
    }

    /// <summary>
    /// Creates the Entra (managed identity) database user for the application with read/write, no DDL.
    /// <c>WITH SID … TYPE = E</c> avoids a directory lookup, so the SQL server needs no Entra read permissions.
    /// </summary>
    private static async Task GrantAppIdentityAsync(SqlConnection connection, string identityName, Guid clientId, CancellationToken cancellationToken)
    {
        if (!IdentityNamePattern().IsMatch(identityName))
        {
            throw new InvalidOperationException($"Invalid identity name '{identityName}'.");
        }

        var sql = $"""
            IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'{identityName}')
                CREATE USER [{identityName}] WITH SID = 0x{Convert.ToHexString(clientId.ToByteArray())}, TYPE = E;
            ALTER ROLE db_datareader ADD MEMBER [{identityName}];
            ALTER ROLE db_datawriter ADD MEMBER [{identityName}];
            GRANT EXECUTE ON SCHEMA::hangfire TO [{identityName}];
            """;
        await using var command = new SqlCommand(sql, connection);
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    [GeneratedRegex("^[A-Za-z0-9-_]{1,128}$")]
    private static partial Regex IdentityNamePattern();
}
