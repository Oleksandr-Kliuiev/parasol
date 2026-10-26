using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crm.Authorization;
using Crm.Infrastructure.Persistence;
using Crm.Notifications.Features;
using Crm.Sales.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using WireMock.RequestBuilders;
using WireMock.ResponseBuilders;
using static Crm.IntegrationTests.IntegrationTestHelpers;

namespace Crm.IntegrationTests;

/// <summary>
/// Microsoft 365 for the people who work here (S10): meetings in the organizer's calendar (FR-ACT-02), the customer's
/// correspondence read from the mailbox (FR-ACT-03), the SharePoint folder (FR-DOC-01) and Teams channels (FR-ACT-04).
/// </summary>
public class OutlookApiTests(CrmWebFactory factory)
{
    private const string Activities = "/api/v1/activities";

    private static string Graph(string path) => $"/graph/v1.0/{path}";

    [Fact]
    public async Task A_meeting_goes_into_the_calendar_follows_outlook_and_can_be_taken_out_again()
    {
        var sales = factory.ClientAs(CrmRoles.Sales, userKey: "outlook-sales");
        var marker = $"M{Guid.NewGuid():N}"[..10];
        var organizationId = await sales.CreateOrganizationAsync(new { name = $"{marker} Møte AS", status = "Customer" });
        var starts = new DateTimeOffset(2027, 4, 12, 9, 0, 0, TimeSpan.Zero);

        factory.Graph.Given(Request.Create().WithPath(Graph("me/events")).UsingPost())
            .RespondWith(JsonReply(new
            {
                id = $"event-{marker}",
                subject = $"{marker} Oppstart",
                start = new { dateTime = "2027-04-12T09:00:00.0000000", timeZone = "UTC" },
                end = new { dateTime = "2027-04-12T10:00:00.0000000", timeZone = "UTC" },
                isCancelled = false,
                webLink = "https://outlook.office.com/calendar/item/1",
            }, 201));

        var created = await (await sales.PostAsJsonAsync($"{Activities}/", new
        {
            type = "Meeting", organizationId, subject = $"{marker} Oppstart", body = "Agenda", dueAt = starts,
            priority = "Normal", durationMinutes = 60, location = "Teams", addToCalendar = true,
        })).ReadJsonAsync();
        var activityId = created.GetProperty("id").GetGuid();
        created.GetProperty("inCalendar").GetBoolean().ShouldBeTrue();
        created.GetProperty("webLink").GetString().ShouldBe("https://outlook.office.com/calendar/item/1");

        // The event carries the activity id in an open extension and invites nobody but the organizer here.
        var sent = factory.Graph.LogEntries
            .Select(e => e.RequestMessage)
            .Where(r => r!.Path == Graph("me/events") && r.Method == "POST")
            .Select(r => JsonDocument.Parse(r!.Body ?? "{}").RootElement)
            .Single(e => e.GetProperty("subject").GetString() == $"{marker} Oppstart");
        sent.GetProperty("extensions")[0].GetProperty("activityId").GetString().ShouldBe(activityId.ToString());
        sent.GetProperty("start").GetProperty("dateTime").GetString().ShouldBe("2027-04-12T09:00:00");

        // Outlook wins for time and subject: the meeting was moved an hour later and shortened there (FR-ACT-02).
        factory.Graph.Given(Request.Create().WithPath(Graph("me/calendarView")).UsingGet())
            .RespondWith(JsonReply(new
            {
                value = new[]
                {
                    new
                    {
                        id = $"event-{marker}",
                        subject = $"{marker} Oppstart, flyttet",
                        start = new { dateTime = "2027-04-12T10:00:00.0000000", timeZone = "UTC" },
                        end = new { dateTime = "2027-04-12T10:30:00.0000000", timeZone = "UTC" },
                        isCancelled = false,
                        webLink = "https://outlook.office.com/calendar/item/1",
                        extensions = new[] { new { extensionName = "no.vardahei.crm", activityId = activityId.ToString() } },
                    },
                },
            }));

        var synced = await (await sales.PostAsync($"{Activities}/calendar/sync?days=400", null)).ReadJsonAsync();
        synced.GetProperty("updated").GetInt32().ShouldBeGreaterThanOrEqualTo(1);

        var after = (await sales.GetFromJsonAsync<JsonElement>($"{Activities}/?organizationId={organizationId}")).GetProperty("items").EnumerateArray()
            .Single(a => a.GetProperty("id").GetGuid() == activityId);
        after.GetProperty("subject").GetString().ShouldBe($"{marker} Oppstart, flyttet");
        after.GetProperty("dueAt").GetDateTimeOffset().ShouldBe(new DateTimeOffset(2027, 4, 12, 10, 0, 0, TimeSpan.Zero));
        after.GetProperty("durationMinutes").GetInt32().ShouldBe(30);

        factory.Graph.Given(Request.Create().WithPath(Graph($"me/events/event-{marker}")).UsingDelete())
            .RespondWith(Response.Create().WithStatusCode(204));
        var removed = await (await sales.DeleteAsync($"{Activities}/{activityId}/calendar")).ReadJsonAsync();
        removed.GetProperty("inCalendar").GetBoolean().ShouldBeFalse();
    }

    [Fact]
    public async Task The_customers_mail_is_read_live_and_saved_with_metadata_only()
    {
        var sales = factory.ClientAs(CrmRoles.Sales, userKey: "outlook-mail");
        var marker = $"P{Guid.NewGuid():N}"[..10];
        var organizationId = await sales.CreateOrganizationAsync(new { name = $"{marker} Post AS", status = "Customer" });
        var email = $"kari.{marker.ToLowerInvariant()}@kunde.no";
        (await sales.PostAsJsonAsync($"/api/v1/customers/organizations/{organizationId}/contacts", new
        {
            firstName = "Kari", lastName = marker, email, roles = Array.Empty<string>(), isPrimary = true,
        })).StatusCode.ShouldBe(HttpStatusCode.Created);

        factory.Graph.Given(Request.Create().WithPath(Graph("me/messages")).UsingGet())
            .RespondWith(JsonReply(new
            {
                value = new[]
                {
                    new
                    {
                        id = "msg-1",
                        internetMessageId = $"<{marker}@kunde.no>",
                        subject = $"{marker} Tilbud på drift",
                        bodyPreview = "Hei, takk for sist.",
                        from = new { emailAddress = new { address = email, name = "Kari Hansen" } },
                        toRecipients = new[] { new { emailAddress = new { address = "ola@vardahei.no", name = "Ola" } } },
                        receivedDateTime = "2027-02-01T08:15:00Z",
                        hasAttachments = true,
                        webLink = "https://outlook.office.com/mail/1",
                    },
                },
            }));

        var mail = await sales.GetFromJsonAsync<JsonElement>($"{Activities}/mail?organizationId={organizationId}");
        mail.GetProperty("searched").EnumerateArray().Select(s => s.GetString()).ShouldBe([email]);
        mail.GetProperty("notSearched").GetInt32().ShouldBe(0);
        var message = mail.GetProperty("messages").EnumerateArray().Single(m => m.GetProperty("messageId").GetString() == $"<{marker}@kunde.no>");
        message.GetProperty("fromAddress").GetString().ShouldBe(email);
        message.GetProperty("hasAttachments").GetBoolean().ShouldBeTrue();
        message.GetProperty("isSaved").GetBoolean().ShouldBeFalse();

        var saved = await sales.PostAsJsonAsync($"{Activities}/mail/save", new
        {
            organizationId,
            messageId = $"<{marker}@kunde.no>",
            subject = $"{marker} Tilbud på drift",
            preview = "Hei, takk for sist.",
            fromAddress = email,
            fromName = "Kari Hansen",
            receivedAt = "2027-02-01T08:15:00Z",
            webLink = "https://outlook.office.com/mail/1",
        });
        saved.StatusCode.ShouldBe(HttpStatusCode.Created);
        var activity = await saved.ReadJsonAsync();
        activity.GetProperty("type").GetString().ShouldBe("Email");
        activity.GetProperty("status").GetString().ShouldBe("Done");
        activity.GetProperty("fromAddress").GetString().ShouldBe(email);

        // The same message is never saved twice, and the list says it is already there.
        (await sales.PostAsJsonAsync($"{Activities}/mail/save", new
        {
            organizationId, messageId = $"<{marker}@kunde.no>", subject = "Duplikat", fromAddress = email,
            receivedAt = "2027-02-01T08:15:00Z",
        })).StatusCode.ShouldBe(HttpStatusCode.Conflict);
        (await sales.GetFromJsonAsync<JsonElement>($"{Activities}/mail?organizationId={organizationId}")).GetProperty("messages").EnumerateArray()
            .Single(m => m.GetProperty("messageId").GetString() == $"<{marker}@kunde.no>")
            .GetProperty("isSaved").GetBoolean().ShouldBeTrue();
    }

    [Fact]
    public async Task The_mail_search_asks_for_the_domain_first_and_says_which_addresses_it_left_out()
    {
        var sales = factory.ClientAs(CrmRoles.Sales, userKey: "outlook-mail-terms");
        var marker = $"T{Guid.NewGuid():N}"[..10].ToLowerInvariant();
        var domain = $"{marker}.no";
        var organizationId = await sales.CreateOrganizationAsync(new { name = $"{marker} Domene AS", status = "Customer", domains = new[] { domain } });
        // One contact at the customer's domain (the domain search finds them) and seven elsewhere — more than the five
        // address terms left once the domain has one.
        var addresses = new[] { $"kari@{domain}" }.Concat(Enumerable.Range(0, 7).Select(i => $"person{i}@{marker}-privat{i}.no")).ToList();
        foreach (var (address, index) in addresses.Select((a, i) => (a, i)))
        {
            (await sales.PostAsJsonAsync($"/api/v1/customers/organizations/{organizationId}/contacts", new
            {
                firstName = "Kontakt", lastName = $"{marker}{index}", email = address, roles = Array.Empty<string>(), isPrimary = index == 0,
            })).StatusCode.ShouldBe(HttpStatusCode.Created);
        }

        factory.Graph.Given(Request.Create().WithPath(Graph("me/messages")).UsingGet()).RespondWith(JsonReply(new { value = Array.Empty<object>() }));
        var mail = await sales.GetFromJsonAsync<JsonElement>($"{Activities}/mail?organizationId={organizationId}");

        var searched = mail.GetProperty("searched").EnumerateArray().Select(s => s.GetString()!).ToList();
        searched[0].ShouldBe(domain);
        searched.Count.ShouldBe(6);
        searched.ShouldNotContain($"kari@{domain}", "the domain already covers her");
        mail.GetProperty("notSearched").GetInt32().ShouldBe(2);
        var asked = factory.Graph.LogEntries
            .Select(e => e.RequestMessage!)
            .Where(r => r.Path == Graph("me/messages") && r.Query is not null && r.Query.TryGetValue("$search", out var terms) && terms.ToString().Contains(marker, StringComparison.Ordinal))
            .Select(r => r.Query!["$search"].ToString())
            .ToList();
        asked.Count.ShouldBe(6, "one request per searched term, no more");
    }

    [Fact]
    public async Task A_customer_gets_a_sharepoint_folder_and_the_card_lists_it()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "outlook-admin");
        var marker = $"D{Guid.NewGuid():N}"[..10];
        var orgNumber = TestData.OrgNumber();
        var folderId = $"folder-{marker}";

        // Every test in the suite creates organizations, and the folder handler answers for all of them; the stub is
        // therefore matched on this test's own folder name so it cannot adopt somebody else's customer.
        factory.Graph.Given(Request.Create().WithPath(Graph("drives/drive-1/root/children")).UsingPost()
                .WithBody(new WireMock.Matchers.WildcardMatcher($"*{marker}*")))
            .RespondWith(JsonReply(new { id = folderId, name = $"{marker} Dokument AS ({orgNumber})", webUrl = "https://vardahei.sharepoint.com/kunder/1", folder = new { childCount = 0 } }, 201));
        factory.Graph.Given(Request.Create().WithPath(Graph($"drives/drive-1/items/{folderId}")).UsingGet())
            .RespondWith(JsonReply(new { id = folderId, name = $"{marker} Dokument AS ({orgNumber})", webUrl = "https://vardahei.sharepoint.com/kunder/1", folder = new { childCount = 1 } }));
        factory.Graph.Given(Request.Create().WithPath(Graph($"drives/drive-1/items/{folderId}/children")).UsingGet())
            .RespondWith(JsonReply(new
            {
                value = new object[]
                {
                    new { id = "file-1", name = "Avtale.pdf", size = 20480, webUrl = "https://vardahei.sharepoint.com/kunder/1/Avtale.pdf", lastModifiedDateTime = "2027-01-05T10:00:00Z", lastModifiedBy = new { user = new { displayName = "Ola Nordmann" } } },
                    new { id = "sub-1", name = "Tilbud", size = 0, webUrl = "https://vardahei.sharepoint.com/kunder/1/Tilbud", folder = new { childCount = 2 }, lastModifiedDateTime = "2027-01-06T10:00:00Z", lastModifiedBy = new { user = new { displayName = "Kari" } } },
                },
            }));

        var organizationId = await admin.CreateOrganizationAsync(new { name = $"{marker} Dokument AS", status = "Customer", orgNumber });
        await factory.EventuallyAsync(async () =>
            (await admin.GetFromJsonAsync<JsonElement>($"/api/v1/customers/organizations/{organizationId}/documents"))
            .GetProperty("folder").ValueKind != JsonValueKind.Null);

        var documents = await admin.GetFromJsonAsync<JsonElement>($"/api/v1/customers/organizations/{organizationId}/documents");
        documents.GetProperty("available").GetBoolean().ShouldBeTrue();
        documents.GetProperty("folder").GetProperty("name").GetString().ShouldBe($"{marker} Dokument AS ({orgNumber})");
        var items = documents.GetProperty("items").EnumerateArray().ToList();
        items.Count.ShouldBe(2);
        // Folders come first, then files by name.
        items[0].GetProperty("isFolder").GetBoolean().ShouldBeTrue();
        items[1].GetProperty("name").GetString().ShouldBe("Avtale.pdf");
        items[1].GetProperty("size").GetInt64().ShouldBe(20480);
    }

    [Fact]
    public async Task A_big_won_deal_is_announced_in_the_sales_channel_and_a_small_one_is_not()
    {
        var sales = factory.ClientAs(CrmRoles.Sales, userKey: "outlook-teams");
        var marker = $"T{Guid.NewGuid():N}"[..10];
        factory.Graph.Given(Request.Create().WithPath("/teams/sales").UsingPost()).RespondWith(Response.Create().WithStatusCode(202));
        var organizationId = await sales.CreateOrganizationAsync(new { name = $"{marker} Teams AS", status = "Customer" });
        var stages = await sales.GetFromJsonAsync<JsonElement>("/api/v1/sales/stages");
        var firstStage = stages.EnumerateArray().First(s => !s.GetProperty("isWon").GetBoolean() && !s.GetProperty("isLost").GetBoolean()).GetProperty("id").GetGuid();
        var wonStage = stages.EnumerateArray().First(s => s.GetProperty("isWon").GetBoolean()).GetProperty("id").GetGuid();

        async Task<Guid> WinAsync(string name, decimal oneOff, decimal mrr)
        {
            var deal = await (await sales.PostAsJsonAsync("/api/v1/sales/opportunities", new
            {
                organizationId, name, businessLine = "Msp", stageId = firstStage, expectedCloseDate = "2027-03-01",
                oneOffAmount = oneOff, mrr, termMonths = 12,
            })).ReadJsonAsync();
            var id = deal.GetProperty("id").GetGuid();
            (await sales.PostAsJsonAsync($"/api/v1/sales/opportunities/{id}/stage", new { stageId = wonStage })).StatusCode.ShouldBe(HttpStatusCode.OK);
            return id;
        }

        var big = await WinAsync($"{marker} Stor avtale", 50_000m, 10_000m);
        await WinAsync($"{marker} Liten avtale", 5_000m, 0m);
        await factory.ProcessEventsAsync();
        // The handler queues the card; crm-worker sends the queue every minute (DEV-07), the oldest cards first.
        await factory.SendChannelPostsUntilAsync(() => Task.FromResult(Cards().Count > 0));

        List<string> Cards() => factory.Graph.LogEntries
            .Select(e => e.RequestMessage)
            .Where(r => r!.Path == "/teams/sales" && r.Method == "POST")
            .Select(r => r!.Body ?? string.Empty)
            .Where(body => body.Contains(marker, StringComparison.Ordinal))
            .ToList();

        var cards = Cards();
        cards.Count.ShouldBe(1, "only the deal worth 170 000 NOK passes the 100 000 threshold");
        cards[0].ShouldContain("Salg vunnet");
        cards[0].ShouldContain($"{marker} Teams AS");

        // The event arrives again (the worker stopped before acknowledging it): the handler's receipt keeps the card single.
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            await scope.ServiceProvider.GetRequiredService<SalesDbContext>().OutboxMessages
                .Where(m => m.Type.Contains("OpportunityWon") && m.Payload.Contains(big.ToString()))
                .ExecuteUpdateAsync(s => s
                    .SetProperty(m => m.Status, OutboxStatus.Processing)
                    .SetProperty(m => m.ProcessedAt, (DateTimeOffset?)null)
                    .SetProperty(m => m.DeliveredHandlers, (string?)null)
                    .SetProperty(m => m.LockedUntil, DateTimeOffset.UtcNow.AddMinutes(-1)));
        }

        await factory.ProcessEventsAsync();
        await factory.RunJobAsync<ChannelPostJob>(job => job.RunAsync(CancellationToken.None));
        Cards().Count.ShouldBe(1);
    }
}
