using Crm.Authorization;
using static Crm.UnitTests.LocalReadinessTestSupport;

namespace Crm.UnitTests;

public sealed class LocalReadinessReaderTests
{
    [Theory]
    [InlineData(false, false)]
    [InlineData(false, true)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public async Task Only_integration_managers_read_the_view_and_nothing_is_queried_before_that_check(bool admin, bool customers)
    {
        var permissions = new List<string>();
        if (admin) permissions.Add(Permissions.IntegrationsManage);
        if (customers) permissions.Add(Permissions.CustomersRead);
        var stored = new Stored(); var flags = new Flags();
        var result = await Reader(new User(Employee, permissions.ToArray()), stored, flags).ReadAsync(default);
        result.IsSuccess.ShouldBe(admin);
        if (!admin) result.Error!.Code.ShouldBe("PARASOL_READINESS_FORBIDDEN");
        stored.Calls.ShouldBe(admin ? 1 : 0); flags.Calls.ShouldBe(admin ? 1 : 0);
        (await Reader(new User(null, Permissions.IntegrationsManage)).ReadAsync(default)).IsSuccess.ShouldBeFalse();
    }

    [Fact]
    public async Task Flags_are_independent_from_historical_SQL_success_and_no_graph_health_is_invented()
    {
        var view = (await Reader(new(Employee, Permissions.IntegrationsManage)).ReadAsync(default)).Value;
        view.Status.ShouldBe("LOCAL_SNAPSHOT"); view.Connectivity.ShouldBe("NOT_CHECKED"); view.Admin.Atera.Enabled.ShouldBeFalse();
        view.Admin.Atera.WriteEnabled.ShouldBeTrue(); view.Admin.PowerOffice.Stored!.LastSucceededAt.ShouldBe(Now);
        view.Admin.MicrosoftGraph.Enabled.ShouldBeFalse(); view.Admin.MicrosoftGraph.TeamsEnabled.ShouldBeTrue();
        view.Admin.AuthMode.ShouldBe("DEVELOPMENT");
    }

    [Fact]
    public async Task Whole_operation_deadline_returns_unknown_stored_state_and_never_zeroes_or_old_evidence()
    {
        var clock = new ReadinessClock(); var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var stored = new Stored { Reply = async ct => { entered.SetResult(); await Task.Delay(Timeout.InfiniteTimeSpan, ct); throw new InvalidOperationException(); } };
        var pending = Reader(new(Employee, Permissions.IntegrationsManage), stored, time: clock).ReadAsync(default);
        await entered.Task; clock.Advance(TimeSpan.FromSeconds(5)); var view = (await pending).Value;
        view.Status.ShouldBe("PARTIAL"); view.Admin.Atera.Stored.ShouldBeNull(); view.Admin.PowerOffice.Stored.ShouldBeNull();
        view.Admin.MicrosoftGraph.Stored.ShouldBeNull();
    }

    [Fact]
    public async Task Caller_cancellation_is_preserved()
    {
        using var canceled = new CancellationTokenSource(); canceled.Cancel();
        await Should.ThrowAsync<OperationCanceledException>(() => Reader(new(Employee, Permissions.IntegrationsManage)).ReadAsync(canceled.Token));
    }
}
