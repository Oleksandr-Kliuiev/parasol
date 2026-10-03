using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crm.Authorization;

namespace Crm.IntegrationTests;

public class SearchApiTests(CrmWebFactory factory)
{
    [Fact]
    public async Task Finds_organizations_and_contacts_by_words_and_numbers()
    {
        var marker = $"Srch{Guid.NewGuid():N}"[..12];
        var sales = factory.ClientAs(CrmRoles.Sales);
        var orgNumber = TestData.OrgNumber();
        var org = await (await sales.PostAsJsonAsync("/api/v1/customers/organizations", TestData.Organization($"{marker} Fjordkraft AS", orgNumber)))
            .Content.ReadFromJsonAsync<JsonElement>();
        var orgId = org.GetProperty("id").GetGuid();
        (await sales.PostAsJsonAsync($"/api/v1/customers/organizations/{orgId}/contacts", new
        {
            firstName = "Ingrid",
            lastName = marker,
            email = $"{marker.ToLowerInvariant()}@example.no",
            phone = "+47 912 34 567",
            roles = Array.Empty<string>(),
            isPrimary = true,
        })).EnsureSuccessStatusCode();

        var byWords = await sales.GetFromJsonAsync<JsonElement>($"/api/v1/search?q={marker}%20fjordkraft");
        var organizations = Group(byWords, "organizations");
        organizations.ShouldHaveSingleItem().GetProperty("url").GetString().ShouldBe($"/organizations/{orgId}");

        var byName = await sales.GetFromJsonAsync<JsonElement>($"/api/v1/search?q=ingrid%20{marker}");
        var contact = Group(byName, "contacts").ShouldHaveSingleItem();
        contact.GetProperty("subtitle").GetString()!.ShouldContain($"{marker} Fjordkraft AS");

        var byOrgNumber = await sales.GetFromJsonAsync<JsonElement>($"/api/v1/search?q={orgNumber[..3]}%20{orgNumber[3..6]}%20{orgNumber[6..]}");
        Group(byOrgNumber, "organizations").ShouldContain(i => i.GetProperty("id").GetGuid() == orgId);
    }

    [Fact]
    public async Task Query_must_have_two_characters()
    {
        var response = await factory.ClientAs(CrmRoles.ReadOnly).GetAsync("/api/v1/search?q=a");
        response.StatusCode.ShouldBe(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Anonymous_search_is_rejected()
    {
        var response = await factory.AnonymousClient().GetAsync("/api/v1/search?q=fjord");
        response.StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
    }

    private static List<JsonElement> Group(JsonElement response, string name) =>
        response.GetProperty("groups").EnumerateArray()
            .Where(g => g.GetProperty("group").GetString() == name)
            .SelectMany(g => g.GetProperty("items").EnumerateArray())
            .ToList();
}
