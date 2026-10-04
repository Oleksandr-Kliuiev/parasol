using Crm.Identity.Contracts;
using Crm.Web.Auth;

namespace Crm.IntegrationTests;

/// <summary>DEV-10: a replica remembers what it read about a session for a bounded time and in bounded numbers.</summary>
public sealed class SessionStateCacheTests
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task A_session_is_read_again_after_the_cache_time_or_once_forgotten()
    {
        var time = new ManualTimeProvider(DateTimeOffset.UtcNow);
        var directory = new CountingDirectory();
        var cache = new SessionStateCache(time, new CrmAuthOptions { SessionStateCacheSeconds = 30 });
        var (user, session) = (Guid.NewGuid(), Guid.NewGuid());

        await cache.GetAsync(user, session, directory, Ct);
        time.Advance(TimeSpan.FromSeconds(29));
        await cache.GetAsync(user, session, directory, Ct);
        directory.Reads.ShouldBe(1);

        time.Advance(TimeSpan.FromSeconds(1));
        await cache.GetAsync(user, session, directory, Ct);
        directory.Reads.ShouldBe(2, "thirty seconds old: read again");

        cache.Forget(user, session);
        await cache.GetAsync(user, session, directory, Ct);
        directory.Reads.ShouldBe(3, "a signed-out session is not answered from memory");
    }

    [Fact]
    public async Task Full_of_fresh_sessions_it_answers_without_remembering_and_makes_room_from_stale_ones()
    {
        var time = new ManualTimeProvider(DateTimeOffset.UtcNow);
        var directory = new CountingDirectory();
        var cache = new SessionStateCache(time, new CrmAuthOptions { SessionStateCacheSeconds = 30 });
        for (var i = 0; i < 10_000; i++)
        {
            await cache.GetAsync(Guid.NewGuid(), Guid.NewGuid(), directory, Ct);
        }

        var (user, session) = (Guid.NewGuid(), Guid.NewGuid());
        await cache.GetAsync(user, session, directory, Ct);
        await cache.GetAsync(user, session, directory, Ct);
        directory.Reads.ShouldBe(10_002, "no room: the 10 001st session is read every time, the bound holds");

        time.Advance(TimeSpan.FromSeconds(31));
        await cache.GetAsync(user, session, directory, Ct);
        await cache.GetAsync(user, session, directory, Ct);
        directory.Reads.ShouldBe(10_003, "the stale entries made room, so it is remembered again");
    }

    private sealed class CountingDirectory : ISessionDirectory
    {
        public int Reads { get; private set; }

        public Task<Guid> StartAsync(Guid userId, DateTimeOffset at, CancellationToken cancellationToken) => throw new NotSupportedException();

        public Task EndAsync(Guid sessionId, string reason, DateTimeOffset at, CancellationToken cancellationToken) => throw new NotSupportedException();

        public Task<SessionState> GetAsync(Guid userId, Guid sessionId, CancellationToken cancellationToken)
        {
            Reads++;
            return Task.FromResult(new SessionState(true, true, [], 1, DateTimeOffset.UtcNow));
        }
    }
}
