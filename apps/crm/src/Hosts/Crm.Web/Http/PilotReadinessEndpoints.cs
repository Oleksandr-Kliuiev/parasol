using System.Globalization;
using Crm.Authorization;
using Crm.Billing.Contracts;
using Crm.Integrations.Atera;
using Crm.Integrations.Core.Persistence;
using Crm.Integrations.MicrosoftGraph;
using Crm.Integrations.PowerOffice;
using Crm.SharedKernel.Operations;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Crm.Web.Http;

/// <summary>
/// One fact about whether a parallel pilot run is safe (DEV-22). <paramref name="Ok"/> is true when the fact does not endanger the
/// run, false when it does, and null when crm-web cannot know it. <paramref name="Decisive"/> checks are the ones
/// <c>safeForParallelRun</c> is made of; the others inform. <paramref name="Code"/> names the explanation for the interface to translate.
/// </summary>
public sealed record PilotReadinessCheck(string Check, string State, bool? Ok, string Code, bool Decisive);

public sealed record PilotReadiness(
    bool SafeForParallelRun, string? TargetPeriod, string Source, IReadOnlyList<PilotReadinessCheck> Checks, IReadOnlyList<string> Caveats);

/// <summary>
/// Whether a parallel pilot month can run without anything leaving the company (DEV-22). It answers from what crm-web can
/// legitimately know: its own configuration, the pause switches and the maintenance state in the stores it reads, and the runs in the
/// database. The provider keys live in crm-worker only, so whatever depends on them is reported as unknown instead of guessed; and
/// crm-worker reads its own configuration, which the probe cannot prove equals crm-web's — the caveat says so every time.
/// </summary>
internal static class PilotReadinessEndpoints
{
    public static IEndpointRouteBuilder MapPilotReadinessEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/v1/billing/pilot-readiness", async (
                string? period, IOptions<PowerOfficeOptions> powerOffice, IOptions<AteraOptions> atera, IOptions<SalesMailOptions> salesMail,
                IOptions<GraphMailOptions> notificationMail, IOptions<GraphOptions> graph, IConfiguration configuration, IntegrationDbContext integrations,
                IMaintenanceGate maintenance, IBillingApi billing, CancellationToken ct) =>
            {
                DateOnly? target = null;
                if (period is not null)
                {
                    if (!DateOnly.TryParseExact(period + "-01", "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var parsed))
                    {
                        return Results.Problem(
                            detail: "Give the period as yyyy-MM.", statusCode: StatusCodes.Status400BadRequest, title: "BIL_PILOT_PERIOD_INVALID",
                            extensions: new Dictionary<string, object?> { ["code"] = "BIL_PILOT_PERIOD_INVALID" });
                    }

                    target = parsed;
                }

                var po = powerOffice.Value;
                var paused = await integrations.IntegrationSwitches.AsNoTracking()
                    .AnyAsync(s => s.System == PowerOfficeTypes.System && s.IsPaused, ct);
                var state = await maintenance.CurrentAsync(ct);
                var checks = new List<PilotReadinessCheck>();

                checks.Add(new("deployment.environment", configuration["Deployment:Environment"] is { Length: > 0 } environment ? environment : "unset", true, "DEPLOYMENT_ENVIRONMENT", false));
                checks.Add(new("poweroffice.enabled", po.Enabled ? "Enabled" : "Disabled", true, po.Enabled ? "POWEROFFICE_ENABLED" : "POWEROFFICE_DISABLED", false));
                checks.Add(new("poweroffice.environment", po.Environment.ToString(), po.Environment == PowerOfficeEnvironment.Demo,
                    po.Environment == PowerOfficeEnvironment.Demo ? "POWEROFFICE_DEMO" : "POWEROFFICE_PRODUCTION", false));
                checks.Add(new("poweroffice.writeEnabled", po.WriteEnabled ? "On" : "Off", !po.WriteEnabled, po.WriteEnabled ? "POWEROFFICE_WRITE_ON" : "POWEROFFICE_WRITE_OFF", false));
                checks.Add(new("poweroffice.paused", paused ? "Paused" : "Running", true, paused ? "POWEROFFICE_PAUSED" : "POWEROFFICE_NOT_PAUSED", false));

                // The decisive one: can an order, a customer or an invoice reach the accounting system at all?
                var sendsBlocked = !po.Enabled || !po.WriteEnabled || paused;
                checks.Add(new("poweroffice.sends", sendsBlocked ? "Blocked" : "Possible", sendsBlocked, sendsBlocked ? "POWEROFFICE_SENDS_BLOCKED" : "POWEROFFICE_SENDS_POSSIBLE", true));
                checks.Add(new("poweroffice.credentials", "UnknownFromWeb", null, "WORKER_ONLY_FACT", false));
                checks.Add(new("atera.writeEnabled", atera.Value.WriteEnabled ? "On" : "Off", !atera.Value.WriteEnabled, atera.Value.WriteEnabled ? "ATERA_WRITE_ON" : "ATERA_WRITE_OFF", false));
                checks.Add(new("mail.sales", salesMail.Value.EmailEnabled ? "On" : "Off", !salesMail.Value.EmailEnabled, salesMail.Value.EmailEnabled ? "SALES_EMAIL_ON" : "SALES_EMAIL_OFF", true));
                checks.Add(new("mail.notifications", notificationMail.Value.EmailEnabled ? "On" : "Off", !notificationMail.Value.EmailEnabled,
                    notificationMail.Value.EmailEnabled ? "NOTIFICATION_EMAIL_ON" : "NOTIFICATION_EMAIL_OFF", true));

                // Reading a mailbox sends nothing: shown, but it does not decide.
                checks.Add(new("mail.graphMailbox", graph.Value.Enabled && graph.Value.MailEnabled ? "On" : "Off", !(graph.Value.Enabled && graph.Value.MailEnabled),
                    graph.Value.Enabled && graph.Value.MailEnabled ? "GRAPH_MAILBOX_READ_ON" : "GRAPH_MAILBOX_READ_OFF", false));

                if (target is { } first)
                {
                    var runs = await billing.GetRunStatesAsync(first, ct);
                    var open = runs.Where(r => r.Status != BillingRunStatus.Closed).ToList();
                    if (open.Count > 0)
                    {
                        checks.Add(new("runs.targetPeriod", $"Open:{open[0].Status}", true, "PERIOD_OPEN_RUN", false));
                    }
                    else if (runs.Count > 0)
                    {
                        checks.Add(new("runs.targetPeriod", "ClosedSupplementaryOnly", false, "PERIOD_SUPPLEMENTARY", false));
                    }
                    else
                    {
                        checks.Add(new("runs.targetPeriod", "NoRun", true, "PERIOD_FREE", false));
                    }
                }

                var openRuns = await billing.GetOpenRunStatesAsync(ct);
                checks.Add(new("runs.open", openRuns.Count.ToString(CultureInfo.InvariantCulture), true, "OPEN_RUNS", false));
                checks.Add(new("maintenance", state.IsReadOnly ? "ReadOnly" : "Normal", !state.IsReadOnly, state.IsReadOnly ? "MAINTENANCE_READ_ONLY" : "MAINTENANCE_NORMAL", false));

                return Results.Ok(new PilotReadiness(
                    checks.Where(c => c.Decisive).All(c => c.Ok == true),
                    period,
                    "crm-web",
                    checks,
                    ["WORKER_CONFIG_NOT_VERIFIED"]));
            })
            .RequirePermission(Permissions.BillingRead);

        return app;
    }
}
