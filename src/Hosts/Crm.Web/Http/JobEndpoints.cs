using Crm.Authorization;
using Crm.Infrastructure.Persistence;
using Crm.Integrations.Core.Persistence;
using Crm.SharedKernel.Application;
using Hangfire;
using Hangfire.Storage;

namespace Crm.Web.Http;

public sealed record RecurringJobInfo(
    string Id,
    string Cron,
    string? TimeZone,
    DateTime? NextExecution,
    DateTime? LastExecution,
    string? LastState,
    string? Error);

/// <summary>Background job overview and manual trigger for administrators (Hangfire storage is shared with crm-worker).</summary>
public static class JobEndpoints
{
    public static IEndpointRouteBuilder MapJobEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/v1/integrations/jobs").WithTags("Integrations");

        group.MapGet("/", (IServiceProvider services) =>
            {
                if (services.GetService<JobStorage>() is not { } storage)
                {
                    return JobsUnavailable();
                }

                using var connection = storage.GetConnection();
                var jobs = connection.GetRecurringJobs()
                    .OrderBy(j => j.Id, StringComparer.Ordinal)
                    .Select(j => new RecurringJobInfo(j.Id, j.Cron, j.TimeZoneId, j.NextExecution, j.LastExecution, j.LastJobState, j.Error))
                    .ToList();
                return Results.Ok(jobs);
            })
            .RequirePermission(Permissions.IntegrationsManage);

        group.MapPost("/{jobId}/trigger", async (
                string jobId, IServiceProvider services, IntegrationDbContext db, ICurrentUser user, IRequestContext request, TimeProvider time, CancellationToken ct) =>
            {
                if (services.GetService<JobStorage>() is not { } storage || services.GetService<IRecurringJobManager>() is not { } manager)
                {
                    return JobsUnavailable();
                }

                using (var connection = storage.GetConnection())
                {
                    if (!connection.GetRecurringJobs([jobId]).Any(j => j.Job is not null || j.Cron is not null))
                    {
                        return Results.Problem(statusCode: StatusCodes.Status404NotFound, title: "JOB_NOT_FOUND", detail: $"Recurring job '{jobId}' does not exist.");
                    }
                }

                manager.Trigger(jobId);
                db.RecordAudit(user, request, time, AuditActions.TriggerJob, "RecurringJob", Guid.Empty, new { JobId = jobId });
                await db.SaveChangesAsync(ct);
                return Results.Accepted();
            })
            .RequirePermission(Permissions.IntegrationsManage);

        return app;
    }

    private static IResult JobsUnavailable() => Results.Problem(
        statusCode: StatusCodes.Status503ServiceUnavailable,
        title: "JOBS_UNAVAILABLE",
        detail: "Background job storage is not configured on this instance.");
}
