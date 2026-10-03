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
            var tenantsWithoutAccess = 0;
            await foreach (var customer in client.GetCustomersAsync(ct))
            {
                // Only mapped customers: a reading without a CRM organization has nowhere to go.
                if (!byCustomer.TryGetValue(customer.CustomerId, out var organizationId))
                {
                    continue;
                }

                var skus = await client.GetSubscribedSkusAsync(customer, ct);
                if (skus.Count == 0)
                {
                    tenantsWithoutAccess++;
                    continue;
                }

                progress.Read += skus.Count;
                readings.AddRange(skus.Select(sku =>
                    new LicenseUsageReading(organizationId, sku.SkuId, sku.SkuPartNumber, sku.Purchased, sku.Assigned)));
            }

            progress.Changed = await licensing.UpsertLicenseUsageAsync(readings, today, ct);
            progress.Message = string.Create(
                CultureInfo.InvariantCulture,
                $"read {progress.Read} SKUs, stored {progress.Changed}, tenants without a reading {tenantsWithoutAccess}");
        }, cancellationToken);
    }
}
