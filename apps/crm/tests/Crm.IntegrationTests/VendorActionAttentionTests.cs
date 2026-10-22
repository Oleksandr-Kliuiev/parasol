using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crm.Infrastructure.Outbox;
using Crm.Infrastructure.Persistence;
using Crm.Integrations.Atera;
using Crm.Integrations.Core.Actions;
using Crm.Integrations.Core.Persistence;
using Crm.Notifications.Contracts;
using Crm.Notifications.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using WireMock.ResponseBuilders;

namespace Crm.IntegrationTests;

/// <summary>
/// M39: an action that ends without a clear answer reaches the person who asked — a notice that opens the ticket with the action's card,
/// a "check needed" fact beside the ticket's row (one lookup per page of rows), and the ticket's links on the action itself.
/// </summary>
public class VendorActionAttentionTests(CrmWebFactory factory)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task A_reply_without_a_clear_answer_reaches_the_person_who_asked_and_marks_its_ticket()
    {
        await using var host = AteraTicketHost.Start(factory);
        var ticket = await host.TicketAsync(url: "https://atera.example/new/ticket/4711");
        await host.MapTechnicianAsync();
        host.On("POST", $"/api/v3/tickets/{ticket.TicketId}/comments").RespondWith(Response.Create().WithStatusCode(503));
        var id = await host.AskAsync(AteraTicketKinds.Reply, ticket, new { text = "Vi ser på det" });
        (await host.RunAsync(id)).Status.ShouldBe(VendorActionStatus.Uncertain);

        // The notice is written by the outbox, with the outcome, after a pause in which the confirmation asks the person itself.
        var message = (await MessageAsync(host.Services, typeof(VendorActionNeedsCheck), id.ToString())).ShouldNotBeNull();
        await using (var scope = host.Services.CreateAsyncScope())
        {
            var saved = await scope.ServiceProvider.GetRequiredService<IntegrationDbContext>().OutboxMessages.AsNoTracking().SingleAsync(m => m.Id == message, Ct);
            var pause = saved.NextAttemptAt.ShouldNotBeNull() - saved.OccurredAt;
            pause.ShouldBeInRange(VendorActionNotices.Delay - TimeSpan.FromSeconds(5), VendorActionNotices.Delay + TimeSpan.FromSeconds(5));
        }

        await DeliverAsync(host.Services, id);
        var notice = await NoticeAsync(host.Services, id);
        notice.ShouldNotBeNull();
        notice.Kind.ShouldBe(NotificationKind.VendorActionUncertain);
        notice.RecipientId.ShouldBe((await ActionAsync(host.Services, id)).RequestedBy);
        notice.Warning.ShouldBeTrue();
        notice.Link.ShouldBe($"/tickets?ticket={ticket.MirrorId:D}&action={id:D}");
        notice.OrganizationId.ShouldBe(ticket.OrganizationId);
        notice.Parameters["system"].ShouldBe("atera");
        notice.Parameters["kind"].ShouldBe(AteraTicketKinds.Reply);
        notice.Parameters["ticket"].ShouldBe(ticket.TicketId.ToString(CultureInfo.InvariantCulture));
        notice.Parameters["organization"].ShouldStartWith("Sak ");
        notice.Parameters.Values.ShouldNotContain("Vi ser på det", "a notice never carries what was written to the customer");
        var mine = await (await host.Client().GetAsync("/api/v1/notifications?limit=200", Ct)).ReadJsonAsync();
        mine.GetProperty("items").EnumerateArray().ShouldContain(n => n.GetProperty("link").GetString() == notice.Link);

        // The action names its ticket in Parasoll and where to check it in Atera.
        var item = await (await host.Client().GetAsync($"/api/v1/actions/{id}", Ct)).ReadJsonAsync();
        item.GetProperty("ticketId").GetGuid().ShouldBe(ticket.MirrorId);
        item.GetProperty("vendorUrl").GetString().ShouldBe("https://atera.example/new/ticket/4711");

        // The ticket's row says a check is needed; a ticket without actions is left out of the answer.
        var other = TestData.AteraId().ToString(CultureInfo.InvariantCulture);
        var facts = await LookupAsync(host.Client(), "ticket", ticket.TicketId.ToString(CultureInfo.InvariantCulture), other);
        var fact = facts.GetProperty("items").EnumerateArray().ShouldHaveSingleItem();
        fact.GetProperty("targetId").GetString().ShouldBe(ticket.TicketId.ToString(CultureInfo.InvariantCulture));
        fact.GetProperty("uncertain").GetInt32().ShouldBe(1);
        fact.GetProperty("waiting").GetInt32().ShouldBe(0);
        fact.GetProperty("done").GetInt32().ShouldBe(0);
        fact.GetProperty("checkId").GetGuid().ShouldBe(id);

        // Once checked, the row no longer asks for it.
        var settle = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/actions/{id}/settle")
        {
            Content = JsonContent.Create(new { outcome = "Succeeded", reason = "The reply is in the ticket in Atera" }),
        };
        settle.Headers.TryAddWithoutValidation("If-Match", item.GetProperty("etag").GetString());
        (await host.Client().SendAsync(settle, Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
        var settled = (await LookupAsync(host.Client(), "ticket", ticket.TicketId.ToString(CultureInfo.InvariantCulture))).GetProperty("items")[0];
        settled.GetProperty("uncertain").GetInt32().ShouldBe(0);
        settled.GetProperty("done").GetInt32().ShouldBe(1);
        settled.GetProperty("checkId").ValueKind.ShouldBe(JsonValueKind.Null);
    }

    [Fact]
    public async Task Only_an_action_still_without_an_answer_gets_a_notice_and_only_one()
    {
        await using var host = VendorActionHost.Start(factory);
        var admin = host.Client();
        // Done, or already settled by the time the message is delivered: nothing to tell. (Called directly: other test classes drain
        // the shared outbox, so the order of delivery and settling cannot be arranged through it.)
        var done = await admin.AskAsync("thing.set", VendorActionCalls.Target());
        await host.RunAsync(done);
        await using (var handling = host.Services.CreateAsyncScope())
        {
            await ActivatorUtilities.CreateInstance<VendorActionNeedsCheckHandler>(handling.ServiceProvider).HandleAsync(new VendorActionNeedsCheck(done), Ct);
        }

        (await NoticeAsync(host.Services, done)).ShouldBeNull();
        await using (var reading = host.Services.CreateAsyncScope())
        {
            (await reading.ServiceProvider.GetRequiredService<IntegrationDbContext>().OutboxMessages.AsNoTracking()
                .CountAsync(m => m.Type.StartsWith(typeof(VendorActionNeedsCheck).FullName!) && m.Payload.Contains(done.ToString()), Ct))
                .ShouldBe(0, "only an outcome without an answer writes the message");
        }

        // A thing is no ticket: the notice of an uncertain thing says the vendor without a ticket and links nowhere.
        var second = VendorActionCalls.Target();
        host.Vendor.Answer(second, TestVendorAnswer.NoAnswer);
        var open = await admin.AskAsync("thing.set", second);
        await host.RunAsync(open);
        await DeliverAsync(host.Services, open);
        var notice = (await NoticeAsync(host.Services, open)).ShouldNotBeNull();
        notice.Link.ShouldBeNull();
        notice.Parameters.ContainsKey("ticket").ShouldBeFalse();
        await using var scope = host.Services.CreateAsyncScope();
        var notices = scope.ServiceProvider.GetRequiredService<INotificationsApi>();
        (await notices.EnqueueAsync(new NotificationRequest(NotificationKind.VendorActionUncertain, notice.RecipientId, notice.DedupeKey,
            notice.Parameters), Ct)).ShouldBeFalse("a repeated delivery adds nothing");
    }

    [Fact]
    public async Task The_lookup_counts_the_actions_of_one_page_of_targets_by_state()
    {
        await using var host = VendorActionHost.Start(factory);
        var admin = host.Client();
        string done = VendorActionCalls.Target(), waiting = VendorActionCalls.Target(), unsure = VendorActionCalls.Target();
        await host.RunAsync(await admin.AskAsync("thing.set", done));
        host.Vendor.Answer(done, TestVendorAnswer.AlreadyDone);
        await host.RunAsync(await admin.AskAsync("thing.set", done, "again"));
        await admin.AskAsync("thing.set", waiting);
        host.Vendor.Answer(unsure, TestVendorAnswer.NoAnswer, TestVendorAnswer.NoAnswer);
        var older = await admin.AskAsync("thing.set", unsure);
        await host.RunAsync(older);
        var newer = await admin.AskAsync("thing.set", unsure, "later");
        await host.RunAsync(newer);

        var facts = (await LookupAsync(admin, TestVendor.TargetType, done, waiting, unsure, waiting)).GetProperty("items").EnumerateArray()
            .ToDictionary(f => f.GetProperty("targetId").GetString()!);
        facts.Count.ShouldBe(3);
        (facts[done].GetProperty("done").GetInt32(), facts[done].GetProperty("waiting").GetInt32(), facts[done].GetProperty("uncertain").GetInt32()).ShouldBe((2, 0, 0));
        (facts[waiting].GetProperty("done").GetInt32(), facts[waiting].GetProperty("waiting").GetInt32()).ShouldBe((0, 1));
        facts[unsure].GetProperty("uncertain").GetInt32().ShouldBe(2);
        facts[unsure].GetProperty("checkId").GetGuid().ShouldBe(newer);

        // One page of targets at a time, and only with a read permission of the action path.
        await ShouldBeBadRequestAsync(admin.PostAsJsonAsync("/api/v1/actions/lookup", new { system = TestVendor.Name, targetType = TestVendor.TargetType, targetIds = Array.Empty<string>() }, Ct));
        await ShouldBeBadRequestAsync(admin.PostAsJsonAsync("/api/v1/actions/lookup", new
        {
            system = TestVendor.Name, targetType = TestVendor.TargetType, targetIds = Enumerable.Range(0, VendorActionReader.LookupLimit + 1).Select(i => $"t-{i}").ToArray(),
        }, Ct));
        await ShouldBeBadRequestAsync(admin.PostAsJsonAsync("/api/v1/actions/lookup", new { targetType = TestVendor.TargetType, targetIds = new[] { done } }, Ct));
        (await host.Client(Crm.Authorization.CrmRoles.ReadOnly).PostAsJsonAsync("/api/v1/actions/lookup",
            new { system = TestVendor.Name, targetType = TestVendor.TargetType, targetIds = new[] { done } }, Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
    }

    private static async Task ShouldBeBadRequestAsync(Task<HttpResponseMessage> request) =>
        (await request).StatusCode.ShouldBe(HttpStatusCode.BadRequest);

    private static async Task<JsonElement> LookupAsync(HttpClient client, string targetType, params string[] targetIds)
    {
        var system = targetType == TestVendor.TargetType ? TestVendor.Name : "atera";
        var response = await client.PostAsJsonAsync("/api/v1/actions/lookup", new { system, targetType, targetIds }, Ct);
        response.StatusCode.ShouldBe(HttpStatusCode.OK, await response.Content.ReadAsStringAsync(Ct));
        response.Headers.CacheControl!.NoStore.ShouldBeTrue();
        return await response.ReadJsonAsync();
    }

    private static async Task<VendorAction> ActionAsync(IServiceProvider services, Guid id)
    {
        await using var scope = services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<IntegrationDbContext>().VendorActions.AsNoTracking().SingleAsync(a => a.Id == id, Ct);
    }

    /// <summary>
    /// Delivers the action's "needs a check" message as the worker would, then the notice it asked the Notifications module for. Other test
    /// classes drain the shared outbox too, so a message already taken by one of them is waited for instead.
    /// </summary>
    private static async Task DeliverAsync(IServiceProvider services, Guid actionId)
    {
        await DeliverOneAsync(services, (await MessageAsync(services, typeof(VendorActionNeedsCheck), actionId.ToString())).ShouldNotBeNull("the outcome comes with its message"));
        if (await MessageAsync(services, typeof(NotificationRequested), actionId.ToString("N")) is { } notice)
        {
            await DeliverOneAsync(services, notice);
        }
    }

    private static async Task<Guid?> MessageAsync(IServiceProvider services, Type eventType, string marker)
    {
        await using var scope = services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<IntegrationDbContext>().OutboxMessages.AsNoTracking()
            .Where(m => m.Type.StartsWith(eventType.FullName!) && m.Payload.Contains(marker))
            .Select(m => (Guid?)m.Id).SingleOrDefaultAsync(Ct);
    }

    private static async Task DeliverOneAsync(IServiceProvider services, Guid messageId)
    {
        // As if the notice's pause had passed.
        await using (var scope = services.CreateAsyncScope())
        {
            var now = DateTimeOffset.UtcNow;
            await scope.ServiceProvider.GetRequiredService<IntegrationDbContext>().OutboxMessages
                .Where(m => m.Id == messageId && m.Status == OutboxStatus.Pending && m.NextAttemptAt > now)
                .ExecuteUpdateAsync(set => set.SetProperty(m => m.NextAttemptAt, now), Ct);
        }

        var processor = ActivatorUtilities.CreateInstance<OutboxProcessor>(services, Options.Create(new OutboxOptions { RetryBaseDelay = TimeSpan.Zero }));
        for (var deadline = DateTime.UtcNow.AddSeconds(20); DateTime.UtcNow < deadline; await Task.Delay(200, Ct))
        {
            await using var scope = services.CreateAsyncScope();
            var db = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
            if (await db.OutboxMessages.AsNoTracking().AnyAsync(m => m.Id == messageId && m.Status == OutboxStatus.Processed, Ct))
            {
                return;
            }

            if (await processor.TryClaimAsync(db, messageId, Ct) is { } token)
            {
                await processor.DeliverAsync(typeof(IntegrationDbContext), messageId, token, Ct);
            }
        }

        throw new TimeoutException($"Outbox message {messageId} was not delivered.");
    }

    private static async Task<Crm.Notifications.Domain.Notification?> NoticeAsync(IServiceProvider services, Guid actionId)
    {
        await using var scope = services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<NotificationsDbContext>().Notifications.AsNoTracking()
            .SingleOrDefaultAsync(n => n.DedupeKey == $"vendor-action:{actionId:N}:uncertain", Ct);
    }
}
