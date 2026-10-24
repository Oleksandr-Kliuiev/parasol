using Crm.Integrations.Core.Parasol;
using static Crm.UnitTests.AtlasAttentionTestSupport;
using Directory = Crm.UnitTests.AtlasAttentionTestSupport.Directory;

namespace Crm.UnitTests;

public sealed class AtlasAttentionBudgetTests
{
    [Fact]
    public async Task A_customer_has_three_seconds_and_failure_is_explicit_without_a_retry()
    {
        var clock = new AtlasAttentionClock(); var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var workspaces = new Workspaces { Reply = async (binding, ct) => { entered.SetResult(); await Task.Delay(Timeout.Infinite, ct); return Workspace(binding); } };
        var pending = Reader(new(1), new([Binding(0)]), workspaces, clock).ReadAsync(default);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5)); clock.Advance(TimeSpan.FromSeconds(3));
        var view = (await pending.WaitAsync(TimeSpan.FromSeconds(5))).Value;
        view.Status.ShouldBe("PARTIAL"); view.Customers!.Single().Status.ShouldBe("TIMEOUT");
        view.Coverage!.TimedOut.ShouldBeTrue(); view.Coverage.FailedCustomers.ShouldBe(1); view.Totals.ShouldBe(new(0, 0, 0)); workspaces.Calls.ShouldBe(1);
    }

    [Fact]
    public async Task The_fifteen_second_operation_deadline_cancels_inflight_reads_and_never_starts_remaining_customers()
    {
        var clock = new AtlasAttentionClock(); var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var workspaces = new Workspaces();
        workspaces.Reply = async (binding, ct) => { if (workspaces.Calls == 4) entered.TrySetResult(); await Task.Delay(Timeout.Infinite, ct); return Workspace(binding); };
        var pending = Reader(new(12), new(Enumerable.Range(0, 12).Select(Binding).ToArray()), workspaces, clock).ReadAsync(default);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5)); clock.Advance(TimeSpan.FromSeconds(15));
        var view = (await pending.WaitAsync(TimeSpan.FromSeconds(5))).Value;
        workspaces.Calls.ShouldBe(4); workspaces.Active.ShouldBe(0); view.Coverage.ShouldBe(new(12, 12, 12, 4, 0, 12, 0, 0, 0, false, true));
        view.Customers!.All(row => row.Status == "TIMEOUT").ShouldBeTrue(); view.Totals.ShouldBe(new(0, 0, 0));
    }

    [Fact]
    public async Task Earlier_twenty_customers_survive_collection_timeout_only_after_a_current_publication_check()
    {
        var clock = new AtlasAttentionClock(); var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var bindings = Enumerable.Range(0, 24).Select(Binding).ToArray(); var mappings = new Mappings(bindings); var workspaces = new Workspaces();
        workspaces.Reply = async (binding, ct) =>
        {
            if (binding.CustomerName.CompareTo(bindings[20].CustomerName) < 0) return Workspace(binding);
            if (workspaces.Calls == 24) entered.TrySetResult();
            await Task.Delay(Timeout.Infinite, ct); return Workspace(binding);
        };
        var pending = Reader(new(24), mappings, workspaces, clock).ReadAsync(default);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5)); clock.Advance(TimeSpan.FromSeconds(14));
        var view = (await pending.WaitAsync(TimeSpan.FromSeconds(5))).Value;
        view.Status.ShouldBe("PARTIAL"); view.Coverage.ShouldBe(new(24, 24, 24, 24, 20, 4, 0, 0, 0, false, true));
        view.Totals.ShouldBe(new(300, 80, 20)); view.Customers!.Count(row => row.Status == "READY").ShouldBe(20);
        mappings.PublicationCalls.ShouldBe(1); workspaces.Calls.ShouldBe(24); workspaces.Active.ShouldBe(0);
    }

    [Fact]
    public async Task A_source_denial_stops_new_work_and_drains_inflight_customers_without_inventing_a_timeout()
    {
        var bindings = Enumerable.Range(0, 50).Select(Binding).ToArray(); var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var deny = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously); var workspaces = new Workspaces();
        workspaces.Reply = async (binding, ct) =>
        {
            if (workspaces.Calls == 4) entered.TrySetResult();
            if (binding == bindings[0]) { await deny.Task.WaitAsync(ct); return new(binding.CustomerId, "ACCESS_DENIED"); }
            await Task.Delay(Timeout.Infinite, ct); return Workspace(binding);
        };
        var pending = Reader(new(50), new(bindings), workspaces).ReadAsync(default);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5)); deny.SetResult();
        var view = (await pending.WaitAsync(TimeSpan.FromSeconds(5))).Value;
        view.Status.ShouldBe("ACCESS_DENIED"); view.Customers.ShouldBeNull(); view.Totals.ShouldBeNull();
        view.Coverage.ShouldBe(new(50, 50, 50, 4, 0, 50, 0, 0, 0, false, false)); workspaces.Calls.ShouldBe(4); workspaces.Active.ShouldBe(0);
    }

    [Fact]
    public async Task The_publication_check_has_the_same_total_budget_and_discards_unverified_technical_results()
    {
        var clock = new AtlasAttentionClock(); var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var mappings = new Mappings([Binding(0)]);
        mappings.Publish = async (_, ct) => { entered.SetResult(); await Task.Delay(Timeout.Infinite, ct); return new Dictionary<Guid, string>(); };
        var pending = Reader(new(1), mappings, new(), clock).ReadAsync(default);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5)); clock.Advance(TimeSpan.FromSeconds(15));
        var view = (await pending.WaitAsync(TimeSpan.FromSeconds(5))).Value;
        view.Customers!.Single().Status.ShouldBe("TIMEOUT"); view.Customers!.Single().Preview.ShouldBeEmpty(); view.Totals.ShouldBe(new(0, 0, 0));
    }

    [Fact]
    public async Task Directory_read_is_inside_the_total_budget_and_request_cancellation_is_never_a_successful_snapshot()
    {
        var clock = new AtlasAttentionClock(); var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var directory = new Directory(0) { Reply = async ct => { entered.SetResult(); await Task.Delay(Timeout.Infinite, ct); return new("READY", Snapshot(0)); } };
        var pending = Reader(directory, new([]), new(), clock).ReadAsync(default);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5)); clock.Advance(TimeSpan.FromSeconds(15));
        var view = (await pending.WaitAsync(TimeSpan.FromSeconds(5))).Value;
        view.Status.ShouldBe("UNAVAILABLE"); view.Coverage.ShouldBeNull(); view.Totals.ShouldBeNull();
        using var caller = new CancellationTokenSource(); caller.Cancel();
        await Should.ThrowAsync<OperationCanceledException>(async () => await Reader(new(0), new([]), new()).ReadAsync(caller.Token));
    }
}
