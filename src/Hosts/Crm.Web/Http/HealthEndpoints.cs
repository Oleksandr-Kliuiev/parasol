using Crm.Authorization;
using Crm.Integrations.Core;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.Options;

namespace Crm.Web.Http;

/// <summary>
/// What operators see beyond the probes (DEV-06): each readiness check with its duration and a description that names no
/// server or credential, and the heartbeats of the worker components with their age. Admins only; the anonymous probes
/// (<c>/health/live</c>, <c>/health/ready</c>) answer with the status word alone.
/// </summary>
public static class HealthEndpoints
{
    private static readonly string[] ExpectedComponents = [Infrastructure.Outbox.OutboxProcessor.HeartbeatComponent, WorkerHeartbeatJob.Component];

    public static IEndpointRouteBuilder MapHealthDetails(this IEndpointRouteBuilder app)
    {
        app.MapGet("/health/details", async (
                HealthCheckService health, IServiceProvider services, IOptions<Infrastructure.Health.ProcessingHealthOptions> options,
                TimeProvider time, CancellationToken ct) =>
            {
                var report = await health.CheckHealthAsync(ct);
                IReadOnlyList<WorkerHeartbeatStatus>? beats = null;
                try
                {
                    await using var scope = services.CreateAsyncScope();
                    beats = await scope.ServiceProvider.GetRequiredService<WorkerHeartbeatReader>().ReadAsync(ct);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    // Without the database the heartbeats cannot be read; the checks above already say so.
                    services.GetRequiredService<ILoggerFactory>().CreateLogger(typeof(HealthEndpoints)).LogWarning("Worker heartbeats could not be read ({ErrorType})", ex.GetType().Name);
                }

                var missing = beats is null ? [] : ExpectedComponents.Where(c => beats.All(b => b.Component != c)).ToList();
                var workerHealthy = beats is not null && missing.Count == 0 && beats.All(b => !b.Stale);
                var status = report.Status == HealthStatus.Unhealthy ? "Unhealthy" : workerHealthy ? report.Status.ToString() : "Degraded";
                return Results.Ok(new
                {
                    status,
                    checkedAt = time.GetUtcNow(),
                    checks = report.Entries.Select(e => new
                    {
                        name = e.Key,
                        status = e.Value.Status.ToString(),
                        durationMs = (int)e.Value.Duration.TotalMilliseconds,
                        description = e.Value.Description,
                    }),
                    worker = new
                    {
                        available = beats is not null,
                        staleAfterSeconds = (int)options.Value.HeartbeatStaleAfter.TotalSeconds,
                        missing,
                        components = beats ?? [],
                    },
                });
            })
            .WithTags("Health")
            .RequirePermission(Permissions.IntegrationsManage);
        return app;
    }
}
