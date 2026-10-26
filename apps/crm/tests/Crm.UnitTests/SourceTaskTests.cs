using Crm.Activities.Contracts;
using Crm.Activities.Domain;
using Crm.Activities.Features;
using Crm.Activities.Persistence;
using Crm.Authorization;
using Crm.Identity.Contracts;
using Crm.Infrastructure.Persistence;
using Crm.SharedKernel.Application;

namespace Crm.UnitTests;

public sealed class SourceTaskTests
{
    private static readonly SourceTaskIdentity Source = new("atera", "alert", "900029", "920029", "Task");

    /// <summary>A system the CRM no longer reads, as the retired technical workspace wrote its receipts (M12).</summary>
    private const string RetiredSystem = "retired-workspace";

    [Fact]
    public void Source_key_is_case_exact_unambiguous_and_independent_of_the_employee_customer_or_draft()
    {
        var key = SourceTaskIdentityRules.Key(Source);
        key.Length.ShouldBe(64); key.ShouldBe(SourceTaskIdentityRules.Key(Source with { }));
        foreach (var changed in new[] { Source with { SourceKind = "Alert" }, Source with { ExternalCustomerId = "900030" },
            Source with { ExternalId = "920030" }, Source with { TargetKind = "Ticket" }, Source with { System = "Atera" } })
            key.ShouldNotBe(SourceTaskIdentityRules.Key(changed));
        SourceTaskIdentityRules.Key(Source with { ExternalCustomerId = "9000", ExternalId = "29" })
            .ShouldNotBe(SourceTaskIdentityRules.Key(Source with { ExternalCustomerId = "900", ExternalId = "029" }));
        key.ShouldNotContain("900029");
    }

    [Fact]
    public void The_key_of_an_Atera_alert_is_the_SHA_256_of_its_identity_array_as_the_recovery_rehearsal_seeds_it()
    {
        // deploy/hostinger/tools/rehearsal_workload.py seeds this exact receipt; both sides must hash the same text.
        var key = SourceTaskIdentityRules.Key(SourceTaskIdentityRules.ForAlert("atera", "900029", "920029"));
        key.ShouldBe(Convert.ToHexStringLower(
            System.Security.Cryptography.SHA256.HashData("[\"SourceTaskV1\",\"atera\",\"alert\",\"900029\",\"920029\",\"Task\"]"u8)));
        key.ShouldBe("8f7340d260a6b240d65f9673b311315552400b89b6fa17821b1fc5c60aae6aa6", "the digest deploy/hostinger/tests/test_rehearsal_workload.py pins");
    }

    [Theory]
    [InlineData("retired")][InlineData("unknown")][InlineData("case")][InlineData("kind")][InlineData("target")][InlineData("empty")]
    [InlineData("whitespace")][InlineData("control")][InlineData("url")][InlineData("customer-limit")][InlineData("alert-limit")]
    public void Source_identity_rejects_unsupported_or_ambiguous_values(string scenario)
    {
        var source = scenario switch
        {
            // The retired technical workspace wrote receipts under its own name; they stay as history and do nothing.
            "retired" => new SourceTaskIdentity(RetiredSystem, "synthetic-workspace", "synthetic-client", "observation-one", "Task"),
            "unknown" => Source with { System = "cloudally" }, "case" => Source with { System = "Atera" },
            "kind" => Source with { SourceKind = "observation" }, "target" => Source with { TargetKind = "Ticket" },
            "empty" => Source with { ExternalId = "" }, "whitespace" => Source with { ExternalCustomerId = " " },
            "control" => Source with { ExternalCustomerId = "900\n" }, "url" => Source with { ExternalId = "https://example.invalid" },
            "customer-limit" => Source with { ExternalCustomerId = new string('1', 129) },
            _ => Source with { ExternalId = new string('2', 257) },
        };
        SourceTaskIdentityRules.IsValid(source).ShouldBeFalse();
        SourceTaskIdentityRules.IsValid(null).ShouldBeFalse();
    }

    [Fact]
    public void The_supported_systems_decide_which_receipts_are_live()
    {
        SourceTaskIdentityRules.IsValid(Source).ShouldBeTrue();
        SourceTaskIdentityRules.SupportedSystems.ShouldBe(["atera", "huntress", "parasoll"], ignoreOrder: true);
        SourceTaskIdentityRules.IsSupported("atera").ShouldBeTrue();
        // M41: an incident, escalation or platform action of Huntress becomes a task like an Atera alert.
        SourceTaskIdentityRules.IsValid(Source with { System = "huntress", ExternalId = "incident:7001" }).ShouldBeTrue();
        // M40: a coverage gap Parasoll found becomes a task like an alert of a source.
        SourceTaskIdentityRules.IsValid(Source with { System = "parasoll", ExternalId = "atera.agent-silent:0199f1a0400070008000000000004001" }).ShouldBeTrue();
        SourceTaskIdentityRules.IsSupported(RetiredSystem).ShouldBeFalse();
        SourceTaskIdentityRules.IsSupported(null).ShouldBeFalse();
        // A system joins by being listed, nothing else (M41 adds Huntress this way).
        var huntress = Source with { System = "huntress" };
        SourceTaskIdentityRules.IsValid(huntress, new HashSet<string>(["atera", "huntress"])).ShouldBeTrue();
        SourceTaskIdentityRules.IsValid(Source, new HashSet<string>(["huntress"])).ShouldBeFalse();
    }

    [Theory]
    [InlineData("Disk almost full", "Disk almost full")]
    [InlineData("  Disk   almost\tfull \n on SRV-01 ", "Disk almost full on SRV-01")]
    [InlineData("", "")]
    public void The_offered_subject_is_the_alert_title_on_one_line(string title, string expected) =>
        SourceTaskIdentityRules.SuggestedSubject(title).ShouldBe(expected);

    [Fact]
    public void A_long_title_is_offered_within_the_subject_column_cut_at_a_word()
    {
        var title = string.Join(' ', Enumerable.Repeat("partition", 40));
        var subject = SourceTaskIdentityRules.SuggestedSubject(title);
        subject.Length.ShouldBeLessThanOrEqualTo(SourceTaskIdentityRules.SubjectLength);
        subject.ShouldEndWith("partition");
        SourceTaskIdentityRules.SuggestedSubject(new string('x', 600)).Length.ShouldBe(SourceTaskIdentityRules.SubjectLength);
        SourceTaskIdentityRules.Subject(subject).ShouldBe(subject);
    }

    [Theory]
    [InlineData(null)][InlineData("")][InlineData("   ")][InlineData("Line one\nline two")]
    public void A_subject_must_be_one_line_of_text(string? subject) => SourceTaskIdentityRules.Subject(subject).ShouldBeNull();

    [Fact]
    public void A_subject_is_trimmed_and_limited_to_the_activity_subject_column()
    {
        SourceTaskIdentityRules.Subject("  Disk almost full  ").ShouldBe("Disk almost full");
        SourceTaskIdentityRules.Subject(new string('x', 256)).ShouldNotBeNull();
        SourceTaskIdentityRules.Subject(new string('x', 257)).ShouldBeNull();
    }

    [Fact]
    public void Receipts_are_insert_only_for_the_shared_runtime_role_in_the_permission_script()
    {
        var script = DatabasePermissions.Script(["activities"], [new ActivitiesDatabasePermissions()]);
        script.ShouldContain("DENY UPDATE, DELETE ON OBJECT::[activities].[SourceTaskLinks] TO [crm_runtime]");
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
        var draft = new SourceTaskDraft(Source, Guid.NewGuid(), Guid.NewGuid(), null, ActivityPriority.High, "Disk almost full");
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
            (await api.FindSourceTasksAsync([new(Guid.NewGuid(), [Source])], default)).Error!.Code.ShouldBe("ACT_SOURCE_TASK_FORBIDDEN");
        }
    }

    [Theory]
    [InlineData("customer")][InlineData("assignee")][InlineData("priority")][InlineData("date")][InlineData("source")][InlineData("retired")]
    [InlineData("subject")][InlineData("subject-length")]
    public async Task Invalid_drafts_fail_before_module_or_directory_queries(string scenario)
    {
        var api = new SourceTaskApi(null!, null!, null!, new User(Guid.NewGuid()), TimeProvider.System);
        var draft = new SourceTaskDraft(Source, Guid.NewGuid(), Guid.NewGuid(), null, ActivityPriority.Normal, "Disk almost full");
        draft = scenario switch
        {
            "customer" => draft with { OrganizationId = Guid.Empty }, "assignee" => draft with { AssigneeId = Guid.Empty },
            "priority" => draft with { Priority = ActivityPriority.Low }, "date" => draft with { DueAt = DateTimeOffset.Parse("1900-01-01T00:00:00Z") },
            "retired" => draft with { Source = Source with { System = RetiredSystem } }, "subject" => draft with { Subject = " " },
            "subject-length" => draft with { Subject = new string('x', 257) },
            _ => draft with { Source = Source with { TargetKind = "Other" } },
        };
        (await api.CreateTaskOnceAsync(draft, default)).Error!.Code.ShouldBe("ACT_SOURCE_TASK_INVALID");
    }

    [Fact]
    public async Task A_lookup_of_no_sources_or_of_too_many_is_refused_before_any_query()
    {
        var api = new SourceTaskApi(null!, null!, null!, new User(Guid.NewGuid()), TimeProvider.System);
        (await api.FindSourceTasksAsync([], default)).Error!.Code.ShouldBe("ACT_SOURCE_TASK_INVALID");
        var many = Enumerable.Range(0, SourceTaskLookupLimits.MaxSources + 1).Select(i => Source with { ExternalId = $"alert-{i}" }).ToList();
        (await api.FindSourceTasksAsync([new(Guid.NewGuid(), many)], default)).Error!.Code.ShouldBe("ACT_SOURCE_TASK_INVALID");
        (await api.FindSourceTasksAsync([new(Guid.Empty, [Source])], default)).Error!.Code.ShouldBe("ACT_SOURCE_TASK_INVALID");
        (await api.FindSourceTasksAsync([new(Guid.NewGuid(), [Source with { System = RetiredSystem }])], default)).Error!.Code.ShouldBe("ACT_SOURCE_TASK_INVALID");
    }

    internal sealed class User(Guid? id, bool service = true, bool read = true, bool write = true) : ICurrentUser
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
