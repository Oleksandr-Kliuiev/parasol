using Crm.Activities.Contracts;
using Crm.Authorization;
using Crm.Integrations.Core.Parasol;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Results;
using static Crm.UnitTests.AtlasAttentionTestSupport;
using Directory = Crm.UnitTests.AtlasAttentionTestSupport.Directory;

namespace Crm.UnitTests;

/// <summary>My day's preview rows say which already have a CRM task (UX 2026 В3), read once for the whole snapshot.</summary>
public sealed class AtlasAttentionTaskTests
{
    private static Task<IReadOnlyDictionary<Guid, IReadOnlyList<AtlasObservationTaskLink>>?> Reply(Dictionary<Guid, IReadOnlyList<AtlasObservationTaskLink>>? value) =>
        Task.FromResult<IReadOnlyDictionary<Guid, IReadOnlyList<AtlasObservationTaskLink>>?>(value);

    [Fact]
    public async Task Preview_rows_of_ready_customers_get_their_tasks_from_one_read_of_exactly_the_published_ids()
    {
        var bindings = Enumerable.Range(0, 3).Select(Binding).ToArray(); var workspaces = new Workspaces();
        workspaces.Reply = (binding, _) => Task.FromResult(binding == bindings[1] ? new AtlasWorkspaceView(binding.CustomerId, "UNAVAILABLE")
            : binding == bindings[2] ? Workspace(binding, high: 0, critical: 0) : Workspace(binding));
        var task = new SourceTaskRef(Guid.NewGuid(), bindings[0].CustomerId, ActivityStatus.Open, Employee, Now.AddDays(1), false, true);
        var tasks = new Tasks { Reply = _ => Reply(new() { [bindings[0].CustomerId] = [new("critical-0", task, "Synthetic technician")], [bindings[2].CustomerId] = [] }) };
        var view = (await Reader(new(3), new(bindings), workspaces, tasks: tasks).ReadAsync(default)).Value;
        tasks.Calls.ShouldBe(1);
        tasks.Asked!.Select(p => (p.Binding.CustomerId, string.Join(',', p.ObservationIds)))
            .ShouldBe([(bindings[0].CustomerId, "critical-0,high-0,high-1"), (bindings[2].CustomerId, "")]);
        view.Customers![0].Tasks!.Single().ShouldBe(new("critical-0", task, "Synthetic technician"));
        view.Customers[1].Tasks.ShouldBeNull(); view.Customers[2].Tasks.ShouldBeEmpty();
        // The unavailable customer makes the snapshot partial; the tasks never do.
        view.Status.ShouldBe("PARTIAL"); view.Coverage!.FailedCustomers.ShouldBe(1);
    }

    [Fact]
    public async Task The_observation_queue_reads_up_to_ten_urgent_rows_per_customer_and_their_tasks_in_the_same_single_read()
    {
        var bindings = Enumerable.Range(0, 2).Select(Binding).ToArray(); var workspaces = new Workspaces(); var tasks = new Tasks();
        workspaces.Reply = (binding, _) => Task.FromResult(binding == bindings[0] ? Workspace(binding, high: 12, critical: 1) : Workspace(binding, high: 2, critical: 0));
        var view = (await Reader(new(2), new(bindings), workspaces, tasks: tasks).ReadAsync(default, AtlasAttentionReader.QueueLimit)).Value;
        view.Customers![0].Preview.Count.ShouldBe(10); view.Customers[0].Preview[0].Severity.ShouldBe("CRITICAL");
        view.Customers[1].Preview.Select(o => o.Id).ShouldBe(["high-0", "high-1"]);
        tasks.Calls.ShouldBe(1); tasks.Asked!.Sum(p => p.ObservationIds.Count).ShouldBe(12);
        // My day keeps three from the same overview.
        (await Reader(new(2), new(bindings), workspaces).ReadAsync(default)).Value.Customers![0].Preview.Count.ShouldBe(3);
        await Should.ThrowAsync<ArgumentOutOfRangeException>(() => Reader(new(2), new(bindings), workspaces).ReadAsync(default, 100));
    }

    [Fact]
    public async Task A_failed_task_read_leaves_rows_without_tasks_and_the_Atlas_snapshot_as_it_was()
    {
        var tasks = new Tasks { Reply = _ => throw new IOException("synthetic-private-failure") };
        var view = (await Reader(new(1), new([Binding(0)]), new(), tasks: tasks).ReadAsync(default)).Value;
        var customer = view.Customers!.Single();
        view.Status.ShouldBe("READY"); customer.Tasks.ShouldBeNull(); customer.Preview.Count.ShouldBe(3);
    }

    [Fact]
    public async Task A_slow_task_read_has_two_seconds_and_never_marks_the_Atlas_coverage_as_timed_out()
    {
        var clock = new AtlasAttentionClock(); var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var tasks = new Tasks { Reply = async ct => { entered.SetResult(); await Task.Delay(Timeout.Infinite, ct); return null; } };
        var pending = Reader(new(1), new([Binding(0)]), new(), clock, tasks: tasks).ReadAsync(default);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5)); clock.Advance(TimeSpan.FromSeconds(2));
        var view = (await pending.WaitAsync(TimeSpan.FromSeconds(5))).Value;
        view.Status.ShouldBe("READY"); view.Coverage!.TimedOut.ShouldBeFalse(); view.Customers!.Single().Tasks.ShouldBeNull();
    }

    [Fact]
    public async Task A_denied_snapshot_reads_no_tasks()
    {
        var bindings = Enumerable.Range(0, 2).Select(Binding).ToArray(); var workspaces = new Workspaces(); var tasks = new Tasks();
        workspaces.Reply = (binding, _) => Task.FromResult(binding == bindings[0] ? Workspace(binding) : new(binding.CustomerId, "ACCESS_DENIED"));
        (await Reader(new(2), new(bindings), workspaces, tasks: tasks).ReadAsync(default)).Value.Status.ShouldBe("ACCESS_DENIED");
        tasks.Calls.ShouldBe(0);
    }

    [Fact]
    public async Task The_task_source_asks_activities_once_for_every_customer_and_only_with_activity_access()
    {
        var bindings = Enumerable.Range(0, 2).Select(Binding).ToArray();
        var task = new SourceTaskRef(Guid.NewGuid(), bindings[1].CustomerId, ActivityStatus.Done, null, null, false, true);
        var activities = new Activities { Found = [new(bindings[1].CustomerId, "high-0", task, null)] };
        IReadOnlyList<(AtlasAttentionBinding, IReadOnlyList<string>)> previews = [(bindings[0], ["critical-0"]), (bindings[1], ["high-0", "high-1"])];
        var links = (await new AtlasAttentionTasks(new Reader(activities: true), activities).ReadAsync(previews, default))!;
        activities.Calls.ShouldBe(1);
        activities.Asked!.Select(q => (q.WorkspaceId, q.ClientId, q.OrganizationId, string.Join(',', q.ObservationIds)))
            .ShouldBe([("synthetic-workspace", "client-0", bindings[0].CustomerId, "critical-0"), ("synthetic-workspace", "client-1", bindings[1].CustomerId, "high-0,high-1")]);
        links[bindings[0].CustomerId].ShouldBeEmpty(); links[bindings[1].CustomerId].Single().ShouldBe(new("high-0", task, null));

        (await new AtlasAttentionTasks(new Reader(activities: false), activities).ReadAsync(previews, default)).ShouldBeNull();
        activities.Calls.ShouldBe(1);
        activities.Failure = Error.Forbidden("ACT_FORBIDDEN", "synthetic");
        (await new AtlasAttentionTasks(new Reader(activities: true), activities).ReadAsync(previews, default)).ShouldBeNull();
    }

    private sealed class Reader(bool activities) : ICurrentUser
    {
        public Guid? UserId => Employee;
        public bool IsAuthenticated => true;
        public string DisplayName => "Synthetic employee";
        public bool HasPermission(string permission) => permission != Permissions.ActivitiesRead || activities;
    }

    private sealed class Activities : IActivitiesApi
    {
        internal int Calls; internal IReadOnlyCollection<SourceTaskQuery>? Asked; internal IReadOnlyList<SourceTaskLookup> Found = []; internal Error? Failure;
        public Task<Result<IReadOnlyList<SourceTaskLookup>>> FindSourceTasksAsync(IReadOnlyCollection<SourceTaskQuery> queries, CancellationToken cancellationToken)
        {
            Calls++; Asked = queries;
            return Task.FromResult(Failure is { } failure ? Result<IReadOnlyList<SourceTaskLookup>>.Failure(failure) : Result<IReadOnlyList<SourceTaskLookup>>.Success(Found));
        }
        public Task<Result<SourceTaskRef>> CreateTaskOnceAsync(SourceTaskDraft draft, CancellationToken cancellationToken) => throw new NotSupportedException();
        public Task<Result<SourceTaskRef?>> FindSourceTaskAsync(SourceTaskIdentity source, Guid organizationId, CancellationToken cancellationToken) => throw new NotSupportedException();
        public Task<Result<SourceTaskDetails>> GetSourceTaskAsync(Guid activityId, CancellationToken cancellationToken) => throw new NotSupportedException();
    }
}
