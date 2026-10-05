using System.Globalization;
using Crm.Integrations.Core;
using Crm.Integrations.Core.Persistence;
using Crm.Licensing.Contracts;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Crm.Integrations.PartnerCenter;

/// <summary>
/// Reads "bought / assigned" per SKU in the customers' tenants through GDAP once a day (FR-LIC-03). The reading is what
/// lets billing count Microsoft 365 users (BR-CON-02) and the licence screen point at seats nobody uses (BR-LIC-04).
/// </summary>
public sealed class PartnerCenterLicenseSyncJob(
    IPartnerCenterClient client,
    IntegrationDbContext db,
    ILicensingApi licensing,
    SyncRunner runner,
    TimeProvider time,
    IOptions<PartnerCenterOptions> options,
    ILogger<PartnerCenterLicenseSyncJob> logger)
{
    public const string JobId = "partnercenter-licenses";

    private static readonly TimeZoneInfo Oslo = TimeZoneInfo.FindSystemTimeZoneById("Europe/Oslo");

    public async Task RunAsync(CancellationToken cancellationToken)
    {
        if (!options.Value.IsConfigured)
        {
            logger.LogInformation("Partner Center licence sync skipped: integration not configured.");
            return;
        }

        await runner.RunAsync(PartnerCenterTypes.System, JobId, async (progress, ct) =>
        {
            var today = DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(time.GetUtcNow(), Oslo).DateTime);
            var links = await db.ExternalLinks
                .Where(l => l.System == PartnerCenterTypes.System && l.ExternalType == PartnerCenterTypes.Customer)
                .Select(l => new { l.ExternalId, l.EntityId })
                .ToListAsync(ct);
            var byCustomer = links.ToDictionary(l => l.ExternalId, l => l.EntityId, StringComparer.Ordinal);

            var readings = new List<LicenseUsageReading>();
            var limited = new List<string>();
            var emptyTenants = 0;
            await foreach (var customer in client.GetCustomersAsync(ct))
            {
                // Only mapped customers: a reading without a CRM organization has nowhere to go.
                if (!byCustomer.TryGetValue(customer.CustomerId, out var organizationId))
                {
                    continue;
                }

                var reading = await client.GetSubscribedSkusAsync(customer, ct);
                if (reading.Limitation is { } limitation)
                {
                    // A tenant that cannot be read is a limitation of this run, not an empty tenant: it is counted as a failure
                    // so the run is not reported as complete, and named (by Partner Center id, no customer data) in the message.
                    progress.Failed++;
                    limited.Add($"{customer.CustomerId}: {limitation}");
                    logger.LogWarning("Partner Center licences of customer {CustomerId} not read: {Limitation}", customer.CustomerId, limitation);
                    continue;
                }

                if (reading.Skus.Count == 0)
                {
                    emptyTenants++;
                    continue;
                }

                progress.Read += reading.Skus.Count;
                readings.AddRange(reading.Skus.Select(sku =>
                    new LicenseUsageReading(organizationId, sku.SkuId, sku.SkuPartNumber, sku.Purchased, sku.Assigned)));
            }

            progress.Changed = await licensing.UpsertLicenseUsageAsync(readings, today, ct);
            progress.Message = string.Create(
                CultureInfo.InvariantCulture,
                $"read {progress.Read} SKUs, stored {progress.Changed}, tenants without SKUs {emptyTenants}, tenants not readable {limited.Count}") +
                (limited.Count == 0 ? string.Empty : $" ({string.Join("; ", limited.Take(5))}{(limited.Count > 5 ? "; …" : string.Empty)})");
        }, cancellationToken);
    }
}
