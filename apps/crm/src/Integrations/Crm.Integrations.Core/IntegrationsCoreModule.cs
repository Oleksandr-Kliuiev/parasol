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
        services.AddScoped<Crm.SharedKernel.Operations.ISyncCompletenessSource, SyncCompletenessReader>();
        services.AddScoped<IntegrationMonitoringReader>();
        services.AddScoped<Crm.Privacy.Contracts.IRetentionContributor, ExceptionTriageRetention>();
        services.AddScoped<ExternalRecordStore>();
        services.AddScoped<ExternalLinkService>();
        services.AddScoped<Crm.Service.Contracts.ITicketOwnershipApi, AteraTicketOwnershipReader>();
        services.AddScoped<OutboundQueue>();
        services.AddScoped<ExternalImportService>();
        // DEV-11: links, mirrored person records and queued changes in subject requests; retention of payloads and the run log.
        services.AddScoped<IntegrationPersonalData>();
        services.AddScoped<Crm.Privacy.Contracts.IPersonalDataContributor>(sp => sp.GetRequiredService<IntegrationPersonalData>());
        services.AddScoped<Crm.Privacy.Contracts.IExternalReferenceSource>(sp => sp.GetRequiredService<IntegrationPersonalData>());
        services.AddScoped<Crm.Privacy.Contracts.IRetentionContributor, ExternalPayloadRetention>();
        services.AddScoped<Crm.Privacy.Contracts.IRetentionContributor, VendorActionTextRetention>();
        services.AddScoped<Crm.Privacy.Contracts.IRetentionContributor, SyncRunRetention>();
        services.AddScoped<Crm.SharedKernel.Operations.IRestoreParticipant, IntegrationRestoreParticipant>();
        services.AddScoped<Crm.Infrastructure.Health.IWorkerHeartbeat, WorkerHeartbeatStore>();
        services.AddScoped<WorkerHeartbeatReader>();
        services.AddScoped<WorkerHeartbeatJob>();
        services.AddSingleton<OutboundProcessorJob>();
        // M39.1: actions at vendors — previewed and asked for in crm-web, sent by the loop of crm-worker.
        services.AddScoped<Actions.VendorActionService>();
        services.AddScoped<Actions.VendorActionReader>();
        services.AddScoped<Actions.CustomerServiceReader>();
        services.AddSingleton<Actions.VendorActionRunner>();
        // M44: crm-web files what a vendor's webhook asks for; the job it names reads the records the webhook named.
        services.AddScoped<Webhooks.WebhookInbox>();
        services.AddScoped<Webhooks.EarlyReadTargets>();
        services.AddOptions<Webhooks.EarlyReadOptions>().Bind(configuration.GetSection(Webhooks.EarlyReadOptions.SectionName));
        services.AddSingleton<Crm.Infrastructure.Persistence.IDatabasePermissionRules, IntegrationDatabasePermissions>();
        services.AddModuleServices(typeof(IntegrationsCoreModule).Assembly);
        return services;
    }

    /// <summary>The five-second loop that sends vendor actions; crm-worker only, the host with the provider credentials.</summary>
    public static IServiceCollection AddVendorActionLoop(this IServiceCollection services) =>
        services.AddHostedService<Actions.VendorActionLoop>();

    /// <summary>
    /// The five-second loop that starts the reads webhooks asked for (M44); crm-worker only, which passes its job server as
    /// <typeparamref name="TTrigger"/>.
    /// </summary>
    public static IServiceCollection AddEarlyReadLoop<TTrigger>(this IServiceCollection services)
        where TTrigger : class, Webhooks.IJobTrigger
    {
        services.AddSingleton<Webhooks.IJobTrigger, TTrigger>();
        services.AddSingleton<Webhooks.EarlyReadRunner>();
        return services.AddHostedService<Webhooks.EarlyReadLoop>();
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
                // Legacy runs may contain a provider response with invoice amounts or personal data.
                foreach (var row in rows) row.Message = row.Status == SyncRunStatus.Failed ? "Synchronization failed." : null;
                return Results.Ok(new PagedResult<SyncRun>(
                    rows, page.Count > take ? new KeysetCursor(rows[^1].StartedAt.ToString("O", CultureInfo.InvariantCulture), rows[^1].Id).Encode() : null, total));
            })
            .WithTags("Integrations")
            .RequirePermission(Permissions.IntegrationsManage);

        // NFR §4.3: what monitoring asks about the external systems. Deliberately not part of readiness — a sulking
        // integration must never take the CRM out of the load balancer.
        app.MapGet("/health/integrations", async (IntegrationMonitoringReader reader, CancellationToken ct) =>
            {
                var snapshot = await reader.ReadAsync(ct);
                return Results.Ok(new
                {
                    status = snapshot.Systems.Any(s => s.Enabled && !s.Paused &&
                        (s.Freshness is "Stale" or "Never" || s.LastRunStatus == "Failed" || s.FailedOutbound > 0)) ? "Degraded" : "Healthy",
                    checkedAt = snapshot.CheckedAt,
                    systems = snapshot.Systems.GroupBy(s => s.System).Select(g => new
                    {
                        system = g.Key,
                        enabled = g.Any(s => s.Enabled),
                        paused = g.Any(s => s.Paused),
                        lastSucceededAt = g.Max(s => s.LastSucceededAt),
                        healthy = g.All(s => !s.Enabled || s.Paused || (s.Freshness == "Fresh" && s.LastRunStatus != "Failed" && s.FailedOutbound == 0)),
                        streams = g.ToList(),
                    }),
                });
            })
            .WithTags("Integrations")
            .RequirePermission(Permissions.IntegrationsManage);

        return app;
    }
}
