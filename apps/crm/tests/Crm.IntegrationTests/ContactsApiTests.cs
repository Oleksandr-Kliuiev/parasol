using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crm.Authorization;

namespace Crm.IntegrationTests;

public class ContactsApiTests(CrmWebFactory factory)
{
    private async Task<Guid> CreateOrganizationAsync(string name)
    {
        var response = await factory.ClientAs(CrmRoles.Sales).PostAsJsonAsync("/api/v1/customers/organizations", TestData.Organization(name));
        response.EnsureSuccessStatusCode();
        return (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
    }

    private static object Contact(string email, bool primary = false, params string[] roles) => new
    {
        firstName = "Kari",
        lastName = "Nordmann",
        email,
        phone = "+47 22 00 00 00",
        title = "IT-ansvarlig",
        roles,
        isPrimary = primary,
    };

    [Fact]
    public async Task Same_person_is_linked_across_organizations_by_email()
    {
        var first = await CreateOrganizationAsync("Contact Org One AS");
        var second = await CreateOrganizationAsync("Contact Org Two AS");
        var technician = factory.ClientAs(CrmRoles.Technician);
        var email = $"kari.{Guid.NewGuid():N}@example.no";

        var created = await technician.PostAsJsonAsync($"/api/v1/customers/organizations/{first}/contacts", Contact(email, true, "Technical"));
        created.StatusCode.ShouldBe(HttpStatusCode.Created);
        var contactId = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("contactId").GetGuid();

        var linked = await technician.PostAsJsonAsync($"/api/v1/customers/organizations/{second}/contacts", Contact(email.ToUpperInvariant(), false, "Billing"));
        var linkedBody = await linked.Content.ReadFromJsonAsync<JsonElement>();
        linkedBody.GetProperty("contactId").GetGuid().ShouldBe(contactId);
        linkedBody.GetProperty("linkedExisting").GetBoolean().ShouldBeTrue();

        var contact = await technician.GetFromJsonAsync<JsonElement>($"/api/v1/customers/contacts/{contactId}");
        contact.GetProperty("affiliations").GetArrayLength().ShouldBe(2);

        var duplicate = await technician.PostAsJsonAsync($"/api/v1/customers/organizations/{first}/contacts", Contact(email));
        duplicate.StatusCode.ShouldBe(HttpStatusCode.Conflict);
    }

    [Fact]
    public async Task Contact_person_can_be_edited_with_etag_from_get()
    {
        var organization = await CreateOrganizationAsync("Contact Edit AS");
        var sales = factory.ClientAs(CrmRoles.Sales);
        var created = await sales.PostAsJsonAsync($"/api/v1/customers/organizations/{organization}/contacts", Contact($"e.{Guid.NewGuid():N}@example.no"));
        var url = $"/api/v1/customers/contacts/{(await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("contactId").GetGuid()}";

        var read = await sales.GetAsync(url);
        var update = new HttpRequestMessage(HttpMethod.Put, url)
        {
            Content = JsonContent.Create(new { firstName = "Kari", lastName = "Hansen", email = (string?)null, phone = "+47 900 00 000", mobilePhone = (string?)null, preferredLanguage = "nb" }),
        };
        update.Headers.IfMatch.ParseAdd(read.Headers.ETag!.Tag);
        var response = await sales.SendAsync(update);

        response.StatusCode.ShouldBe(HttpStatusCode.OK);
        (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("lastName").GetString().ShouldBe("Hansen");
    }

    [Fact]
    public async Task Only_one_primary_contact_per_organization()
    {
        var organization = await CreateOrganizationAsync("Primary Contact AS");
        var sales = factory.ClientAs(CrmRoles.Sales);
        var url = $"/api/v1/customers/organizations/{organization}/contacts";

        (await sales.PostAsJsonAsync(url, Contact($"a.{Guid.NewGuid():N}@example.no", true))).EnsureSuccessStatusCode();
        (await sales.PostAsJsonAsync(url, Contact($"b.{Guid.NewGuid():N}@example.no", true))).EnsureSuccessStatusCode();

        var contacts = await sales.GetFromJsonAsync<JsonElement>(url);
        contacts.EnumerateArray().Count(c => c.GetProperty("isPrimary").GetBoolean()).ShouldBe(1);
    }

    [Fact]
    public async Task Deactivated_contact_is_hidden_by_default()
    {
        var organization = await CreateOrganizationAsync("Inactive Contact AS");
        var sales = factory.ClientAs(CrmRoles.Sales);
        var url = $"/api/v1/customers/organizations/{organization}/contacts";
        var created = await sales.PostAsJsonAsync(url, Contact($"c.{Guid.NewGuid():N}@example.no"));
        var contactId = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("contactId").GetGuid();

        var deactivate = await sales.PutAsJsonAsync($"{url}/{contactId}", new { title = "Sluttet", roles = Array.Empty<string>(), isPrimary = false, isActive = false });
        deactivate.StatusCode.ShouldBe(HttpStatusCode.NoContent);

        (await sales.GetFromJsonAsync<JsonElement>(url)).GetArrayLength().ShouldBe(0);
        (await sales.GetFromJsonAsync<JsonElement>($"{url}?includeInactive=true")).GetArrayLength().ShouldBe(1);
    }

    [Fact]
    public async Task Read_only_user_cannot_add_contacts()
    {
        var organization = await CreateOrganizationAsync("Read Only AS");
        var response = await factory.ClientAs(CrmRoles.ReadOnly)
            .PostAsJsonAsync($"/api/v1/customers/organizations/{organization}/contacts", Contact($"d.{Guid.NewGuid():N}@example.no"));
        response.StatusCode.ShouldBe(HttpStatusCode.Forbidden);
    }
}
