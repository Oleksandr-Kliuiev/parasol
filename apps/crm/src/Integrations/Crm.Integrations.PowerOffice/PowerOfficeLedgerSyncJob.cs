using System.Text;
using System.Text.Json;
using Crm.Billing.Contracts;
using Crm.Integrations.Core;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Crm.Integrations.PowerOffice;

/// <summary>Complete statement scans avoid filtering away old unmatches and unallocated customer payments.</summary>
public sealed class PowerOfficeLedgerSyncJob(IPowerOfficeClient client, IBillingApi billing, ExternalLinkService links,
    SyncRunner runner, TimeProvider time, IOptions<PowerOfficeOptions> options, ILogger<PowerOfficeLedgerSyncJob> logger)
{
    public const string JobId = "poweroffice-customer-ledger";
    internal const string Stream = "customer-ledger-snapshot-v1";

    public async Task RunAsync(CancellationToken cancellationToken)
    {
        if (!options.Value.IsConfigured || !options.Value.CustomerLedgerSyncEnabled)
        {
            logger.LogInformation("PowerOffice customer ledger sync skipped: not enabled/configured.");
            return;
        }
        await runner.RunExclusiveAsync(PowerOfficeTypes.System, JobId, async (progress, ct) =>
        {
            var scanId = Guid.NewGuid();
            var started = time.GetUtcNow();
            var entries = new Dictionary<long, ExternalCustomerLedgerEntry>();
            long bytes = 0;
            // No voucher-type, open-item, creation-origin or incremental filter: all posting dates and match states matter.
            await foreach (var source in client.GetCustomerLedgerAsync(ct))
            {
                var entry = PowerOfficeLedgerMapping.Map(source);
                progress.Read++;
                if (entries.TryGetValue(entry.ExternalId, out var previous))
                {
                    if (previous != entry) throw new InvalidOperationException("Conflicting duplicate customer ledger entry.");
                    continue;
                }
                bytes += Encoding.UTF8.GetByteCount(entry.SourceJson);
                if (entries.Count >= 100_000 || bytes > 64L * 1024 * 1024)
                    throw new InvalidOperationException("Customer ledger scan exceeds its explicit limit.");
                entries.Add(entry.ExternalId, entry);
            }
            // Only after every page succeeds may any customer snapshot be published. Per-customer commits can be replayed.
            var groups = entries.Values.GroupBy(e => e.ExternalCustomerId).ToDictionary(g => g.Key ?? "", g => g.ToList());
            var keys = (await billing.GetCustomerLedgerSourcesAsync(PowerOfficeTypes.System, ct)).Select(k => k ?? "")
                .Concat(groups.Keys).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal);
            foreach (var key in keys)
            {
                var batch = new CustomerLedgerBatch(PowerOfficeTypes.System, key.Length == 0 ? null : key, null, scanId, started,
                    groups.GetValueOrDefault(key) ?? []);
                var result = key.Length > 0
                    ? await links.WithExternalLinkAsync(PowerOfficeTypes.System, PowerOfficeTypes.Customer, key, async (link, token) =>
                        await billing.ImportCustomerLedgerAsync(batch with
                        {
                            OrganizationId = link?.EntityType == EntityTypes.Organization ? link.EntityId : null,
                        }, token), ct)
                    : await billing.ImportCustomerLedgerAsync(batch, ct);
                progress.Changed += result.Created + result.Updated;
            }
            await runner.SetCursorAsync(PowerOfficeTypes.System, Stream, JsonSerializer.Serialize(new
            {
                scanId, readStartedAt = started, completedAt = time.GetUtcNow(), entries = entries.Count,
                mode = "complete-statement", fromDate = "0001-01-01", toDate = "9999-12-31",
            }), ct);
            progress.Message = $"complete customer ledger scan: {entries.Count} entries, {progress.Changed} source changes";
        }, cancellationToken);
    }
}
