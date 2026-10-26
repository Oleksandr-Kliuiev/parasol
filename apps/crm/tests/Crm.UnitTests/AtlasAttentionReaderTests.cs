using System.Text.Json;
using Crm.Integrations.Core.Parasol;
using static Crm.UnitTests.AtlasAttentionTestSupport;
using Directory = Crm.UnitTests.AtlasAttentionTestSupport.Directory;

namespace Crm.UnitTests;

public sealed class AtlasAttentionReaderTests
{
    [Theory]
    [InlineData(false, true)]
    [InlineData(true, false)]
    [InlineData(false, false)]
    public async Task Customer_and_Atlas_permissions_are_both_required_before_any_source_read(bool customers, bool atlas)
    {
        var directory = new Directory(0); var mappings = new Mappings([]); var workspaces = new Workspaces();
        (await Reader(directory, mappings, workspaces, user: new User(Employee, customers, atlas)).ReadAsync(default)).Error!.Code.ShouldBe("PARASOL_ATTENTION_FORBIDDEN");
        (await Reader(directory, mappings, workspaces, user: new User()).ReadAsync(default)).IsSuccess.ShouldBeFalse();
        directory.Calls.ShouldBe(0); mappings.Calls.ShouldBe(0); workspaces.Calls.ShouldBe(0);
    }

    [Fact]
    public async Task The_personal_intersection_is_capped_and_counts_are_global_for_successful_customers_with_only_three_preview_rows()
    {
        var directory = new Directory(55); var bindings = Enumerable.Range(0, 52).Select(Binding).ToArray();
        var mappings = new Mappings(bindings, unmapped: 2, issues: 1); var workspaces = new Workspaces();
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        workspaces.Reply = async (binding, ct) => { if (workspaces.Calls == 4) entered.TrySetResult(); await release.Task.WaitAsync(ct); return Workspace(binding); };
        var pending = Reader(directory, mappings, workspaces).ReadAsync(default);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5)); workspaces.Calls.ShouldBe(4); workspaces.Peak.ShouldBe(4);
        release.SetResult(); var view = (await pending).Value;
        view.Status.ShouldBe("PARTIAL"); workspaces.Calls.ShouldBe(50); workspaces.Peak.ShouldBeLessThanOrEqualTo(4);
        view.Coverage.ShouldBe(new(55, 52, 50, 50, 50, 0, 2, 2, 1, true, false));
        view.Totals.ShouldBe(new(750, 200, 50)); view.Customers!.Count.ShouldBe(50);
        foreach (var customer in view.Customers)
        {
            customer.Preview.Count.ShouldBe(3); customer.Preview[0].Severity.ShouldBe("CRITICAL");
            customer.Devices.Select(device => device.Id).Order().ShouldBe(["device-one", "device-two"]);
            customer.GeneratedAt.ShouldBe(Now); customer.RetrievedAt.ShouldNotBeNull();
        }
        JsonSerializer.Serialize(view).ShouldNotContain("unused-device"); mappings.PublicationCalls.ShouldBe(1);
    }

    [Fact]
    public async Task Failed_and_incomplete_customers_cannot_turn_into_zeroes_or_a_complete_all_clear()
    {
        var bindings = Enumerable.Range(0, 4).Select(Binding).ToArray(); var workspaces = new Workspaces();
        workspaces.Reply = (binding, _) => Task.FromResult(binding == bindings[0] ? new AtlasWorkspaceView(binding.CustomerId, "UNAVAILABLE")
            : binding == bindings[1] ? new(binding.CustomerId, "INVALID_RESPONSE")
            : Workspace(binding, high: binding == bindings[2] ? 4 : 0, critical: 0, completeness: binding == bindings[2] ? "PARTIAL" : "COMPLETE"));
        var view = (await Reader(new(4), new(bindings), workspaces).ReadAsync(default)).Value;
        view.Status.ShouldBe("PARTIAL"); view.Coverage!.ReadyCustomers.ShouldBe(2); view.Coverage.FailedCustomers.ShouldBe(2);
        view.Totals.ShouldBe(new(24, 4, 0));
        view.Customers![0].ActiveObservations.ShouldBeNull(); view.Customers[0].Resources.ShouldBeNull(); view.Customers[0].Preview.ShouldBeEmpty();
        view.Customers[3].High.ShouldBe(0); view.Customers[3].Preview.ShouldBeEmpty();
    }

    [Fact]
    public async Task Any_source_denial_clears_every_earlier_technical_result_and_its_totals()
    {
        var bindings = Enumerable.Range(0, 2).Select(Binding).ToArray(); var mappings = new Mappings(bindings); var workspaces = new Workspaces();
        workspaces.Reply = (binding, _) => Task.FromResult(binding == bindings[0] ? Workspace(binding) : new(binding.CustomerId, "ACCESS_DENIED"));
        var view = (await Reader(new(2), mappings, workspaces).ReadAsync(default)).Value;
        view.Status.ShouldBe("ACCESS_DENIED"); view.Customers.ShouldBeNull(); view.Totals.ShouldBeNull();
        view.Coverage!.ReadyCustomers.ShouldBe(1); view.Coverage.FailedCustomers.ShouldBe(1); mappings.PublicationCalls.ShouldBe(0);
        JsonSerializer.Serialize(view).ShouldNotContain("Synthetic technical");
    }

    [Fact]
    public async Task A_mapping_replaced_after_its_customer_read_is_removed_again_at_publication()
    {
        var bindings = Enumerable.Range(0, 2).Select(Binding).ToArray(); var mappings = new Mappings(bindings);
        mappings.Publish = (_, _) => Task.FromResult<IReadOnlyDictionary<Guid, string>>(new Dictionary<Guid, string> { [bindings[1].CustomerId] = "Renamed current CRM customer" });
        var view = (await Reader(new(2), mappings, new()).ReadAsync(default)).Value;
        view.Status.ShouldBe("PARTIAL"); view.Customers![0].Status.ShouldBe("IDENTITY_CHANGED");
        view.Customers[0].Preview.ShouldBeEmpty(); view.Customers[0].Devices.ShouldBeEmpty(); view.Customers[0].Resources.ShouldBeNull();
        view.Customers[1].CustomerName.ShouldBe("Renamed current CRM customer"); view.Totals.ShouldBe(new(15, 4, 1));
    }

    [Fact]
    public async Task A_confirmed_empty_personal_directory_is_complete_but_unmapped_visible_clients_are_partial()
    {
        var complete = (await Reader(new(0), new([]), new()).ReadAsync(default)).Value;
        complete.Status.ShouldBe("READY"); complete.Customers.ShouldBeEmpty(); complete.Totals.ShouldBe(new(0, 0, 0));
        var unmapped = (await Reader(new(2), new([], unmapped: 2), new()).ReadAsync(default)).Value;
        unmapped.Status.ShouldBe("PARTIAL"); unmapped.Coverage!.UnmappedClients.ShouldBe(2); unmapped.Customers.ShouldBeEmpty();
    }

    [Fact]
    public async Task Aggregate_counts_preserve_valid_source_Int32_counts_without_overflow()
    {
        var workspaces = new Workspaces();
        workspaces.Reply = (binding, _) =>
        {
            var view = Workspace(binding, high: 3, critical: 0);
            return Task.FromResult(view with { Summary = view.Summary! with { ActiveObservations = int.MaxValue,
                SeverityCounts = new Dictionary<string, int> { ["INFO"] = 0, ["LOW"] = 0, ["MEDIUM"] = 0, ["HIGH"] = int.MaxValue, ["CRITICAL"] = 0 } } });
        };
        var result = (await Reader(new(2), new(Enumerable.Range(0, 2).Select(Binding).ToArray()), workspaces).ReadAsync(default)).Value;
        result.Status.ShouldBe("READY"); result.Totals!.ActiveObservations.ShouldBe(2L * int.MaxValue); result.Totals.High.ShouldBe(2L * int.MaxValue);
    }
}
