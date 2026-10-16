using Crm.Infrastructure.DependencyInjection;
using Crm.Infrastructure.Persistence;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Diagnostics.HealthChecks;

namespace Crm.Infrastructure.Health;

/// <summary>
/// Readiness of crm-web and crm-worker (DEV-06): the database answers within the probe budget and holds every migration
/// this build expects. The answer goes to the load balancer, so it says nothing about the server, the connection string or
/// the error; the exception reaches only the log. A <c>SELECT 1</c> on every probe; the schema is rechecked every five
/// minutes once it was complete, never on each probe. External systems are not part of readiness.
/// </summary>
public sealed class DatabaseReadinessCheck(IConfiguration configuration, IServiceScopeFactory scopes, ModuleDbContextRegistry registry, TimeProvider time)
    : IHealthCheck
{
    private static readonly TimeSpan SchemaRecheck = TimeSpan.FromMinutes(5);
    private DateTimeOffset _schemaVerifiedUntil = DateTimeOffset.MinValue;

    /// <summary>The time the probe waits for the database before it answers "not ready" anyway.</summary>
    internal static readonly TimeSpan ConnectionBudget = TimeSpan.FromSeconds(3.5);

    public async Task<HealthCheckResult> CheckHealthAsync(HealthCheckContext context, CancellationToken cancellationToken)
    {
        // A connection of its own, outside the pool and with a short connect timeout: a pooled connection to a server that
        // stopped answering waits for the command timeout and then for the cancellation to be acknowledged (measured: 8 s).
        var builder = new SqlConnectionStringBuilder(configuration.GetConnectionString(ModuleRegistration.ConnectionStringName))
        {
            ConnectTimeout = 3,
            Pooling = false,
        };
        var probe = PingAsync(builder.ConnectionString, cancellationToken);
        if (await Task.WhenAny(probe, Task.Delay(ConnectionBudget, time, cancellationToken)) != probe)
        {
            // Whatever SqlClient still waits for, the load balancer gets its answer in time; the late result is only logged.
            _ = probe.ContinueWith(t => t.Exception?.Flatten(), TaskScheduler.Default);
            return HealthCheckResult.Unhealthy("The database does not answer in time.");
        }

        if (await probe is { } failure)
        {
            return HealthCheckResult.Unhealthy("The database does not answer.", failure);
        }

        if (time.GetUtcNow() < _schemaVerifiedUntil)
        {
            return HealthCheckResult.Healthy();
        }

        await using var scope = scopes.CreateAsyncScope();
        foreach (var contextType in registry.Contexts)
        {
            var moduleContext = (ModuleDbContext)scope.ServiceProvider.GetRequiredService(contextType);
            var pending = (await moduleContext.Database.GetPendingMigrationsAsync(cancellationToken)).Count();
            if (pending > 0)
            {
                return HealthCheckResult.Unhealthy($"The database schema is behind this build ({moduleContext.Schema}: {pending} migrations not applied).");
            }
        }

        _schemaVerifiedUntil = time.GetUtcNow() + SchemaRecheck;
        return HealthCheckResult.Healthy();
    }

    /// <summary>Opens a connection and runs <c>SELECT 1</c>; returns the failure, or null.</summary>
    private static async Task<Exception?> PingAsync(string connectionString, CancellationToken cancellationToken)
    {
        try
        {
            await using var connection = new SqlConnection(connectionString);
            await connection.OpenAsync(cancellationToken);
            await using var command = new SqlCommand("SELECT 1", connection) { CommandTimeout = 3 };
            await command.ExecuteScalarAsync(cancellationToken);
            return null;
        }
        catch (Exception ex) when (ex is SqlException or InvalidOperationException or OperationCanceledException or TimeoutException)
        {
            return ex;
        }
    }
}
