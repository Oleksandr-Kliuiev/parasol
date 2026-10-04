using System.Collections.Concurrent;
using Crm.Identity.Contracts;

namespace Crm.Web.Auth;

/// <summary>
/// What each replica last read about a session (DEV-10), kept for <see cref="CrmAuthOptions.SessionStateCacheSeconds"/>: a revoked
/// role, an ended session or a deactivated user reach every replica within that time, without a database read per request.
/// </summary>
internal sealed class SessionStateCache(TimeProvider time, CrmAuthOptions options)
{
    private const int MaxEntries = 10_000;
    private readonly ConcurrentDictionary<(Guid User, Guid Session), (SessionState State, DateTimeOffset ReadAt)> _entries = new();

    public async Task<SessionState> GetAsync(Guid userId, Guid sessionId, ISessionDirectory directory, CancellationToken cancellationToken)
    {
        var now = time.GetUtcNow();
        var ttl = TimeSpan.FromSeconds(Math.Max(options.SessionStateCacheSeconds, 0));
        if (_entries.TryGetValue((userId, sessionId), out var entry) && now - entry.ReadAt < ttl)
        {
            return entry.State;
        }

        var state = await directory.GetAsync(userId, sessionId, cancellationToken);
        if (_entries.Count >= MaxEntries)
        {
            foreach (var stale in _entries.Where(e => now - e.Value.ReadAt >= ttl).Select(e => e.Key).ToList())
            {
                _entries.TryRemove(stale, out _);
            }

            if (_entries.Count >= MaxEntries)
            {
                // Full of fresh entries: answer from the database without remembering, so the bound holds.
                return state;
            }
        }

        _entries[(userId, sessionId)] = (state, now);
        return state;
    }

    /// <summary>Drops what this replica knows about a session it has just ended.</summary>
    public void Forget(Guid userId, Guid sessionId) => _entries.TryRemove((userId, sessionId), out _);
}
