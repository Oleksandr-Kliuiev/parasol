using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crm.Authorization;
using Crm.Identity.Contracts;
using Crm.Integrations.Atera;
using Crm.Integrations.Core.Actions;
using Microsoft.Extensions.DependencyInjection;
using static Crm.IntegrationTests.IntegrationTestHelpers;

namespace Crm.IntegrationTests;

/// <summary>
/// One Atera account for the whole firm (after M39): the technician shared by everyone is the one a person without their own
/// writes as, and what it did maps back to no one. A shared technician is global, so the class runs alone in the Atera collection
/// and ends the sharing it starts.
/// </summary>
[Collection(AteraCollection.Name)]
public class AteraSharedTechnicianTests(CrmWebFactory factory)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task A_person_without_a_technician_writes_as_the_shared_one_and_it_maps_back_to_no_one()
    {
        await using var host = AteraTicketHost.Start(factory);
        var ticket = await host.TicketAsync();
        var admin = host.Client();
        var sharedId = TestData.AteraId().ToString(CultureInfo.InvariantCulture);
        await RegisterAsync(host, sharedId, "Felles Atera");
        var shared = await MappingAsync(admin, sharedId);
        (await PreviewNoteAsync(admin, ticket)).GetProperty("block").GetProperty("code").GetString().ShouldBe("VND_TECHNICIAN_UNMAPPED");
        // The account page says the same before any change: with no technician, nothing is signed in Atera.
        var none = await MineAsync(host.Client(CrmRoles.ReadOnly));
        none.GetProperty("enabled").GetBoolean().ShouldBeTrue();
        none.GetProperty("technician").ValueKind.ShouldBe(JsonValueKind.Null);
        try
        {
            (await admin.PutAsJsonAsync($"/api/v1/identity/technicians/{shared}", new { userId = (Guid?)null, shared = true }, Ct)).StatusCode.ShouldBe(HttpStatusCode.NoContent);
            var mine = (await MineAsync(host.Client(CrmRoles.ReadOnly))).GetProperty("technician");
            mine.GetProperty("name").GetString().ShouldBe("Felles Atera");
            mine.GetProperty("shared").GetBoolean().ShouldBeTrue();
            var listed = await ListedAsync(admin, sharedId);
            listed.GetProperty("shared").GetBoolean().ShouldBeTrue();
            listed.GetProperty("userId").ValueKind.ShouldBe(JsonValueKind.Null);

            var preview = await PreviewNoteAsync(admin, ticket);
            preview.GetProperty("block").ValueKind.ShouldBe(JsonValueKind.Null, preview.ToString());
            var effects = preview.GetProperty("effects").EnumerateArray().Select(e => e.GetProperty("code").GetString()).ToList();
            effects.ShouldContain("VND_EFFECT_SHARED_TECHNICIAN");
            preview.GetProperty("effects").EnumerateArray().Single(e => e.GetProperty("code").GetString() == "VND_EFFECT_TICKET_AUTHOR")
                .GetProperty("values").GetProperty("name").GetString().ShouldBe("Felles Atera");

            host.On("POST", $"/api/v3/tickets/{ticket.TicketId}/comments").RespondWith(JsonReply(new { ActionID = 902 }));
            host.On("GET", $"/api/v3/tickets/{ticket.TicketId}/comments").RespondWith(JsonReply(new { items = Array.Empty<object>(), totalPages = 1 }));
            var action = await host.RunAsync(await host.AskAsync(AteraTicketKinds.Note, ticket, new { text = "Sjekk skriverdriveren" }));
            action.Status.ShouldBe(VendorActionStatus.Succeeded, action.Outcome);
            host.Posted($"/api/v3/tickets/{ticket.TicketId}/comments").GetProperty("TechnicianCommentDetails").GetProperty("TechnicianId").GetInt64()
                .ShouldBe(long.Parse(sharedId, CultureInfo.InvariantCulture));

            // What the shared technician did belongs to no one person: tickets, comments and imported hours stay without a user.
            (await RegisterAsync(host, sharedId, "Felles Atera")).ShouldBeNull();

            // A person with their own technician still writes as their own.
            await host.MapTechnicianAsync();
            var own = await PreviewNoteAsync(admin, ticket);
            own.GetProperty("effects").EnumerateArray().Select(e => e.GetProperty("code").GetString()).ShouldNotContain("VND_EFFECT_SHARED_TECHNICIAN");
            var ownListed = (await MineAsync(admin)).GetProperty("technician");
            ownListed.GetProperty("id").GetString().ShouldBe(host.Technician.ToString(CultureInfo.InvariantCulture));
            ownListed.GetProperty("shared").GetBoolean().ShouldBeFalse();
        }
        finally
        {
            (await admin.PutAsJsonAsync($"/api/v1/identity/technicians/{shared}", new { userId = (Guid?)null }, Ct)).StatusCode.ShouldBe(HttpStatusCode.NoContent);
        }

        (await ListedAsync(admin, sharedId)).GetProperty("shared").GetBoolean().ShouldBeFalse();
    }

    [Fact]
    public async Task One_technician_per_system_is_shared_and_never_together_with_a_person()
    {
        await using var host = AteraTicketHost.Start(factory);
        var admin = host.Client();
        var firstId = TestData.AteraId().ToString(CultureInfo.InvariantCulture);
        var secondId = TestData.AteraId().ToString(CultureInfo.InvariantCulture);
        await RegisterAsync(host, firstId, "Felles en");
        await RegisterAsync(host, secondId, "Felles to");
        var first = await MappingAsync(admin, firstId);
        var second = await MappingAsync(admin, secondId);

        var both = await admin.PutAsJsonAsync($"/api/v1/identity/technicians/{first}", new { userId = Guid.NewGuid(), shared = true }, Ct);
        both.StatusCode.ShouldBe(HttpStatusCode.BadRequest);
        (await both.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe("IDN_SHARED_WITH_USER");
        try
        {
            (await admin.PutAsJsonAsync($"/api/v1/identity/technicians/{first}", new { userId = (Guid?)null, shared = true }, Ct)).StatusCode.ShouldBe(HttpStatusCode.NoContent);

            var taken = await admin.PutAsJsonAsync($"/api/v1/identity/technicians/{second}", new { userId = (Guid?)null, shared = true }, Ct);
            taken.StatusCode.ShouldBe(HttpStatusCode.Conflict);
            (await taken.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe("IDN_SHARED_TECHNICIAN_TAKEN");
            (await ListedAsync(admin, secondId)).GetProperty("shared").GetBoolean().ShouldBeFalse();

            // A shared technician is decided, so it is no longer among the ones waiting for a person.
            (await ListedAsync(admin, firstId, unmappedOnly: true)).ValueKind.ShouldBe(JsonValueKind.Undefined);
        }
        finally
        {
            (await admin.PutAsJsonAsync($"/api/v1/identity/technicians/{first}", new { userId = (Guid?)null }, Ct)).StatusCode.ShouldBe(HttpStatusCode.NoContent);
        }
    }

    /// <summary>The technician as the ticket sync registers it, with an e-mail no user has; the CRM user it maps to (null when none).</summary>
    private static async Task<Guid?> RegisterAsync(AteraTicketHost host, string externalId, string name)
    {
        await using var scope = host.Services.CreateAsyncScope();
        var users = await scope.ServiceProvider.GetRequiredService<ITechnicianDirectory>().ResolveAsync(
            [new TechnicianRef("atera", externalId, $"felles-{externalId}@firm.test", name)], Ct);
        return users[externalId];
    }

    /// <summary>The technician the client's user writes as, as the account page reads it (no permission of its own).</summary>
    private static async Task<JsonElement> MineAsync(HttpClient client) =>
        await client.GetFromJsonAsync<JsonElement>("/api/v1/integrations/atera/technicians/me", Ct);

    private static async Task<Guid> MappingAsync(HttpClient client, string externalId) =>
        (await ListedAsync(client, externalId)).GetProperty("id").GetGuid();

    /// <summary>The technician's row in the mapping list, page by page; an undefined element when the list does not hold it.</summary>
    private static async Task<JsonElement> ListedAsync(HttpClient client, string externalId, bool unmappedOnly = false)
    {
        string? cursor = null;
        do
        {
            var query = $"/api/v1/identity/technicians?limit=100&unmappedOnly={(unmappedOnly ? "true" : "false")}"
                        + (cursor is null ? string.Empty : $"&cursor={Uri.EscapeDataString(cursor)}");
            var page = await (await client.GetAsync(query, Ct)).ReadJsonAsync();
            foreach (var item in page.GetProperty("items").EnumerateArray().Where(item => item.GetProperty("externalId").GetString() == externalId))
            {
                return item.Clone();
            }

            cursor = page.GetProperty("nextCursor").GetString();
        }
        while (cursor is not null);

        return default;
    }

    private static async Task<JsonElement> PreviewNoteAsync(HttpClient client, TestTicket ticket) =>
        await (await client.PostAsJsonAsync("/api/v1/actions/preview", new
        {
            system = "atera", kind = AteraTicketKinds.Note, targetType = "ticket", targetId = ticket.TicketId.ToString(CultureInfo.InvariantCulture),
            parameters = new { text = "Sjekk skriverdriveren" },
        }, Ct)).ReadJsonAsync();
}
