using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crm.Authorization;
using Crm.Infrastructure.Persistence;
using Crm.Integrations.Core;
using Crm.Integrations.Core.Actions;
using Crm.Integrations.Core.Persistence;
using Crm.SharedKernel.Operations;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crm.IntegrationTests;

/// <summary>
/// M39.1: the one path of every action at a vendor — preview from saved data with a signed token, a confirmation by level, an
/// idempotent command saved with its outbound operation, the worker's attempt with the switches read again, and the outcomes.
/// Each test runs its own action only (<see cref="VendorActionHost.RunAsync"/>), so the shared database never mixes them.
/// </summary>
public class VendorActionApiTests(CrmWebFactory factory)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task A_previewed_action_is_saved_once_sent_once_and_logged()
    {
        await using var host = VendorActionHost.Start(factory);
        var admin = host.Client();
        var target = VendorActionCalls.Target();

        var preview = await admin.PreviewAsync("thing.set", target, new { value = " on " });
        preview.GetProperty("level").GetString().ShouldBe("Standard");
        preview.GetProperty("target").GetProperty("name").GetString().ShouldBe($"Thing {target}");
        preview.GetProperty("effects")[0].GetProperty("values").GetProperty("value").GetString().ShouldBe("on");
        preview.GetProperty("block").ValueKind.ShouldBe(JsonValueKind.Null);
        preview.GetProperty("simulated").GetBoolean().ShouldBeFalse();
        var token = preview.GetProperty("previewToken").GetString();

        // The same parameters in another spelling are the same action: the command key decides whether it is a repeat.
        var key = Guid.NewGuid();
        var first = await admin.CommandAsync(token, "thing.set", target, new { value = "on" }, key);
        first.StatusCode.ShouldBe(HttpStatusCode.Accepted);
        first.Headers.ETag.ShouldNotBeNull();
        var action = await first.ReadJsonAsync();
        action.GetProperty("status").GetString().ShouldBe("Queued");
        var id = action.GetProperty("id").GetGuid();
        var repeat = await admin.CommandAsync(token, "thing.set", target, new { value = "on" }, key);
        repeat.StatusCode.ShouldBe(HttpStatusCode.OK);
        (await repeat.ReadJsonAsync()).GetProperty("id").GetGuid().ShouldBe(id);

        (await host.OperationAsync(id)).Operation.ShouldBe("action:thing.set");
        (await host.RunAsync(id)).ShouldBeTrue();
        var sent = await host.ActionAsync(id);
        sent.Status.ShouldBe(VendorActionStatus.Succeeded);
        sent.Reference.ShouldBe($"ref-{target}");
        sent.Attempts.ShouldBe(1);
        (await host.OperationAsync(id)).Status.ShouldBe(OutboundStatus.Succeeded);
        host.Vendor.Calls.Count(c => c.Target == target).ShouldBe(1);
        (await host.RunAsync(id)).ShouldBeFalse("a finished action is never taken again");

        var log = await (await admin.GetAsync($"/api/v1/actions?targetType=thing&targetId={target}", Ct)).ReadJsonAsync();
        log.GetProperty("totalCount").GetInt32().ShouldBe(1);
        var item = log.GetProperty("items")[0];
        item.GetProperty("status").GetString().ShouldBe("Succeeded");
        item.GetProperty("outcomeCode").GetString().ShouldBe("VND_SENT");
        item.GetProperty("parameters").GetProperty("value").GetString().ShouldBe("on");
        item.GetProperty("requestedByName").GetString().ShouldNotBeNullOrEmpty();

        await using var scope = host.Services.CreateAsyncScope();
        var audit = await scope.ServiceProvider.GetRequiredService<IntegrationDbContext>().AuditEntries.AsNoTracking()
            .Where(e => e.EntityType == VendorAction.EntityType && e.EntityId == id).ToListAsync(Ct);
        audit.ShouldHaveSingleItem().Action.ShouldBe(AuditActions.Create);
        audit[0].Changes!.ShouldNotContain("\"on\"", Case.Sensitive, "the audit names the action, never its parameters");
    }

    [Fact]
    public async Task A_command_must_bring_the_unchanged_preview_of_the_same_person()
    {
        await using var host = VendorActionHost.Start(factory);
        var admin = host.Client();
        var target = VendorActionCalls.Target();
        var token = (await admin.PreviewAsync("thing.set", target, new { value = "on" })).GetProperty("previewToken").GetString();

        (await admin.CommandAsync(null, "thing.set", target, new { value = "on" })).StatusCode.ShouldBe(HttpStatusCode.BadRequest);
        await ShouldRefuseAsync(admin.CommandAsync(token, "thing.set", target, new { value = "off" }), HttpStatusCode.Conflict, "VND_PREVIEW_STALE");
        await ShouldRefuseAsync(admin.CommandAsync(token, "thing.set", VendorActionCalls.Target(), new { value = "on" }), HttpStatusCode.Conflict, "VND_PREVIEW_STALE");
        await ShouldRefuseAsync(admin.CommandAsync(token + "x", "thing.set", target, new { value = "on" }), HttpStatusCode.Conflict, "VND_PREVIEW_EXPIRED");
        await ShouldRefuseAsync(host.Client(user: "actions-someone-else").CommandAsync(token, "thing.set", target, new { value = "on" }),
            HttpStatusCode.Conflict, "VND_PREVIEW_EXPIRED");
        await ShouldRefuseAsync(admin.CommandAsync(token, "thing.unknown", target, new { value = "on" }), HttpStatusCode.BadRequest, "VND_UNKNOWN_KIND");

        var key = Guid.NewGuid();
        (await admin.CommandAsync(token, "thing.set", target, new { value = "on" }, key)).StatusCode.ShouldBe(HttpStatusCode.Accepted);
        var other = (await admin.PreviewAsync("thing.set", target, new { value = "off" })).GetProperty("previewToken").GetString();
        await ShouldRefuseAsync(admin.CommandAsync(other, "thing.set", target, new { value = "off" }, key), HttpStatusCode.Conflict, "VND_COMMAND_KEY_REUSED");

        (await admin.PostAsJsonAsync("/api/v1/actions/preview", VendorActionCalls.Body("thing.set", "missing-1", new { value = "on" }), Ct))
            .StatusCode.ShouldBe(HttpStatusCode.NotFound);
        var invalid = await admin.PreviewAsync("thing.set", target, new { value = " " });
        invalid.GetProperty("block").GetProperty("code").GetString().ShouldBe("VND_TEST_VALUE");
        invalid.GetProperty("previewToken").ValueKind.ShouldBe(JsonValueKind.Null);
        await ShouldRefuseAsync(host.Client(CrmRoles.ReadOnly).PostAsJsonAsync("/api/v1/actions/preview", VendorActionCalls.Body("thing.set", target, new { value = "on" }), Ct),
            HttpStatusCode.Forbidden, null);
    }

    [Fact]
    public async Task The_switches_block_the_preview_and_the_command_and_are_read_again_before_sending()
    {
        await using var host = VendorActionHost.Start(factory);
        var admin = host.Client();
        var target = VendorActionCalls.Target();
        var allowed = host.Vendor.Switches;

        host.Vendor.Switches = allowed with { WriteEnabled = false };
        var blocked = await admin.PreviewAsync("thing.set", target, new { value = "on" });
        blocked.GetProperty("block").GetProperty("code").GetString().ShouldBe("VND_WRITE_DISABLED");
        blocked.GetProperty("previewToken").ValueKind.ShouldBe(JsonValueKind.Null);

        host.Vendor.Switches = allowed;
        var token = (await admin.PreviewAsync("thing.set", target, new { value = "on" })).GetProperty("previewToken").GetString();
        host.Vendor.Switches = allowed with { EnabledActions = [] };
        await ShouldRefuseAsync(admin.CommandAsync(token, "thing.set", target, new { value = "on" }), HttpStatusCode.Conflict, "VND_KIND_DISABLED");

        // Asked while allowed, then the allow-list changed before the worker came to it: rejected, nothing sent.
        host.Vendor.Switches = allowed;
        var rejected = await admin.AskAsync("thing.set", target);
        host.Vendor.Switches = allowed with { AllowedCustomerIds = ["another"] };
        await host.RunAsync(rejected);
        (await host.ActionAsync(rejected)).OutcomeCode.ShouldBe("VND_CUSTOMER_NOT_ALLOWED");
        (await host.ActionAsync(rejected)).Status.ShouldBe(VendorActionStatus.Rejected);
        (await host.OperationAsync(rejected)).Status.ShouldBe(OutboundStatus.Cancelled);
        host.Vendor.Calls.ShouldNotContain(c => c.Target == target);

        // DryRun: the live state is read, nothing is sent, and writing may be off meanwhile.
        host.Vendor.Switches = allowed with { DryRun = true, WriteEnabled = false };
        var simulated = await admin.AskAsync("thing.set", target);
        (await admin.PreviewAsync("thing.set", target, new { value = "on" })).GetProperty("simulated").GetBoolean().ShouldBeTrue();
        await host.RunAsync(simulated);
        (await host.ActionAsync(simulated)).Status.ShouldBe(VendorActionStatus.Simulated);
        host.Vendor.Calls.ShouldContain(c => c.Target == target && c.Simulated);
    }

    [Fact]
    public async Task A_paused_vendor_keeps_its_actions_waiting()
    {
        await using var host = VendorActionHost.Start(factory);
        var admin = host.Client();
        var target = VendorActionCalls.Target();
        var id = await admin.AskAsync("thing.set", target);
        await using (var scope = host.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
            db.IntegrationSwitches.Add(new IntegrationSwitch { System = TestVendor.Name, IsPaused = true, Reason = "test", PausedAt = DateTimeOffset.UtcNow });
            await db.SaveChangesAsync(Ct);
        }

        try
        {
            (await admin.PreviewAsync("thing.set", target, new { value = "on" })).GetProperty("paused").GetBoolean().ShouldBeTrue();
            (await host.RunAsync(id)).ShouldBeFalse("the vendor is paused");
            (await host.ActionAsync(id)).Status.ShouldBe(VendorActionStatus.Queued);
        }
        finally
        {
            await using var scope = host.Services.CreateAsyncScope();
            await scope.ServiceProvider.GetRequiredService<IntegrationDbContext>().IntegrationSwitches.Where(s => s.System == TestVendor.Name).ExecuteDeleteAsync(Ct);
        }

        await host.RunAsync(id);
        (await host.ActionAsync(id)).Status.ShouldBe(VendorActionStatus.Succeeded);
    }

    [Fact]
    public async Task A_disruptive_action_needs_a_reason_and_a_destructive_one_its_name_its_endpoint_and_a_hold()
    {
        await using var host = VendorActionHost.Start(factory);
        var admin = host.Client();
        var target = VendorActionCalls.Target();

        var pause = await admin.PreviewAsync("thing.pause", target, new { value = "on" });
        pause.GetProperty("confirmation").GetProperty("reason").GetBoolean().ShouldBeTrue();
        await ShouldRefuseAsync(admin.CommandAsync(pause.GetProperty("previewToken").GetString(), "thing.pause", target, new { value = "on" }, reason: "short"),
            HttpStatusCode.BadRequest, "VND_REASON_REQUIRED");

        var delete = await admin.PreviewAsync("thing.delete", target, new { value = "on" });
        delete.GetProperty("confirmation").GetProperty("holdSeconds").GetInt32().ShouldBe(60);
        delete.GetProperty("confirmation").GetProperty("freshSignIn").GetBoolean().ShouldBeTrue();
        var token = delete.GetProperty("previewToken").GetString();
        const string reason = "The customer asked for it in writing";
        await ShouldRefuseAsync(admin.CommandAsync(token, "thing.delete", target, new { value = "on" }, reason: reason, typedName: $"Thing {target}"),
            HttpStatusCode.BadRequest, "VND_WRONG_ENDPOINT");
        await ShouldRefuseAsync(admin.CommandAsync(token, "thing.delete", target, new { value = "on" }, reason: reason, typedName: "Thing", destructive: true),
            HttpStatusCode.BadRequest, "VND_NAME_MISMATCH");
        await ShouldRefuseAsync(admin.CommandAsync(pause.GetProperty("previewToken").GetString(), "thing.pause", target, new { value = "on" }, reason: reason, destructive: true),
            HttpStatusCode.BadRequest, "VND_WRONG_ENDPOINT");

        var accepted = await admin.CommandAsync(token, "thing.delete", target, new { value = "on" }, reason: reason, typedName: $"  thing {target} ", destructive: true);
        accepted.StatusCode.ShouldBe(HttpStatusCode.Accepted);
        var held = await accepted.ReadJsonAsync();
        held.GetProperty("status").GetString().ShouldBe("Scheduled");
        (held.GetProperty("notBefore").GetDateTimeOffset() - held.GetProperty("requestedAt").GetDateTimeOffset()).ShouldBe(TimeSpan.FromSeconds(60));
        var id = held.GetProperty("id").GetGuid();
        (await host.RunAsync(id)).ShouldBeFalse("the hold has not passed");

        (await admin.PostAsync($"/api/v1/actions/{id}/cancel", null, Ct)).StatusCode.ShouldBe((HttpStatusCode)428);
        var cancel = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/actions/{id}/cancel");
        cancel.Headers.TryAddWithoutValidation("If-Match", held.GetProperty("etag").GetString());
        var cancelled = await admin.SendAsync(cancel, Ct);
        cancelled.StatusCode.ShouldBe(HttpStatusCode.OK);
        (await cancelled.ReadJsonAsync()).GetProperty("status").GetString().ShouldBe("Cancelled");
        (await host.OperationAsync(id)).Status.ShouldBe(OutboundStatus.Cancelled);
        await host.DueNowAsync(id);
        (await host.RunAsync(id)).ShouldBeFalse("a cancelled action is never sent");
        host.Vendor.Calls.ShouldNotContain(c => c.Target == target);

        // Once its hold has passed, a destructive action goes like any other.
        var second = await admin.AskAsync("thing.delete", target, reason: reason, typedName: $"Thing {target}");
        await host.DueNowAsync(second);
        (await host.RunAsync(second)).ShouldBeTrue();
        (await host.ActionAsync(second)).Status.ShouldBe(VendorActionStatus.Succeeded);
        (await host.ActionAsync(second)).Reason.ShouldBe(reason);
    }

    [Fact]
    public async Task The_destructive_endpoint_demands_a_fresh_sign_in_and_every_kind_can_reach_the_command()
    {
        await using var host = VendorActionHost.Start(factory);
        var endpoints = host.Services.GetRequiredService<EndpointDataSource>().Endpoints.OfType<RouteEndpoint>().ToList();
        endpoints.Single(e => e.RoutePattern.RawText == "/api/v1/actions/destructive").Metadata.GetMetadata<RequiresFreshRolesMetadata>().ShouldNotBeNull();
        // The group's own route is spelled with or without its closing slash.
        endpoints.Single(e => e.RoutePattern.RawText?.TrimEnd('/') == "/api/v1/actions" && e.Metadata.GetMetadata<HttpMethodMetadata>()!.HttpMethods.Contains("POST"))
            .Metadata.GetMetadata<RequiresFreshRolesMetadata>().ShouldBeNull();

        await using var scope = factory.Services.CreateAsyncScope();
        foreach (var handler in scope.ServiceProvider.GetServices<IVendorActionHandler>())
        {
            VendorActionEndpoints.RequestPermissions.ShouldContain(handler.Permission, $"{handler.System}/{handler.Kind}");
            VendorActionEndpoints.ReadPermissions.ShouldContain(handler.ReadPermission, $"{handler.System}/{handler.Kind}");
        }
    }

    [Fact]
    public async Task A_comment_without_an_answer_waits_for_a_person_who_settles_it()
    {
        await using var host = VendorActionHost.Start(factory);
        var admin = host.Client();
        var target = VendorActionCalls.Target();
        host.Vendor.Answer(target, TestVendorAnswer.NoAnswer);
        var id = await admin.AskAsync("thing.set", target);

        await host.RunAsync(id);
        var uncertain = await host.ActionAsync(id);
        uncertain.Status.ShouldBe(VendorActionStatus.Uncertain);
        uncertain.OutcomeCode.ShouldBe("VND_NO_ANSWER");
        uncertain.MayHaveSent.ShouldBeTrue();
        (await host.OperationAsync(id)).Status.ShouldBe(OutboundStatus.Failed);
        (await (await admin.GetAsync($"/api/v1/actions?state=attention&targetType=thing&targetId={target}", Ct)).ReadJsonAsync())
            .GetProperty("uncertain").GetInt32().ShouldBe(1);

        // The outbound pages cannot send it again: a comment could reach the customer twice.
        var operation = await host.OperationAsync(id);
        var retry = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/integrations/outbound/{operation.Id}/retry")
        {
            Content = JsonContent.Create(new { reason = "Trying the comment once more" }),
        };
        retry.Headers.TryAddWithoutValidation("If-Match", OutboundOperationItem.Version(operation));
        await ShouldRefuseAsync(admin.SendAsync(retry, Ct), HttpStatusCode.Conflict, "INT_OUTBOUND_IS_ACTION");

        var etag = (await (await admin.GetAsync($"/api/v1/actions/{id}", Ct)).ReadJsonAsync()).GetProperty("etag").GetString();
        await ShouldRefuseAsync(SettleAsync(admin, id, etag, "Succeeded", "short"), HttpStatusCode.BadRequest, null);
        var settled = await SettleAsync(admin, id, etag, "Succeeded", "The note is there in the vendor's console");
        settled.StatusCode.ShouldBe(HttpStatusCode.OK);
        var item = await settled.ReadJsonAsync();
        item.GetProperty("status").GetString().ShouldBe("Succeeded");
        item.GetProperty("outcomeCode").GetString().ShouldBe("VND_SETTLED_DONE");
        item.GetProperty("closeReason").GetString().ShouldBe("The note is there in the vendor's console");
        item.GetProperty("closedByName").GetString().ShouldNotBeNullOrEmpty();
        (await host.OperationAsync(id)).Status.ShouldBe(OutboundStatus.Succeeded);
        await ShouldRefuseAsync(SettleAsync(admin, id, item.GetProperty("etag").GetString(), "Failed", "Changed my mind about it"), HttpStatusCode.Conflict, "VND_NOT_UNCERTAIN");
        await ShouldRefuseAsync(SettleAsync(admin, id, etag, "Failed", "An old version of the action"), HttpStatusCode.PreconditionFailed, "VND_STALE");
    }

    [Fact]
    public async Task A_repeatable_action_reads_the_vendor_again_after_an_unclear_answer()
    {
        await using var host = VendorActionHost.Start(factory);
        var admin = host.Client();
        var target = VendorActionCalls.Target();
        host.Vendor.Answer(target, TestVendorAnswer.NoAnswer, TestVendorAnswer.AlreadyDone);
        var id = await admin.AskAsync("thing.pause", target, reason: "The customer is moving offices");

        await host.RunAsync(id);
        var waiting = await host.ActionAsync(id);
        waiting.Status.ShouldBe(VendorActionStatus.Queued);
        waiting.Attempts.ShouldBe(1);
        (await host.OperationAsync(id)).NextAttemptAt.ShouldBeGreaterThan(DateTimeOffset.UtcNow.AddSeconds(5));
        (await host.RunAsync(id)).ShouldBeFalse("it waits out its pause");

        await host.DueNowAsync(id);
        await host.RunAsync(id);
        var done = await host.ActionAsync(id);
        done.Status.ShouldBe(VendorActionStatus.Skipped);
        done.Attempts.ShouldBe(2);
    }

    [Fact]
    public async Task A_vendor_that_stays_busy_ends_the_action_as_failed_with_nothing_sent()
    {
        await using var host = VendorActionHost.Start(factory);
        var admin = host.Client();
        var target = VendorActionCalls.Target();
        host.Vendor.Answer(target, Enumerable.Repeat(TestVendorAnswer.Later, VendorActionRules.MaxAttempts).ToArray());
        var id = await admin.AskAsync("thing.set", target);
        for (var attempt = 0; attempt < VendorActionRules.MaxAttempts; attempt++)
        {
            await host.DueNowAsync(id);
            await host.RunAsync(id);
        }

        var failed = await host.ActionAsync(id);
        failed.Status.ShouldBe(VendorActionStatus.Failed);
        failed.OutcomeCode.ShouldBe("VND_VENDOR_UNAVAILABLE");
        failed.Attempts.ShouldBe(VendorActionRules.MaxAttempts);
    }

    [Fact]
    public async Task An_attempt_that_may_have_left_is_never_sent_again_by_a_comment()
    {
        await using var host = VendorActionHost.Start(factory);
        var admin = host.Client();
        var target = VendorActionCalls.Target();
        var id = await admin.AskAsync("thing.set", target);
        // A worker stopped after the request left and before its outcome was saved: only the journal knows.
        var operation = await host.OperationAsync(id);
        await host.Services.GetRequiredService<IExternalEffectJournal>().BeginAsync(
            new ExternalEffect(TestVendor.Name, operation.Operation, VendorAction.EntityType, id, operation.Id), Ct);

        await host.RunAsync(id);
        var action = await host.ActionAsync(id);
        action.Status.ShouldBe(VendorActionStatus.Uncertain);
        action.OutcomeCode.ShouldBe("VND_EARLIER_ATTEMPT");
        host.Vendor.Calls.ShouldNotContain(c => c.Target == target);
    }

    [Fact]
    public async Task One_action_per_target_is_sent_at_a_time_and_the_outbound_job_leaves_actions_alone()
    {
        await using var host = VendorActionHost.Start(factory);
        var admin = host.Client();
        var target = VendorActionCalls.Target();
        var first = await admin.AskAsync("thing.set", target, "one");
        var second = await admin.AskAsync("thing.set", target, "two");
        await using (var scope = host.Services.CreateAsyncScope())
        {
            await scope.ServiceProvider.GetRequiredService<IntegrationDbContext>().VendorActions.Where(a => a.Id == first)
                .ExecuteUpdateAsync(s => s.SetProperty(a => a.Status, VendorActionStatus.Sending), Ct);
        }

        (await host.RunAsync(second)).ShouldBeFalse("the target is busy");
        (await host.ActionAsync(second)).Status.ShouldBe(VendorActionStatus.Queued);
        (await host.ActionAsync(second)).Attempts.ShouldBe(0);
        (await host.OperationAsync(second)).NextAttemptAt.ShouldBeGreaterThan(DateTimeOffset.UtcNow);

        await host.Services.GetRequiredService<OutboundProcessorJob>().RunAsync(Ct);
        (await host.OperationAsync(second)).Status.ShouldBe(OutboundStatus.Pending);
        (await host.OperationAsync(second)).Attempts.ShouldBe(0);
    }

    [Fact]
    public async Task A_restore_holds_an_action_that_may_have_left_as_uncertain()
    {
        await using var host = VendorActionHost.Start(factory);
        var admin = host.Client();
        var id = await admin.AskAsync("thing.set", VendorActionCalls.Target());
        var operation = await host.OperationAsync(id);
        var effect = new ExternalEffectEntry("e-1", TestVendor.Name, operation.Operation, VendorAction.EntityType, id, operation.Id, EffectPhase.Sending, DateTimeOffset.UtcNow, null);

        await using (var scope = host.Services.CreateAsyncScope())
        {
            var participant = scope.ServiceProvider.GetServices<IRestoreParticipant>().Single(p => p.Area == "integrations");
            (await participant.ReconcileAsync(DateTimeOffset.UtcNow.AddMinutes(-5), [effect], apply: true, Ct)).ShouldNotBeEmpty();
        }

        var held = await host.ActionAsync(id);
        held.Status.ShouldBe(VendorActionStatus.Uncertain);
        held.OutcomeCode.ShouldBe("VND_HELD_AFTER_RESTORE");
        (await host.OperationAsync(id)).Status.ShouldBe(OutboundStatus.Failed);
        // The person who asked hears of it once the outbox runs again after the maintenance.
        await using var check = host.Services.CreateAsyncScope();
        (await check.ServiceProvider.GetRequiredService<IntegrationDbContext>().OutboxMessages.AsNoTracking()
            .CountAsync(m => m.Type.StartsWith(typeof(VendorActionNeedsCheck).FullName!) && m.Payload.Contains(id.ToString()), Ct)).ShouldBe(1);
    }

    [Fact]
    public async Task The_log_shows_a_role_only_the_kinds_it_may_read()
    {
        await using var host = VendorActionHost.Start(factory);
        var target = VendorActionCalls.Target();
        var id = await host.Client().AskAsync("thing.set", target);
        var readOnly = host.Client(CrmRoles.ReadOnly);
        var seen = await (await readOnly.GetAsync($"/api/v1/actions?targetType=thing&targetId={target}", Ct)).ReadJsonAsync();
        seen.GetProperty("items")[0].GetProperty("id").GetGuid().ShouldBe(id);
        (await readOnly.GetAsync($"/api/v1/actions/{id}", Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await readOnly.GetAsync("/api/v1/actions?state=everything", Ct)).StatusCode.ShouldBe(HttpStatusCode.BadRequest);
        (await factory.ClientAs(CrmRoles.Finance).GetAsync("/api/v1/actions", Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
        var cancel = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/actions/{id}/cancel");
        cancel.Headers.TryAddWithoutValidation("If-Match", "\"AAAAAAAAAAA=\"");
        (await readOnly.SendAsync(cancel, Ct)).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task The_kinds_offered_are_those_the_switches_and_the_role_let_through()
    {
        await using var host = VendorActionHost.Start(factory);
        var allowed = host.Vendor.Switches;
        async Task<JsonElement> KindsAsync(HttpClient client) =>
            await (await client.GetAsync($"/api/v1/actions/kinds?system={TestVendor.Name}", Ct)).ReadJsonAsync();
        static string[] Names(JsonElement kinds) => [.. kinds.EnumerateArray().Select(k => k.GetProperty("kind").GetString()!)];

        var all = await KindsAsync(host.Client());
        Names(all).ShouldBe(["thing.delete", "thing.pause", "thing.set"]);
        all[2].GetProperty("level").GetString().ShouldBe("Standard");
        all[2].GetProperty("simulated").GetBoolean().ShouldBeFalse();

        // The allow-list depends on the target: the kind is offered, and the preview refuses a customer that is not on it.
        host.Vendor.Switches = allowed with { EnabledActions = ["thing.set"], AllowedCustomerIds = ["another"] };
        var limited = await KindsAsync(host.Client());
        Names(limited).ShouldBe(["thing.set"]);
        limited[0].GetProperty("limitedToCustomers").GetBoolean().ShouldBeTrue();

        host.Vendor.Switches = allowed with { WriteEnabled = false };
        Names(await KindsAsync(host.Client())).ShouldBeEmpty();
        host.Vendor.Switches = allowed with { WriteEnabled = false, DryRun = true };
        (await KindsAsync(host.Client())).EnumerateArray().ShouldAllBe(k => k.GetProperty("simulated").GetBoolean());
        host.Vendor.Switches = allowed with { Enabled = false };
        Names(await KindsAsync(host.Client())).ShouldBeEmpty();

        // A role that may read the log but not ask for these kinds is offered none of them.
        host.Vendor.Switches = allowed;
        Names(await KindsAsync(host.Client(CrmRoles.ReadOnly))).ShouldBeEmpty();
        (await factory.ClientAs(CrmRoles.Finance).GetAsync("/api/v1/actions/kinds", Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
    }

    private static Task<HttpResponseMessage> SettleAsync(HttpClient client, Guid id, string? etag, string outcome, string reason)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/actions/{id}/settle") { Content = JsonContent.Create(new { outcome, reason }) };
        request.Headers.TryAddWithoutValidation("If-Match", etag);
        return client.SendAsync(request, Ct);
    }

    private static async Task ShouldRefuseAsync(Task<HttpResponseMessage> call, HttpStatusCode status, string? code)
    {
        var response = await call;
        response.StatusCode.ShouldBe(status, await response.Content.ReadAsStringAsync(Ct));
        if (code is not null)
        {
            (await response.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe(code);
        }
    }
}
