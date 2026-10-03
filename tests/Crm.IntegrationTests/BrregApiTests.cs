using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crm.Authorization;
using WireMock.RequestBuilders;
using WireMock.ResponseBuilders;

namespace Crm.IntegrationTests;

public class BrregApiTests(CrmWebFactory factory)
{
    [Fact]
    public async Task Lookup_maps_registry_data_and_status()
    {
        factory.Brreg
            .Given(Request.Create().WithPath("/enhetsregisteret/api/enheter/912345675").UsingGet())
            .RespondWith(Response.Create().WithStatusCode(200).WithHeader("Content-Type", "application/json").WithBody("""
                {
                  "organisasjonsnummer": "912345675",
                  "navn": "NORDLYS DRIFT AS",
                  "organisasjonsform": { "kode": "AS", "beskrivelse": "Aksjeselskap" },
                  "naeringskode1": { "kode": "62.030", "beskrivelse": "Drift av IT-systemer" },
                  "forretningsadresse": { "adresse": ["Kirkegata 5"], "postnummer": "9008", "poststed": "TROMSØ", "landkode": "NO" },
                  "hjemmeside": "nordlys.no",
                  "konkurs": true,
                  "underAvvikling": false,
                  "underTvangsavviklingEllerTvangsopplosning": false
                }
                """));

        var result = await factory.ClientAs(CrmRoles.Sales).GetFromJsonAsync<JsonElement>("/api/v1/integrations/brreg/organizations/912%20345%20675");

        result.GetProperty("status").GetString().ShouldBe("Bankrupt");
        var organization = result.GetProperty("organization");
        organization.GetProperty("name").GetString().ShouldBe("NORDLYS DRIFT AS");
        organization.GetProperty("naceCode").GetString().ShouldBe("62.030");
        organization.GetProperty("website").GetString().ShouldBe("https://nordlys.no");
        organization.GetProperty("businessAddress").GetProperty("city").GetString().ShouldBe("TROMSØ");
    }

    [Fact]
    public async Task Unknown_org_number_returns_not_found_status()
    {
        factory.Brreg
            .Given(Request.Create().WithPath("/enhetsregisteret/api/enheter/998877665").UsingGet())
            .RespondWith(Response.Create().WithStatusCode(404));

        var result = await factory.ClientAs(CrmRoles.Sales).GetFromJsonAsync<JsonElement>("/api/v1/integrations/brreg/organizations/998877665");

        result.GetProperty("status").GetString().ShouldBe("NotFound");
        result.GetProperty("organization").ValueKind.ShouldBe(JsonValueKind.Null);
    }

    [Fact]
    public async Task Search_requires_two_characters()
    {
        var response = await factory.ClientAs(CrmRoles.Sales).GetAsync("/api/v1/integrations/brreg/organizations?name=a");
        response.StatusCode.ShouldBe(HttpStatusCode.BadRequest);
    }
}
