using Crm.Integrations.Core.Parasol;
using Crm.SharedKernel.Application;

namespace Crm.UnitTests;

internal static class LocalReadinessTestSupport
{
    internal static readonly Guid Employee = Guid.Parse("11111111-1111-4111-8111-111111111111");
    internal static readonly DateTimeOffset Now = DateTimeOffset.Parse("2026-10-16T12:00:00Z");
    internal sealed class User(Guid? id = null, params string[] permissions) : ICurrentUser
    {
        public Guid? UserId => id;
        public bool IsAuthenticated => id is not null;
        public string DisplayName => "Synthetic employee";
        public bool HasPermission(string permission) => permissions.Contains(permission, StringComparer.Ordinal);
    }
    internal sealed class Flags : ILocalReadinessFlags
    {
        internal int Calls;
        public LocalReadinessFlags Read() { Calls++; return new("DEVELOPMENT", false, true, true, false, false, true, false, true, true); }
    }
    internal sealed class Stored : ILocalReadinessStoredState
    {
        internal int Calls;
        internal Func<CancellationToken, Task<LocalStoredState>> Reply = _ => Task.FromResult(new LocalStoredState(
            new(false, null, 0, 0, 0, 0), new(true, Now, 5, 2, 1, 1), new(null, null)));
        public Task<LocalStoredState> ReadAsync(CancellationToken ct) { Calls++; return Reply(ct); }
    }
    internal static LocalReadinessReader Reader(User user, Stored? stored = null, Flags? flags = null, TimeProvider? time = null) =>
        new(user, flags ?? new(), stored ?? new(), time ?? TimeProvider.System);
}

/// <summary>Deterministic budget tests advance owned timers without sleeping or changing the process clock.</summary>
internal sealed class ReadinessClock : TimeProvider
{
    private readonly Lock gate = new();
    private readonly List<ClockTimer> timers = [];
    private DateTimeOffset now = LocalReadinessTestSupport.Now;
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
    private sealed class ClockTimer(ReadinessClock owner, TimerCallback callback, object? state) : ITimer
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
