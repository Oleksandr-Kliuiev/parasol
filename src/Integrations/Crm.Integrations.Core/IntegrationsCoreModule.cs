using System.Globalization;
using Crm.Authorization;
using Crm.Infrastructure.DependencyInjection;
using Crm.Integrations.Core.Persistence;
using Crm.SharedKernel.Application;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace Crm.Integrations.Core;

public static class IntegrationsCoreModule
{
    public static IServiceCollection AddIntegrationsCore(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddModuleDbContext<IntegrationDbContext>(configuration);
        services.AddScoped<SyncRunner>();
        services.AddScoped<ExternalRecordStore>();
        services.AddScoped<ExternalLinkService>();
        services.AddScoped<OutboundQueue>();
        services.AddScoped<ExternalImportService>();
        // DEV-11: links, mirrored person records and queued changes in subject requests; retention of payloads and the run log.
        services.AddScoped<IntegrationPersonalData>();
        services.AddScoped<Crm.Privacy.Contracts.IPersonalDataContributor>(sp => sp.GetRequiredService<IntegrationPersonalData>());
        services.AddScoped<Crm.Privacy.Contracts.IExternalReferenceSource>(sp => sp.GetRequiredService<IntegrationPersonalData>());
        services.AddScoped<Crm.Privacy.Contracts.IRetentionContributor, ExternalPayloadRetention>();
        services.AddScoped<Crm.Privacy.Contracts.IRetentionContributor, SyncRunRetention>();
        services.AddScoped<Crm.Infrastructure.Health.IWorkerHeartbeat, WorkerHeartbeatStore>();
        services.AddScoped<WorkerHeartbeatReader>();
        services.AddScoped<WorkerHeartbeatJob>();
        services.AddSingleton<OutboundProcessorJob>();
        services.AddModuleServices(typeof(IntegrationsCoreModule).Assembly);
        return services;
    }

    public static IEndpointRouteBuilder MapIntegrationRunEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/v1/integrations/runs", async (string? system, int? limit, string? cursor, IntegrationDbContext db, CancellationToken ct) =>
            {
                var runs = db.SyncRuns.AsNoTracking();
                if (!string.IsNullOrWhiteSpace(system))
                {
                    runs = runs.Where(r => r.System == system);
                }

                // Newest first, then id (DEV-12): a page per request and the count of all.
                var total = await runs.CountAsync(ct);
                if (KeysetCursor.Decode(cursor) is { } after &&
                    DateTimeOffset.TryParseExact(after.SortKey, "O", CultureInfo.InvariantCulture, DateTimeStyles.None, out var started))
                {
                    runs = runs.Where(r => r.StartedAt < started || (r.StartedAt == started && r.Id.CompareTo(after.Id) < 0));
                }

                var take = KeysetCursor.ClampLimit(limit);
                var page = await runs.OrderByDescending(r => r.StartedAt).ThenByDescending(r => r.Id).Take(take + 1).ToListAsync(ct);
                var rows = page.Take(take).ToList();
                return Results.Ok(new PagedResult<SyncRun>(
                    rows, page.Count > take ? new KeysetCursor(rows[^1].StartedAt.ToString("O", CultureInfo.InvariantCulture), rows[^1].Id).Encode() : null, total));
            })
            .WithTags("Integrations")
            .RequirePermission(Permissions.IntegrationsManage);

        // NFR §4.3: what monitoring asks about the external systems. Deliberately not part of readiness — a sulking
        // integration must never take the CRM out of the load balancer.
        app.MapGet("/health/integrations", async (IEnumerable<IIntegrationAdapter> adapters, IntegrationDbContext db, TimeProvider time, CancellationToken ct) =>
            {
                var now = time.GetUtcNow();
                var systems = new List<object>();
                var degraded = false;
                foreach (var adapter in adapters.OrderBy(a => a.System))
                {
                    // A connection test is a question an administrator asked, not a synchronization: it says nothing about freshness.
                    var last = await db.SyncRuns.AsNoTracking()
                        .Where(r => r.System == adapter.System && r.Status != SyncRunStatus.Running && r.Job != IntegrationConnectionTestHandler.Job)
                        .OrderByDescending(r => r.StartedAt)
                        .FirstOrDefaultAsync(ct);
                    var paused = await db.IntegrationSwitches.AsNoTracking()
                        .SingleOrDefaultAsync(s => s.System == adapter.System && s.IsPaused, ct);
                    var failedOutbound = await db.OutboundOperations
                        .CountAsync(o => o.System == adapter.System && (o.Status == OutboundStatus.Failed || o.Status == OutboundStatus.DeadLetter), ct);
                    var unhealthy = adapter.IsEnabled && paused is null &&
                                    (last is null || last.Status == SyncRunStatus.Failed || failedOutbound > 0);
                    degraded |= unhealthy;
                    systems.Add(new
                    {
                        system = adapter.System,
                        enabled = adapter.IsEnabled,
                        paused = paused is not null,
                        pauseReason = paused?.Reason,
                        lastRunAt = last?.StartedAt,
                        lastRunStatus = last?.Status.ToString(),
                        lastRunMessage = last?.Message,
                        minutesSinceLastRun = last is null ? (int?)null : (int)(now - last.StartedAt).TotalMinutes,
                        failedOutbound,
                        healthy = !unhealthy,
                    });
                }

                return Results.Ok(new { status = degraded ? "Degraded" : "Healthy", checkedAt = now, systems });
            })
            .WithTags("Integrations")
            .RequirePermission(Permissions.IntegrationsManage);

        return app;
    }
}
