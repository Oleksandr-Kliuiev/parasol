using System.Diagnostics.Metrics;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Microsoft.Extensions.Hosting;

/// <summary>Readiness is measured even when no request arrives; an external provider never participates in this check.</summary>
internal sealed class DatabaseReadinessTelemetry(HealthCheckService checks, ILogger<DatabaseReadinessTelemetry> logger) : BackgroundService
{
    private static readonly Meter Meter = new("Crm.Health");
    private static readonly Histogram<int> Ready = Meter.CreateHistogram<int>("crm.sql.ready", description: "Database readiness: 1 healthy, 0 unhealthy");

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(30));
        do
        {
            try
            {
                var result = await checks.CheckHealthAsync(registration => registration.Name == "database", stoppingToken);
                if (result.Entries.Count > 0)
                {
                    Ready.Record(result.Status == HealthStatus.Healthy ? 1 : 0);
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception)
            {
                Ready.Record(0);
                // The check owns diagnostics. General monitoring must not copy connection details or domain data.
                logger.LogWarning("Database readiness telemetry could not complete its check");
            }
        }
        while (await timer.WaitForNextTickAsync(stoppingToken));
    }
}
