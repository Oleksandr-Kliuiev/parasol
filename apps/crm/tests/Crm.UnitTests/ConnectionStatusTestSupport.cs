using System.Data.Common;
using Crm.Integrations.Core;
using Crm.Integrations.Core.Readiness;
using Crm.SharedKernel.Application;

namespace Crm.UnitTests;

internal static class ConnectionStatusTestSupport
{
    internal static readonly Guid Employee = Guid.Parse("11111111-1111-4111-8111-111111111111");
    internal static readonly DateTimeOffset Now = DateTimeOffset.Parse("2026-10-16T12:00:00Z");
    internal static readonly ConnectionDefinition Atera = new("atera", true, true, ["atera-alerts", "atera-tickets"]);
    internal static readonly ConnectionDefinition Brreg = new("brreg", true, null, ["brreg-registry-check"]);

    internal sealed class User(Guid? id = null, params string[] permissions) : ICurrentUser
    {
        public Guid? UserId => id;
        public bool IsAuthenticated => id is not null;
        public string DisplayName => "Synthetic employee";
        public bool HasPermission(string permission) => permissions.Contains(permission, StringComparer.Ordinal);
    }

    internal sealed class TestCatalog(params ConnectionDefinition[] connections) : IConnectionCatalog
    {
        internal int Calls;
        public IReadOnlyList<ConnectionDefinition> Read() { Calls++; return connections.Length == 0 ? [Atera, Brreg] : connections; }
    }

    internal sealed class Stored : IConnectionStatusStore
    {
        internal int Calls;
        internal Func<CancellationToken, Task<ConnectionStoredState>> Reply = _ => Task.FromResult(State(
            [Stream("atera", "atera-alerts", Minutes(5)), Stream("atera", "atera-tickets", Minutes(3)), Stream("brreg", "brreg-registry-check", Minutes(45))],
            Beat("outbox", 20), Beat("jobs", 40), Beat("actions", 10), Beat("early-reads", 5)));
        public Task<ConnectionStoredState> ReadAsync(IReadOnlyList<ConnectionDefinition> connections, CancellationToken ct) { Calls++; return Reply(ct); }
    }

    internal sealed class SyntheticDbException : DbException;

    internal static DateTimeOffset Minutes(int ago) => Now.AddMinutes(-ago);

    /// <summary>A stream as monitoring reports it; the freshness follows the success against a 60-minute limit unless given.</summary>
    internal static IntegrationFreshnessItem Stream(
        string system, string job, DateTimeOffset? succeeded, DateTimeOffset? failed = null, string? freshness = null, bool paused = false,
        int failedOutbound = 0) =>
        new(system, job, true, paused, failed ?? succeeded, failed is null ? "Succeeded" : "Failed", succeeded,
            succeeded is { } at ? (Now - at).TotalMinutes : null,
            freshness ?? (paused ? "Paused" : succeeded is null ? "Never" : Now - succeeded > TimeSpan.FromMinutes(60) ? "Stale" : "Fresh"),
            60, failedOutbound, 0, failed);

    internal static WorkerHeartbeatStatus Beat(string component, int ageSeconds, string instance = "worker-a", bool? stale = null) =>
        new(component, instance, Now.AddSeconds(-ageSeconds), ageSeconds, stale ?? ageSeconds > 180, null);

    internal static ConnectionStoredState State(IEnumerable<IntegrationFreshnessItem> streams, params WorkerHeartbeatStatus[] beats) =>
        new(new IntegrationMonitoringSnapshot(Now, streams.ToList(), []), beats, TimeSpan.FromMinutes(3));

    internal static ConnectionStatusReader Reader(User user, Stored? stored = null, TestCatalog? catalog = null, TimeProvider? time = null) =>
        new(user, catalog ?? new(), stored ?? new(), time ?? new StatusClock());
}

/// <summary>Deterministic budget tests advance owned timers without sleeping or changing the process clock.</summary>
internal sealed class StatusClock : TimeProvider
{
    private readonly Lock gate = new();
    private readonly List<ClockTimer> timers = [];
    private DateTimeOffset now = ConnectionStatusTestSupport.Now;
    public override DateTimeOffset GetUtcNow() { lock (gate) return now; }
    public override ITimer CreateTimer(TimerCallback callback, object? state, TimeSpan dueTime, TimeSpan period)
    {
        lock (gate) { var timer = new ClockTimer(this, callback, state); timers.Add(timer); timer.Change(dueTime, period); return timer; }
    }
    internal void Advance(TimeSpan duration)
    {
        ClockTimer[] due;
        lock (gate) { now += duration; due = timers.Where(timer => !timer.Disposed && timer.Due <= now).ToArray(); }
        foreach (var timer in due) timer.Fire();
    }
    private sealed class ClockTimer(StatusClock owner, TimerCallback callback, object? state) : ITimer
    {
        internal bool Disposed; internal DateTimeOffset? Due;
        private TimeSpan period;
        public bool Change(TimeSpan dueTime, TimeSpan newPeriod)
        {
            lock (owner.gate) { if (Disposed) return false; period = newPeriod; Due = dueTime == Timeout.InfiniteTimeSpan ? null : owner.now + dueTime; return true; }
        }
        internal void Fire()
        {
            lock (owner.gate) { if (Disposed) return; Due = period == Timeout.InfiniteTimeSpan ? null : owner.now + period; }
            callback(state);
        }
        public void Dispose() { lock (owner.gate) { Disposed = true; Due = null; } }
        public ValueTask DisposeAsync() { Dispose(); return ValueTask.CompletedTask; }
    }
}
