using System.Net;
using Crm.Integrations.Core;
using Crm.Service.Contracts;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Crm.Integrations.Atera;

/// <summary>
/// Reads the Windows updates of every current Windows agent (M40): the installed and the available ones, one call each per agent,
/// keyed by its DeviceGuid (<c>GET agents/{DeviceGuid}/installed-patches</c>, <c>available-patches</c>; Atera's API has no patch
/// list across agents and no way to install one). A device whose read fails keeps the updates of its last complete read, with that
/// read's time, and makes the run incomplete. Atera's API documents only 200 and 500 for these routes: a 500 is counted as a device
/// Atera keeps no update data for (to be confirmed on the company's account, EXT-03).
/// </summary>
public sealed class AteraPatchSyncJob(
    IAteraClient client,
    IServiceApi service,
    SyncRunner runner,
    IOptions<AteraOptions> options,
    ILogger<AteraPatchSyncJob> logger)
{
    public const string JobId = "atera-patches";

    /// <summary>Failed devices in a row that end the run: Atera is not answering, and asking every other device would not help.</summary>
    public const int MaxConsecutiveFailures = 5;

    public async Task RunAsync(CancellationToken cancellationToken)
    {
        if (!options.Value.IsConfigured)
        {
            logger.LogInformation("Atera is not configured; the update read is skipped");
            return;
        }

        await runner.RunAsync(AteraTypes.System, JobId, async (progress, ct) =>
        {
            int notWindows = 0, withoutGuid = 0, unknown = 0, noData = 0, consecutive = 0;
            foreach (var device in await service.GetCurrentDevicesAsync(AteraTypes.System, ct))
            {
                if (!AteraServiceMapping.HasWindowsUpdates(device.Os))
                {
                    notWindows++;
                    continue;
                }

                if (device.AlternateId is not { } guid)
                {
                    withoutGuid++;
                    continue;
                }

                progress.Read++;
                try
                {
                    var installed = await client.GetPatchesAsync(guid, installed: true, ct);
                    var available = await client.GetPatchesAsync(guid, installed: false, ct);
                    consecutive = 0;
                    if (installed is null || available is null)
                    {
                        unknown++;
                        continue;
                    }

                    var snapshot = new DevicePatchSnapshot(
                        installed.Patches.Select(Reading).ToList(), available.Patches.Select(Reading).ToList(), installed.CollectedAt ?? available.CollectedAt);
                    progress.Changed += await service.ApplyDevicePatchesAsync(device.Id, snapshot, ct) ? 1 : 0;
                }
                catch (AteraApiException ex) when (ex.Status == HttpStatusCode.InternalServerError)
                {
                    consecutive = 0;
                    noData++;
                }
                catch (Exception ex) when (AteraConversationReader.IsReadFailure(ex, ct))
                {
                    // The device keeps the updates it had; the run is not complete.
                    progress.Failed++;
                    logger.LogWarning("The updates of Atera device {DeviceId} could not be read ({ErrorType})", device.Id, ex.GetType().Name);
                    if (++consecutive >= MaxConsecutiveFailures)
                    {
                        throw new AteraApiException(HttpStatusCode.BadGateway, $"The updates of {consecutive} devices in a row could not be read.");
                    }
                }
            }

            progress.Message = $"updates of {progress.Changed} devices; not Windows {notWindows}, without DeviceGuid {withoutGuid}, " +
                               $"unknown to Atera {unknown}, without update data {noData}, unreadable {progress.Failed}";
        }, cancellationToken);
    }

    private static DevicePatchReading Reading(AteraPatch patch) => new(patch.KbId, patch.Name, patch.Class, patch.InstalledAt, patch.Status);
}
