using Crm.Authorization;
using Crm.Identity.Contracts;
using Crm.Infrastructure.DependencyInjection;
using Crm.Infrastructure.Http;
using Crm.Infrastructure.Persistence;
using Crm.Integrations.Core;
using Crm.Integrations.Core.Persistence;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Domain;
using Crm.SharedKernel.Operations;
using Crm.SharedKernel.Results;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;

namespace Crm.Web.Http;

public sealed record UpdateExceptionTriage(string Key, Guid? OwnerId, string Status, string? Comment);
public sealed record OutboundRetrySelectionItem(Guid Id, string Etag);
public sealed record RetryOutboundSelection(IReadOnlyList<OutboundRetrySelectionItem>? Messages, int Expected, string? Reason);
public sealed record OutboundRetryItem(Guid Id, string Status);

/// <summary>Operator diagnostics are deliberately summaries: no provider response, amount or customer payload is exposed.</summary>
public static class MonitoringEndpoints
{
    public static IEndpointRouteBuilder MapMonitoringEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/v1/integrations/monitoring").WithTags("Integrations");
        group.MapGet("/", async (HttpContext http, IntegrationMonitoringReader reader, IntegrationDbContext db,
            ModuleDbContextRegistry registry, IEnumerable<IOperationalSignalSource> contributors, ICurrentUser user, IUserDirectory users, CancellationToken ct) =>
        {
            var snapshot = await ReadAsync(http, reader, registry, contributors, user, ct);
            var keys = snapshot.Exceptions.Select(e => e.Key).ToList();
            var records = await db.ExceptionTriages.AsNoTracking().Where(t => keys.Contains(t.Key)).ToListAsync(ct);
            var permissionNames = await db.ExceptionTriages.AsNoTracking().Select(t => t.RequiredPermission).Distinct().ToListAsync(ct);
            var permissions = permissionNames.Where(p => p is not null && user.HasPermission(p)).ToArray();
            var recoveredQuery = db.ExceptionTriages.AsNoTracking().Where(t => !keys.Contains(t.Key) && t.Status != "Resolved" && t.Source != "" &&
                    (t.RequiredPermission == null || permissions.Contains(t.RequiredPermission)));
            var recoveredTotalCount = await recoveredQuery.CountAsync(ct);
            var recovered = await recoveredQuery.OrderByDescending(t => t.UpdatedAt).Take(200).ToListAsync(ct);
            records.AddRange(recovered);
            var triage = records.ToDictionary(t => t.Key);
            var owners = await users.GetUsersAsync(triage.Values.Where(t => t.OwnerId != null).Select(t => t.OwnerId!.Value).Distinct().ToArray(), ct);
            var exceptions = snapshot.Exceptions.Concat(recovered.Select(t => new MonitoringExceptionItem(t.Key, t.Category, t.Source, t.Kind,
                t.UpdatedAt, null, null, null, 0, "Recovered", IntegrationMonitoringReader.Runbook, ExceptionTriageItem.Empty, false, t.RequiredPermission)));
            return Results.Ok(snapshot with { RecoveredTotalCount = recoveredTotalCount, Exceptions = exceptions.Select(e => e with
            {
                Triage = triage.TryGetValue(e.Key, out var t) ? Describe(t, t.OwnerId is { } id ? owners.GetValueOrDefault(id)?.DisplayName : null, e.Active) : ExceptionTriageItem.Empty,
            }).ToList() });
        }).RequirePermission(Permissions.IntegrationsManage);

        group.MapGet("/triage", async (string key, HttpContext http, IntegrationMonitoringReader reader, IntegrationDbContext db,
            ModuleDbContextRegistry registry, IEnumerable<IOperationalSignalSource> contributors, ICurrentUser user, IUserDirectory users, CancellationToken ct) =>
        {
            var active = (await ReadAsync(http, reader, registry, contributors, user, ct)).Exceptions.Any(e => e.Key == key);
            var triage = await db.ExceptionTriages.SingleOrDefaultAsync(t => t.Key == key, ct);
            if (!active && !CanRead(triage, user)) return NotFound();
            var owner = triage?.OwnerId is { } id ? await users.GetProfileAsync(id, ct) : null;
            var item = triage is null ? ExceptionTriageItem.Empty : Describe(triage, owner?.DisplayName, active);
            http.Response.Headers.ETag = item.Etag;
            return Results.Ok(item);
        }).RequirePermission(Permissions.IntegrationsManage);

        group.MapPut("/triage", async (UpdateExceptionTriage body, HttpContext http, IntegrationMonitoringReader reader, IntegrationDbContext db,
            ModuleDbContextRegistry registry, IEnumerable<IOperationalSignalSource> contributors, ICurrentUser user, IUserDirectory users,
            IRequestContext request, TimeProvider time, CancellationToken ct) =>
        {
            if (http.Request.GetIfMatch() is not { } etag) return HeaderExtensions.PreconditionRequired();
            if (string.IsNullOrWhiteSpace(body.Key) || body.Key.Length > 256 || body.Status is not ("Open" or "InProgress" or "Resolved") || body.Comment?.Length > 2000)
                return Error.Validation("MONITORING_TRIAGE_INVALID", "Use an active exception, a valid status and a comment of at most 2000 characters.").ToProblem();
            var active = (await ReadAsync(http, reader, registry, contributors, user, ct)).Exceptions.SingleOrDefault(e => e.Key == body.Key);
            var triage = await db.ExceptionTriages.SingleOrDefaultAsync(t => t.Key == body.Key, ct);
            if (active is null && !CanRead(triage, user)) return NotFound();
            if (active is not null && body.Status == "Resolved")
                return Error.Validation("MONITORING_STILL_ACTIVE", "Fix the cause before completing the review.").ToProblem();
            var owner = body.OwnerId is { } id ? await users.GetProfileAsync(id, ct) : null;
            if (body.OwnerId is not null && owner is not { IsActive: true })
                return Error.Validation("MONITORING_OWNER_INVALID", "Choose an active CRM user.").ToProblem();
            if (etag != (triage is null ? ExceptionTriageItem.Empty.Etag : Tag(triage))) return Stale();
            if (triage is null)
            {
                triage = new ExceptionTriage { Id = SequentialId.New(), Key = body.Key };
                db.ExceptionTriages.Add(triage);
            }
            var before = new { triage.OwnerId, triage.Status, triage.Comment };
            if (active is not null)
            {
                triage.Category = active.Category;
                triage.Source = active.Source;
                triage.Kind = active.Kind;
                triage.RequiredPermission = active.RequiredPermission;
            }
            triage.OwnerId = body.OwnerId;
            triage.Status = body.Status;
            triage.Comment = string.IsNullOrWhiteSpace(body.Comment) ? null : body.Comment.Trim();
            triage.UpdatedAt = time.GetUtcNow();
            db.RecordAudit(user, request, time, AuditActions.Update, nameof(ExceptionTriage), triage.Id,
                new { triage.Key, Before = before, After = new { triage.OwnerId, triage.Status, triage.Comment } });
            try { await db.SaveChangesAsync(ct); }
            catch (DbUpdateConcurrencyException) { return Stale(); }
            catch (DbUpdateException ex) when (ex.InnerException is SqlException { Number: 2601 or 2627 }) { return Stale(); }
            var result = Describe(triage, owner?.DisplayName);
            http.Response.Headers.ETag = result.Etag;
            return Results.Ok(result);
        }).RequirePermission(Permissions.IntegrationsManage);

        group.MapPost("/outbound/retry", async (RetryOutboundSelection body, IntegrationDbContext db, ICurrentUser user,
            IRequestContext request, TimeProvider time, CancellationToken ct) =>
        {
            var selected = body.Messages ?? [];
            if (selected.Any(m => m is null))
                return Error.Validation("MONITORING_RETRY_INVALID", "Every selected operation needs an ID and version.").ToProblem();
            var ids = selected.Select(m => m.Id).Distinct().ToList();
            var reason = body.Reason?.Trim() ?? string.Empty;
            if (ids.Count is 0 or > 100 || ids.Count != selected.Count || ids.Count != body.Expected ||
                selected.Any(m => string.IsNullOrWhiteSpace(m.Etag)) || reason.Length is < 10 or > 500)
                return Error.Validation("MONITORING_RETRY_INVALID", "Confirm 1–100 distinct operations with their versions and a reason of 10–500 characters.").ToProblem();
            return await db.Database.CreateExecutionStrategy().ExecuteAsync(async () =>
            {
                await using var transaction = await db.Database.BeginTransactionAsync(System.Data.IsolationLevel.Serializable, ct);
                var now = time.GetUtcNow();
                // Update locks serialize two operators before either writes: no double retry and no deadlock upgrade race.
                await db.Database.ExecuteSqlRawAsync("DECLARE @result int; EXEC @result = sys.sp_getapplock @Resource=N'crm-monitoring-outbound-retry', @LockMode=N'Exclusive', @LockOwner=N'Transaction', @LockTimeout=10000; IF @result < 0 THROW 51000, 'Retry selection is busy.', 1;", ct);
                var operations = await db.OutboundOperations.Where(o => ids.Contains(o.Id)).ToListAsync(ct);
                var versions = selected.ToDictionary(m => m.Id, m => m.Etag);
                // A vendor action is settled in the action log, never sent again from here (M39.1): it counts as unavailable.
                var eligible = operations.Where(o => o.Status is OutboundStatus.Failed or OutboundStatus.DeadLetter &&
                    !o.Operation.StartsWith(Crm.Integrations.Core.Actions.VendorAction.OperationPrefix, StringComparison.Ordinal) &&
                    (o.LockedUntil == null || o.LockedUntil < now) && versions[o.Id] == OutboundOperationItem.Version(o)).ToList();
                var items = ids.Select(id => new OutboundRetryItem(id, eligible.Any(o => o.Id == id) ? "Available" :
                    operations.Any(o => o.Id == id && versions[id] != OutboundOperationItem.Version(o)) ? "Stale" : "Unavailable")).ToList();
                if (eligible.Count != ids.Count)
                    return new Error("MONITORING_RETRY_STALE", "The selection changed. Reload and confirm the exact operations again.",
                        ErrorType.Conflict, new Dictionary<string, object?> { ["items"] = items }).ToProblem();
                foreach (var operation in eligible)
                {
                    db.RecordAudit(user, request, time, AuditActions.Replay, nameof(OutboundOperation), operation.Id,
                        new { Reason = reason, operation.System, operation.Operation, Previous = operation.Status.ToString(), operation.Attempts });
                    operation.Status = OutboundStatus.Pending;
                    operation.Attempts = 0;
                    operation.NextAttemptAt = now;
                    operation.CompletedAt = null;
                    operation.LockedUntil = null;
                    operation.LeaseOwner = null;
                    operation.LastError = null;
                }
                await db.SaveChangesAsync(ct);
                await transaction.CommitAsync(ct);
                return Results.Accepted(value: new { items = ids.Select(id => new OutboundRetryItem(id, "Requested")) });
            });
        }).RequirePermission(Permissions.IntegrationsManage);
        return app;
    }

    private static async Task<IntegrationMonitoringSnapshot> ReadAsync(HttpContext http, IntegrationMonitoringReader reader,
        ModuleDbContextRegistry registry, IEnumerable<IOperationalSignalSource> contributors, ICurrentUser user, CancellationToken ct)
    {
        var snapshot = await reader.ReadAsync(ct);
        var exceptions = snapshot.Exceptions.ToList();
        foreach (var type in registry.Contexts)
        {
            var context = (ModuleDbContext)http.RequestServices.GetRequiredService(type);
            var counts = await context.OutboxMessages.AsNoTracking().Where(m => m.ProcessedAt == null &&
                (m.Status == OutboxStatus.DeadLetter || m.Status == OutboxStatus.Quarantined)).GroupBy(m => m.Status)
                .Select(g => new { Status = g.Key, Count = g.Count(), At = g.Min(m => m.OccurredAt) }).ToListAsync(ct);
            exceptions.AddRange(counts.Select(g => IntegrationMonitoringReader.Item($"outbox:{context.Schema}:{g.Status}", "Integration", context.Schema,
                g.Status == OutboxStatus.DeadLetter ? "OutboxDeadLetter" : "OutboxQuarantined", g.At, g.Count)));
        }
        foreach (var contributor in contributors)
        {
            var signals = await contributor.ReadAsync(ct);
            exceptions.AddRange(signals.Where(s => s.Count > 0 && (s.RequiredPermission is null || user.HasPermission(s.RequiredPermission))).Select(s =>
                new MonitoringExceptionItem(s.Key, s.Category, s.Source, s.Kind, s.DetectedAt, null, null, null, s.Count, s.Impact, s.Runbook, ExceptionTriageItem.Empty, true, s.RequiredPermission)));
        }
        return snapshot with { Exceptions = exceptions.OrderBy(e => e.Category).ThenBy(e => e.Source).ThenBy(e => e.Key).ToList() };
    }
    private static string Tag(ExceptionTriage triage) => '"' + Convert.ToBase64String(triage.RowVersion) + '"';
    private static ExceptionTriageItem Describe(ExceptionTriage triage, string? name, bool active = false) =>
        new(triage.OwnerId, name, active && triage.Status == "Resolved" ? "Open" : triage.Status, triage.Comment, Tag(triage));
    private static bool CanRead(ExceptionTriage? triage, ICurrentUser user) => triage is not null && triage.Source.Length > 0 &&
        (triage.RequiredPermission is null || user.HasPermission(triage.RequiredPermission));
    private static IResult NotFound() => Error.NotFound("MONITORING_NOT_FOUND", "The exception does not exist or is not accessible.").ToProblem();
    private static IResult Stale() => Error.PreconditionFailed("MONITORING_TRIAGE_STALE", "The exception was changed by another operator. Reload before saving.").ToProblem();
}
