using System.Globalization;
using System.Security.Claims;
using System.Text.Json;
using Crm.Authorization;
using Crm.Infrastructure.DependencyInjection;
using Crm.Infrastructure.Http;
using Crm.Infrastructure.Persistence;
using Crm.Integrations.Core.Persistence;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Documents;
using Crm.SharedKernel.Operations;
using Crm.Web.Auth;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore;

namespace Crm.Web.Http;

public sealed record InFlightCount(string Area, int Count);

public sealed record MaintenanceStatus(
    MaintenanceMode Mode, string? Reason, string? Reference, string? SetBy, DateTimeOffset? Since, string? Key, bool Forced,
    IReadOnlyList<InFlightCount> InFlight);

public sealed record MaintenanceRequest(MaintenanceMode Mode, string? Reason, string? Reference, string? ExpectedKey);

/// <summary>What the app tells everyone, signed in or not: the mode and since when — the reason only to a signed-in user.</summary>
public sealed record PublicMaintenanceStatus(MaintenanceMode Mode, DateTimeOffset? Since, string? Reason);

public sealed record RestoreReconcileRequest(DateTimeOffset? RestorePoint, bool Apply);

public sealed record RestoreReport(
    string Id, DateTimeOffset At, DateTimeOffset RestorePoint, bool Applied, string By, string? MaintenanceKey, int Effects,
    IReadOnlyList<RestoreLine> Checks, IReadOnlyList<RestoreLine> Reconciliation);

public sealed record RestoreReportSummary(string Id, DateTimeOffset At, DateTimeOffset RestorePoint, bool Applied, string By, int Effects, int NeedsPerson);

/// <summary>
/// The operator's controls of DEV-13 (ADR-021, runbook 03): the maintenance switch, how many sends are still under way, and
/// the restore reconciliation with its checks. Behind <see cref="Permissions.OperationsMaintenance"/> (privileged: a fresh
/// confirmation of the roles); they keep working while the CRM is read-only — that is what they are for.
/// </summary>
public static class OperationsEndpoints
{
    public const string ReportPrefix = "operations/reconciliations/";
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        Converters = { new System.Text.Json.Serialization.JsonStringEnumConverter() },
    };

    public static IEndpointRouteBuilder MapOperationsEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/bff/maintenance", async (HttpContext http, IMaintenanceGate gate, CancellationToken ct) =>
            {
                var state = await gate.CurrentAsync(ct);
                return Results.Ok(new PublicMaintenanceStatus(
                    state.Mode, Since(state), http.User.Identity?.IsAuthenticated == true ? state.Reason : null));
            })
            .AllowAnonymous()
            .AllowedInMaintenance()
            .ExcludeFromDescription();

        var group = app.MapGroup("/api/v1/operations").WithTags("Operations");

        group.MapGet("/maintenance", async (HttpContext http, IMaintenanceGate gate, CancellationToken ct) =>
                Results.Ok(await StatusAsync(http, gate, await gate.CurrentAsync(ct), ct)))
            .RequirePermission(Permissions.OperationsMaintenance)
            .AllowedInMaintenance();

        group.MapPut("/maintenance", async (
                MaintenanceRequest request, HttpContext http, IMaintenanceGate gate, IntegrationDbContext db, ICurrentUser user,
                IRequestContext requestContext, TimeProvider time, ILoggerFactory loggers, CancellationToken ct) =>
            {
                if (string.IsNullOrWhiteSpace(request.Reason) || request.Reason.Trim().Length is < 10 or > 500)
                {
                    return Results.ValidationProblem(new Dictionary<string, string[]> { ["reason"] = ["Give a reason of 10 to 500 characters."] });
                }

                MaintenanceState state;
                try
                {
                    state = await gate.SetAsync(
                        request.Mode, Crm.SharedKernel.Text.LogText.Clean(request.Reason.Trim())!, Clean(request.Reference), WhoIs(http.User), request.ExpectedKey, ct);
                }
                catch (MaintenanceConflictException conflict)
                {
                    return Results.Problem(
                        statusCode: StatusCodes.Status409Conflict, title: "MAINTENANCE_CHANGED",
                        detail: conflict.Current.Key is null && conflict.Current.SetBy == "configuration"
                            ? "This deployment is read-only by configuration (Maintenance:ForceReadOnly); only a new revision lifts it."
                            : "Another maintenance decision was taken meanwhile. Look at it before changing it.",
                        extensions: new Dictionary<string, object?> { ["code"] = "MAINTENANCE_CHANGED" });
                }
                catch (MaintenanceStateUnavailableException)
                {
                    return Results.Problem(
                        statusCode: StatusCodes.Status503ServiceUnavailable, title: "MAINTENANCE_STATE_UNAVAILABLE",
                        detail: "The document store cannot be reached, so the decision cannot be recorded. Use Maintenance:ForceReadOnly (runbook 03).",
                        extensions: new Dictionary<string, object?> { ["code"] = "MAINTENANCE_STATE_UNAVAILABLE" });
                }

                // The decision is the stored object; the audit entry is a convenience next to the other events of the day. It may
                // land in a database that a restore replaces, which is why it is not the record.
                try
                {
                    using (MaintenanceScope.AllowWrites("maintenance-decision"))
                    {
                        db.RecordAudit(user, requestContext, time, AuditActions.Maintenance, "Maintenance", Guid.Empty,
                            new { state.Mode, state.Reason, state.Reference, state.Key });
                        await db.SaveChangesAsync(ct);
                    }
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    loggers.CreateLogger(typeof(OperationsEndpoints)).LogWarning(
                        "The maintenance decision {Key} is stored but its audit entry was not written ({Error}).", state.Key, ex.GetType().Name);
                }

                return Results.Ok(await StatusAsync(http, gate, state, ct));
            })
            .RequirePermission(Permissions.OperationsMaintenance)
            .AllowedInMaintenance();

        group.MapPost("/restore/reconcile", async (
                RestoreReconcileRequest request, HttpContext http, IMaintenanceGate gate, IExternalEffectJournal journal,
                IEnumerable<IRestoreParticipant> participants, IDocumentStore store, IDataProtectionProvider protection,
                ModuleDbContextRegistry registry, IntegrationDbContext db, ICurrentUser user, IRequestContext requestContext,
                TimeProvider time, CancellationToken ct) =>
            {
                var now = time.GetUtcNow();
                if (request.RestorePoint is not { } restorePoint || restorePoint > now || restorePoint < now.AddDays(-40))
                {
                    return Results.ValidationProblem(new Dictionary<string, string[]>
                    {
                        ["restorePoint"] = ["Give the restore point in UTC, at most 40 days back (the longest point-in-time retention)."],
                    });
                }

                MaintenanceState state;
                try
                {
                    state = await gate.FreshAsync(ct);
                }
                catch (MaintenanceStateUnavailableException)
                {
                    return Results.Problem(statusCode: StatusCodes.Status503ServiceUnavailable, title: "MAINTENANCE_STATE_UNAVAILABLE",
                        extensions: new Dictionary<string, object?> { ["code"] = "MAINTENANCE_STATE_UNAVAILABLE" });
                }

                if (!state.IsReadOnly)
                {
                    // Reconciling while the worker sends would race with it: the CRM has to be read-only first (runbook 03).
                    return Results.Problem(
                        statusCode: StatusCodes.Status409Conflict, title: "MAINTENANCE_REQUIRED",
                        detail: "Switch the CRM to read-only maintenance before reconciling a restore.",
                        extensions: new Dictionary<string, object?> { ["code"] = "MAINTENANCE_REQUIRED" });
                }

                var effects = await journal.SinceAsync(restorePoint, ct);
                var checks = new List<RestoreLine>();
                var reconciliation = new List<RestoreLine>();
                checks.AddRange(await HostChecksAsync(http, protection, registry, ct));
                using (MaintenanceScope.AllowWrites("restore-reconciliation"))
                {
                    foreach (var participant in participants.OrderBy(p => p.Area, StringComparer.Ordinal))
                    {
                        checks.AddRange(await participant.CheckAsync(restorePoint, ct));
                        reconciliation.AddRange(await participant.ReconcileAsync(restorePoint, effects, request.Apply, ct));
                    }
                }

                var at = time.GetUtcNow();
                var id = string.Create(CultureInfo.InvariantCulture, $"{at.UtcDateTime:yyyyMMdd'T'HHmmss'Z'}-{Guid.NewGuid():N}");
                var report = new RestoreReport(id, at, restorePoint, request.Apply, WhoIs(http.User), state.Key, effects.Count, checks, reconciliation);
                await store.PutAsync($"{ReportPrefix}{id}.json", JsonSerializer.SerializeToUtf8Bytes(report, Json), "application/json", ct);

                if (request.Apply)
                {
                    using (MaintenanceScope.AllowWrites("restore-reconciliation"))
                    {
                        db.RecordAudit(user, requestContext, time, AuditActions.Reconcile, "Restore", Guid.Empty, new
                        {
                            Report = id,
                            RestorePoint = restorePoint,
                            Effects = effects.Count,
                            NeedsPerson = reconciliation.Count(l => l.NeedsPerson),
                        });
                        await db.SaveChangesAsync(ct);
                    }
                }

                return Results.Ok(report);
            })
            .RequirePermission(Permissions.OperationsMaintenance)
            .AllowedInMaintenance();

        group.MapGet("/restore/reports", async (IDocumentStore store, CancellationToken ct) =>
            {
                var summaries = new List<RestoreReportSummary>();
                await foreach (var item in store.ListAsync(ReportPrefix, ct))
                {
                    if (await ReadReportAsync(store, item.Key, ct) is { } report)
                    {
                        summaries.Add(new RestoreReportSummary(
                            report.Id, report.At, report.RestorePoint, report.Applied, report.By, report.Effects,
                            report.Checks.Concat(report.Reconciliation).Count(l => l.NeedsPerson)));
                    }
                }

                return Results.Ok(summaries.OrderByDescending(s => s.At).ToList());
            })
            .RequirePermission(Permissions.OperationsMaintenance)
            .AllowedInMaintenance();

        group.MapGet("/restore/reports/{id}", async (string id, IDocumentStore store, CancellationToken ct) =>
                id.All(c => char.IsAsciiLetterOrDigit(c) || c is '-') && await ReadReportAsync(store, $"{ReportPrefix}{id}.json", ct) is { } report
                    ? Results.Ok(report)
                    : Results.Problem(statusCode: StatusCodes.Status404NotFound, title: "REPORT_NOT_FOUND",
                        extensions: new Dictionary<string, object?> { ["code"] = "REPORT_NOT_FOUND" }))
            .RequirePermission(Permissions.OperationsMaintenance)
            .AllowedInMaintenance();

        return app;
    }

    private static async Task<MaintenanceStatus> StatusAsync(HttpContext http, IMaintenanceGate gate, MaintenanceState state, CancellationToken ct)
    {
        var inFlight = new List<InFlightCount> { new("outbox", await LeasedOutboxAsync(http, ct)) };
        foreach (var participant in http.RequestServices.GetServices<IRestoreParticipant>().OrderBy(p => p.Area, StringComparer.Ordinal))
        {
            inFlight.Add(new InFlightCount(participant.Area, await participant.InFlightAsync(ct)));
        }

        return new MaintenanceStatus(
            state.Mode, state.Reason, state.Reference, state.SetBy, Since(state), state.Key, state.SetBy == "configuration" && state.Key is null,
            inFlight.Where(c => c.Count > 0 || c.Area == "outbox").ToList());
    }

    /// <summary>Domain events being delivered right now, in every module: their handlers may still write or enqueue a send.</summary>
    private static async Task<int> LeasedOutboxAsync(HttpContext http, CancellationToken ct)
    {
        var now = DateTimeOffset.UtcNow;
        var registry = http.RequestServices.GetRequiredService<ModuleDbContextRegistry>();
        var leased = 0;
        foreach (var type in registry.Contexts)
        {
            var context = (ModuleDbContext)http.RequestServices.GetRequiredService(type);
            leased += await context.OutboxMessages.AsNoTracking().CountAsync(m => m.ProcessedAt == null && m.LockedUntil > now, ct);
        }

        return leased;
    }

    /// <summary>What only the host can tell: the schema against this build, and whether the key ring still unprotects.</summary>
    private static async Task<IReadOnlyList<RestoreLine>> HostChecksAsync(
        HttpContext http, IDataProtectionProvider protection, ModuleDbContextRegistry registry, CancellationToken ct)
    {
        var lines = new List<RestoreLine>();
        foreach (var type in registry.Contexts)
        {
            var context = (ModuleDbContext)http.RequestServices.GetRequiredService(type);
            var pending = (await context.Database.GetPendingMigrationsAsync(ct)).ToList();
            if (pending.Count > 0)
            {
                lines.Add(new RestoreLine("database", context.Schema,
                    $"The restored copy lacks {pending.Count} migration(s) of this build (latest {pending[^1]}).",
                    "Run the migration job before reconciling further (runbook 03).", true));
            }
        }

        if (lines.Count == 0)
        {
            lines.Add(new RestoreLine("database", "schema", "Every module schema matches this build.", null, false));
        }

        try
        {
            var protector = protection.CreateProtector("Crm.Operations.RestoreCheck");
            var ok = protector.Unprotect(protector.Protect("restore-check")) == "restore-check";
            lines.Add(new RestoreLine("keys", "data protection", ok ? "The key ring protects and unprotects." : "The key ring answered wrongly.", null, !ok));
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            lines.Add(new RestoreLine("keys", "data protection", $"The key ring cannot be used ({ex.GetType().Name}): sign-ins and antiforgery fail.",
                "Restore the key ring blob and the Key Vault key access (runbook 03, lost keys).", true));
        }

        return lines;
    }

    private static async Task<RestoreReport?> ReadReportAsync(IDocumentStore store, string key, CancellationToken ct) =>
        await store.ReadAsync(key, ct) is { } bytes ? JsonSerializer.Deserialize<RestoreReport>(bytes, Json) : null;

    private static DateTimeOffset? Since(MaintenanceState state) => state.At == DateTimeOffset.MinValue ? null : state.At;

    private static string? Clean(string? value) =>
        string.IsNullOrWhiteSpace(value) ? null : Crm.SharedKernel.Text.LogText.Clean(value.Trim()[..Math.Min(value.Trim().Length, 100)]);

    /// <summary>The operator as the decision shows them: name and user id — an employee, not a customer.</summary>
    private static string WhoIs(ClaimsPrincipal user) =>
        $"{user.FindFirstValue("name") ?? user.Identity?.Name ?? "unknown"} ({user.FindFirstValue(CrmClaimTypes.UserId) ?? "?"})";
}
