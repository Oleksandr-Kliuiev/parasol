using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crm.Activities.Persistence;
using Crm.Authorization;
using Crm.Notifications.Contracts;
using Crm.Notifications.Domain;
using Crm.Notifications.Features;
using Crm.Notifications.Persistence;
using Crm.SharedKernel.Documents;
using Crm.SharedKernel.Operations;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using WireMock.Matchers;
using WireMock.RequestBuilders;
using static Crm.IntegrationTests.IntegrationTestHelpers;

namespace Crm.IntegrationTests;

/// <summary>
/// DEV-13: what a restored copy forgets about posts, digests and meetings after the restore point, the reconciliation puts right
/// from the external effect journal — the worker posts and e-mails nothing a second time, a meeting is updated rather than put
/// into the calendar again. Database administration: it stages the copy with SQL and reconciles every journal entry after its
/// restore point, so it runs alone.
/// </summary>
[Collection(DatabaseAdministrationCollection.Name)]
public class RestoreReconciliationTests(CrmWebFactory factory)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task DEV13_AC04_the_reconciliation_marks_posts_and_digests_sent_and_links_a_meeting_to_its_event_again()
    {
        var sales = factory.ClientAs(CrmRoles.Sales, userKey: "restore-sales");
        var salesId = await sales.UserIdAsync();
        var marker = $"Y{Guid.NewGuid():N}"[..10];
        var organizationId = await sales.CreateOrganizationAsync(new { name = $"{marker} Avstemt AS", status = "Customer" });
        var restorePoint = DateTimeOffset.UtcNow;

        // After the restore point: a meeting goes to Outlook, a channel post and a digest leave (all journaled as they go).
        factory.Graph.Given(Request.Create().WithPath("/graph/v1.0/me/events").UsingPost().WithBody(new WildcardMatcher($"*{marker}*")))
            .AtPriority(1)
            .RespondWith(JsonReply(new
            {
                id = $"event-{marker}", subject = $"{marker} Oppstart",
                start = new { dateTime = "2027-05-10T09:00:00.0000000", timeZone = "UTC" },
                end = new { dateTime = "2027-05-10T10:00:00.0000000", timeZone = "UTC" },
                isCancelled = false, webLink = "https://outlook.office.com/calendar/item/restore",
            }, 201));
        var meeting = await (await sales.PostAsJsonAsync("/api/v1/activities/", new
        {
            type = "Meeting", organizationId, subject = $"{marker} Oppstart", body = "Agenda", dueAt = new DateTimeOffset(2027, 5, 10, 9, 0, 0, TimeSpan.Zero),
            priority = "Normal", durationMinutes = 60, location = "Teams", addToCalendar = true,
        }, Ct)).ReadJsonAsync();
        var activityId = meeting.GetProperty("id").GetGuid();
        meeting.GetProperty("inCalendar").GetBoolean().ShouldBeTrue();
        // Whichever stub answered (another class may stub the same Graph path), the meeting is linked to that event.
        var linkedEvent = (await GraphEventAsync(activityId)).ShouldNotBeNull();

        var journal = factory.Services.GetRequiredService<IExternalEffectJournal>();
        Guid postId;
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<NotificationsDbContext>();
            var post = ChannelPost.For(TeamsChannel.Sales, new TeamsCard($"{marker} Vunnet", "Avtale signert", [], null, null), DateTimeOffset.UtcNow);
            db.ChannelPosts.Add(post);
            await db.SaveChangesAsync(Ct);
            postId = post.Id;
            (await scope.ServiceProvider.GetRequiredService<INotificationsApi>().EnqueueAsync(new NotificationRequest(
                NotificationKind.StaleOpportunity, salesId, $"restore-{marker}", new Dictionary<string, string> { ["name"] = marker }), Ct)).ShouldBeTrue();
        }

        var posted = await journal.BeginAsync(new ExternalEffect("teams", ChannelPostJob.EffectKind, ChannelPostJob.EffectEntity, postId), Ct);
        await journal.CompleteAsync(posted, EffectPhase.Sent, null, Ct);
        var digest = await journal.BeginAsync(new ExternalEffect("graph", NotificationDigestJob.EffectKind, NotificationDigestJob.EffectEntity, salesId), Ct);
        await journal.CompleteAsync(digest, EffectPhase.Sent, null, Ct);

        // The copy is from before: the meeting without its event, the post and the notice still waiting.
        await factory.AdminSqlAsync($"UPDATE activities.Activities SET GraphEventId = NULL, WebLink = NULL WHERE Id = '{activityId}';");

        var switchStore = new TestDocumentStore();
        try
        {
            await using var host = factory.WithWebHostBuilder(builder => builder.ConfigureTestServices(services =>
                services.AddSingleton<IDocumentStore>(new SplitDocumentStore(switchStore, factory.Documents))));
            var operatorClient = QuoteDocumentsTests.Client(host, CrmRoles.Admin, "restore-admin");
            var maintenance = await (await operatorClient.PutAsJsonAsync("/api/v1/operations/maintenance",
                new { mode = "ReadOnly", reason = "DEV-13 test: reconciling a restore", reference = "DEV-13" }, Ct)).ReadJsonAsync();

            var preview = await (await operatorClient.PostAsJsonAsync("/api/v1/operations/restore/reconcile", new { restorePoint, apply = false }, Ct)).ReadJsonAsync();
            var lines = preview.GetProperty("reconciliation").EnumerateArray().ToList();
            lines.ShouldContain(l => l.GetProperty("subject").GetString() == $"activity {activityId}" && l.GetProperty("action").GetString() == "Would be linked to its event again.");
            lines.ShouldContain(l => l.GetProperty("subject").GetString() == $"channel post {postId}" && l.GetProperty("action").GetString() == "Would be marked sent.");
            lines.ShouldContain(l => l.GetProperty("subject").GetString() == $"digest for user {salesId}");
            (await PostStatusAsync(postId)).ShouldBe(ChannelPostStatus.Pending);
            (await GraphEventAsync(activityId)).ShouldBeNull();

            var applied = await (await operatorClient.PostAsJsonAsync("/api/v1/operations/restore/reconcile", new { restorePoint, apply = true }, Ct)).ReadJsonAsync();
            applied.GetProperty("applied").GetBoolean().ShouldBeTrue();
            (await PostStatusAsync(postId)).ShouldBe(ChannelPostStatus.Sent);
            (await GraphEventAsync(activityId)).ShouldBe(linkedEvent);
            await using (var scope = factory.Services.CreateAsyncScope())
            {
                var notice = await scope.ServiceProvider.GetRequiredService<NotificationsDbContext>().Notifications.AsNoTracking()
                    .SingleAsync(n => n.DedupeKey == $"restore-{marker}", Ct);
                notice.EmailStatus.ShouldBe(EmailStatus.Sent);
            }

            (await operatorClient.PutAsJsonAsync("/api/v1/operations/maintenance", new
            {
                mode = "Normal", reason = "DEV-13 test: reconciliation done", reference = "DEV-13", expectedKey = maintenance.GetProperty("key").GetString(),
            }, Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
        }
        finally
        {
            if (Directory.Exists(switchStore.Root))
            {
                Directory.Delete(switchStore.Root, recursive: true);
            }
        }
    }

    private async Task<ChannelPostStatus> PostStatusAsync(Guid postId)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<NotificationsDbContext>().ChannelPosts.AsNoTracking()
            .Where(p => p.Id == postId).Select(p => p.Status).SingleAsync(Ct);
    }

    private async Task<string?> GraphEventAsync(Guid activityId)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<ActivitiesDbContext>().Activities.AsNoTracking()
            .Where(a => a.Id == activityId).Select(a => a.GraphEventId).SingleAsync(Ct);
    }
}
