using Crm.Customers.Contracts;
using Crm.Integrations.Core;
using Microsoft.Extensions.Logging;

namespace Crm.Integrations.Brreg;

/// <summary>
/// Nightly re-check of registry status for organizations with an org number (docs/02-functional-spec.md BR-CUS-03).
/// Status changes raise <see cref="OrganizationRegistryStatusChanged"/> in the Customers module.
/// </summary>
public sealed class BrregRegistryCheckJob(
    IBrregClient brreg,
    ICustomersApi customers,
    SyncRunner runner,
    TimeProvider timeProvider,
    ILogger<BrregRegistryCheckJob> logger)
{
    public const string JobId = "brreg-registry-check";
    public const string System = "brreg";

    /// <summary>Every night at two, Oslo time; the connections page calls the check late after its gap (FreshnessLimits).</summary>
    public const string Cron = "0 2 * * *";
    private const int BatchSize = 200;

    public Task RunAsync(CancellationToken cancellationToken) =>
        runner.RunAsync(System, JobId, async (progress, ct) =>
        {
            var checkedBefore = timeProvider.GetUtcNow().AddHours(-20);
            while (!ct.IsCancellationRequested)
            {
                var batch = await customers.GetOrganizationsDueForRegistryCheckAsync(checkedBefore, BatchSize, ct);
                if (batch.Count == 0)
                {
                    break;
                }

                foreach (var organization in batch)
                {
                    progress.Read++;
                    try
                    {
                        var lookup = await brreg.GetAsync(organization.OrgNumber!, ct);
                        await customers.ApplyRegistryStatusAsync(organization.Id, lookup.Status, timeProvider.GetUtcNow(), ct);
                        progress.Changed++;
                    }
                    catch (HttpRequestException ex)
                    {
                        progress.Failed++;
                        logger.LogWarning("Registry check failed for organization {OrganizationId} ({ErrorType})", organization.Id, ex.GetType().Name);
                        // Mark as checked with unknown status so a single failing entity does not block the loop.
                        await customers.ApplyRegistryStatusAsync(organization.Id, BrregStatus.Unknown, timeProvider.GetUtcNow(), ct);
                    }
                }
            }

            progress.Message = $"checked {progress.Changed}, failed {progress.Failed}";
        }, cancellationToken);
}
