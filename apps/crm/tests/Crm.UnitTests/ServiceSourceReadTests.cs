using Crm.Service;
using Crm.SharedKernel.Operations;

namespace Crm.UnitTests;

/// <summary>
/// M41: a status line names a source's read once the source was read, or while it is switched on; a source switched off and never read
/// is left out instead of being "not read yet" for good, and one read before and switched off since stays with what its last read was.
/// </summary>
public sealed class ServiceSourceReadTests
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private sealed class Source(bool connected, SyncCompleteness? latest) : ISyncCompletenessSource
    {
        public Task<SyncCompleteness?> LatestAsync(string system, string job, CancellationToken cancellationToken) => Task.FromResult(latest);

        public bool IsConnected(string system) => connected;
    }

    [Fact]
    public async Task A_source_switched_off_and_never_read_is_left_out()
    {
        (await ServiceSourceRead.ShownAsync([new Source(false, null)], "security-alerts", Ct)).ShouldBeNull();
        (await ServiceSourceRead.ShownAsync([], "devices", Ct)).ShouldBeNull("no integration answers at all");
    }

    [Fact]
    public async Task A_source_switched_on_is_named_before_its_first_read_and_one_switched_off_since_keeps_its_last_read()
    {
        (await ServiceSourceRead.ShownAsync([new Source(true, null)], "security-alerts", Ct))
            .ShouldBe(new ServiceSourceRead("security-alerts", "huntress", null, false, false));

        var last = new SyncCompleteness(DateTimeOffset.Parse("2026-10-19T06:00:00Z"), Complete: true, Late: true);
        (await ServiceSourceRead.ShownAsync([new Source(false, last)], "security-devices", Ct))
            .ShouldBe(new ServiceSourceRead("security-devices", "huntress", last.StartedAt, true, true));
        // Atera's reads follow the same rule (M41).
        (await ServiceSourceRead.ShownAsync([new Source(true, last)], "tickets", Ct))!.System.ShouldBe("atera");
    }
}
