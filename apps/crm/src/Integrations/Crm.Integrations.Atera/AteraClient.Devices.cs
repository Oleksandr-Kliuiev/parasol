using System.Net;
using System.Text.Json;

namespace Crm.Integrations.Atera;

/// <summary>Agents (devices), their Windows updates and alerts.</summary>
internal sealed partial class AteraClient
{
    /// <summary>
    /// The device mirror marks removed what a read no longer lists, and the machines and coverage gaps (M40) stand on it, so this
    /// read must not lose anything quietly either: the previous page is read again, and an agent without an id or a customer fails
    /// the read.
    /// </summary>
    public IAsyncEnumerable<AteraAgent> GetAgentsAsync(CancellationToken cancellationToken) =>
        GetPagedAsync("agents", ReadAgent, cancellationToken, key: a => a.AgentId, strict: true);

    /// <summary>
    /// The alert mirror resolves what a complete read no longer lists (M38), so this read must not lose anything quietly: the
    /// previous page is read again for alerts that moved across the boundary, and an alert without an id fails the read.
    /// </summary>
    public IAsyncEnumerable<AteraAlert> GetAlertsAsync(string? status, CancellationToken cancellationToken) =>
        GetPagedAsync("alerts", ReadAlert, cancellationToken, status is null ? null : $"alertStatus={Uri.EscapeDataString(status)}", a => a.AlertId, strict: true);

    /// <summary>
    /// The installed or the available Windows updates of an agent (M40): <c>GET agents/{DeviceGuid}/installed-patches</c> or
    /// <c>available-patches</c>, one object per agent. Null when Atera does not know the device (404).
    /// </summary>
    public async Task<AteraPatchList?> GetPatchesAsync(string deviceGuid, bool installed, CancellationToken cancellationToken)
    {
        using var response = await http.GetAsync($"agents/{Uri.EscapeDataString(deviceGuid)}/{(installed ? "installed-patches" : "available-patches")}", cancellationToken);
        if (response.StatusCode == HttpStatusCode.NotFound)
        {
            return null;
        }

        await EnsureSuccessAsync(response, cancellationToken);
        using var document = await JsonDocument.ParseAsync(await response.Content.ReadAsStreamAsync(cancellationToken), cancellationToken: cancellationToken);
        return ReadPatches(document.RootElement, installed);
    }
}
