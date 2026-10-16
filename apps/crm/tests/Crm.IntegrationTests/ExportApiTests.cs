using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using ClosedXML.Excel;
using Crm.Authorization;

namespace Crm.IntegrationTests;

public class ExportApiTests(CrmWebFactory factory)
{
    [Fact]
    public async Task Export_contains_filtered_rows_as_text_and_is_audited()
    {
        var marker = $"Xprt{Guid.NewGuid():N}"[..12];
        var sales = factory.ClientAs(CrmRoles.Sales, "export-rows");
        var orgNumber = TestData.OrgNumber();
        (await sales.PostAsJsonAsync("/api/v1/customers/organizations", TestData.Organization($"{marker} Alpha AS", orgNumber, "Customer"))).EnsureSuccessStatusCode();
        (await sales.PostAsJsonAsync("/api/v1/customers/organizations", TestData.Organization($"{marker} Beta AS", status: "Lead"))).EnsureSuccessStatusCode();

        var response = await sales.GetAsync($"/api/v1/customers/organizations/export?search={marker}&status=Customer&lang=nb");

        response.StatusCode.ShouldBe(HttpStatusCode.OK);
        response.Content.Headers.ContentType!.MediaType.ShouldBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        response.Content.Headers.ContentDisposition!.FileNameStar.ShouldStartWith("organizations-");

        using var workbook = new XLWorkbook(await response.Content.ReadAsStreamAsync());
        var sheet = workbook.Worksheet("Organisasjoner");
        sheet.Cell(1, 1).GetString().ShouldBe("Navn");
        sheet.Cell(2, 1).GetString().ShouldBe($"{marker} Alpha AS");
        sheet.Cell(2, 2).GetString().ShouldBe(orgNumber);
        sheet.Cell(2, 4).GetString().ShouldBe("Kunde");
        sheet.Cell(3, 1).IsEmpty().ShouldBeTrue();

        var audit = await factory.ClientAs(CrmRoles.Admin).GetFromJsonAsync<JsonElement>("/api/v1/audit?action=Export&limit=50");
        audit.GetProperty("items").EnumerateArray().ShouldContain(e =>
            e.GetProperty("userName").GetString() == "Test export-rows" &&
            e.GetProperty("changes").GetProperty("rows").GetInt32() == 1);
    }

    [Fact]
    public async Task Exports_are_rate_limited_per_user()
    {
        var client = factory.ClientAs(CrmRoles.ReadOnly, $"export-limit-{Guid.NewGuid():N}");
        for (int i = 0; i < 3; i++)
        {
            (await client.GetAsync("/api/v1/customers/organizations/export?search=nothing-matches-this")).StatusCode.ShouldBe(HttpStatusCode.OK);
        }

        var limited = await client.GetAsync("/api/v1/customers/organizations/export?search=nothing-matches-this");

        limited.StatusCode.ShouldBe(HttpStatusCode.TooManyRequests);
        (await limited.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString().ShouldBe("RATE_LIMITED");
        // Other endpoints are not affected by the export limit.
        (await client.GetAsync("/api/v1/customers/organizations?limit=1")).StatusCode.ShouldBe(HttpStatusCode.OK);
    }
}
