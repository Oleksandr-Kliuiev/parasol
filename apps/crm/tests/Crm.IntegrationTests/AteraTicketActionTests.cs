using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crm.Integrations.Atera;
using Crm.Integrations.Core;
using Crm.Integrations.Core.Actions;
using Crm.Integrations.Core.Persistence;
using Crm.Service.Contracts;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using WireMock.RequestBuilders;
using WireMock.ResponseBuilders;
using static Crm.IntegrationTests.IntegrationTestHelpers;

namespace Crm.IntegrationTests;

/// <summary>
/// M39.2: Atera tickets worked from the CRM through the one action path — a reply and an internal note written as the person's Atera
/// technician, status, priority, technician and closing — against an Atera stub, and the conversation read back into the mirror.
/// </summary>
public class AteraTicketActionTests(CrmWebFactory factory)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static void Comments(AteraTicketHost host, TestTicket ticket, params object[] comments) =>
        host.On("GET", $"/api/v3/tickets/{ticket.TicketId}/comments")
            .RespondWith(JsonReply(new { items = comments, totalPages = 1 }));

    [Fact]
    public async Task A_reply_is_written_as_the_persons_technician_and_read_back_into_the_conversation()
    {
        await using var host = AteraTicketHost.Start(factory);
        var ticket = await host.TicketAsync();
        await host.MapTechnicianAsync();
        host.On("POST", $"/api/v3/tickets/{ticket.TicketId}/comments").RespondWith(JsonReply(new { ActionID = 900 }));
        Comments(host, ticket,
            new { CommentID = 899, CommentText = "Skriveren svarer ikke", CommentDate = DateTimeOffset.UtcNow.AddHours(-3), EnduserID = 55, FirstName = "Kari", LastName = "Kunde" },
            new { CommentID = 900, CommentText = "Vi ser på det nå.", CommentDate = DateTimeOffset.UtcNow, IsInternal = false, TechnicianContactID = host.Technician, TechnicianFullName = "Test Technician" });

        var client = host.Client();
        var preview = await (await client.PostAsJsonAsync("/api/v1/actions/preview", new
        {
            system = "atera", kind = AteraTicketKinds.Reply, targetType = "ticket", targetId = ticket.TicketId.ToString(CultureInfo.InvariantCulture),
            parameters = new { text = "  Vi ser på det nå.  " },
        }, Ct)).ReadJsonAsync();
        preview.GetProperty("target").GetProperty("name").GetString().ShouldBe($"#{ticket.TicketId} Printer is down");
        preview.GetProperty("effects").EnumerateArray().Select(e => e.GetProperty("code").GetString())
            .ShouldBe(["VND_EFFECT_TICKET_REPLY", "VND_EFFECT_TICKET_AUTHOR"]);
        preview.GetProperty("effects")[0].GetProperty("values").GetProperty("to").GetString().ShouldBe("Kari Kunde");

        var action = await host.RunAsync(await host.AskAsync(AteraTicketKinds.Reply, ticket, new { text = "Vi ser på det nå." }));

        action.Status.ShouldBe(VendorActionStatus.Succeeded, action.Outcome);
        action.Reference.ShouldBe("900");
        var posted = host.Posted($"/api/v3/tickets/{ticket.TicketId}/comments");
        posted.GetProperty("CommentText").GetString().ShouldBe("Vi ser på det nå.");
        posted.GetProperty("TechnicianCommentDetails").GetProperty("TechnicianId").GetInt64().ShouldBe(host.Technician);
        posted.GetProperty("TechnicianCommentDetails").GetProperty("IsInternal").GetBoolean().ShouldBeFalse();
        host.Count("POST", $"/api/v3/tickets/{ticket.TicketId}/comments").ShouldBe(1);

        // Read back at once: the conversation shows the reply newest first, the customer's message before it.
        var conversation = await (await client.GetAsync($"/api/v1/service/tickets/{ticket.MirrorId}/comments", Ct)).ReadJsonAsync();
        conversation.GetProperty("totalCount").GetInt32().ShouldBe(2);
        conversation.GetProperty("items")[0].GetProperty("text").GetString().ShouldBe("Vi ser på det nå.");
        conversation.GetProperty("items")[0].GetProperty("author").GetString().ShouldBe("Technician");
        conversation.GetProperty("items")[1].GetProperty("authorName").GetString().ShouldBe("Kari Kunde");
        var detail = await (await client.GetAsync($"/api/v1/service/tickets/{ticket.MirrorId}", Ct)).ReadJsonAsync();
        detail.GetProperty("commentsReadAt").ValueKind.ShouldBe(JsonValueKind.String);
    }

    [Fact]
    public async Task An_internal_note_stays_internal_and_a_person_without_a_technician_cannot_write()
    {
        await using var host = AteraTicketHost.Start(factory);
        var ticket = await host.TicketAsync();
        var client = host.Client();
        var unmapped = await (await client.PostAsJsonAsync("/api/v1/actions/preview", new
        {
            system = "atera", kind = AteraTicketKinds.Note, targetType = "ticket", targetId = ticket.TicketId.ToString(CultureInfo.InvariantCulture),
            parameters = new { text = "Sjekk skriverdriveren" },
        }, Ct)).ReadJsonAsync();
        unmapped.GetProperty("block").GetProperty("code").GetString().ShouldBe("VND_TECHNICIAN_UNMAPPED");

        await host.MapTechnicianAsync();
        host.On("POST", $"/api/v3/tickets/{ticket.TicketId}/comments").RespondWith(JsonReply(new { ActionID = 901 }));
        Comments(host, ticket);
        var action = await host.RunAsync(await host.AskAsync(AteraTicketKinds.Note, ticket, new { text = "Sjekk skriverdriveren" }));

        action.Status.ShouldBe(VendorActionStatus.Succeeded, action.Outcome);
        host.Posted($"/api/v3/tickets/{ticket.TicketId}/comments").GetProperty("TechnicianCommentDetails").GetProperty("IsInternal").GetBoolean().ShouldBeTrue();
    }

    [Fact]
    public async Task Status_priority_and_technician_change_only_what_differs_at_atera()
    {
        await using var host = AteraTicketHost.Start(factory);
        var ticket = await host.TicketAsync();
        await host.MapTechnicianAsync();
        host.On("POST", $"/api/v3/tickets/{ticket.TicketId}").RespondWith(JsonReply(new { ActionID = ticket.TicketId }));
        var path = $"/api/v3/tickets/{ticket.TicketId}";

        var status = await host.RunAsync(await host.AskAsync(AteraTicketKinds.Status, ticket, new { status = "pending" }));
        status.Status.ShouldBe(VendorActionStatus.Succeeded, status.Outcome);
        host.Posted(path).GetProperty("TicketStatus").GetString().ShouldBe("Pending");
        host.Posted(path).EnumerateObject().Select(p => p.Name).ShouldBe(["TicketStatus"]);

        // Atera already shows the asked priority (someone changed it there): nothing is sent.
        host.Live(ticket, priority: "High");
        var priority = await host.RunAsync(await host.AskAsync(AteraTicketKinds.Priority, ticket, new { priority = "High" }));
        priority.Status.ShouldBe(VendorActionStatus.Skipped);
        priority.OutcomeCode.ShouldBe("VND_ALREADY_DONE");
        host.Count("POST", path).ShouldBe(1);

        host.Live(ticket);
        var technician = await host.RunAsync(await host.AskAsync(AteraTicketKinds.Technician, ticket, new { technicianId = host.Technician.ToString(CultureInfo.InvariantCulture) }));
        technician.Status.ShouldBe(VendorActionStatus.Succeeded, technician.Outcome);
        host.Posted(path).GetProperty("TechnicianContactID").GetInt64().ShouldBe(host.Technician);

        var close = await host.RunAsync(await host.AskAsync(AteraTicketKinds.Close, ticket, new { }));
        close.Status.ShouldBe(VendorActionStatus.Succeeded, close.Outcome);
        host.Posted(path).GetProperty("TicketStatus").GetString().ShouldBe("Closed");
        host.Count("POST", path).ShouldBe(3);

        var client = host.Client();
        var unknown = await (await client.PostAsJsonAsync("/api/v1/actions/preview", new
        {
            system = "atera", kind = AteraTicketKinds.Status, targetType = "ticket", targetId = ticket.TicketId.ToString(CultureInfo.InvariantCulture),
            parameters = new { status = "Waiting for Godot" },
        }, Ct)).ReadJsonAsync();
        unknown.GetProperty("block").GetProperty("code").GetString().ShouldBe("VND_VALUE_UNKNOWN");
        (await client.PostAsJsonAsync("/api/v1/actions/preview", new
        {
            system = "atera", kind = AteraTicketKinds.Status, targetType = "ticket", targetId = "999999999", parameters = new { status = "Open" },
        }, Ct)).StatusCode.ShouldBe(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task A_ticket_that_moved_to_another_customer_or_left_atera_is_never_changed()
    {
        await using var host = AteraTicketHost.Start(factory);
        var ticket = await host.TicketAsync();
        host.Live(ticket, customer: ticket.CustomerId + 1);
        var moved = await host.RunAsync(await host.AskAsync(AteraTicketKinds.Priority, ticket, new { priority = "Critical" }));
        moved.Status.ShouldBe(VendorActionStatus.Rejected);
        moved.OutcomeCode.ShouldBe("VND_TICKET_MOVED");

        host.On("GET", $"/api/v3/tickets/{ticket.TicketId}").RespondWith(Response.Create().WithStatusCode(404));
        var gone = await host.RunAsync(await host.AskAsync(AteraTicketKinds.Priority, ticket, new { priority = "Critical" }));
        gone.Status.ShouldBe(VendorActionStatus.Failed);
        gone.OutcomeCode.ShouldBe("VND_TARGET_GONE");
        host.Count("POST", $"/api/v3/tickets/{ticket.TicketId}").ShouldBe(0);
    }

    [Fact]
    public async Task A_refusal_fails_the_reply_and_a_lost_answer_leaves_it_to_a_person()
    {
        await using var host = AteraTicketHost.Start(factory);
        var ticket = await host.TicketAsync();
        await host.MapTechnicianAsync();
        var path = $"/api/v3/tickets/{ticket.TicketId}/comments";
        host.On("POST", path).RespondWith(Response.Create().WithStatusCode(400).WithBody("{\"message\":\"bad\"}"));
        var refused = await host.RunAsync(await host.AskAsync(AteraTicketKinds.Reply, ticket, new { text = "Første forsøk" }));
        refused.Status.ShouldBe(VendorActionStatus.Failed);
        refused.OutcomeCode.ShouldBe("VND_VENDOR_REFUSED");

        // A server error after the request left proves nothing about a write: the comment may exist.
        host.On("POST", path).RespondWith(Response.Create().WithStatusCode(503));
        var lost = await host.RunAsync(await host.AskAsync(AteraTicketKinds.Reply, ticket, new { text = "Andre forsøk" }));
        lost.Status.ShouldBe(VendorActionStatus.Uncertain);
        lost.MayHaveSent.ShouldBeTrue();
        // A write is never repeated on a lost answer: one POST per attempt, two attempts in all.
        host.Count("POST", path).ShouldBe(2);
    }

    [Fact]
    public async Task DryRun_reads_the_ticket_and_sends_nothing_and_writing_off_blocks_the_preview()
    {
        await using (var host = AteraTicketHost.Start(factory, write: false, dryRun: true))
        {
            var ticket = await host.TicketAsync();
            var action = await host.RunAsync(await host.AskAsync(AteraTicketKinds.Status, ticket, new { status = "Resolved" }));
            action.Status.ShouldBe(VendorActionStatus.Simulated);
            host.Count("GET", $"/api/v3/tickets/{ticket.TicketId}").ShouldBe(1);
            host.Count("POST", $"/api/v3/tickets/{ticket.TicketId}").ShouldBe(0);
        }

        await using var off = AteraTicketHost.Start(factory, write: false);
        var other = await off.TicketAsync();
        var preview = await (await off.Client().PostAsJsonAsync("/api/v1/actions/preview", new
        {
            system = "atera", kind = AteraTicketKinds.Status, targetType = "ticket", targetId = other.TicketId.ToString(CultureInfo.InvariantCulture),
            parameters = new { status = "Resolved" },
        }, Ct)).ReadJsonAsync();
        preview.GetProperty("block").GetProperty("code").GetString().ShouldBe("VND_WRITE_DISABLED");
    }
}

/// <summary>M39.2: the conversation reader — a complete read per ticket, a cursor that waits for every conversation, and the summary's reads.</summary>
[Collection(AteraCollection.Name)]
public class AteraConversationSyncTests(CrmWebFactory factory)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static async Task RunAsync(AteraTicketHost host)
    {
        await using var scope = host.Services.CreateAsyncScope();
        await scope.ServiceProvider.GetRequiredService<AteraTicketConversationSyncJob>().RunAsync(Ct);
    }

    [Fact]
    public async Task Reads_that_save_the_same_new_tickets_at_once_all_succeed_with_one_row_each()
    {
        var organizationId = Guid.NewGuid();
        var numbers = Enumerable.Range(0, 5).Select(_ => TestData.AteraId()).ToList();
        var tickets = numbers.Select(n => new ExternalTicket("atera", n, organizationId, null, $"Samtidig {n}", "Open", "Medium", null, "Incident", "Email",
            null, null, null, null, DateTimeOffset.UtcNow.AddHours(-1), null, null, DateTimeOffset.UtcNow, null)).ToList();

        // Eight reads at once, as the open, recent and conversation reads and a run started by hand can be: none fails.
        await Task.WhenAll(Enumerable.Range(0, 8).Select(async _ =>
        {
            await using var scope = factory.Services.CreateAsyncScope();
            await scope.ServiceProvider.GetRequiredService<IServiceApi>().UpsertTicketsAsync(tickets, Ct);
        }));

        await using var read = factory.Services.CreateAsyncScope();
        (await read.ServiceProvider.GetRequiredService<Crm.Service.Persistence.ServiceDbContext>().Tickets.AsNoTracking()
            .CountAsync(t => t.System == "atera" && numbers.Contains(t.ExternalId), Ct)).ShouldBe(numbers.Count);
    }

    private static async Task<string?> CursorAsync(AteraTicketHost host)
    {
        await using var scope = host.Services.CreateAsyncScope();
        return (await scope.ServiceProvider.GetRequiredService<IntegrationDbContext>().SyncCursors.AsNoTracking()
            .SingleOrDefaultAsync(c => c.System == "atera" && c.Stream == AteraTicketConversationSyncJob.CursorStream, Ct))?.Value;
    }

    private static object Ticket(TestTicket ticket, string status = "Open") => new
    {
        TicketID = ticket.TicketId, CustomerID = ticket.CustomerId, TicketTitle = "Printer is down", TicketStatus = status, TicketPriority = "Medium",
        TicketCreatedDate = DateTimeOffset.UtcNow.AddHours(-3), EndUserEmail = "kari@example.no",
    };

    [Fact]
    public async Task Changed_tickets_bring_their_whole_conversation_and_the_cursor_waits_for_every_one()
    {
        await using var host = AteraTicketHost.Start(factory);
        var first = await host.TicketAsync();
        var second = await host.TicketAsync();
        host.On("GET", "/api/v3/tickets/lastmodified")
            .RespondWith(JsonReply(new { items = new[] { Ticket(first, "Pending"), Ticket(second) }, totalPages = 1 }));
        host.On("GET", $"/api/v3/tickets/{first.TicketId}/comments").RespondWith(JsonReply(new
        {
            items = new object[]
            {
                new { CommentID = "c-1", CommentText = "Hei", CommentDate = DateTimeOffset.UtcNow.AddHours(-2), EnduserID = 7 },
                new { CommentID = "c-2", CommentText = "Internt", CommentDate = DateTimeOffset.UtcNow.AddHours(-1), IsInternal = true },
            },
            totalPages = 1,
        }));
        // The second conversation cannot be read: what it had stays, and the run is not complete.
        host.On("GET", $"/api/v3/tickets/{second.TicketId}/comments").RespondWith(Response.Create().WithStatusCode(500));
        var before = await CursorAsync(host);

        await RunAsync(host);

        var client = host.Client();
        var conversation = await (await client.GetAsync($"/api/v1/service/tickets/{first.MirrorId}/comments", Ct)).ReadJsonAsync();
        conversation.GetProperty("items").EnumerateArray().Select(c => (c.GetProperty("externalId").GetString(), c.GetProperty("isInternal").GetBoolean(), c.GetProperty("author").GetString()))
            .ShouldBe([("c-2", true, "Technician"), ("c-1", false, "EndUser")]);
        (await (await client.GetAsync($"/api/v1/service/tickets/{first.MirrorId}", Ct)).ReadJsonAsync()).GetProperty("status").GetString().ShouldBe("Pending");
        (await (await client.GetAsync($"/api/v1/service/tickets/{second.MirrorId}", Ct)).ReadJsonAsync()).GetProperty("commentsReadAt").ValueKind
            .ShouldBe(JsonValueKind.Null);
        (await CursorAsync(host)).ShouldBe(before, "a run that could not read every conversation keeps the cursor");

        // Next run: every conversation reads; a comment Atera no longer lists is removed, and the cursor moves.
        host.On("GET", $"/api/v3/tickets/{first.TicketId}/comments").RespondWith(JsonReply(new
        {
            items = new object[] { new { CommentID = "c-1", CommentText = "Hei igjen", CommentDate = DateTimeOffset.UtcNow.AddHours(-2), EnduserID = 7 } },
            totalPages = 1,
        }));
        host.On("GET", $"/api/v3/tickets/{second.TicketId}/comments").RespondWith(JsonReply(new { items = Array.Empty<object>(), totalPages = 1 }));
        await RunAsync(host);

        conversation = await (await client.GetAsync($"/api/v1/service/tickets/{first.MirrorId}/comments", Ct)).ReadJsonAsync();
        conversation.GetProperty("items").EnumerateArray().Select(c => c.GetProperty("text").GetString()).ShouldBe(["Hei igjen"]);
        DateTimeOffset.Parse((await CursorAsync(host))!, CultureInfo.InvariantCulture).ShouldBeGreaterThan(DateTimeOffset.UtcNow.AddMinutes(-5));
        host.Atera.LogEntries.ShouldContain(e => e.RequestMessage!.Path == "/api/v3/tickets/lastmodified" && e.RequestMessage.Query!["includeComments"].Contains("false"));
    }

    [Fact]
    public async Task The_drift_summary_names_the_read_of_each_source_instead_of_a_zero()
    {
        await using var host = AteraTicketHost.Start(factory);
        var ticket = await host.TicketAsync();
        var summary = await (await host.Client().GetAsync($"/api/v1/service/organizations/{ticket.OrganizationId}/summary", Ct)).ReadJsonAsync();
        var reads = summary.GetProperty("reads").EnumerateArray().ToDictionary(r => r.GetProperty("source").GetString()!);
        reads.Keys.ShouldBe(["tickets", "alerts", "devices"], ignoreOrder: true);
        foreach (var read in reads.Values)
        {
            read.GetProperty("system").GetString().ShouldBe("atera");
            read.TryGetProperty("startedAt", out _).ShouldBeTrue();
            read.TryGetProperty("complete", out _).ShouldBeTrue();
        }
    }
}
