using Crm.Billing.Contracts;
using Crm.Integrations.Core;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Crm.Integrations.PowerOffice;

/// <summary>Rescans saved source UUIDs: documentation can appear/change independently of invoice balance timestamps.</summary>
public sealed class PowerOfficePdfSyncJob(IPowerOfficeClient client, IBillingApi billing, SyncRunner runner,
    IOptions<PowerOfficeOptions> options, ILogger<PowerOfficePdfSyncJob> logger)
{
    public const string JobId = "poweroffice-invoice-pdfs";

    public async Task RunAsync(CancellationToken cancellationToken)
    {
        if (!options.Value.IsConfigured || !options.Value.InvoicePdfSyncEnabled)
        {
            logger.LogInformation("PowerOffice invoice PDF import skipped: not enabled/configured.");
            return;
        }
        await runner.RunExclusiveAsync(PowerOfficeTypes.System, JobId, async (progress, ct) =>
        {
            for (int offset = 0; ; offset = checked(offset + 200))
            {
                var sources = await billing.GetInvoiceDocumentSourcesAsync(PowerOfficeTypes.System, offset, 200, ct);
                if (sources.Count == 0) break;
                foreach (var source in sources)
                {
                    PoVoucherDocumentation? found = null;
                    await foreach (var metadata in client.GetVoucherDocumentationAsync(source.VoucherId, ct))
                    {
                        if (found is not null || metadata.VoucherId != source.VoucherId || metadata.HasPdf is null ||
                            metadata.VoucherType != (source.Kind == InvoiceDocumentKind.CreditNote ? "OutgoingCreditNote" : "OutgoingInvoice"))
                            throw new InvalidOperationException("PowerOffice PDF metadata does not match the source invoice.");
                        found = metadata;
                    }
                    // An empty metadata result means documentation unavailable, not a successfully imported empty archive.
                    var hasPdf = found?.HasPdf;
                    var files = hasPdf == true ? await PowerOfficePdfArchive.ReadAsync(await client.DownloadVoucherPdfArchiveAsync(source.VoucherId, ct), ct) : [];
                    var result = await billing.ImportInvoiceDocumentsAsync(PowerOfficeTypes.System, source, hasPdf, files, ct);
                    progress.Read++;
                    progress.Changed += result.Created;
                }
            }
            progress.Message = $"checked {progress.Read} invoice PDF sources, captured {progress.Changed} new PDFs";
        }, cancellationToken);
    }
}
