using Crm.Authorization;
using Crm.Integrations.Core.Parasol;
using Crm.SharedKernel.Application;

namespace Crm.UnitTests;

internal static class AtlasAttentionTestSupport
{
    internal static readonly Guid Employee = Guid.Parse("11111111-1111-4111-8111-111111111111");
    internal static readonly DateTimeOffset Now = DateTimeOffset.Parse("2026-10-16T12:00:00Z");
    internal static AtlasAttentionBinding Binding(int index) => new(Guid.Parse($"00000000-0000-4000-8000-{index + 1:000000000000}"),
        $"Synthetic customer {index:000}", "synthetic-workspace", $"client-{index}", Guid.NewGuid());
    internal static AtlasIdentitySnapshot Snapshot(int count) => new(1, "atlas", "synthetic-workspace",
        Enumerable.Range(0, count).Select(index => new AtlasIdentityClient($"client-{index}", "Synthetic source name")).ToArray());
    internal static AtlasWorkspaceView Workspace(AtlasAttentionBinding binding, int high = 4, int critical = 1, string completeness = "COMPLETE")
    {
        var observations = Enumerable.Range(0, critical).Select(index => Observation($"critical-{index}", "CRITICAL", index == 0 ? "device-one" : "device-two"))
            .Concat(Enumerable.Range(0, high).Select(index => Observation($"high-{index}", "HIGH", "device-two"))).ToArray();
        return new(binding.CustomerId, "READY", new("db", Now, completeness, 3, 0, high + critical + 10,
            new Dictionary<string, int> { ["INFO"] = 0, ["LOW"] = 0, ["MEDIUM"] = 10, ["HIGH"] = high, ["CRITICAL"] = critical },
            [new("atera", "alert", "OK", Now, Now, 0, false)],
            [new("device-one", "SYNTHETIC-ONE", ["atera"]), new("device-two", "SYNTHETIC-TWO", ["atera"]), new("unused-device", "SYNTHETIC-UNUSED", ["atera"])],
            new(observations, true)));
    }
    private static AtlasObservationView Observation(string id, string severity, string device) =>
        new(id, "Synthetic technical observation " + id, "atera", "alert", "DISK_CAPACITY", "OPERATIONS", severity, "URGENT",
            "HUMAN_REVIEW", "OPEN", Now, Now, "CONFIRMED", device);

    internal sealed class User(Guid? id = null, bool customers = true, bool atlas = true) : ICurrentUser
    {
        public Guid? UserId => id;
        public bool IsAuthenticated => id is not null;
        public string DisplayName => "Synthetic employee";
        public bool HasPermission(string permission) => permission == Permissions.CustomersRead ? customers : permission == Permissions.ParasolAtlasRead && atlas;
    }
    internal sealed class Directory(int count) : IAtlasAttentionDirectory
    {
        internal int Calls;
        internal Func<CancellationToken, Task<AtlasAttentionDirectoryResult>>? Reply;
        public Task<AtlasAttentionDirectoryResult> ReadAsync(CancellationToken ct)
        { Calls++; return Reply?.Invoke(ct) ?? Task.FromResult(new AtlasAttentionDirectoryResult("READY", Snapshot(count))); }
    }
    internal sealed class Mappings(IReadOnlyList<AtlasAttentionBinding> bindings, int unmapped = 0, int issues = 0) : IAtlasAttentionMappings
    {
        internal int Calls; internal int PublicationCalls;
        internal Func<IReadOnlyList<AtlasAttentionBinding>, CancellationToken, Task<IReadOnlyDictionary<Guid, string>>>? Publish;
        public Task<AtlasAttentionMappingSet> IntersectAsync(AtlasIdentitySnapshot snapshot, CancellationToken ct)
        { ct.ThrowIfCancellationRequested(); Calls++; return Task.FromResult(new AtlasAttentionMappingSet(bindings, unmapped, issues)); }
        public Task<IReadOnlyDictionary<Guid, string>> CurrentAsync(IReadOnlyList<AtlasAttentionBinding> expected, CancellationToken ct)
        {
            ct.ThrowIfCancellationRequested(); PublicationCalls++;
            return Publish?.Invoke(expected, ct) ?? Task.FromResult<IReadOnlyDictionary<Guid, string>>(expected.ToDictionary(binding => binding.CustomerId, binding => binding.CustomerName));
        }
    }
    internal sealed class Workspaces : IAtlasAttentionWorkspaces
    {
        internal int Calls; internal int Active; internal int Peak;
        internal Func<AtlasAttentionBinding, CancellationToken, Task<AtlasWorkspaceView>> Reply = (binding, _) => Task.FromResult(Workspace(binding));
        public async Task<AtlasWorkspaceView> ReadAsync(AtlasAttentionBinding binding, CancellationToken ct)
        {
            Interlocked.Increment(ref Calls);
            var active = Interlocked.Increment(ref Active);
            int previous;
            do { previous = Peak; if (previous >= active) break; } while (Interlocked.CompareExchange(ref Peak, active, previous) != previous);
            try { return await Reply(binding, ct); } finally { Interlocked.Decrement(ref Active); }
        }
    }

    internal sealed class Tasks : IAtlasAttentionTasks
    {
        internal int Calls;
        internal IReadOnlyList<(AtlasAttentionBinding Binding, IReadOnlyList<string> ObservationIds)>? Asked;
        internal Func<CancellationToken, Task<IReadOnlyDictionary<Guid, IReadOnlyList<AtlasObservationTaskLink>>?>> Reply = _ => Task.FromResult<IReadOnlyDictionary<Guid, IReadOnlyList<AtlasObservationTaskLink>>?>(null);
        public Task<IReadOnlyDictionary<Guid, IReadOnlyList<AtlasObservationTaskLink>>?> ReadAsync(
            IReadOnlyList<(AtlasAttentionBinding Binding, IReadOnlyList<string> ObservationIds)> previews, CancellationToken ct)
        { Calls++; Asked = previews; return Reply(ct); }
    }

    internal static AtlasAttentionReader Reader(Directory directory, Mappings mappings, Workspaces workspaces, TimeProvider? clock = null, User? user = null,
        Tasks? tasks = null) =>
        new(user ?? new User(Employee), directory, mappings, workspaces, tasks ?? new Tasks(), clock ?? TimeProvider.System);
}

/// <summary>Deterministic budget tests advance owned timers without sleeping or changing the process clock.</summary>
internal sealed class AtlasAttentionClock : TimeProvider
{
    private readonly Lock gate = new();
    private readonly List<ClockTimer> timers = [];
    private DateTimeOffset now = AtlasAttentionTestSupport.Now;
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
    private sealed class ClockTimer(AtlasAttentionClock owner, TimerCallback callback, object? state) : ITimer
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
