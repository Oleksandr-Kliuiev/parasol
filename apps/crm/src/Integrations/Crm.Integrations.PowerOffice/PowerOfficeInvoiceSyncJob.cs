using Crm.Billing.Contracts;
using Crm.Integrations.Core;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Crm.Integrations.PowerOffice;

/// <summary>Historical documents and their lines; source customer links are resolved after provider reads, never by name.</summary>
public sealed class PowerOfficeInvoiceSyncJob(
    IPowerOfficeClient client, IBillingApi billing, ExternalLinkService links, SyncRunner runner,
    IOptions<PowerOfficeOptions> options, ILogger<PowerOfficeInvoiceSyncJob> logger)
{
    public const string JobId = "poweroffice-invoices";
    // A separate checkpoint forces the initial full scan even if the old header-only mirror already has a cursor.
    internal const string Stream = "invoice-history-v1";

    public async Task RunAsync(CancellationToken cancellationToken)
    {
        if (!options.Value.IsConfigured)
        {
            logger.LogInformation("PowerOffice invoice sync skipped: integration not configured.");
            return;
        }
        await runner.RunExclusiveAsync(PowerOfficeTypes.System, JobId, async (progress, ct) =>
        {
            var since = PowerOfficeCursor.Parse(await runner.GetCursorAsync(PowerOfficeTypes.System, Stream, ct));
            var newest = since;
            int created = 0, updated = 0, unmatched = 0, missingTimes = 0;
            await foreach (var header in client.GetOutgoingInvoicesAsync(PowerOfficeCursor.ReadFrom(since), ct))
            {
                progress.Read++;
                if (header.Id == Guid.Empty) throw new InvalidOperationException("PowerOffice invoice source UUID is missing.");
                var lines = new List<PoOutgoingInvoiceLine>();
                await foreach (var line in client.GetOutgoingInvoiceLinesAsync(header.Id, ct))
                {
                    if (lines.Count >= 10_000) throw new InvalidOperationException("PowerOffice invoice line limit exceeded.");
                    lines.Add(line);
                }
                var invoice = PowerOfficeInvoiceMapping.Map(header, lines);
                var result = invoice.History!.ExternalCustomerId is { } customer
                    ? await links.WithExternalLinkAsync(PowerOfficeTypes.System, PowerOfficeTypes.Customer, customer,
                        async (link, token) => await billing.UpsertInvoicesAsync([invoice with { OrganizationId = CustomerId(link) }], token), ct)
                    : await billing.UpsertInvoicesAsync([invoice], ct);
                created += result.Created;
                updated += result.Updated;
                unmatched += result.Unmatched;
                if (header.BalanceLastChangedDateTimeOffset is { } changed)
                    newest = newest is null || changed > newest ? changed : newest;
                else missingTimes++;
            }

            // Recheck saved bindings even when an old invoice falls outside the incremental provider window.
            // Unlink/relink, customer import and merge must not leave a historical copy attached to a former customer.
            foreach (var binding in await billing.GetInvoiceCustomerBindingsAsync(PowerOfficeTypes.System, ct))
                await links.WithExternalLinkAsync(PowerOfficeTypes.System, PowerOfficeTypes.Customer, binding.ExternalCustomerId, async (link, token) =>
                {
                    await billing.BindHistoricalInvoiceAsync(binding.InvoiceId, binding.ExternalCustomerId, CustomerId(link), token);
                    return true;
                }, ct);
            progress.Changed = created + updated;
            progress.Failed = missingTimes;
            await runner.SetCursorAsync(PowerOfficeTypes.System, Stream, PowerOfficeCursor.Format(missingTimes == 0 ? newest : since), ct);
            progress.Message = $"created {created}, updated {updated}, unmatched customers {unmatched}, missing balance timestamps {missingTimes}";
        }, cancellationToken);
    }
    private static Guid? CustomerId(Crm.Integrations.Core.Persistence.ExternalLink? link) =>
        link?.EntityType == EntityTypes.Organization ? link.EntityId : null;
}
