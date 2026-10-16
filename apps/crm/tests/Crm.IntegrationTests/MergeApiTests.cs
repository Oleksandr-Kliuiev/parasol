using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crm.Authorization;

namespace Crm.IntegrationTests;

public class MergeApiTests(CrmWebFactory factory)
{
    private const string Organizations = "/api/v1/customers/organizations";

    private async Task<Guid> CreateAsync(HttpClient client, object body)
    {
        var response = await client.PostAsJsonAsync(Organizations, body);
        response.EnsureSuccessStatusCode();
        return (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
    }

    private static object Org(string name, string? orgNumber, string domain, string status = "Prospect") => new
    {
        name,
        orgNumber,
        status,
        email = $"post@{domain}",
        domains = new[] { domain },
    };

    [Fact]
    public async Task Duplicates_are_found_merged_and_the_merge_can_be_undone()
    {
        var marker = $"mrg{Guid.NewGuid():N}"[..11];
        var domain = $"{marker}.no";
        var management = factory.ClientAs(CrmRoles.Management);
        var orgNumber = TestData.OrgNumber();
        var targetId = await CreateAsync(management, Org($"{marker} Havbris AS", null, domain));
        var sourceId = await CreateAsync(management, Org($"{marker} Havbris", orgNumber, domain, "Customer"));

        var sourceContact = await management.PostAsJsonAsync($"{Organizations}/{sourceId}/contacts",
            new { firstName = "Per", lastName = marker, email = $"per@{domain}", roles = new[] { "Billing" }, isPrimary = true });
        sourceContact.EnsureSuccessStatusCode();

        // Found from both sides, with the reasons
        var duplicates = await management.GetFromJsonAsync<JsonElement>($"{Organizations}/duplicates?organizationId={targetId}");
        var pair = duplicates.GetProperty("items").EnumerateArray().ShouldHaveSingleItem();
        pair.GetProperty("reasons").EnumerateArray().Select(r => r.GetString()).ShouldBe(["SameName", "SharedDomain", "SameEmailDomain"]);

        // Sales may not merge
        (await factory.ClientAs(CrmRoles.Sales).PostAsJsonAsync($"{Organizations}/{targetId}/merge", new { sourceOrganizationId = sourceId }))
            .StatusCode.ShouldBe(HttpStatusCode.Forbidden);

        var merged = await management.PostAsJsonAsync($"{Organizations}/{targetId}/merge", new { sourceOrganizationId = sourceId });
        merged.StatusCode.ShouldBe(HttpStatusCode.OK);
        var merge = await merged.Content.ReadFromJsonAsync<JsonElement>();
        merge.GetProperty("movedContacts").GetInt32().ShouldBe(1);

        var target = await management.GetFromJsonAsync<JsonElement>($"{Organizations}/{targetId}");
        target.GetProperty("orgNumber").GetString().ShouldBe(orgNumber);
        target.GetProperty("status").GetString().ShouldBe("Customer");
        (await management.GetFromJsonAsync<JsonElement>($"{Organizations}/{targetId}/contacts")).GetArrayLength().ShouldBe(1);

        var gone = await management.GetAsync($"{Organizations}/{sourceId}");
        gone.StatusCode.ShouldBe(HttpStatusCode.NotFound);
        var problem = await gone.Content.ReadFromJsonAsync<JsonElement>();
        problem.GetProperty("code").GetString().ShouldBe("CUS_ORGANIZATION_MERGED");
        problem.GetProperty("mergedIntoId").GetGuid().ShouldBe(targetId);

        (await management.GetFromJsonAsync<JsonElement>($"{Organizations}/duplicates?organizationId={targetId}")).GetProperty("items").GetArrayLength().ShouldBe(0);

        // Undo restores both organizations and moves the contact back
        var mergeId = merge.GetProperty("mergeId").GetGuid();
        var merges = await management.GetFromJsonAsync<JsonElement>($"{Organizations}/merges?limit=200");
        merges.GetProperty("items").EnumerateArray().Single(m => m.GetProperty("id").GetGuid() == mergeId).GetProperty("canUndo").GetBoolean().ShouldBeTrue();

        (await management.PostAsync($"{Organizations}/merges/{mergeId}/undo", null)).StatusCode.ShouldBe(HttpStatusCode.NoContent);

        var restoredSource = await management.GetFromJsonAsync<JsonElement>($"{Organizations}/{sourceId}");
        restoredSource.GetProperty("orgNumber").GetString().ShouldBe(orgNumber);
        var restoredTarget = await management.GetFromJsonAsync<JsonElement>($"{Organizations}/{targetId}");
        restoredTarget.GetProperty("orgNumber").ValueKind.ShouldBe(JsonValueKind.Null);
        restoredTarget.GetProperty("status").GetString().ShouldBe("Prospect");
        (await management.GetFromJsonAsync<JsonElement>($"{Organizations}/{sourceId}/contacts")).GetArrayLength().ShouldBe(1);
        (await management.GetFromJsonAsync<JsonElement>($"{Organizations}/{targetId}/contacts")).GetArrayLength().ShouldBe(0);

        (await management.PostAsync($"{Organizations}/merges/{mergeId}/undo", null)).StatusCode.ShouldBe(HttpStatusCode.Conflict);
    }

    [Fact]
    public async Task Undo_is_refused_when_the_target_was_edited_after_the_merge()
    {
        var marker = $"mre{Guid.NewGuid():N}"[..11];
        var domain = $"{marker}.no";
        var management = factory.ClientAs(CrmRoles.Management);
        var targetId = await CreateAsync(management, Org($"{marker} Target AS", null, domain));
        var sourceId = await CreateAsync(management, Org($"{marker} Source AS", null, domain));
        var mergeId = (await (await management.PostAsJsonAsync($"{Organizations}/{targetId}/merge", new { sourceOrganizationId = sourceId }))
            .Content.ReadFromJsonAsync<JsonElement>()).GetProperty("mergeId").GetGuid();

        var read = await management.GetAsync($"{Organizations}/{targetId}");
        var edit = new HttpRequestMessage(HttpMethod.Put, $"{Organizations}/{targetId}") { Content = JsonContent.Create(Org($"{marker} Target Renamed AS", null, domain)) };
        edit.Headers.IfMatch.ParseAdd(read.Headers.ETag!.Tag);
        (await management.SendAsync(edit)).EnsureSuccessStatusCode();

        var undo = await management.PostAsync($"{Organizations}/merges/{mergeId}/undo", null);

        undo.StatusCode.ShouldBe(HttpStatusCode.Conflict);
        (await undo.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString().ShouldBe("CUS_MERGE_TARGET_CHANGED");
    }

    [Fact]
    public async Task Dismissed_pairs_are_no_longer_reported()
    {
        var marker = $"dsm{Guid.NewGuid():N}"[..11];
        var sales = factory.ClientAs(CrmRoles.Sales);
        var a = await CreateAsync(sales, Org($"{marker} Kystlys AS", null, $"{marker}.no"));
        var b = await CreateAsync(sales, Org($"{marker} Kystlys", null, $"{marker}-other.no"));
        var pairs = await sales.GetFromJsonAsync<JsonElement>($"{Organizations}/duplicates?organizationId={a}");
        pairs.GetProperty("items").GetArrayLength().ShouldBe(1);
        pairs.GetProperty("totalCount").GetInt32().ShouldBe(1);

        (await sales.PostAsJsonAsync($"{Organizations}/duplicates/dismissals", new { organizationId = b, otherOrganizationId = a }))
            .StatusCode.ShouldBe(HttpStatusCode.NoContent);

        (await sales.GetFromJsonAsync<JsonElement>($"{Organizations}/duplicates?organizationId={a}")).GetProperty("items").GetArrayLength().ShouldBe(0);
    }

    [Fact]
    public async Task Organizations_with_different_org_numbers_cannot_be_merged()
    {
        var management = factory.ClientAs(CrmRoles.Management);
        var a = await CreateAsync(management, Org("Entity One AS", TestData.OrgNumber(), "entity-one.no"));
        var b = await CreateAsync(management, Org("Entity Two AS", TestData.OrgNumber(), "entity-two.no"));

        var response = await management.PostAsJsonAsync($"{Organizations}/{a}/merge", new { sourceOrganizationId = b });

        response.StatusCode.ShouldBe(HttpStatusCode.Conflict);
        (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString().ShouldBe("CUS_MERGE_DIFFERENT_ORGNR");
    }
}
