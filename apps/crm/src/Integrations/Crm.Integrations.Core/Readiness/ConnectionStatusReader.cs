using System.Data.Common;
using Crm.Authorization;
using Crm.Infrastructure.Outbox;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Results;
using Microsoft.EntityFrameworkCore.Storage;

namespace Crm.Integrations.Core.Readiness;

/// <summary>The connections page (M38): the CRM's own state of each integration and of the worker, never a call to a provider.</summary>
public sealed class ConnectionStatusReader
{
    internal static readonly TimeSpan Budget = TimeSpan.FromSeconds(5);

    /// <summary>
    /// The worker parts that must beat: the outbox loop, the job server and the vendor action loop (M39.1), which sends what people
    /// asked vendors to do.
    /// </summary>
    internal static readonly string[] WorkerComponents = [OutboxProcessor.HeartbeatComponent, WorkerHeartbeatJob.Component, Actions.VendorActionLoop.HeartbeatComponent];

    private readonly ICurrentUser user;
    private readonly IConnectionCatalog catalog;
    private readonly IConnectionStatusStore stored;
    private readonly TimeProvider time;

    internal ConnectionStatusReader(ICurrentUser user, IConnectionCatalog catalog, IConnectionStatusStore stored, TimeProvider time) =>
        (this.user, this.catalog, this.stored, this.time) = (user, catalog, stored, time);

    public async Task<Result<ConnectionStatusView>> ReadAsync(CancellationToken ct)
    {
        if (!user.IsAuthenticated || user.UserId is null || !user.HasPermission(Permissions.IntegrationsManage))
            return Error.Forbidden("CONNECTION_STATUS_FORBIDDEN", "Integration administration access is required.");
        ct.ThrowIfCancellationRequested();
        var connections = catalog.Read();
        using var deadline = new CancellationTokenSource(Budget, time);
        using var budget = CancellationTokenSource.CreateLinkedTokenSource(ct, deadline.Token);
        ConnectionStoredState? state = null;
        try { state = await stored.ReadAsync(connections, budget.Token); }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested) { }
        catch (DbException) { }
        catch (RetryLimitExceededException) { }
        ct.ThrowIfCancellationRequested();
        return Compose(connections, state, time.GetUtcNow());
    }

    /// <summary>
    /// Green only for a complete picture: every job of every enabled integration fresh and not failed since its last success,
    /// nothing unsent, no pause and every worker part beating. Everything else is a gap; a state that could not be read is
    /// Unavailable, with neither figures nor gaps.
    /// </summary>
    internal static ConnectionStatusView Compose(IReadOnlyList<ConnectionDefinition> connections, ConnectionStoredState? state, DateTimeOffset now)
    {
        if (state is null)
        {
            return new("Unavailable", now, connections.Select(c => new ConnectionIntegration(c.System, c.Enabled, c.WriteEnabled, null)).ToList(), null, []);
        }

        var gaps = new List<ConnectionGap>();
        var integrations = new List<ConnectionIntegration>(connections.Count);
        foreach (var connection in connections)
        {
            var streams = state.Monitoring.Systems.Where(s => s.System == connection.System).ToList();
            var paused = streams.Any(s => s.Paused);
            var failedOutbound = streams.Select(s => s.FailedOutbound).DefaultIfEmpty(0).Max();
            var jobs = connection.Jobs.Select(job => Job(connection, streams.Single(s => s.Job == job))).ToList();
            integrations.Add(new(connection.System, connection.Enabled, connection.WriteEnabled, new(paused, failedOutbound, jobs)));
            if (!connection.Enabled)
            {
                continue;
            }

            // A pause holds every job of the integration: it is the one gap to name, not each job it holds.
            if (paused)
            {
                gaps.Add(new("Paused", connection.System));
            }
            else
            {
                foreach (var job in jobs)
                {
                    if (job.LastFailedAt is { } failed && (job.LastSucceededAt is not { } succeeded || failed > succeeded))
                        gaps.Add(new("Failed", connection.System, job.Job));
                    else if (job.Freshness is "Never" or "Stale")
                        gaps.Add(new(job.Freshness, connection.System, job.Job));
                }
            }

            if (failedOutbound > 0)
            {
                gaps.Add(new("OutboundFailed", connection.System, Count: failedOutbound));
            }
        }

        var worker = new ConnectionWorker((int)state.HeartbeatStaleAfter.TotalSeconds, WorkerComponents.Select(component =>
        {
            // A replaced worker leaves its old instance's row behind for a week: the part is alive when any instance beats.
            var newest = state.Heartbeats.Where(b => b.Component == component).OrderByDescending(b => b.BeatAt).FirstOrDefault();
            return newest is null
                ? new ConnectionHeartbeat(component, "Missing", null, null)
                : new ConnectionHeartbeat(component, newest.Stale ? "Late" : "Current", newest.BeatAt, newest.AgeSeconds);
        }).ToList());
        gaps.AddRange(worker.Components.Where(c => c.State != "Current")
            .Select(c => new ConnectionGap(c.State == "Missing" ? "WorkerMissing" : "WorkerLate", Component: c.Component)));
        return new(gaps.Count == 0 ? "Ready" : "Gaps", now, integrations, worker, gaps);
    }

    private static ConnectionJob Job(ConnectionDefinition connection, IntegrationFreshnessItem stream) => new(
        stream.Job, connection.Enabled ? stream.Freshness : "Disabled", stream.LastSucceededAt,
        stream.AgeMinutes is { } age ? (int)Math.Floor(age) : null, stream.ThresholdMinutes, stream.LastRunAt, stream.LastRunStatus,
        stream.LastFailedAt);
}
