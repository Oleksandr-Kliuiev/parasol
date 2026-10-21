using Crm.Activities.Contracts;
using Crm.Activities.Domain;
using Crm.Activities.Features;
using Crm.Authorization;
using Crm.Identity.Contracts;
using Crm.SharedKernel.Application;

namespace Crm.UnitTests;

public sealed class SourceTaskTests
{
    private static readonly SourceTaskIdentity Source = new("Atlas", "synthetic-workspace", "synthetic-client", "observation-one", "Task");

    [Fact]
    public void Source_key_is_case_exact_unambiguous_and_independent_of_the_employee_customer_or_draft()
    {
        var key = SourceTaskIdentityRules.Key(Source);
        key.Length.ShouldBe(64); key.ShouldBe(SourceTaskIdentityRules.Key(Source with { }));
        foreach (var changed in new[] { Source with { WorkspaceId = "Synthetic-workspace" }, Source with { ClientId = "Synthetic-client" },
            Source with { ObservationId = "Observation-one" }, Source with { TargetKind = "Ticket" }, Source with { System = "Other" } })
            key.ShouldNotBe(SourceTaskIdentityRules.Key(changed));
        SourceTaskIdentityRules.Key(Source with { WorkspaceId = "ab", ClientId = "c" })
            .ShouldNotBe(SourceTaskIdentityRules.Key(Source with { WorkspaceId = "a", ClientId = "bc" }));
        key.ShouldNotContain("synthetic");
    }

    [Theory]
    [InlineData("system")][InlineData("kind")][InlineData("empty")][InlineData("whitespace")][InlineData("control")]
    [InlineData("url")][InlineData("workspace-limit")][InlineData("client-limit")][InlineData("observation-limit")]
    public void Source_identity_rejects_unsupported_or_ambiguous_values(string scenario)
    {
        var source = scenario switch
        {
            "system" => Source with { System = "atera" }, "kind" => Source with { TargetKind = "Ticket" },
            "empty" => Source with { ObservationId = "" }, "whitespace" => Source with { ClientId = " " },
            "control" => Source with { WorkspaceId = "test\n" }, "url" => Source with { ObservationId = "https://example.invalid" },
            "workspace-limit" => Source with { WorkspaceId = new string('a', 129) },
            "client-limit" => Source with { ClientId = new string('a', 129) },
            _ => Source with { ObservationId = new string('a', 257) },
        };
        SourceTaskIdentityRules.IsValid(source).ShouldBeFalse();
        SourceTaskIdentityRules.IsValid(null).ShouldBeFalse();
    }

    [Theory]
    [InlineData(CrmRoles.Admin, true)][InlineData(CrmRoles.Management, true)][InlineData(CrmRoles.Technician, true)]
    [InlineData(CrmRoles.ServiceLead, true)][InlineData(CrmRoles.ReadOnly, false)][InlineData(CrmRoles.Finance, true)]
    [InlineData(CrmRoles.Sales, true)][InlineData("Unknown", false)]
    public void Assignees_must_be_active_employees_who_can_work_on_tasks_and_read_service_data(string role, bool allowed)
    {
        var profile = new UserProfile(Guid.NewGuid(), "Synthetic employee", null, null, true, [role]);
        SourceTaskApi.IsEligibleAssignee(profile).ShouldBe(allowed);
        SourceTaskApi.IsEligibleAssignee(profile with { IsActive = false }).ShouldBeFalse();
        SourceTaskApi.IsEligibleAssignee(profile with { Roles = null }).ShouldBeFalse();
    }

    [Theory]
    [InlineData(false, true, true)][InlineData(true, false, true)][InlineData(true, true, false)]
    public async Task All_permissions_are_required_before_a_source_task_can_be_created(bool service, bool read, bool write)
    {
        var api = new SourceTaskApi(null!, null!, null!, new User(Guid.NewGuid(), service, read, write), TimeProvider.System);
        var draft = new SourceTaskDraft(Source, Guid.NewGuid(), Guid.NewGuid(), null, ActivityPriority.High);
        (await api.CreateTaskOnceAsync(draft, default)).Error!.Code.ShouldBe("ACT_SOURCE_TASK_FORBIDDEN");
    }

    [Fact]
    public async Task Background_jobs_and_readers_without_both_permissions_cannot_read_source_references()
    {
        foreach (var user in new[] { new User(null), new User(Guid.NewGuid(), service: false), new User(Guid.NewGuid(), read: false) })
        {
            var api = new SourceTaskApi(null!, null!, null!, user, TimeProvider.System);
            (await api.FindSourceTaskAsync(Source, Guid.NewGuid(), default)).Error!.Code.ShouldBe("ACT_SOURCE_TASK_FORBIDDEN");
            (await api.GetSourceTaskAsync(Guid.NewGuid(), default)).Error!.Code.ShouldBe("ACT_SOURCE_TASK_FORBIDDEN");
        }
    }

    [Theory]
    [InlineData("customer")][InlineData("assignee")][InlineData("priority")][InlineData("date")][InlineData("source")]
    public async Task Invalid_drafts_fail_before_module_or_directory_queries(string scenario)
    {
        var api = new SourceTaskApi(null!, null!, null!, new User(Guid.NewGuid()), TimeProvider.System);
        var draft = new SourceTaskDraft(Source, Guid.NewGuid(), Guid.NewGuid(), null, ActivityPriority.Normal);
        draft = scenario switch
        {
            "customer" => draft with { OrganizationId = Guid.Empty }, "assignee" => draft with { AssigneeId = Guid.Empty },
            "priority" => draft with { Priority = ActivityPriority.Low }, "date" => draft with { DueAt = DateTimeOffset.Parse("1900-01-01T00:00:00Z") },
            _ => draft with { Source = Source with { TargetKind = "Other" } },
        };
        (await api.CreateTaskOnceAsync(draft, default)).Error!.Code.ShouldBe("ACT_SOURCE_TASK_INVALID");
    }

    private sealed class User(Guid? id, bool service = true, bool read = true, bool write = true) : ICurrentUser
    {
        public Guid? UserId => id;
        public string DisplayName => "Synthetic employee";
        public bool IsAuthenticated => id is not null;
        public bool HasPermission(string permission) => permission switch
        {
            Permissions.ServiceRead => service, Permissions.ActivitiesRead => read, Permissions.ActivitiesWrite => write, _ => false,
        };
    }
}
