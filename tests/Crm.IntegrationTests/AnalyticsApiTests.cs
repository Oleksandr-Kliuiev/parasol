using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crm.Authorization;
using Crm.Service.Contracts;
using static Crm.IntegrationTests.IntegrationTestHelpers;

namespace Crm.IntegrationTests;

/// <summary>SLA report (FR-SRV-04), customer margins (FR-RPT-02), the Power BI mart (FR-RPT-03) and custom fields (FR-ADM-04).</summary>
public class AnalyticsApiTests(CrmWebFactory factory)
{
    private const string Service = "/api/v1/service";
    private const string Reports = "/api/v1/reports";
    private const string CustomFields = "/api/v1/custom-fields";

    private static string Iso(DateOnly date) => date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

    [Fact]
    public async Task The_sla_report_measures_response_in_support_hours_and_flags_breaches()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "sla-admin");
        var marker = $"S{Guid.NewGuid():N}"[..10];
        var organizationId = await admin.CreateOrganizationAsync(new { name = $"{marker} SLA AS", status = "Customer" });

        var sla = await admin.PostAsJsonAsync("/api/v1/contracts/sla-policies", new
        {
            name = $"{marker} Gold",
            coverage = "Business8x5",
            p1 = new { responseMinutes = 60, resolutionMinutes = 240 },
            p2 = new { responseMinutes = 120, resolutionMinutes = 480 },
            p3 = new { responseMinutes = 480, resolutionMinutes = 1440 },
            p4 = new { responseMinutes = 960, resolutionMinutes = 4800 },
            includedHoursPerMonth = 0m,
            afterHoursMultiplier = 1.5m,
        });
        sla.StatusCode.ShouldBe(HttpStatusCode.Created);
        var slaId = (await sla.ReadJsonAsync()).GetProperty("id").GetGuid();

        var contract = await admin.PostAsJsonAsync("/api/v1/contracts", new
        {
            organizationId,
            title = $"{marker} Drift",
            type = "Msp",
            startDate = "2026-01-01",
            endDate = (string?)null,
            autoRenew = false,
            renewalTermMonths = 0,
            noticePeriodDays = 90,
            slaPolicyId = slaId,
            invoiceFrequency = "Monthly",
            invoiceTiming = "InAdvance",
            indexation = false,
        });
        contract.StatusCode.ShouldBe(HttpStatusCode.Created);
        var contractId = (await contract.ReadJsonAsync()).GetProperty("id").GetGuid();
        (await admin.PostAsync($"/api/v1/contracts/{contractId}/activate", null)).StatusCode.ShouldBe(HttpStatusCode.OK);

        // Friday 16:30 → Monday 09:15 is 75 minutes of 8×5 support time: inside the two-hour P2 target.
        var friday = new DateTimeOffset(new DateTime(2026, 9, 25, 16, 30, 0), TimeSpan.Zero);
        // Wednesday 09:00 → 11:00 is two hours: past the one-hour P1 target.
        var wednesday = new DateTimeOffset(new DateTime(2026, 9, 23, 9, 0, 0), TimeSpan.Zero);
        var ticketBase = Random.Shared.NextInt64(500_000, 900_000);
        await factory.RunJobAsync<IServiceApi>(api => api.UpsertTicketsAsync(
            [
                new ExternalTicket("atera", ticketBase, organizationId, null, $"{marker} weekend", "Closed", "High", null, null, null, null, null, null, null,
                    friday, friday.AddDays(2).AddHours(16).AddMinutes(45), friday.AddDays(3), null, null),
                new ExternalTicket("atera", ticketBase + 1, organizationId, null, $"{marker} breach", "Closed", "Critical", null, null, null, null, null, null, null,
                    wednesday, wednesday.AddHours(2), wednesday.AddHours(3), null, null),
            ],
            CancellationToken.None));

        var report = await admin.GetFromJsonAsync<JsonElement>($"{Service}/sla-report?year=2026&month=9&organizationId={organizationId}");
        report.GetProperty("tickets").GetInt32().ShouldBe(2);
        report.GetProperty("withoutSla").GetInt32().ShouldBe(0);
        var row = report.GetProperty("organizations").EnumerateArray().Single();
        row.GetProperty("policyName").GetString().ShouldBe($"{marker} Gold");
        row.GetProperty("responseMeasured").GetInt32().ShouldBe(2);
        row.GetProperty("responseMet").GetInt32().ShouldBe(1);
        row.GetProperty("responseMetPct").GetDecimal().ShouldBe(50m);

        var breaches = row.GetProperty("breaches").EnumerateArray().ToList();
        var breach = breaches.ShouldHaveSingleItem();
        breach.GetProperty("externalId").GetInt64().ShouldBe(ticketBase + 1);
        breach.GetProperty("responseMinutes").GetInt32().ShouldBe(120);
        breach.GetProperty("responseTarget").GetInt32().ShouldBe(60);

        // The weekend ticket only spends 75 minutes inside 8×5 support hours (BR-SRV-05).
        var weekend = await admin.GetFromJsonAsync<JsonElement>($"{Service}/sla-report?year=2026&month=9&organizationId={organizationId}");
        weekend.GetProperty("organizations").EnumerateArray().Single().GetProperty("medianResponseMinutes").GetInt32().ShouldBeGreaterThan(0);

        // A technician may read the report; the numbers are not money.
        var technician = factory.ClientAs(CrmRoles.Technician, userKey: "sla-technician");
        (await technician.GetAsync($"{Service}/sla-report?year=2026&month=9")).StatusCode.ShouldBe(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Margins_compare_what_was_billed_with_licence_and_hour_cost()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "margin-admin");
        var finance = factory.ClientAs(CrmRoles.Finance, userKey: "margin-finance");
        var marker = $"M{Guid.NewGuid():N}"[..10];
        var orgNumber = TestData.OrgNumber();
        var organizationId = await admin.CreateOrganizationAsync(new { name = $"{marker} Margin AS", orgNumber, status = "Customer" });
        var product = await CatalogApiTests.CreateProductAsync(finance, CatalogApiTests.Product(CatalogApiTests.Sku("MRG")));

        var period = new DateOnly(2028, 7, 1);
        var contract = await admin.PostAsJsonAsync("/api/v1/contracts", new
        {
            organizationId,
            title = $"{marker} Drift",
            type = "Msp",
            startDate = Iso(period),
            endDate = (string?)null,
            autoRenew = false,
            renewalTermMonths = 0,
            noticePeriodDays = 90,
            invoiceFrequency = "Monthly",
            invoiceTiming = "InAdvance",
            indexation = false,
        });
        var contractId = (await contract.ReadJsonAsync()).GetProperty("id").GetGuid();
        (await admin.PostAsJsonAsync($"/api/v1/contracts/{contractId}/lines", new
        {
            productId = product, quantityModel = "Fixed", quantity = 1m, unitPrice = 10_000m, discountPct = 0m, validFrom = Iso(period),
        })).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await admin.PostAsync($"/api/v1/contracts/{contractId}/activate", null)).StatusCode.ShouldBe(HttpStatusCode.OK);

        var runId = (await (await finance.PostAsJsonAsync("/api/v1/billing/runs", new { year = period.Year, month = period.Month, notes = marker })).ReadJsonAsync())
            .GetProperty("id").GetGuid();
        (await finance.RunCommandAsync(runId, "collect")).StatusCode.ShouldBe(HttpStatusCode.OK);

        var report = await finance.GetFromJsonAsync<JsonElement>($"{Reports}/margins?year={period.Year}&month={period.Month}");
        var row = report.GetProperty("rows").EnumerateArray().Single(r => r.GetProperty("organizationId").GetGuid() == organizationId);
        row.GetProperty("revenue").GetDecimal().ShouldBe(10_000m);
        // Nothing was imported from Microsoft and no hours were booked, so the margin is the whole invoice.
        row.GetProperty("licenseCost").GetDecimal().ShouldBe(0m);
        row.GetProperty("margin").GetDecimal().ShouldBe(10_000m);
        report.GetProperty("hourlyCost").GetDecimal().ShouldBeGreaterThan(0m);

        // FR-RPT-03: the same numbers as a table Power BI can read.
        var datasets = await finance.GetFromJsonAsync<JsonElement>($"{Reports}/mart");
        datasets.GetProperty("datasets").EnumerateArray().Select(d => d.GetString()).ShouldContain("margins");

        var csv = await (await finance.GetAsync($"{Reports}/mart/revenue-by-customer?from={Iso(period)}&to={Iso(period.AddMonths(1).AddDays(-1))}&format=csv"))
            .Content.ReadAsStringAsync();
        csv.ShouldContain("organizationId;name;total");
        csv.ShouldContain($"{marker} Margin AS");

        var unknown = await finance.GetAsync($"{Reports}/mart/what-ever");
        unknown.StatusCode.ShouldBe(HttpStatusCode.NotFound);

        // Cost is finance data: sales sees neither the margins nor the mart.
        var sales = factory.ClientAs(CrmRoles.Sales, userKey: "margin-sales");
        (await sales.GetAsync($"{Reports}/margins?year={period.Year}&month={period.Month}")).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        (await sales.GetAsync($"{Reports}/mart/organizations")).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task A_custom_field_is_defined_once_and_answered_per_customer()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "cf-admin");
        var sales = factory.ClientAs(CrmRoles.Sales, userKey: "cf-sales");
        var marker = $"C{Guid.NewGuid():N}"[..8];
        var organizationId = await admin.CreateOrganizationAsync(new { name = $"{marker} Felt AS", status = "Customer" });

        var created = await admin.PostAsJsonAsync($"{CustomFields}/definitions", new
        {
            entity = "Organization",
            key = $"{marker} segment",
            label = "Segment",
            type = "Select",
            options = new[] { "Liten", "Mellomstor", "Stor" },
            required = false,
            order = 1,
            hint = (string?)null,
        });
        created.StatusCode.ShouldBe(HttpStatusCode.Created);
        var field = await created.ReadJsonAsync();
        var key = field.GetProperty("key").GetString()!;
        key.ShouldBe($"{marker.ToLowerInvariant()}_segment");

        // The same key twice for the same record type is refused.
        (await admin.PostAsJsonAsync($"{CustomFields}/definitions", new
        {
            entity = "Organization", key, label = "Segment igjen", type = "Text", options = Array.Empty<string>(),
            required = false, order = 2, hint = (string?)null,
        })).StatusCode.ShouldBe(HttpStatusCode.Conflict);

        // Sales may answer the field even though only an admin defines it.
        var saved = await sales.PutAsJsonAsync($"{CustomFields}/Organization/{organizationId}", new
        {
            values = new Dictionary<string, string?> { [key] = "stor" },
        });
        saved.StatusCode.ShouldBe(HttpStatusCode.OK);
        var values = await saved.ReadJsonAsync();
        values.EnumerateArray().Single(v => v.GetProperty("key").GetString() == key).GetProperty("value").GetString().ShouldBe("Stor");

        // A value outside the list is refused.
        var invalid = await sales.PutAsJsonAsync($"{CustomFields}/Organization/{organizationId}", new
        {
            values = new Dictionary<string, string?> { [key] = "Enorm" },
        });
        invalid.StatusCode.ShouldBe(HttpStatusCode.BadRequest);
        (await invalid.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe("CF_INVALID_VALUE");

        // Clearing the value leaves the field in place.
        (await sales.PutAsJsonAsync($"{CustomFields}/Organization/{organizationId}", new
        {
            values = new Dictionary<string, string?> { [key] = null },
        })).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await sales.GetFromJsonAsync<JsonElement>($"{CustomFields}/Organization/{organizationId}"))
            .EnumerateArray().Single(v => v.GetProperty("key").GetString() == key)
            .GetProperty("value").ValueKind.ShouldBe(JsonValueKind.Null);

        // Only an admin defines fields.
        (await sales.PostAsJsonAsync($"{CustomFields}/definitions", new
        {
            entity = "Contract", key = "noe", label = "Noe", type = "Text", options = Array.Empty<string>(),
            required = false, order = 1, hint = (string?)null,
        })).StatusCode.ShouldBe(HttpStatusCode.Forbidden);

        // A deactivated field disappears from the record's list but keeps its definition.
        (await admin.PostAsJsonAsync($"{CustomFields}/definitions/{field.GetProperty("id").GetGuid()}/active", new { active = false }))
            .StatusCode.ShouldBe(HttpStatusCode.NoContent);
        (await sales.GetFromJsonAsync<JsonElement>($"{CustomFields}/Organization/{organizationId}"))
            .EnumerateArray().ShouldNotContain(v => v.GetProperty("key").GetString() == key);
        (await admin.GetFromJsonAsync<JsonElement>($"{CustomFields}/definitions?entity=Organization&includeInactive=true"))
            .EnumerateArray().ShouldContain(v => v.GetProperty("key").GetString() == key);
    }
}
