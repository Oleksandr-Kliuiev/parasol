using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Diagnostics.HealthChecks;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using OpenTelemetry;
using OpenTelemetry.Metrics;
using OpenTelemetry.Trace;

namespace Microsoft.Extensions.Hosting;

/// <summary>Telemetry, health checks and HTTP defaults shared by crm-web and crm-worker.</summary>
public static class ServiceDefaultsExtensions
{
    public const string LivePath = "/health/live";
    public const string ReadyPath = "/health/ready";

    public static TBuilder AddServiceDefaults<TBuilder>(this TBuilder builder)
        where TBuilder : IHostApplicationBuilder
    {
        builder.ConfigureOpenTelemetry();

        builder.Services.AddHealthChecks().AddCheck("self", () => HealthCheckResult.Healthy(), ["live"]);
        builder.Services.AddHostedService<DatabaseReadinessTelemetry>();
        builder.Services.AddServiceDiscovery();
        builder.Services.ConfigureHttpClientDefaults(http => http.AddServiceDiscovery());
        return builder;
    }

    private static void ConfigureOpenTelemetry<TBuilder>(this TBuilder builder)
        where TBuilder : IHostApplicationBuilder
    {
        builder.Logging.AddOpenTelemetry(logging =>
        {
            logging.IncludeFormattedMessage = true;
            logging.IncludeScopes = true;
        });

        var otel = builder.Services.AddOpenTelemetry()
            .WithMetrics(metrics => metrics
                .AddMeter("Crm.Health", "Crm.Operations", "Crm.Outbox", "Crm.Security")
                .AddAspNetCoreInstrumentation()
                .AddHttpClientInstrumentation()
                .AddRuntimeInstrumentation())
            .WithTracing(tracing => tracing
                .AddSource(builder.Environment.ApplicationName)
                // A vendor's webhook address may carry its key (Atera's, M44): no span records that path.
                .AddAspNetCoreInstrumentation(o => o.Filter = ctx => !ctx.Request.Path.StartsWithSegments("/health") && !ctx.Request.Path.StartsWithSegments("/webhooks"))
                .AddHttpClientInstrumentation());

        if (!string.IsNullOrWhiteSpace(builder.Configuration["OTEL_EXPORTER_OTLP_ENDPOINT"]))
        {
            otel.UseOtlpExporter();
        }
    }

    public static WebApplication MapDefaultEndpoints(this WebApplication app)
    {
        app.MapHealthChecks(LivePath, new HealthCheckOptions { Predicate = r => r.Tags.Contains("live") }).AllowAnonymous();
        app.MapHealthChecks(ReadyPath, new HealthCheckOptions { Predicate = r => r.Tags.Contains("ready") || r.Tags.Contains("live") })
            .AllowAnonymous();
        return app;
    }
}
