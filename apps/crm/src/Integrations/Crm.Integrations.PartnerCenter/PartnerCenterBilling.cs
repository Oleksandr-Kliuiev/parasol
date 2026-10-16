using System.Globalization;
using Crm.Integrations.Core;
using Crm.Licensing.Contracts;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Crm.Integrations.PartnerCenter;

/// <summary>
/// Pulls what Microsoft charged the partner into the CRM so the licence margin can be seen per customer (FR-LIC-04).
/// Only the invoices of the last few months are re-read: an older invoice never changes, and the export is expensive.
/// </summary>
public sealed class PartnerBillingSyncJob(
    IPartnerCenterClient client,
    IPartnerBillingClient billing,
    ILicensingApi licensing,
    SyncRunner runner,
    TimeProvider time,
    ILogger<PartnerBillingSyncJob> logger)
{
    public const string JobId = "partnercenter-billing";

    /// <summary>Microsoft closes an invoice late in the following month, so two months back is what can still move.</summary>
    private const int MonthsBack = 2;

    public async Task RunAsync(CancellationToken cancellationToken)
    {
        if (!billing.IsEnabled)
        {
            logger.LogInformation("Partner billing reconciliation skipped: not enabled.");
            return;
        }

        await runner.RunAsync(PartnerCenterTypes.System, JobId, async (progress, ct) =>
        {
            var since = DateOnly.FromDateTime(time.GetUtcNow().UtcDateTime).AddMonths(-MonthsBack);
            var invoices = await client.GetInvoicesAsync(ct);
            var wanted = invoices.Where(i => i.InvoiceDate is null || i.InvoiceDate >= since).Take(MonthsBack + 1).ToList();
            var imported = 0;
            foreach (var invoice in wanted)
            {
                var lines = await billing.GetBilledLinesAsync(invoice.Id, ct);
                if (lines.Count == 0)
                {
                    continue;
                }

                progress.Read += lines.Count;
                var result = await licensing.ImportBilledLinesAsync(lines, dryRun: false, ct);
                imported += result.Created + result.Updated;
                foreach (var warning in result.Warnings.Take(3))
                {
                    logger.LogWarning("Partner billing invoice {Invoice}: {Warning}", invoice.Id, warning);
                }
            }

            progress.Changed = imported;
            progress.Message = string.Create(CultureInfo.InvariantCulture, $"invoices {wanted.Count}, lines {progress.Read}, stored {imported}");
        }, cancellationToken);
    }
}
