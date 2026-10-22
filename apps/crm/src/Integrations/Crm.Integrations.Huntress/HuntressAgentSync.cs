using Crm.Integrations.Core;
using Crm.Service.Contracts;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Crm.Integrations.Huntress;

/// <summary>
/// Huntress's agents (M41) as devices of the Service mirror: per linked organization the complete list, so the machine matcher joins
/// each agent with the computer's Atera agent, and an agent Huntress no longer lists is marked removed. A complete read then lets the
/// coverage rules of Huntress check the customers it covered: a machine without Huntress, a silent or outdated agent, Defender off.
/// <see cref="IServiceApi.ReplaceDevicesAsync"/> counts for billing only Atera's devices, so these never change a device count.
/// </summary>
public sealed class HuntressAgentSyncJob(
    IHuntressClient client,
    HuntressLinkIndex links,
    IServiceApi service,
    ICoverageCheck coverage,
    SyncRunner runner,
    TimeProvider time,
    IOptions<HuntressOptions> options,
    ILogger<HuntressAgentSyncJob> logger)
{
    public const string JobId = "huntress-agents";

    public async Task RunAsync(CancellationToken cancellationToken)
    {
        if (!options.Value.IsConfigured)
        {
            logger.LogInformation("Huntress agent sync skipped: integration not configured.");
            return;
        }

        await runner.RunAsync(HuntressTypes.System, JobId, async (progress, ct) =>
        {
            var organizations = await links.OrganizationsAsync(ct);
            var now = time.GetUtcNow();
            var byOrganization = new Dictionary<Guid, List<ExternalDevice>>();
            var skipped = 0;
            // The enumeration throws on any page or agent it cannot read, so arriving after it means every agent was read.
            await foreach (var agent in client.GetAgentsAsync(null, ct))
            {
                progress.Read++;
                if (!organizations.TryGetValue(agent.OrganizationId, out var organizationId))
                {
                    skipped++;
                    continue;
                }

                byOrganization.TryAdd(organizationId, []);
                byOrganization[organizationId].Add(HuntressMapping.Device(agent, options.Value.AgentUrlTemplate, now));
            }

            // Linked organizations without agents lose their devices too.
            foreach (var organizationId in organizations.Values.Distinct())
            {
                byOrganization.TryAdd(organizationId, []);
            }

            foreach (var (organizationId, devices) in byOrganization)
            {
                await service.ReplaceDevicesAsync(organizationId, HuntressTypes.System, devices, ct);
                progress.Changed += devices.Count;
            }

            var gaps = await coverage.CheckAsync(HuntressTypes.System, byOrganization.Keys.ToList(), ct);
            progress.Message = $"agents {progress.Changed} in {byOrganization.Count} organizations, skipped (organization not linked) {skipped}; "
                + $"coverage gaps {gaps.Found} found, {gaps.Opened} new, {gaps.Reopened} again, {gaps.Resolved} closed";
        }, cancellationToken);
    }
}
