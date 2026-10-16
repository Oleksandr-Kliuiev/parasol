using System.Diagnostics;
using System.Diagnostics.Metrics;
using Crm.Infrastructure.DependencyInjection;
using Crm.Infrastructure.Outbox;
using Crm.Infrastructure.Persistence;
using Crm.Integrations.Core;
using Crm.SharedKernel.Operations;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Crm.Worker;

/// <summary>
/// Bounded, read-only operational snapshots. Labels are registered modules, systems and jobs, never record ids, people,
/// amounts or exception text. Collection failures are observable independently of the database and job server.
/// </summary>
public sealed class OperationalTelemetry(IServiceScopeFactory scopes, TimeProvider time, ILogger<OperationalTelemetry> logger) : BackgroundService
{
    private static readonly Meter Meter = new("Crm.Operations");
    private static readonly Histogram<int> CollectionSuccess = Meter.CreateHistogram<int>("crm.monitoring.collection.success");
    private static readonly Histogram<double> HeartbeatAge = Meter.CreateHistogram<double>("crm.worker.heartbeat.age", "s");
    private static readonly Histogram<int> HeartbeatMissing = Meter.CreateHistogram<int>("crm.worker.heartbeat.missing");
    private static readonly Histogram<int> OutboxDepth = Meter.CreateHistogram<int>("crm.outbox.depth");
    private static readonly Histogram<double> OutboxAge = Meter.CreateHistogram<double>("crm.outbox.oldest.age", "s");
    private static readonly Histogram<int> OutboxDeadletter = Meter.CreateHistogram<int>("crm.outbox.deadletter");
    private static readonly Histogram<int> OutboundErrors = Meter.CreateHistogram<int>("crm.outbound.errors");
    private static readonly Histogram<double> SyncAge = Meter.CreateHistogram<double>("crm.sync.last_success.age", "s");
    private static readonly Histogram<int> SyncOverdue = Meter.CreateHistogram<int>("crm.sync.overdue");
    private static readonly Histogram<int> SyncFailed = Meter.CreateHistogram<int>("crm.sync.failed");
    private static readonly Histogram<int> Paused = Meter.CreateHistogram<int>("crm.integration.paused");
    private static readonly Histogram<int> Unmapped = Meter.CreateHistogram<int>("crm.records.unmapped");
    private static readonly Histogram<int> Anomalies = Meter.CreateHistogram<int>("crm.exceptions.count");

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromMinutes(1), time);
        do
        {
            try
            {
                // A cancelled/failed snapshot cannot silently look healthy; the missing-telemetry rule catches a wedged collector.
                using var budget = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
                budget.CancelAfter(TimeSpan.FromSeconds(45));
                await CollectAsync(budget.Token);
                CollectionSuccess.Record(1);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception)
            {
                CollectionSuccess.Record(0);
                logger.LogWarning("Operational monitoring snapshot failed; see database readiness and the monitoring runbook");
            }
        }
        while (await timer.WaitForNextTickAsync(stoppingToken));
    }

    public async Task CollectAsync(CancellationToken cancellationToken)
    {
        await using var scope = scopes.CreateAsyncScope();
        var services = scope.ServiceProvider;
        var now = time.GetUtcNow();
        var maintenance = await services.GetRequiredService<IMaintenanceGate>().CurrentAsync(cancellationToken);
        var maintenanceTag = new KeyValuePair<string, object?>("maintenance", maintenance.IsReadOnly ? "true" : "false");
        var beats = await services.GetRequiredService<WorkerHeartbeatReader>().ReadAsync(cancellationToken);
        foreach (var component in new[] { WorkerHeartbeatJob.Component, OutboxProcessor.HeartbeatComponent })
        {
            // A retired replica must not page the operator for a week: freshest beat represents service availability.
            var latest = beats.Where(beat => beat.Component == component).MaxBy(beat => beat.BeatAt);
            HeartbeatMissing.Record(latest is null ? 1 : 0, new KeyValuePair<string, object?>("component", component));
            if (latest is not null)
            {
                HeartbeatAge.Record(Math.Max(0, (now - latest.BeatAt).TotalSeconds), new KeyValuePair<string, object?>("component", component));
            }
        }

        foreach (var contextType in services.GetRequiredService<ModuleDbContextRegistry>().Contexts)
        {
            var db = (ModuleDbContext)services.GetRequiredService(contextType);
            if (db.IsAuditModule)
            {
                continue;
            }

            var rows = await db.OutboxMessages.AsNoTracking().Where(message => message.Status != OutboxStatus.Processed)
                .GroupBy(message => message.Status)
                .Select(group => new { Status = group.Key, Count = group.Count(), Oldest = group.Min(message => message.OccurredAt) })
                .ToListAsync(cancellationToken);
            var tags = new TagList { { "module", db.Schema }, maintenanceTag };
            var oldest = rows.Count > 0 ? rows.Min(row => row.Oldest) : (DateTimeOffset?)null;
            OutboxDepth.Record(rows.Sum(row => row.Count), tags);
            OutboxAge.Record(oldest is { } occurred ? Math.Max(0, (now - occurred).TotalSeconds) : 0, tags);
            OutboxDeadletter.Record(rows.Where(row => row.Status is OutboxStatus.DeadLetter or OutboxStatus.Quarantined).Sum(row => row.Count), tags);
        }

        var integrations = await services.GetRequiredService<IntegrationMonitoringReader>().ReadAsync(cancellationToken);
        foreach (var item in integrations.Systems)
        {
            var tags = new TagList { { "system", item.System }, { "job", item.Job } };
            // Never is a separate overdue signal; no invented successful timestamp is exported.
            if (item.AgeMinutes is { } minutes)
            {
                SyncAge.Record(minutes * 60, tags);
            }

            SyncOverdue.Record(!maintenance.IsReadOnly && item.Freshness is "Stale" or "Never" ? 1 : 0, tags);
            SyncFailed.Record(!maintenance.IsReadOnly && integrations.Exceptions.Any(e => e.Key == $"sync-failed:{item.System}:{item.Job}") ? 1 : 0, tags);
        }

        var systems = integrations.Systems.Select(item => item.System)
            .Concat(integrations.Exceptions.Select(item => item.Source))
            .Concat(services.GetServices<IIntegrationAdapter>().Select(adapter => adapter.System)).Distinct();
        foreach (var system in systems)
        {
            var paused = integrations.Exceptions.Any(item => item.Key == $"paused:{system}");
            var tags = new TagList { { "system", system }, { "paused", paused ? "true" : "false" }, maintenanceTag };
            Paused.Record(paused ? 1 : 0, new KeyValuePair<string, object?>("system", system));
            OutboundErrors.Record(integrations.Exceptions.Where(item => item.Key == $"outbound:{system}").Sum(item => item.Count), tags);
            Unmapped.Record(integrations.Exceptions.Where(item => item.Key == $"unmapped:{system}").Sum(item => item.Count), tags);
        }

        foreach (var source in services.GetServices<IOperationalSignalSource>())
        {
            foreach (var signal in await source.ReadAsync(cancellationToken))
            {
                Anomalies.Record(signal.Count, new TagList { { "category", signal.Category }, { "source", signal.Source }, { "kind", signal.Kind } });
            }
        }
    }
}
