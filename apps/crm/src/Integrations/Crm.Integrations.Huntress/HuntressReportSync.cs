using Crm.Integrations.Core;
using Crm.Security.Contracts;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Crm.Integrations.Huntress;

/// <summary>
/// Huntress's monthly summary reports of the linked organizations (M41), read only: the period, a few figures and Huntress's link to
/// the PDF. Filing the PDF among the customer's documents comes with M43.
/// </summary>
public sealed class HuntressReportSyncJob(
    IHuntressClient client,
    HuntressLinkIndex links,
    ISecurityApi security,
    SyncRunner runner,
    TimeProvider time,
    IOptions<HuntressOptions> options,
    ILogger<HuntressReportSyncJob> logger)
{
    public const string JobId = "huntress-reports";

    public async Task RunAsync(CancellationToken cancellationToken)
    {
        if (!options.Value.IsConfigured)
        {
            logger.LogInformation("Huntress report sync skipped: integration not configured.");
            return;
        }

        await runner.RunAsync(HuntressTypes.System, JobId, async (progress, ct) =>
        {
            var organizations = await links.OrganizationsAsync(ct);
            var today = DateOnly.FromDateTime(time.GetUtcNow().UtcDateTime);
            var from = new DateOnly(today.Year, today.Month, 1).AddMonths(-Math.Clamp(options.Value.ReportMonths, 1, 120));
            var reports = new List<ExternalReport>();
            var unlinked = 0;
            await foreach (var report in client.GetReportsAsync(from, ct))
            {
                progress.Read++;
                if (!organizations.TryGetValue(report.OrganizationId, out var organizationId))
                {
                    unlinked++;
                    continue;
                }

                reports.Add(new ExternalReport(
                    HuntressTypes.System, report.Id, organizationId, report.OrganizationId, report.Type, report.PeriodStart, report.PeriodEnd, report.Url,
                    report.AgentsCount, report.IncidentsReported, report.IncidentsResolved, report.SignalsDetected, report.SignalsInvestigated,
                    report.EventsAnalyzed, report.CreatedAt));
            }

            var stored = await security.ApplyReportsAsync(reports, ct);
            progress.Changed = stored.Changed;
            progress.Message = $"reports {reports.Count} since {from:yyyy-MM-dd}: new {stored.Added}, changed {stored.Updated}; skipped (organization not linked) {unlinked}";
        }, cancellationToken);
    }
}
