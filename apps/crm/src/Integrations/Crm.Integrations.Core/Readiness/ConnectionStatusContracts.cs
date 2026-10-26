namespace Crm.Integrations.Core.Readiness;

/// <summary>
/// The CRM's own state of its integrations (the connections page): whether each one is on, when each of its jobs last read
/// everything, and whether the worker that runs them is alive. Saved state only: no provider is called and no secret is read.
/// <c>Status</c> is <c>Ready</c> only when every job of every enabled integration is fresh, its latest run did not fail, nothing
/// waits unsent and the worker answers; otherwise <c>Gaps</c> lists what is missing, and <c>Unavailable</c> says the saved
/// state could not be read at all (then no state and no gaps are given, never zeroes).
/// </summary>
public sealed record ConnectionStatusView(
    string Status, DateTimeOffset CheckedAt, IReadOnlyList<ConnectionIntegration> Integrations, ConnectionWorker? Worker,
    IReadOnlyList<ConnectionGap> Gaps);

/// <param name="WriteEnabled">Whether the CRM may send changes to the system, or null for a system it only reads.</param>
/// <param name="State">What the CRM saved about it, or null when the saved state could not be read.</param>
/// <param name="Webhook">The system's webhook (M44), or null for a system without one, or when the saved state could not be read.</param>
public sealed record ConnectionIntegration(string System, bool Enabled, bool? WriteEnabled, ConnectionIntegrationState? State, ConnectionWebhook? Webhook = null);

/// <summary>
/// A vendor's webhook as the CRM heard it (M44): whether it is switched on, the last delivery it accepted and the name of its event,
/// how many it accepted, the last one it refused and why (<c>Unsigned</c>, <c>Stale</c>, <c>BadSignature</c>), and when a webhook last
/// started a read early. A refusal is not a gap: the scheduled reads go on, only sooner reads stop.
/// </summary>
public sealed record ConnectionWebhook(
    bool Enabled, DateTimeOffset? LastReceivedAt, string? LastEventType, long Received, DateTimeOffset? LastRefusedAt, string? LastRefusal,
    DateTimeOffset? LastEarlyReadAt);

/// <param name="FailedOutbound">Changes for the system that could not be sent (failed or dead-lettered).</param>
public sealed record ConnectionIntegrationState(bool Paused, int FailedOutbound, IReadOnlyList<ConnectionJob> Jobs);

/// <summary>
/// One recurring job as monitoring judges it (<see cref="IntegrationMonitoringReader"/>): <c>Freshness</c> is Fresh, Stale, Never,
/// Paused or Disabled against the job's own limit; the last error is when its latest unsuccessful run ended.
/// </summary>
public sealed record ConnectionJob(
    string Job, string Freshness, DateTimeOffset? LastSucceededAt, int? AgeMinutes, int ThresholdMinutes, DateTimeOffset? LastRunAt,
    string? LastRunStatus, DateTimeOffset? LastFailedAt);

/// <param name="Components">The worker's parts that must beat (the outbox loop and the job server), each Current, Late or Missing.</param>
public sealed record ConnectionWorker(int StaleAfterSeconds, IReadOnlyList<ConnectionHeartbeat> Components);

public sealed record ConnectionHeartbeat(string Component, string State, DateTimeOffset? BeatAt, int? AgeSeconds);

/// <summary>
/// Something that keeps the status from being green: a job that never read everything, read too long ago or failed last
/// (<c>Never</c>, <c>Stale</c>, <c>Failed</c>), a paused integration, changes that could not be sent (<c>OutboundFailed</c> with
/// <c>Count</c>), or a worker part that is late or has never beaten (<c>WorkerLate</c>, <c>WorkerMissing</c>).
/// </summary>
public sealed record ConnectionGap(string Kind, string? System = null, string? Job = null, string? Component = null, int? Count = null);

/// <summary>
/// An integration as this instance is configured: whether it is on, whether it may write, the recurring jobs that read it, and
/// whether its webhook is switched on (null for a system without webhooks, M44). Crm.Web builds the list from the integrations'
/// options and job ids (it references them all; this project cannot).
/// </summary>
public sealed record ConnectionDefinition(string System, bool Enabled, bool? WriteEnabled, IReadOnlyList<string> Jobs, bool? WebhookEnabled = null);

/// <summary>Only configuration switches and job names cross the host boundary: never credentials, endpoints or their presence.</summary>
public interface IConnectionCatalog
{
    IReadOnlyList<ConnectionDefinition> Read();
}

/// <summary>What the saved state holds: monitoring's judgement of the jobs and the worker heartbeats.</summary>
/// <summary>
/// What the page is composed from; <paramref name="UncertainActions"/> counts, per system, the actions without a clear answer that
/// wait for a person to check at the vendor (M39).
/// </summary>
internal sealed record ConnectionStoredState(
    IntegrationMonitoringSnapshot Monitoring, IReadOnlyList<WorkerHeartbeatStatus> Heartbeats, TimeSpan HeartbeatStaleAfter,
    IReadOnlyDictionary<string, int>? UncertainActions = null, IReadOnlyDictionary<string, StoredWebhook>? Webhooks = null);

/// <summary>What was saved about a system's webhook (M44): <c>integration.WebhookStates</c> and the latest early start of its jobs.</summary>
internal sealed record StoredWebhook(
    DateTimeOffset? LastReceivedAt, string? LastEventType, long Received, DateTimeOffset? LastRefusedAt, string? LastRefusal, DateTimeOffset? LastEarlyReadAt);

internal interface IConnectionStatusStore
{
    Task<ConnectionStoredState> ReadAsync(IReadOnlyList<ConnectionDefinition> connections, CancellationToken ct);
}
