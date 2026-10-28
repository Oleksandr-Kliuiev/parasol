using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crm.Authorization;
using Crm.Integrations.Core.Actions;
using Crm.Integrations.Core.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crm.IntegrationTests;

/// <summary>
/// M45 on SQL Server: one preview and one confirmation for many targets of one kind, on the M39.1 path. The preview plans every target
/// from saved data and signs the ready set; the command saves one action per target (with its outbound operation, in one transaction)
/// under one batch; a repeat of the confirmation asks nothing new; a target with the same action still waiting is not asked twice;
/// destructive kinds and kinds without a batch planner are never asked in bulk; and the batch is read with what happened to each.
/// </summary>
public sealed class VendorActionBatchTests(CrmWebFactory factory)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task A_batch_is_previewed_from_saved_data_and_asks_one_action_per_ready_target()
    {
        await using var host = VendorActionHost.Start(factory, batches: true);
        var admin = host.Client();
        var (done, already, waiting) = (VendorActionCalls.Target(), VendorActionCalls.Target(), VendorActionCalls.Target());
        var missing = $"missing-{Guid.NewGuid():N}"[..20];
        var blocked = $"blocked-{Guid.NewGuid():N}"[..20];
        var earlier = await admin.AskAsync("thing.tag", waiting);

        var preview = await PreviewAsync(admin, "thing.tag", [done, already, missing, blocked, waiting, done]);
        preview.GetProperty("ready").GetInt32().ShouldBe(2);
        preview.GetProperty("previewToken").GetString().ShouldNotBeNullOrEmpty();
        preview.GetProperty("block").ValueKind.ShouldBe(JsonValueKind.Null);
        Blocks(preview).ShouldBe([(done, null), (already, null), (missing, "VND_TARGET_NOT_FOUND"), (blocked, "VND_TEST_BLOCKED"), (waiting, "VND_ALREADY_WAITING")],
            "each target once, in the order asked");
        var targets = preview.GetProperty("targets").EnumerateArray().ToList();
        targets[0].GetProperty("target").GetProperty("name").GetString().ShouldBe($"Thing {done}");
        targets[4].GetProperty("waitingActionId").GetGuid().ShouldBe(earlier);
        targets[2].GetProperty("target").ValueKind.ShouldBe(JsonValueKind.Null);

        var answer = await CommandAsync(admin, preview, "thing.tag", [done, already], Guid.NewGuid());
        answer.StatusCode.ShouldBe(HttpStatusCode.Accepted, await answer.Content.ReadAsStringAsync(Ct));
        var result = await answer.ReadJsonAsync();
        result.GetProperty("asked").GetInt32().ShouldBe(2);
        result.GetProperty("repeated").GetBoolean().ShouldBeFalse();
        var batchId = result.GetProperty("batchId").GetGuid();
        var items = result.GetProperty("items").EnumerateArray().ToList();
        items.Select(i => (i.GetProperty("targetId").GetString(), i.GetProperty("status").GetString())).ShouldBe([(done, "Queued"), (already, "Queued")]);
        var ids = items.Select(i => i.GetProperty("actionId").GetGuid()).ToList();

        // One action per target under the batch, each with its own outbound operation, as one asked alone.
        foreach (var id in ids)
        {
            var action = await host.ActionAsync(id);
            (action.BatchId, action.Kind, action.Status).ShouldBe((batchId, "thing.tag", VendorActionStatus.Queued));
            (await host.OperationAsync(id)).Operation.ShouldBe("action:thing.tag");
        }

        var queued = await BatchAsync(admin, batchId, items: true);
        (queued.GetProperty("total").GetInt32(), queued.GetProperty("waiting").GetInt32()).ShouldBe((2, 2));
        queued.GetProperty("items").EnumerateArray().Select(i => i.GetProperty("targetName").GetString()).ShouldBe([$"Thing {done}", $"Thing {already}"]);

        // The worker sends them one by one; the batch says what happened to each.
        host.Vendor.Answer(already, TestVendorAnswer.AlreadyDone);
        foreach (var id in ids)
        {
            (await host.RunAsync(id)).ShouldBeTrue();
        }

        var finished = await BatchAsync(admin, batchId, items: true);
        (finished.GetProperty("waiting").GetInt32(), finished.GetProperty("succeeded").GetInt32(), finished.GetProperty("skipped").GetInt32())
            .ShouldBe((0, 1, 1));
        finished.GetProperty("items").EnumerateArray().Select(i => (i.GetProperty("status").GetString(), i.GetProperty("outcomeCode").GetString()))
            .ShouldBe([("Succeeded", "VND_SENT"), ("Skipped", "VND_ALREADY_DONE")]);
        (await BatchAsync(admin, batchId, items: false)).GetProperty("items").GetArrayLength().ShouldBe(0, "the counts alone while it is followed");

        // Each action is in the log on /connections, naming its batch.
        var log = await (await admin.GetAsync($"/api/v1/actions?system={TestVendor.Name}&targetType=thing&targetId={done}", Ct)).ReadJsonAsync();
        log.GetProperty("items")[0].GetProperty("batchId").GetGuid().ShouldBe(batchId);
        (await admin.GetAsync($"/api/v1/actions/batches/{Guid.NewGuid()}", Ct)).StatusCode.ShouldBe(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task A_repeat_of_the_confirmation_answers_with_its_actions_and_asks_nothing_new()
    {
        await using var host = VendorActionHost.Start(factory, batches: true);
        var admin = host.Client();
        var (first, second) = (VendorActionCalls.Target(), VendorActionCalls.Target());
        var preview = await PreviewAsync(admin, "thing.tag", [first, second]);
        var key = Guid.NewGuid();

        var saved = await (await CommandAsync(admin, preview, "thing.tag", [first, second], key)).ReadJsonAsync();
        var repeat = await CommandAsync(admin, preview, "thing.tag", [second, first], key);
        repeat.StatusCode.ShouldBe(HttpStatusCode.OK, "the answer was lost, not the batch");
        var again = await repeat.ReadJsonAsync();
        again.GetProperty("repeated").GetBoolean().ShouldBeTrue();
        (again.GetProperty("asked").GetInt32(), again.GetProperty("batchId").GetGuid()).ShouldBe((0, saved.GetProperty("batchId").GetGuid()));
        ActionIds(again).ShouldBe(ActionIds(saved), ignoreOrder: true);
        (await CountAsync(host, first, second)).ShouldBe(2, "a repeat never asks a second time");

        // The same key with other targets is another confirmation: it asks for them, and never again for a target whose action waits.
        var other = VendorActionCalls.Target();
        var next = await PreviewAsync(admin, "thing.tag", [first, other]);
        Blocks(next).ShouldBe([(first, "VND_ALREADY_WAITING"), (other, null)]);
        var asked = await CommandAsync(admin, next, "thing.tag", [other], key);
        asked.StatusCode.ShouldBe(HttpStatusCode.Accepted, await asked.Content.ReadAsStringAsync(Ct));
        var nextBatch = await asked.ReadJsonAsync();
        nextBatch.GetProperty("batchId").GetGuid().ShouldNotBe(saved.GetProperty("batchId").GetGuid());
        (await CountAsync(host, first, second, other)).ShouldBe(3);
    }

    [Fact]
    public async Task Confirmations_at_the_same_moment_ask_a_shared_target_once_and_a_doubled_one_saves_once()
    {
        await using var host = VendorActionHost.Start(factory, batches: true);
        var admin = host.Client();
        var colleague = host.Client(user: "colleague");
        var (shared, mine, theirs) = (VendorActionCalls.Target(), VendorActionCalls.Target(), VendorActionCalls.Target());
        var myPreview = await PreviewAsync(admin, "thing.tag", [shared, mine]);
        var theirPreview = await PreviewAsync(colleague, "thing.tag", [shared, theirs]);

        // Two people confirm overlapping batches at once: the later one plans after the earlier one saved and finds its action waiting.
        var answers = await Task.WhenAll(
            CommandAsync(admin, myPreview, "thing.tag", [shared, mine], Guid.NewGuid()),
            CommandAsync(colleague, theirPreview, "thing.tag", [shared, theirs], Guid.NewGuid()));
        var results = new List<JsonElement>();
        foreach (var answer in answers)
        {
            answer.StatusCode.ShouldBe(HttpStatusCode.Accepted, await answer.Content.ReadAsStringAsync(Ct));
            results.Add(await answer.ReadJsonAsync());
        }

        results.Sum(r => r.GetProperty("asked").GetInt32()).ShouldBe(3);
        results.SelectMany(r => r.GetProperty("items").EnumerateArray()).Count(i => i.GetProperty("code").GetString() == "VND_ALREADY_WAITING").ShouldBe(1);
        (await CountAsync(host, shared)).ShouldBe(1, "the shared target is asked once");

        // One confirmation sent twice at once (a retry while the first is being saved) saves once, and both answers name its batch.
        var (first, second) = (VendorActionCalls.Target(), VendorActionCalls.Target());
        var preview = await PreviewAsync(admin, "thing.tag", [first, second]);
        var key = Guid.NewGuid();
        var doubled = await Task.WhenAll(
            CommandAsync(admin, preview, "thing.tag", [first, second], key),
            CommandAsync(admin, preview, "thing.tag", [first, second], key));
        var both = new List<JsonElement>();
        foreach (var answer in doubled)
        {
            answer.IsSuccessStatusCode.ShouldBeTrue(await answer.Content.ReadAsStringAsync(Ct));
            both.Add(await answer.ReadJsonAsync());
        }

        both.Select(r => r.GetProperty("batchId").GetGuid()).Distinct().Count().ShouldBe(1);
        both.Count(r => r.GetProperty("repeated").GetBoolean()).ShouldBe(1);
        (await CountAsync(host, first, second)).ShouldBe(2);
    }

    [Fact]
    public async Task The_command_takes_only_the_targets_its_fresh_preview_showed_and_skips_one_asked_meanwhile()
    {
        await using var host = VendorActionHost.Start(factory, batches: true);
        var admin = host.Client();
        var (first, second) = (VendorActionCalls.Target(), VendorActionCalls.Target());
        var preview = await PreviewAsync(admin, "thing.tag", [first, second]);

        await RefusedAsync(CommandAsync(admin, preview, "thing.tag", [first, second, VendorActionCalls.Target()], Guid.NewGuid()), HttpStatusCode.Conflict,
            "VND_PREVIEW_STALE");
        await RefusedAsync(CommandAsync(admin, preview, "thing.tag", [first], Guid.NewGuid()), HttpStatusCode.Conflict, "VND_PREVIEW_STALE");
        await RefusedAsync(CommandAsync(host.Client(user: "someone-else"), preview, "thing.tag", [first, second], Guid.NewGuid()), HttpStatusCode.Conflict,
            "VND_PREVIEW_EXPIRED");
        await RefusedAsync(admin.PostAsJsonAsync("/api/v1/actions/batch", Body("thing.tag", [first, second], "not a token", Guid.NewGuid()), Ct),
            HttpStatusCode.Conflict, "VND_PREVIEW_EXPIRED");
        await RefusedAsync(CommandAsync(admin, preview, "thing.hold", [first, second], Guid.NewGuid()), HttpStatusCode.Conflict, "VND_PREVIEW_EXPIRED");
        (await CountAsync(host, first, second)).ShouldBe(0, "nothing refused asked anything");

        // Someone asks the same for one target between the preview and the confirmation: it is not asked twice.
        var meanwhile = await admin.AskAsync("thing.tag", second);
        var result = await (await CommandAsync(admin, preview, "thing.tag", [first, second], Guid.NewGuid())).ReadJsonAsync();
        result.GetProperty("asked").GetInt32().ShouldBe(1);
        var items = result.GetProperty("items").EnumerateArray().ToList();
        items[1].GetProperty("code").GetString().ShouldBe("VND_ALREADY_WAITING");
        items[1].GetProperty("actionId").GetGuid().ShouldBe(meanwhile);
        (await CountAsync(host, first, second)).ShouldBe(2);
    }

    [Fact]
    public async Task Destructive_kinds_and_kinds_without_a_batch_planner_are_asked_one_target_at_a_time()
    {
        await using var host = VendorActionHost.Start(factory, batches: true);
        var admin = host.Client();
        foreach (var kind in (string[])["thing.delete", "thing.set"])
        {
            var response = await admin.PostAsJsonAsync("/api/v1/actions/batch/preview", PreviewBody(kind, [VendorActionCalls.Target()]), Ct);
            response.StatusCode.ShouldBe(HttpStatusCode.BadRequest, kind);
            (await response.Content.ReadAsStringAsync(Ct)).ShouldContain("VND_BATCH_UNSUPPORTED");
        }

        var kinds = (await (await admin.GetAsync($"/api/v1/actions/kinds?system={TestVendor.Name}", Ct)).ReadJsonAsync()).EnumerateArray()
            .ToDictionary(k => k.GetProperty("kind").GetString()!, k => k.GetProperty("batch").GetBoolean());
        kinds.ShouldBe(new Dictionary<string, bool>
        {
            ["thing.delete"] = false, ["thing.hold"] = true, ["thing.pause"] = false, ["thing.set"] = false, ["thing.tag"] = true,
        });

        (await admin.PostAsJsonAsync("/api/v1/actions/batch/preview", PreviewBody("thing.tag", []), Ct)).StatusCode.ShouldBe(HttpStatusCode.BadRequest);
        (await admin.PostAsJsonAsync("/api/v1/actions/batch/preview",
            PreviewBody("thing.tag", [.. Enumerable.Range(0, VendorActionBatches.MaxTargets + 1).Select(i => $"t-{i}")]), Ct)).StatusCode.ShouldBe(HttpStatusCode.BadRequest);
        (await host.Client(CrmRoles.ReadOnly).PostAsJsonAsync("/api/v1/actions/batch/preview", PreviewBody("thing.tag", [VendorActionCalls.Target()]), Ct))
            .StatusCode.ShouldBe(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task The_switches_of_the_vendor_hold_for_a_batch_as_for_one_action()
    {
        await using var host = VendorActionHost.Start(factory, batches: true);
        var admin = host.Client();
        var allowed = host.Vendor.Switches;
        var (first, second) = (VendorActionCalls.Target(), VendorActionCalls.Target());
        var preview = await PreviewAsync(admin, "thing.tag", [first, second]);

        host.Vendor.Switches = allowed with { EnabledActions = ["thing.set"] };
        var off = await PreviewAsync(admin, "thing.tag", [first, second]);
        (off.GetProperty("block").GetProperty("code").GetString(), off.GetProperty("previewToken").ValueKind).ShouldBe(("VND_KIND_DISABLED", JsonValueKind.Null));
        await RefusedAsync(CommandAsync(admin, preview, "thing.tag", [first, second], Guid.NewGuid()), HttpStatusCode.Conflict, "VND_KIND_DISABLED");

        // The allow-list is a matter of each target's customer.
        host.Vendor.Switches = allowed with { AllowedCustomerIds = ["another"] };
        var limited = await PreviewAsync(admin, "thing.tag", [first, second]);
        limited.GetProperty("ready").GetInt32().ShouldBe(0);
        limited.GetProperty("previewToken").ValueKind.ShouldBe(JsonValueKind.Null, "nothing to confirm");
        Blocks(limited).ShouldAllBe(b => b.Code == "VND_CUSTOMER_NOT_ALLOWED");

        // Test mode: every action of the batch reads the vendor and sends nothing.
        host.Vendor.Switches = allowed with { WriteEnabled = false, DryRun = true };
        var simulated = await PreviewAsync(admin, "thing.tag", [first, second]);
        simulated.GetProperty("simulated").GetBoolean().ShouldBeTrue();
        var result = await (await CommandAsync(admin, simulated, "thing.tag", [first, second], Guid.NewGuid())).ReadJsonAsync();
        foreach (var id in ActionIds(result))
        {
            await host.RunAsync(id);
        }

        (await BatchAsync(admin, result.GetProperty("batchId").GetGuid(), items: false)).GetProperty("simulated").GetInt32().ShouldBe(2);
    }

    [Fact]
    public async Task A_disruptive_batch_takes_one_reason_for_all_its_targets()
    {
        await using var host = VendorActionHost.Start(factory, batches: true);
        var admin = host.Client();
        var (first, second) = (VendorActionCalls.Target(), VendorActionCalls.Target());
        var preview = await PreviewAsync(admin, "thing.hold", [first, second]);
        preview.GetProperty("confirmation").GetProperty("reason").GetBoolean().ShouldBeTrue();

        await RefusedAsync(CommandAsync(admin, preview, "thing.hold", [first, second], Guid.NewGuid(), reason: "short"), HttpStatusCode.BadRequest,
            "VND_REASON_REQUIRED");
        var result = await (await CommandAsync(admin, preview, "thing.hold", [first, second], Guid.NewGuid(), reason: "The customer asked for a pause")).ReadJsonAsync();
        foreach (var id in ActionIds(result))
        {
            (await host.ActionAsync(id)).Reason.ShouldBe("The customer asked for a pause");
        }
    }

    private static object PreviewBody(string kind, IReadOnlyList<string> targets) =>
        new { system = TestVendor.Name, kind, targetType = TestVendor.TargetType, targetIds = targets, parameters = new { value = "on" } };

    private static object Body(string kind, IReadOnlyList<string> targets, string? token, Guid key, string? reason = null) => new
    {
        previewToken = token, system = TestVendor.Name, kind, targetType = TestVendor.TargetType, targetIds = targets, parameters = new { value = "on" },
        batchKey = key, reason,
    };

    private static async Task<JsonElement> PreviewAsync(HttpClient client, string kind, IReadOnlyList<string> targets)
    {
        var response = await client.PostAsJsonAsync("/api/v1/actions/batch/preview", PreviewBody(kind, targets), Ct);
        response.StatusCode.ShouldBe(HttpStatusCode.OK, await response.Content.ReadAsStringAsync(Ct));
        return await response.ReadJsonAsync();
    }

    private static Task<HttpResponseMessage> CommandAsync(
        HttpClient client, JsonElement preview, string kind, IReadOnlyList<string> targets, Guid key, string? reason = null) =>
        client.PostAsJsonAsync("/api/v1/actions/batch", Body(kind, targets, preview.GetProperty("previewToken").GetString(), key, reason), Ct);

    private static async Task<JsonElement> BatchAsync(HttpClient client, Guid batchId, bool items)
    {
        var response = await client.GetAsync($"/api/v1/actions/batches/{batchId}?items={(items ? "true" : "false")}", Ct);
        response.StatusCode.ShouldBe(HttpStatusCode.OK, await response.Content.ReadAsStringAsync(Ct));
        return await response.ReadJsonAsync();
    }

    private static List<(string Target, string? Code)> Blocks(JsonElement preview) =>
        preview.GetProperty("targets").EnumerateArray().Select(t => (t.GetProperty("targetId").GetString()!,
            t.GetProperty("block").ValueKind == JsonValueKind.Null ? null : t.GetProperty("block").GetProperty("code").GetString())).ToList();

    private static List<Guid> ActionIds(JsonElement result) =>
        result.GetProperty("items").EnumerateArray().Where(i => i.GetProperty("actionId").ValueKind != JsonValueKind.Null)
            .Select(i => i.GetProperty("actionId").GetGuid()).ToList();

    private static async Task RefusedAsync(Task<HttpResponseMessage> call, HttpStatusCode status, string code)
    {
        var response = await call;
        response.StatusCode.ShouldBe(status, await response.Content.ReadAsStringAsync(Ct));
        (await response.Content.ReadAsStringAsync(Ct)).ShouldContain(code);
    }

    private static async Task<int> CountAsync(VendorActionHost host, params string[] targets)
    {
        await using var scope = host.Services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<IntegrationDbContext>().VendorActions.AsNoTracking()
            .CountAsync(a => a.System == TestVendor.Name && targets.Contains(a.TargetId), Ct);
    }
}
