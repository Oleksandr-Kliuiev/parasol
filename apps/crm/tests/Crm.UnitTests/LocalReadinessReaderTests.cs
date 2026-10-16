using System.Text.Json;
using Crm.Authorization;
using Crm.Integrations.Core.Parasol;
using static Crm.UnitTests.LocalReadinessTestSupport;

namespace Crm.UnitTests;

public sealed class LocalReadinessReaderTests
{
    [Theory]
    [InlineData(false, false, false)]
    [InlineData(true, false, false)]
    [InlineData(false, true, true)]
    [InlineData(true, true, false)]
    public async Task Sections_are_permission_fenced_before_their_queries(bool atlas, bool admin, bool customers)
    {
        var permissions = new List<string>();
        if (atlas) permissions.Add(Permissions.ParasolAtlasRead);
        if (admin) permissions.Add(Permissions.IntegrationsManage);
        if (customers) permissions.Add(Permissions.CustomersRead);
        var stored = new Stored(); var mappings = new Mappings(); var flags = new Flags();
        var result = await Reader(new User(Employee, permissions.ToArray()), stored, mappings, flags).ReadAsync(default);
        result.IsSuccess.ShouldBe(atlas || admin);
        if (result.IsSuccess)
        {
            (result.Value.PersonalAtlas is not null).ShouldBe(atlas); (result.Value.Admin is not null).ShouldBe(admin);
            (result.Value.Admin?.AtlasMappings is not null).ShouldBe(admin && customers);
        }
        stored.Calls.ShouldBe(admin ? 1 : 0); flags.Calls.ShouldBe(admin ? 1 : 0); mappings.Calls.ShouldBe(admin && customers ? 1 : 0);
    }

    [Theory]
    [InlineData(false, false, "DISABLED")]
    [InlineData(true, false, "PERSONAL_ENTRY_MISSING")]
    [InlineData(true, true, "PERSONAL_ENTRY_PRESENT")]
    public async Task Presence_is_only_the_current_immutable_employee_entry_and_never_a_credential_or_access_test(bool enabled, bool own, string expected)
    {
        var options = new AtlasWorkspaceOptions { Enabled = enabled, BaseUrl = "https://synthetic-private.invalid/" };
        options.Employees[Guid.NewGuid().ToString("D")] = new() { WorkspaceId = "private-other-workspace", Token = "private-other-token" };
        if (own) options.Employees[Employee.ToString("D")] = new() { WorkspaceId = "private-own-workspace", Token = "private-own-token" };
        var view = (await Reader(new(Employee, Permissions.ParasolAtlasRead), atlas: options).ReadAsync(default)).Value;
        view.PersonalAtlas!.Status.ShouldBe(expected); view.Connectivity.ShouldBe("NOT_CHECKED"); view.Admin.ShouldBeNull();
        JsonSerializer.Serialize(view).ShouldNotContain("private-");
        (await Reader(new User(null, Permissions.ParasolAtlasRead), atlas: options).ReadAsync(default)).IsSuccess.ShouldBeFalse();
    }

    [Fact]
    public async Task Flags_are_independent_from_historical_SQL_success_and_no_graph_or_Huntress_health_is_invented()
    {
        var view = (await Reader(new(Employee, Permissions.IntegrationsManage, Permissions.CustomersRead)).ReadAsync(default)).Value;
        view.Status.ShouldBe("LOCAL_SNAPSHOT"); view.Admin!.Atera.Enabled.ShouldBeFalse(); view.Admin.Atera.WriteEnabled.ShouldBeTrue();
        view.Admin.PowerOffice.Stored!.LastSucceededAt.ShouldBe(AtlasAttentionTestSupport.Now);
        view.Admin.MicrosoftGraph.Enabled.ShouldBeFalse(); view.Admin.MicrosoftGraph.TeamsEnabled.ShouldBeTrue();
        view.Admin.Huntress.ShouldBe(new("ATLAS", "UNKNOWN", "NOT_CHECKED")); view.Admin.AuthMode.ShouldBe("DEVELOPMENT");
    }

    [Fact]
    public async Task Whole_operation_deadline_returns_unknown_stored_state_and_never_zeroes_or_old_evidence()
    {
        var clock = new AtlasAttentionClock(); var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var stored = new Stored { Reply = async ct => { entered.SetResult(); await Task.Delay(Timeout.InfiniteTimeSpan, ct); throw new InvalidOperationException(); } };
        var mappings = new Mappings { Reply = ct => { ct.ThrowIfCancellationRequested(); throw new InvalidOperationException(); } };
        var pending = Reader(new(Employee, Permissions.IntegrationsManage, Permissions.CustomersRead), stored, mappings, time: clock).ReadAsync(default);
        await entered.Task; clock.Advance(TimeSpan.FromSeconds(5)); var view = (await pending).Value;
        view.Status.ShouldBe("PARTIAL"); view.Admin!.Atera.Stored.ShouldBeNull(); view.Admin.PowerOffice.Stored.ShouldBeNull();
        view.Admin.MicrosoftGraph.Stored.ShouldBeNull(); view.Admin.AtlasMappings!.Status.ShouldBe("UNAVAILABLE"); view.Admin.AtlasMappings.Counts.ShouldBeNull();
    }

    [Fact]
    public async Task Caller_cancellation_is_preserved()
    {
        using var canceled = new CancellationTokenSource(); canceled.Cancel();
        await Should.ThrowAsync<OperationCanceledException>(() => Reader(new(Employee, Permissions.ParasolAtlasRead)).ReadAsync(canceled.Token));
    }
}
