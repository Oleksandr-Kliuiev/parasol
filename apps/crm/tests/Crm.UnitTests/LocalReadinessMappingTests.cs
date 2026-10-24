using Crm.Integrations.Core.Parasol;
using static Crm.UnitTests.LocalReadinessTestSupport;

namespace Crm.UnitTests;

public sealed class LocalReadinessMappingTests
{
    [Theory]
    [InlineData("missing", 0, 1, 0, 0, 0)]
    [InlineData("gone", 0, 0, 1, 0, 0)]
    [InlineData("uppercase", 1, 0, 0, 0, 0)]
    [InlineData("duplicate-outside-cap", 1, 0, 0, 0, 0)]
    [InlineData("customer-duplicate-outside-cap", 1, 0, 0, 0, 0)]
    [InlineData("wrong-entity", 1, 0, 0, 0, 0)]
    [InlineData("foreign-tuple", 0, 0, 0, 1, 0)]
    [InlineData("uppercase-reference", 0, 0, 0, 1, 0)]
    [InlineData("duplicate-json", 0, 0, 0, 1, 0)]
    [InlineData("extra-json", 0, 0, 0, 1, 0)]
    [InlineData("oversized", 0, 0, 0, 1, 0)]
    [InlineData("invalid-id", 0, 0, 0, 1, 0)]
    [InlineData("deleted", 0, 0, 0, 0, 1)]
    public async Task Local_issues_are_exclusive_and_never_adopt_a_casefold_or_sample_only_duplicate_winner(string issue, int identities, int missing, int gone, int invalid, int unavailable)
    {
        var snapshot = Snapshot(); var link = snapshot.Links[0]; var reference = snapshot.References[0];
        snapshot = issue switch
        {
            "missing" => snapshot with { References = [] },
            "gone" => snapshot with { References = [reference with { IsGone = true }] },
            "uppercase" => snapshot with { Links = [link with { ExternalId = link.ExternalId.ToUpperInvariant() }] },
            "duplicate-outside-cap" => snapshot with { Links = [link with { IdentityMatches = 2 }] },
            "customer-duplicate-outside-cap" => snapshot with { Links = [link with { CustomerMatches = 2 }] },
            "wrong-entity" => snapshot with { Links = [link with { EntityType = "Contact" }] },
            "foreign-tuple" => snapshot with { References = [reference with { Payload = "{\"workspaceId\":\"foreign\",\"clientId\":\"client-0\"}" }] },
            "uppercase-reference" => snapshot with { References = [reference with { ExternalId = reference.ExternalId.ToUpperInvariant() }] },
            "duplicate-json" => snapshot with { References = [reference with { Payload = "{\"workspaceId\":\"synthetic-workspace\",\"workspaceId\":\"synthetic-workspace\",\"clientId\":\"client-0\"}" }] },
            "extra-json" => snapshot with { References = [reference with { Payload = reference.Payload.TrimEnd('}') + ",\"private\":\"value\"}" }] },
            "oversized" => snapshot with { References = [reference with { PayloadBytes = 8194 }] },
            "invalid-id" => snapshot with { References = [reference with { Payload = "{\"workspaceId\":\"bad space\",\"clientId\":\"client-0\"}" }] },
            "deleted" => snapshot with { LiveCustomerIds = [] },
            _ => throw new ArgumentException("Unknown synthetic issue."),
        };
        var view = await new LocalReadinessMappings(new Source(snapshot), TimeProvider.System).ReadAsync(default);
        view.Status.ShouldBe("CHECKED"); view.ReviewStatus.ShouldBe("REQUIRED");
        view.Counts.ShouldBe(new(0, identities, missing, gone, invalid, unavailable));
    }

    [Fact]
    public async Task Cap_and_unlinked_local_references_require_review_without_claiming_complete_source_coverage()
    {
        var snapshot = Snapshot(500, 1) with { UnlinkedStoredReferences = 3 };
        var source = new Source(snapshot); var view = await new LocalReadinessMappings(source, TimeProvider.System).ReadAsync(default);
        view.Status.ShouldBe("INCOMPLETE"); view.ReviewStatus.ShouldBe("REQUIRED"); view.Coverage.ShouldBe(new(501, 500, 1, 3));
        view.Counts.ShouldBe(new(500, 0, 0, 0, 0, 0)); source.Calls.ShouldBe(2);
    }

    [Theory]
    [InlineData("link")]
    [InlineData("reference")]
    [InlineData("customer")]
    [InlineData("total")]
    [InlineData("unlinked")]
    public async Task Publication_changes_discard_all_counts(string changed)
    {
        var snapshot = Snapshot(); var current = changed switch
        {
            "link" => snapshot with { Links = [snapshot.Links[0] with { Id = Guid.NewGuid() }] },
            "reference" => snapshot with { References = [snapshot.References[0] with { IsGone = true }] },
            "customer" => snapshot with { LiveCustomerIds = [] },
            "total" => snapshot with { StoredLinks = 2 },
            "unlinked" => snapshot with { UnlinkedStoredReferences = 1 },
            _ => throw new ArgumentException("Unknown synthetic change."),
        };
        var source = new Source(snapshot) { Reply = (call, _) => Task.FromResult(call == 1 ? snapshot : current) };
        var view = await new LocalReadinessMappings(source, TimeProvider.System).ReadAsync(default);
        view.Status.ShouldBe("CHANGED"); view.ReviewStatus.ShouldBe("UNKNOWN"); view.Counts.ShouldBeNull(); view.Coverage.ShouldBeNull();
    }

    [Fact]
    public async Task Mapping_budget_is_three_seconds_and_caller_abort_is_preserved()
    {
        var clock = new AtlasAttentionClock(); var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var source = new Source(Snapshot()) { Reply = async (_, ct) => { entered.TrySetResult(); await Task.Delay(Timeout.InfiniteTimeSpan, ct); throw new InvalidOperationException(); } };
        var pending = new LocalReadinessMappings(source, clock).ReadAsync(default); await entered.Task;
        clock.Advance(TimeSpan.FromSeconds(3)); (await pending).Status.ShouldBe("UNAVAILABLE");
        using var canceled = new CancellationTokenSource(); canceled.Cancel();
        await Should.ThrowAsync<OperationCanceledException>(() => new LocalReadinessMappings(source, clock).ReadAsync(canceled.Token));
    }

    [Theory]
    [InlineData("{\"workspaceId\":\"w\",\"clientId\":\"c\"}", true)]
    [InlineData("{\"clientId\":\"c\",\"workspaceId\":\"w\"}", true)]
    [InlineData("{\"workspaceId\":\"w\",\"clientId\":\"c\",\"extra\":0}", false)]
    [InlineData("{\"workspaceId\":\"w\",\"workspaceId\":\"w\"}", false)]
    [InlineData("[]", false)]
    public void Shared_reference_syntax_preserves_M14_exact_two_field_semantics(string payload, bool expected) =>
        CustomerIdentityReferenceValidation.TryRead(payload, out _).ShouldBe(expected);
}
