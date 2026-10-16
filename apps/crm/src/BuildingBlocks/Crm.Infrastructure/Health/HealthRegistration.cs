using Crm.Infrastructure.Outbox;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Diagnostics.HealthChecks;

namespace Crm.Infrastructure.Health;

public static class HealthRegistration
{
    /// <summary>Checks with this tag decide <c>/health/ready</c>; <c>live</c> ones also decide <c>/health/live</c>.</summary>
    public const string ReadyTag = "ready";

    public const string LiveTag = "live";

    /// <summary>Readiness of a host: the database answers and has this build's schema (DEV-06). Never an external system.</summary>
    public static IServiceCollection AddDatabaseReadiness(this IServiceCollection services)
    {
        services.AddSingleton<DatabaseReadinessCheck>();
        services.AddHealthChecks().AddCheck<DatabaseReadinessCheck>("database", HealthStatus.Unhealthy, [ReadyTag], TimeSpan.FromSeconds(4));
        return services;
    }

    /// <summary>
    /// The outbox loop of crm-worker with its liveness check: the loop beats in memory after every round and stores a
    /// heartbeat for monitoring (DEV-06).
    /// </summary>
    public static IServiceCollection AddOutboxProcessing(this IServiceCollection services)
    {
        services.AddHostedService<OutboxProcessor>();
        services.AddHealthChecks().AddCheck<ProcessingLoopHealthCheck>("outbox-loop", HealthStatus.Unhealthy, [LiveTag]);
        return services;
    }
}
