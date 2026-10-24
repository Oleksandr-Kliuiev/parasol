using Crm.Infrastructure.Health;
using Microsoft.Extensions.Options;

namespace Crm.Integrations.Core.Readiness;

/// <summary>
/// The saved state through the readers monitoring and <c>/health/details</c> use, so the connections page judges freshness
/// the way monitoring does. Saved success is evidence of a past read, not of the provider's health now.
/// </summary>
internal sealed class ConnectionStatusStore(
    IntegrationMonitoringReader monitoring, WorkerHeartbeatReader heartbeats, IOptions<ProcessingHealthOptions> options) : IConnectionStatusStore
{
    public async Task<ConnectionStoredState> ReadAsync(IReadOnlyList<ConnectionDefinition> connections, CancellationToken ct)
    {
        // Every configured job is judged, also one that has never run: "never read" is a gap, not a missing row.
        var expected = connections.SelectMany(connection => connection.Jobs.Select(job => (connection.System, job))).ToList();
        var snapshot = await monitoring.ReadAsync(expected, ct);
        return new(snapshot, await heartbeats.ReadAsync(ct), options.Value.HeartbeatStaleAfter);
    }
}
