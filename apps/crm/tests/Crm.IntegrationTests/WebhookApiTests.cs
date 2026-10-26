using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Text;
using Crm.Integrations.Atera;
using Crm.Integrations.Core.Persistence;
using Crm.Integrations.Core.Webhooks;
using Crm.Integrations.Huntress;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using static Crm.IntegrationTests.IntegrationTestHelpers;

namespace Crm.IntegrationTests;

/// <summary>
/// M44: vendors' webhooks at <c>/webhooks</c>. A delivery proves its sender before anything is filed, a refused one leaves only the time
/// and reason of the refusal, and an accepted one is filed as an early read the worker starts. The class runs in the Atera collection:
/// the conversation read of the other Atera tests reads the tickets a webhook names.
/// </summary>
[Collection(AteraCollection.Name)]
public sealed class WebhookApiTests(CrmWebFactory factory) : IAsyncLifetime
{
    private const string HuntressSecret = "whsec_plJ3nmyCDGBKInavdOK15jsl";
    private const string AteraKey = "synthetic-atera-webhook-key-0123456789abcdef";
    private static CancellationToken Ct => TestContext.Current.CancellationToken;
    private readonly List<string> namedTickets = [];

    public ValueTask InitializeAsync() => ValueTask.CompletedTask;

    public async ValueTask DisposeAsync()
    {
        // A ticket left named would be read by the next Atera test's conversation read.
        await using var scope = factory.Services.CreateAsyncScope();
        await scope.ServiceProvider.GetRequiredService<IntegrationDbContext>().EarlyReadTargets
            .Where(t => t.System == AteraTypes.System && namedTickets.Contains(t.ExternalId)).ExecuteDeleteAsync(Ct);
    }

    private WebApplicationFactory<Program> Host(bool huntress = true, bool atera = true) => factory.WithWebHostBuilder(builder =>
    {
        builder.UseSetting("Integrations:Huntress:Enabled", "true");
        builder.UseSetting("Integrations:Huntress:WebhookEnabled", huntress ? "true" : "false");
        builder.UseSetting("Integrations:Huntress:WebhookSecret", HuntressSecret);
        builder.UseSetting("Integrations:Atera:WebhookEnabled", atera ? "true" : "false");
        builder.UseSetting("Integrations:Atera:WebhookKey", AteraKey);
    });

    private static HttpRequestMessage Signed(string body, string secret = HuntressSecret, DateTimeOffset? at = null, string path = "/webhooks/huntress")
    {
        var id = "msg_" + Guid.NewGuid().ToString("N");
        var timestamp = (at ?? DateTimeOffset.UtcNow).ToUnixTimeSeconds();
        var bytes = Encoding.UTF8.GetBytes(body);
        var request = new HttpRequestMessage(HttpMethod.Post, path) { Content = new ByteArrayContent(bytes) };
        request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
        request.Headers.Add("svix-id", id);
        request.Headers.Add("svix-timestamp", timestamp.ToString(CultureInfo.InvariantCulture));
        request.Headers.Add("svix-signature", SvixSignature.Sign(SvixSignature.Key(secret)!, id, timestamp, bytes));
        return request;
    }

    private static HttpRequestMessage Unsigned(string path, string body) =>
        new(HttpMethod.Post, path) { Content = new StringContent(body, Encoding.UTF8, "application/json") };

    private async Task<(WebhookState? State, EarlyReadRequest? Request)> SavedAsync(string system, string job)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
        return (await db.WebhookStates.AsNoTracking().SingleOrDefaultAsync(s => s.System == system, Ct),
            await db.EarlyReadRequests.AsNoTracking().SingleOrDefaultAsync(r => r.System == system && r.Job == job, Ct));
    }

    [Fact]
    public async Task A_signed_huntress_event_is_filed_as_an_early_read_of_the_alerts()
    {
        await using var host = Host(); using var client = host.CreateClient();
        var (stateBefore, requestBefore) = await SavedAsync(HuntressTypes.System, HuntressAlertSyncJob.JobId);
        var started = DateTimeOffset.UtcNow;

        var response = await client.SendAsync(Signed("""
            {"event_type":"incident_report.created","id":17,"organization":{"id":4,"name":"Synthetic AS"},"subject":"Synthetic subject","body":"Synthetic body"}
            """), Ct);

        response.StatusCode.ShouldBe(HttpStatusCode.NoContent);
        var (state, request) = await SavedAsync(HuntressTypes.System, HuntressAlertSyncJob.JobId);
        state!.LastEventType.ShouldBe("incident_report.created");
        state.Received.ShouldBe((stateBefore?.Received ?? 0) + 1);
        state.LastReceivedAt!.Value.ShouldBeGreaterThanOrEqualTo(started.AddSeconds(-1));
        request!.Requests.ShouldBe((requestBefore?.Requests ?? 0) + 1);
        request.IsWaiting.ShouldBeTrue();
        request.RequestedAt.ShouldBeGreaterThanOrEqualTo(started.AddSeconds(-1));

        // A notification has nothing the API can read: it is counted and asks for nothing.
        (await client.SendAsync(Signed("""{"event_type":"account_notice.notification","id":3,"subject":"Synthetic"}"""), Ct)).StatusCode
            .ShouldBe(HttpStatusCode.NoContent);
        var (afterNotice, requestAfterNotice) = await SavedAsync(HuntressTypes.System, HuntressAlertSyncJob.JobId);
        afterNotice!.LastEventType.ShouldBe("account_notice.notification");
        afterNotice.Received.ShouldBe(state.Received + 1);
        requestAfterNotice!.Requests.ShouldBe(request.Requests);
    }

    [Fact]
    public async Task A_delivery_that_cannot_prove_its_sender_is_refused_and_files_nothing_but_the_refusal()
    {
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            await scope.ServiceProvider.GetRequiredService<IntegrationDbContext>().WebhookStates.Where(s => s.System == HuntressTypes.System)
                .ExecuteUpdateAsync(set => set.SetProperty(s => s.LastRefusedAt, (DateTimeOffset?)null).SetProperty(s => s.LastRefusal, (string?)null), Ct);
        }

        await using var host = Host(); using var client = host.CreateClient();
        var (stateBefore, requestBefore) = await SavedAsync(HuntressTypes.System, HuntressAlertSyncJob.JobId);
        const string body = """{"event_type":"incident_report.created","id":17,"subject":"Synthetic subject"}""";

        var unsigned = await client.SendAsync(Unsigned("/webhooks/huntress", body), Ct);
        unsigned.StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
        var refusedAt = (await SavedAsync(HuntressTypes.System, HuntressAlertSyncJob.JobId)).State!.LastRefusedAt;
        (await client.SendAsync(Signed(body, secret: "whsec_" + Convert.ToBase64String(new byte[24])), Ct)).StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
        (await client.SendAsync(Signed(body, at: DateTimeOffset.UtcNow.AddMinutes(-10)), Ct)).StatusCode.ShouldBe(HttpStatusCode.Unauthorized);

        var (state, request) = await SavedAsync(HuntressTypes.System, HuntressAlertSyncJob.JobId);
        state!.Received.ShouldBe(stateBefore?.Received ?? 0);
        (request?.Requests ?? 0).ShouldBe(requestBefore?.Requests ?? 0);
        // The first refusal is noted with its reason; more within a minute cost the database nothing.
        state.LastRefusal.ShouldBe(nameof(WebhookRefusal.Unsigned));
        state.LastRefusedAt.ShouldNotBeNull().ShouldBe(refusedAt!.Value);
        // The answer names nothing of the delivery.
        (await unsigned.Content.ReadAsStringAsync(Ct)).ShouldNotContain("Synthetic");
    }

    [Fact]
    public async Task A_switched_off_webhook_and_an_unknown_system_answer_as_if_there_were_no_address()
    {
        await using var off = Host(huntress: false, atera: false); using var client = off.CreateClient();
        (await client.SendAsync(Signed("""{"event_type":"incident_report.created"}"""), Ct)).StatusCode.ShouldBe(HttpStatusCode.NotFound);
        (await client.SendAsync(Unsigned($"/webhooks/atera/{AteraKey}", """{"TicketID":1}"""), Ct)).StatusCode.ShouldBe(HttpStatusCode.NotFound);

        await using var on = Host(); using var other = on.CreateClient();
        (await other.SendAsync(Signed("""{"event_type":"x"}""", path: "/webhooks/cloudally"), Ct)).StatusCode.ShouldBe(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task A_body_larger_than_the_limit_is_refused_before_it_is_read()
    {
        await using var host = Host(); using var client = host.CreateClient();
        var (stateBefore, _) = await SavedAsync(HuntressTypes.System, HuntressAlertSyncJob.JobId);
        var large = $$"""{"event_type":"incident_report.created","body":"{{new string('x', WebhookEvents.MaxBodyBytes)}}"}""";

        (await client.SendAsync(Signed(large), Ct)).StatusCode.ShouldBe(HttpStatusCode.RequestEntityTooLarge);

        (await SavedAsync(HuntressTypes.System, HuntressAlertSyncJob.JobId)).State?.Received.ShouldBe(stateBefore?.Received ?? 0);
    }

    [Fact]
    public async Task An_atera_delivery_needs_the_key_in_its_address_and_names_its_ticket_for_the_conversation_read()
    {
        await using var host = Host(); using var client = host.CreateClient();
        var ticket = TestData.AteraId().ToString(CultureInfo.InvariantCulture);
        namedTickets.Add(ticket);
        var body = $$"""{"TicketID":{{ticket}},"TicketTitle":"Synthetic title"}""";

        (await client.SendAsync(Unsigned("/webhooks/atera", body), Ct)).StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
        (await client.SendAsync(Unsigned($"/webhooks/atera/{AteraKey}x", body), Ct)).StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            (await scope.ServiceProvider.GetRequiredService<IntegrationDbContext>().EarlyReadTargets.AnyAsync(t => t.ExternalId == ticket, Ct)).ShouldBeFalse();
        }

        (await client.SendAsync(Unsigned($"/webhooks/atera/{AteraKey}", body), Ct)).StatusCode.ShouldBe(HttpStatusCode.NoContent);

        await using var read = factory.Services.CreateAsyncScope();
        var db = read.ServiceProvider.GetRequiredService<IntegrationDbContext>();
        (await db.EarlyReadTargets.AsNoTracking().SingleAsync(t => t.ExternalId == ticket, Ct)).Job.ShouldBe(AteraTicketConversationSyncJob.JobId);
        (await db.EarlyReadRequests.AsNoTracking().SingleAsync(r => r.System == AteraTypes.System && r.Job == AteraTicketConversationSyncJob.JobId, Ct))
            .IsWaiting.ShouldBeTrue();
    }

    [Fact]
    public async Task Crm_web_refuses_to_start_with_a_webhook_switched_on_and_no_secret()
    {
        await using var host = factory.WithWebHostBuilder(builder =>
        {
            builder.UseSetting("Integrations:Huntress:Enabled", "true");
            builder.UseSetting("Integrations:Huntress:WebhookEnabled", "true");
            builder.UseSetting("Integrations:Huntress:WebhookSecret", "not-a-signing-secret");
        });

        var refused = Should.Throw<InvalidOperationException>(() => host.CreateClient());
        refused.Message.ShouldContain("Integrations:Huntress:WebhookSecret");
        refused.Message.ShouldNotContain("not-a-signing-secret");
    }

    [Fact]
    public async Task A_ticket_an_atera_webhook_names_is_read_by_its_id_even_when_the_list_of_changes_does_not_name_it()
    {
        await using var host = AteraTicketHost.Start(factory, configure: builder =>
        {
            builder.UseSetting("Integrations:Atera:WebhookEnabled", "true");
            builder.UseSetting("Integrations:Atera:WebhookKey", AteraKey);
        });
        var ticket = await host.TicketAsync();
        namedTickets.Add(ticket.TicketId.ToString(CultureInfo.InvariantCulture));
        // Atera's list of changed tickets does not name it (whether a change moves it there at once is not confirmed, EXT-03).
        host.On("GET", "/api/v3/tickets/lastmodified").RespondWith(JsonReply(new { items = Array.Empty<object>(), totalPages = 1 }));
        host.On("GET", $"/api/v3/tickets/{ticket.TicketId}/comments").RespondWith(JsonReply(new
        {
            items = new object[] { new { CommentID = "w-1", CommentText = "Synthetic reply", CommentDate = DateTimeOffset.UtcNow.AddMinutes(-1), EnduserID = 7 } },
            totalPages = 1,
        }));
        using (var webhook = host.Client())
        {
            (await webhook.SendAsync(Unsigned($"/webhooks/atera/{AteraKey}", $$"""{"TicketID":{{ticket.TicketId}}}"""), Ct)).StatusCode
                .ShouldBe(HttpStatusCode.NoContent);
        }

        await using (var scope = host.Services.CreateAsyncScope())
        {
            await scope.ServiceProvider.GetRequiredService<AteraTicketConversationSyncJob>().RunAsync(Ct);
        }

        host.Atera.LogEntries.ShouldContain(e => e.RequestMessage!.Path == $"/api/v3/tickets/{ticket.TicketId}");
        var comments = await (await host.Client().GetAsync($"/api/v1/service/tickets/{ticket.MirrorId}/comments", Ct)).ReadJsonAsync();
        comments.GetProperty("items").EnumerateArray().Select(c => c.GetProperty("text").GetString()).ShouldBe(["Synthetic reply"]);
        // Read: it is not asked for again.
        await using var read = factory.Services.CreateAsyncScope();
        (await read.ServiceProvider.GetRequiredService<IntegrationDbContext>().EarlyReadTargets
            .AnyAsync(t => t.ExternalId == ticket.TicketId.ToString(CultureInfo.InvariantCulture), Ct)).ShouldBeFalse();
    }
}
