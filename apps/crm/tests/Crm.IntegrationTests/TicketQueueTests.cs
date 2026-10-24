using System.Net.Http.Json;
using System.Text.Json;
using Crm.Authorization;
using Crm.Service.Contracts;

namespace Crm.IntegrationTests;

/// <summary>
/// M39: the ticket queue (<c>/tickets</c>) — open tickets first, then the most recently active (the last message or change the desk
/// reported, else the creation) across pages with ties; search by title, number and the contact as the desk names it; a customer filter.
/// </summary>
public sealed class TicketQueueTests(CrmWebFactory factory)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static ExternalTicket Ticket(
        string system, long id, Guid organizationId, string title, DateTimeOffset createdAt, DateTimeOffset? lastActivityAt, bool open = true,
        string? endUserName = null, string? endUserEmail = null) =>
        new(system, id, organizationId, null, title, open ? "Open" : "Closed", "Medium", null, null, null, null, null, endUserName, endUserEmail,
            createdAt, null, open ? null : createdAt.AddHours(2), lastActivityAt, null);

    [Fact]
    public async Task Open_tickets_come_first_then_the_most_recently_active_across_pages_with_ties()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "m39-ticket-queue");
        var marker = $"Q{Guid.NewGuid():N}"[..9];
        var system = $"queue-{marker}";
        var organizationId = await admin.CreateOrganizationAsync(new { name = $"{marker} Kø AS", status = "Customer" });
        var at = DateTimeOffset.UtcNow.AddDays(-5);
        // 40 open tickets created in one order and active in another, five to an instant; every fourth was never active, so its
        // creation counts. Ten closed ones were active last of all, and still come after every open ticket.
        var open = Enumerable.Range(0, 40).Select(i => Ticket(system, 3_000_000 + i, organizationId, $"{marker} sak {i}", at.AddMinutes(i),
            i % 4 == 0 ? null : at.AddHours(10).AddMinutes(-(i / 5) * 7)));
        var closed = Enumerable.Range(40, 10).Select(i => Ticket(system, 3_000_000 + i, organizationId, $"{marker} sak {i}", at.AddMinutes(i),
            at.AddDays(4), open: false));
        await factory.RunJobAsync<IServiceApi>(api => api.UpsertTicketsAsync([.. open, .. closed], CancellationToken.None));

        var listed = new List<JsonElement>();
        string? cursor = null;
        do
        {
            var page = await admin.GetFromJsonAsync<JsonElement>(
                $"/api/v1/service/tickets?organizationId={organizationId}&limit=7{(cursor is null ? "" : $"&cursor={Uri.EscapeDataString(cursor)}")}", Ct);
            page.GetProperty("totalCount").GetInt32().ShouldBe(50);
            listed.AddRange(page.GetProperty("items").EnumerateArray());
            cursor = page.GetProperty("nextCursor").ValueKind == JsonValueKind.Null ? null : page.GetProperty("nextCursor").GetString();
        }
        while (cursor is not null);

        listed.Select(t => t.GetProperty("id").GetGuid()).Distinct().Count().ShouldBe(50, "every ticket once, ties across page ends included");
        listed.Take(40).ShouldAllBe(t => t.GetProperty("isOpen").GetBoolean());
        static DateTimeOffset Active(JsonElement t) =>
            t.GetProperty("lastActivityAt").ValueKind == JsonValueKind.Null ? t.GetProperty("createdAt").GetDateTimeOffset() : t.GetProperty("lastActivityAt").GetDateTimeOffset();
        var activeOpen = listed.Take(40).Select(Active).ToList();
        activeOpen.ShouldBe(activeOpen.OrderByDescending(a => a).ToList(), "the most recently active open ticket first");
        // A ticket never active counts by its creation: here the oldest, newest of them first.
        listed.Skip(30).Take(10).Select(t => t.GetProperty("externalId").GetInt64())
            .ShouldBe(Enumerable.Range(0, 10).Select(i => 3_000_036L - (i * 4)));
    }

    [Fact]
    public async Task Search_finds_a_ticket_by_title_number_or_its_contact_and_the_customer_filter_narrows_the_queue()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "m39-ticket-search");
        var marker = $"S{Guid.NewGuid():N}"[..9];
        var system = $"search-{marker}";
        var first = await admin.CreateOrganizationAsync(new { name = $"{marker} Første AS", status = "Customer" });
        var second = await admin.CreateOrganizationAsync(new { name = $"{marker} Andre AS", status = "Customer" });
        var at = DateTimeOffset.UtcNow.AddHours(-3);
        var contact = $"Solveig K{marker[1..]}";
        await factory.RunJobAsync<IServiceApi>(api => api.UpsertTicketsAsync(
        [
            Ticket(system, 4_000_001, first, $"{marker} skriveren står", at, null, endUserName: contact, endUserEmail: $"solveig.{marker.ToLowerInvariant()}@kunde.example"),
            Ticket(system, 4_000_002, first, $"{marker} ny bærbar", at.AddMinutes(1), null, endUserName: "Per Hansen"),
            Ticket(system, 4_000_003, second, $"{marker} e-post", at.AddMinutes(2), null, endUserName: "Kari Kunde"),
        ], CancellationToken.None));

        async Task<long[]> FoundAsync(string query) =>
            [.. (await admin.GetFromJsonAsync<JsonElement>($"/api/v1/service/tickets?{query}&limit=50", Ct)).GetProperty("items").EnumerateArray()
                .Select(t => t.GetProperty("externalId").GetInt64()).Order()];

        (await FoundAsync($"search={Uri.EscapeDataString(contact)}")).ShouldBe([4_000_001], "the contact's name as the desk gave it");
        (await FoundAsync($"search={Uri.EscapeDataString($"solveig.{marker.ToLowerInvariant()}@")}")).ShouldBe([4_000_001], "part of the contact's address");
        (await FoundAsync("search=4000002")).ShouldBe([4_000_002], "a number is the ticket's own");
        (await FoundAsync($"search={marker}")).ShouldBe([4_000_001, 4_000_002, 4_000_003]);
        (await FoundAsync($"search={marker}&organizationId={first}")).ShouldBe([4_000_001, 4_000_002], "the customer filter narrows the search");
        (await FoundAsync($"organizationId={second}")).ShouldBe([4_000_003]);
    }
}
