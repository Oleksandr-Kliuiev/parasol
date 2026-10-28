using Crm.Integrations.Core.Actions;
using Microsoft.AspNetCore.DataProtection;

namespace Crm.UnitTests;

/// <summary>
/// M45: the rules of a batch of vendor actions — which kinds take one, what its token fixes about the targets, and the command key
/// each target gets from the confirmation's key.
/// </summary>
public class VendorActionBatchRulesTests
{
    private sealed class Handler(VendorActionLevel level) : IVendorActionHandler
    {
        public string System => "atera";
        public string Kind => "alert.resolve";
        public string TargetType => "alert";
        public VendorActionLevel Level => level;
        public string Permission => "service.write";
        public string ReadPermission => "service.read";
        public bool IsRepeatable => true;

        public Task<VendorActionPlan> PlanAsync(VendorActionRequest request, CancellationToken cancellationToken) => Task.FromResult(VendorActionPlan.NotFound);

        public Task<VendorActionResult> ExecuteAsync(VendorActionContext context, CancellationToken cancellationToken) =>
            Task.FromResult(VendorActionResult.Skipped("VND_ALREADY_DONE", "Already so."));
    }

    private sealed class Planner(VendorActionLevel level) : IVendorActionHandler, IVendorActionBatchPlanner
    {
        private readonly Handler one = new(level);

        public string System => one.System;
        public string Kind => one.Kind;
        public string TargetType => one.TargetType;
        public VendorActionLevel Level => one.Level;
        public string Permission => one.Permission;
        public string ReadPermission => one.ReadPermission;
        public bool IsRepeatable => one.IsRepeatable;

        public Task<VendorActionPlan> PlanAsync(VendorActionRequest request, CancellationToken cancellationToken) => one.PlanAsync(request, cancellationToken);

        public Task<VendorActionResult> ExecuteAsync(VendorActionContext context, CancellationToken cancellationToken) => one.ExecuteAsync(context, cancellationToken);

        public Task<IReadOnlyDictionary<string, VendorActionPlan>> PlanManyAsync(VendorActionBatchRequest request, CancellationToken cancellationToken) =>
            Task.FromResult<IReadOnlyDictionary<string, VendorActionPlan>>(new Dictionary<string, VendorActionPlan>());
    }

    [Theory]
    [InlineData(VendorActionLevel.Standard, true)]
    [InlineData(VendorActionLevel.Disruptive, true)]
    [InlineData(VendorActionLevel.Destructive, false)]
    public void Only_a_kind_that_plans_a_batch_and_destroys_nothing_takes_one(VendorActionLevel level, bool supported)
    {
        VendorActionBatches.Supports(new Planner(level)).ShouldBe(supported);
        VendorActionBatches.Supports(new Handler(level)).ShouldBeFalse("a kind without a batch planner is asked one target at a time");
    }

    [Fact]
    public void The_token_fixes_the_set_of_targets_not_their_order_or_repeats()
    {
        var set = VendorActionBatches.Targets(["920029", "920030", "920031"]);
        VendorActionBatches.Targets(["920031", "920029", "920030", "920029"]).ShouldBe(set);
        VendorActionBatches.Targets(["920029", "920030"]).ShouldNotBe(set);
        VendorActionBatches.Targets(["920029", "920030", "920032"]).ShouldNotBe(set);
        // Ids are compared as they are written: a target is never another one that differs only in case.
        VendorActionBatches.Targets(["a"]).ShouldNotBe(VendorActionBatches.Targets(["A"]));
        VendorActionBatches.Distinct(["b", "a", "b", "c", "a"]).ShouldBe(["b", "a", "c"], "each target once, in the order asked");
    }

    [Fact]
    public void A_target_gets_the_same_command_key_for_the_same_confirmation_and_another_for_any_other()
    {
        var key = Guid.NewGuid();
        var set = VendorActionBatches.Targets(["920029", "920030"]);
        var first = VendorActionBatches.CommandKey(key, set, "atera", "alert.resolve", "alert", "920029");

        VendorActionBatches.CommandKey(key, set, "atera", "alert.resolve", "alert", "920029").ShouldBe(first, "a repeat finds what it saved");
        VendorActionBatches.CommandKey(key, set, "atera", "alert.resolve", "alert", "920030").ShouldNotBe(first);
        VendorActionBatches.CommandKey(Guid.NewGuid(), set, "atera", "alert.resolve", "alert", "920029").ShouldNotBe(first);
        VendorActionBatches.CommandKey(key, VendorActionBatches.Targets(["920029"]), "atera", "alert.resolve", "alert", "920029")
            .ShouldNotBe(first, "the same key with other targets is another confirmation");
        VendorActionBatches.CommandKey(key, set, "atera", "alert.delete", "alert", "920029").ShouldNotBe(first);
    }

    [Fact]
    public void A_batch_token_reads_back_only_with_its_own_purpose()
    {
        var protection = new EphemeralDataProtectionProvider();
        var claim = new VendorActionBatchClaim(Guid.NewGuid(), "atera", "alert.resolve", "alert", VendorActionLevel.Standard,
            VendorActionBatches.Hash("{}"), VendorActionBatches.Targets(["920029"]), DateTimeOffset.UtcNow.AddMinutes(10));
        var token = VendorActionBatchToken.Issue(protection, claim);

        VendorActionBatchToken.Read(protection, token).ShouldBe(claim);
        VendorActionBatchToken.Read(protection, token[..^4] + "AAAA").ShouldBeNull("a changed token is no token");
        VendorActionBatchToken.Read(protection, null).ShouldBeNull();
        // A preview token of one action is not a batch's, and the other way round: each purpose reads its own.
        VendorActionPreviewToken.Read(protection, token).ShouldBeNull();
        VendorActionBatchToken.Read(protection, VendorActionPreviewToken.Issue(protection,
            new VendorActionPreviewClaim(claim.UserId, "fingerprint", VendorActionLevel.Standard, claim.ExpiresAt))).ShouldBeNull();
    }
}
