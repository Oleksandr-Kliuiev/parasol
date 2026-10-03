using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Crm.Authorization;
using Crm.Integrations.PartnerCenter;
using Crm.Licensing.Contracts;
using WireMock.RequestBuilders;
using static Crm.IntegrationTests.IntegrationTestHelpers;

namespace Crm.IntegrationTests;

public class SalesAndLicensingApiTests(CrmWebFactory factory)
{
    private const string Sales = "/api/v1/sales";
    private const string Activities = "/api/v1/activities";
    private const string Licensing = "/api/v1/licensing";

    private static readonly DateOnly Today = DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, TimeZoneInfo.FindSystemTimeZoneById("Europe/Oslo")).DateTime);

    private static async Task<Guid> StageAsync(HttpClient client, string name)
    {
        var stages = await client.GetFromJsonAsync<JsonElement>($"{Sales}/stages");
        return stages.EnumerateArray().Single(s => s.GetProperty("name").GetString() == name).GetProperty("id").GetGuid();
    }

    [Fact]
    public async Task A_lead_becomes_a_customer_with_a_deal_and_the_pipeline_forecasts_it()
    {
        var sales = factory.ClientAs(CrmRoles.Sales, userKey: "pipeline-sales");
        var marker = $"L{Guid.NewGuid():N}"[..10];
        var orgNumber = TestData.OrgNumber();
        var me = (await sales.GetFromJsonAsync<JsonElement>("/bff/user")).GetProperty("id").GetGuid();

        var created = await sales.PostAsJsonAsync($"{Sales}/leads", new
        {
            companyName = $"{marker} Havbris AS", orgNumber, contactName = "Ingrid Havbris", email = $"ingrid@{marker.ToLowerInvariant()}.no",
            phone = "900 00 001", source = "Web", ownerId = me,
        });
        created.StatusCode.ShouldBe(HttpStatusCode.Created);
        var lead = await created.ReadJsonAsync();
        lead.GetProperty("status").GetString().ShouldBe("New");
        var leadId = lead.GetProperty("id").GetGuid();

        (await sales.PostAsync($"{Sales}/leads/{leadId}/qualify", null)).StatusCode.ShouldBe(HttpStatusCode.OK);
        var converted = await (await sales.PostAsJsonAsync($"{Sales}/leads/{leadId}/convert", new
        {
            createOpportunity = true, opportunityName = $"{marker} MSP-avtale", expectedCloseDate = Today.AddMonths(2), oneOffAmount = 20000m, mrr = 5000m, termMonths = 24,
        })).ReadJsonAsync();
        converted.GetProperty("status").GetString().ShouldBe("Converted");
        var organizationId = converted.GetProperty("organizationId").GetGuid();
        var opportunityId = converted.GetProperty("opportunityId").GetGuid();

        // The organization and its first contact now exist in the CRM.
        var organization = await sales.GetFromJsonAsync<JsonElement>($"/api/v1/customers/organizations/{organizationId}");
        organization.GetProperty("orgNumber").GetString().ShouldBe(orgNumber);
        (await sales.GetFromJsonAsync<JsonElement>($"/api/v1/customers/organizations/{organizationId}/contacts"))
            .EnumerateArray().ShouldHaveSingleItem().GetProperty("firstName").GetString().ShouldBe("Ingrid");

        // BR-SAL-01: 20 000 + 5 000 × 12 = 80 000 weighted by the first stage's 10 %.
        var opportunity = await sales.GetFromJsonAsync<JsonElement>($"{Sales}/opportunities/{opportunityId}");
        opportunity.GetProperty("probability").GetInt32().ShouldBe(10);
        opportunity.GetProperty("forecastAmount").GetDecimal().ShouldBe(8_000m);

        var negotiation = await StageAsync(sales, "Negotiation");
        var moved = await (await sales.PostAsJsonAsync($"{Sales}/opportunities/{opportunityId}/stage", new { stageId = negotiation })).ReadJsonAsync();
        moved.GetProperty("probability").GetInt32().ShouldBe(75);
        moved.GetProperty("forecastAmount").GetDecimal().ShouldBe(60_000m);

        var pipeline = await sales.GetFromJsonAsync<JsonElement>($"{Sales}/pipeline?mine=true");
        var column = pipeline.GetProperty("columns").EnumerateArray().Single(c => c.GetProperty("stageName").GetString() == "Negotiation");
        column.GetProperty("count").GetInt32().ShouldBeGreaterThanOrEqualTo(1);
        column.GetProperty("forecast").GetDecimal().ShouldBeGreaterThanOrEqualTo(60_000m);

        // BR-SAL-02: losing needs a reason.
        var lost = await StageAsync(sales, "Lost");
        var withoutReason = await sales.PostAsJsonAsync($"{Sales}/opportunities/{opportunityId}/stage", new { stageId = lost });
        withoutReason.StatusCode.ShouldBe(HttpStatusCode.BadRequest);
        (await withoutReason.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe("SAL_LOST_REASON_REQUIRED");

        var won = await StageAsync(sales, "Won");
        var wonDeal = await (await sales.PostAsJsonAsync($"{Sales}/opportunities/{opportunityId}/stage", new { stageId = won })).ReadJsonAsync();
        wonDeal.GetProperty("status").GetString().ShouldBe("Won");

        // A technician may look but not touch.
        var technician = factory.ClientAs(CrmRoles.Technician);
        (await technician.GetFromJsonAsync<JsonElement>($"{Sales}/opportunities/{opportunityId}")).TryGetProperty("mrr", out _).ShouldBeFalse();
        (await technician.PostAsJsonAsync($"{Sales}/leads", new { companyName = "Nei" })).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task Activities_show_up_as_my_tasks_and_keep_the_deal_from_looking_stale()
    {
        var sales = factory.ClientAs(CrmRoles.Sales, userKey: "activity-sales");
        var marker = $"A{Guid.NewGuid():N}"[..10];
        var me = (await sales.GetFromJsonAsync<JsonElement>("/bff/user")).GetProperty("id").GetGuid();
        var organizationId = await sales.CreateOrganizationAsync(new { name = $"{marker} Aktivitet AS", status = "Customer" });
        var stageId = await StageAsync(sales, "Qualification");
        var opportunityId = (await (await sales.PostAsJsonAsync($"{Sales}/opportunities", new
        {
            organizationId, name = $"{marker} avtale", businessLine = "Msp", stageId, expectedCloseDate = Today.AddMonths(1),
            oneOffAmount = 0m, mrr = 2500m, termMonths = 12, ownerId = me,
        })).ReadJsonAsync()).GetProperty("id").GetGuid();

        var task = await sales.PostAsJsonAsync(Activities + "/", new
        {
            type = "Task", organizationId, opportunityId, subject = $"{marker} ring kunden", body = "Følge opp tilbud",
            dueAt = DateTimeOffset.UtcNow.AddDays(-1), priority = "High", assigneeId = me,
        });
        task.StatusCode.ShouldBe(HttpStatusCode.Created);
        var created = await task.ReadJsonAsync();
        created.GetProperty("status").GetString().ShouldBe("Open");
        created.GetProperty("isOverdue").GetBoolean().ShouldBeTrue();
        var taskId = created.GetProperty("id").GetGuid();

        var note = await sales.PostAsJsonAsync(Activities + "/", new { type = "Note", organizationId, subject = $"{marker} notat", body = "Kunden vurderer" });
        (await note.ReadJsonAsync()).GetProperty("status").GetString().ShouldBe("Done");

        var mine = await sales.GetFromJsonAsync<JsonElement>($"{Activities}?mine=true&open=true");
        mine.EnumerateArray().ShouldContain(a => a.GetProperty("id").GetGuid() == taskId);

        var timeline = await sales.GetFromJsonAsync<JsonElement>($"{Activities}?organizationId={organizationId}");
        timeline.EnumerateArray().Count().ShouldBe(2);

        // The deal's "last activity" follows the activity, so the stale warning is based on real contact (BR-SAL-03).
        await factory.ProcessEventsAsync();
        (await sales.GetFromJsonAsync<JsonElement>($"{Sales}/opportunities/{opportunityId}")).GetProperty("isStale").GetBoolean().ShouldBeFalse();

        (await sales.PostAsync($"{Activities}/{taskId}/complete", null)).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await sales.GetFromJsonAsync<JsonElement>($"{Activities}?mine=true&open=true")).EnumerateArray()
            .ShouldNotContain(a => a.GetProperty("id").GetGuid() == taskId);
        (await factory.ClientAs(CrmRoles.ReadOnly).PostAsJsonAsync(Activities + "/", new { type = "Note", organizationId, subject = "Nei" }))
            .StatusCode.ShouldBe(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task Distributor_subscriptions_are_imported_linked_and_flagged_when_they_are_not_billed()
    {
        var admin = factory.ClientAs(CrmRoles.Admin);
        var finance = factory.ClientAs(CrmRoles.Finance);
        var marker = $"C{Guid.NewGuid():N}"[..10];
        var orgNumber = TestData.OrgNumber();
        var organizationId = await admin.CreateOrganizationAsync(new { name = $"{marker} Lisens AS", orgNumber, status = "Customer" });
        var offerId = $"OFFER-{marker}";
        var productId = await CatalogApiTests.CreateProductAsync(finance, new
        {
            sku = CatalogApiTests.Sku("M365"), name = "Microsoft 365 Business Premium", type = "MicrosoftLicense", businessLine = "Microsoft",
            unit = "License", billingPeriod = "Monthly", vatRate = 25m, listPrice = 265m, unitCost = 225m, microsoftOfferId = offerId, commitmentTerm = "P1Y",
        });

        var csv = string.Join('\n',
            "Kundenavn;Organisasjonsnummer;KundeID;AbonnementsID;OfferId;Produktnavn;Antall;Status;Bindingstid;Faktureringsperiode;Startdato;Sluttdato;Autofornyelse;Partnerpris",
            $"{marker} Lisens AS;{orgNumber};csp-{marker};sub-{marker};{offerId};Microsoft 365 Business Premium;25;Active;P1Y;Annual;{Today.AddMonths(-1):yyyy-MM-dd};{Today.AddDays(30):yyyy-MM-dd};ja;225,50");

        var preview = await admin.PostAsync($"{Licensing}/import?dryRun=true", new StringContent(csv, Encoding.UTF8, "text/csv"));
        preview.StatusCode.ShouldBe(HttpStatusCode.OK);
        (await preview.ReadJsonAsync()).GetProperty("created").GetInt32().ShouldBe(1);
        // A preview writes nothing.
        (await admin.GetFromJsonAsync<JsonElement>($"{Licensing}/subscriptions?organizationId={organizationId}")).EnumerateArray().ShouldBeEmpty();

        var imported = await admin.PostAsync($"{Licensing}/import", new StringContent(csv, Encoding.UTF8, "text/csv"));
        imported.StatusCode.ShouldBe(HttpStatusCode.OK);
        (await imported.ReadJsonAsync()).GetProperty("created").GetInt32().ShouldBe(1);

        // The same file again changes nothing, and the preview says so instead of counting an update.
        var second = await admin.PostAsync($"{Licensing}/import?dryRun=true", new StringContent(csv, Encoding.UTF8, "text/csv"));
        var secondPreview = await second.ReadJsonAsync();
        secondPreview.GetProperty("created").GetInt32().ShouldBe(0);
        secondPreview.GetProperty("updated").GetInt32().ShouldBe(0);
        secondPreview.GetProperty("unchanged").GetInt32().ShouldBe(1);

        var subscriptions = await finance.GetFromJsonAsync<JsonElement>($"{Licensing}/subscriptions?organizationId={organizationId}");
        var subscription = subscriptions.EnumerateArray().ShouldHaveSingleItem();
        subscription.GetProperty("source").GetString().ShouldBe("Distributor");
        // BR-LIC-01: matched to the organization by its organization number.
        subscription.GetProperty("organizationId").GetGuid().ShouldBe(organizationId);
        subscription.GetProperty("productId").GetGuid().ShouldBe(productId);
        subscription.GetProperty("quantity").GetInt32().ShouldBe(25);
        subscription.GetProperty("partnerUnitPrice").GetDecimal().ShouldBe(225.50m);
        // BR-LIC-03: no contract line for the product yet, so it is not billed.
        subscription.GetProperty("isBilled").GetBoolean().ShouldBeFalse();
        // BR-LIC-02: the 7-day window runs from the purchase date, which is in the past here.
        subscription.GetProperty("cancellationWindowOpen").GetBoolean().ShouldBeFalse();

        // Cost prices stay with Finance and Admin.
        var asSales = await factory.ClientAs(CrmRoles.Sales).GetFromJsonAsync<JsonElement>($"{Licensing}/subscriptions?organizationId={organizationId}");
        asSales.EnumerateArray().ShouldHaveSingleItem().TryGetProperty("partnerUnitPrice", out _).ShouldBeFalse();

        // Put the product on an active contract: the subscription is billed from then on.
        var contract = await (await admin.PostAsJsonAsync("/api/v1/contracts", new
        {
            organizationId, title = "Lisenser", type = "Licensing", startDate = Today.AddMonths(-1), autoRenew = false, renewalTermMonths = 0,
            noticePeriodDays = 30, invoiceFrequency = "Monthly", invoiceTiming = "InAdvance", indexation = false,
        })).ReadJsonAsync();
        var contractId = contract.GetProperty("id").GetGuid();
        (await admin.PostAsJsonAsync($"/api/v1/contracts/{contractId}/lines", new
        {
            productId, quantityModel = "PerM365User", quantity = 25m, unitPrice = 265m, validFrom = Today.AddMonths(-1),
        })).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await admin.PostAsync($"/api/v1/contracts/{contractId}/activate", null)).StatusCode.ShouldBe(HttpStatusCode.OK);

        var billed = await finance.GetFromJsonAsync<JsonElement>($"{Licensing}/subscriptions?organizationId={organizationId}");
        billed.EnumerateArray().ShouldHaveSingleItem().GetProperty("isBilled").GetBoolean().ShouldBeTrue();

        // Importing the same file again changes nothing.
        var again = await admin.PostAsync($"{Licensing}/import", new StringContent(csv, Encoding.UTF8, "text/csv"));
        (await again.ReadJsonAsync()).GetProperty("unchanged").GetInt32().ShouldBe(1);
        (await factory.ClientAs(CrmRoles.Sales).PostAsync($"{Licensing}/import", new StringContent(csv, Encoding.UTF8, "text/csv")))
            .StatusCode.ShouldBe(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task Partner_center_subscriptions_are_mirrored_for_mapped_csp_customers()
    {
        var admin = factory.ClientAs(CrmRoles.Admin);
        var pc = factory.PartnerCenter;
        var marker = $"P{Guid.NewGuid():N}"[..10];
        var organizationId = await admin.CreateOrganizationAsync(new { name = $"{marker} Partner AS", orgNumber = TestData.OrgNumber(), status = "Customer" });
        var cspCustomerId = $"csp-{marker}";
        var subscriptionId = $"sub-{marker}";
        var purchasedAt = DateTimeOffset.UtcNow.AddHours(-2);

        pc.Given(Request.Create().WithPath("/oauth2/token").UsingPost())
            .RespondWith(JsonReply(new { access_token = "pc-token", token_type = "Bearer", expires_in = "3600" }));
        pc.Given(Request.Create().WithPath("/v1/customers").UsingGet())
            .RespondWith(JsonReply(new
            {
                totalCount = 1,
                items = new object[]
                {
                    new
                    {
                        id = cspCustomerId,
                        companyProfile = new { companyName = $"{marker} Partner AS", domain = $"{marker.ToLowerInvariant()}.no", tenantId = "tenant-1" },
                        billingProfile = new { companyName = $"{marker} Partner AS" },
                    },
                },
            }));
        pc.Given(Request.Create().WithPath($"/v1/customers/{cspCustomerId}/subscriptions").UsingGet())
            .RespondWith(JsonReply(new
            {
                totalCount = 1,
                items = new object[]
                {
                    new
                    {
                        id = subscriptionId,
                        offerId = "CFQ7TTC0LF8Q",
                        offerName = "Microsoft 365 Business Premium",
                        friendlyName = "M365 BP",
                        quantity = 12,
                        status = "active",
                        termDuration = "P1Y",
                        billingCycle = "annual",
                        autoRenewEnabled = true,
                        creationDate = purchasedAt.ToString("O", CultureInfo.InvariantCulture),
                        commitmentEndDate = Today.AddMonths(11).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
                        unitPrice = 225.0,
                    },
                },
            }));

        await factory.RunJobAsync<PartnerCenterCustomerSyncJob>(j => j.RunAsync(CancellationToken.None));

        // The CSP customer waits in the mapping queue until someone links it.
        var records = await admin.GetFromJsonAsync<JsonElement>($"/api/v1/integrations/records?system=partnercenter&type=Customer&search={marker}");
        records.GetProperty("items").EnumerateArray().ShouldHaveSingleItem().GetProperty("externalId").GetString().ShouldBe(cspCustomerId);
        (await admin.PostAsJsonAsync("/api/v1/integrations/links", new
        {
            system = "partnercenter", externalType = "Customer", externalId = cspCustomerId, entityId = organizationId,
        })).StatusCode.ShouldBe(HttpStatusCode.OK);

        await factory.RunJobAsync<PartnerCenterSubscriptionSyncJob>(j => j.RunAsync(CancellationToken.None));

        var subscriptions = await admin.GetFromJsonAsync<JsonElement>($"{Licensing}/subscriptions?organizationId={organizationId}");
        var subscription = subscriptions.EnumerateArray().ShouldHaveSingleItem();
        subscription.GetProperty("source").GetString().ShouldBe("PartnerCenter");
        subscription.GetProperty("quantity").GetInt32().ShouldBe(12);
        subscription.GetProperty("term").GetString().ShouldBe("P1Y");
        subscription.GetProperty("autoRenew").GetBoolean().ShouldBeTrue();
        // BR-LIC-02: bought two hours ago, so the cancellation window is still open.
        subscription.GetProperty("cancellationWindowOpen").GetBoolean().ShouldBeTrue();

        var attention = await admin.GetFromJsonAsync<JsonElement>($"{Licensing}/attention");
        attention.GetProperty("summary").GetProperty("cancellationWindowOpen").GetInt32().ShouldBeGreaterThanOrEqualTo(1);
        attention.GetProperty("cancellationWindow").EnumerateArray().ShouldContain(s => s.GetProperty("subscriptionId").GetString() == subscriptionId);
    }

    [Fact]
    public async Task Licence_usage_shows_unused_seats_and_the_reconciliation_shows_what_microsoft_charged()
    {
        var admin = factory.ClientAs(CrmRoles.Admin);
        var marker = $"L{Guid.NewGuid():N}"[..10];
        var orgNumber = TestData.OrgNumber();
        var organizationId = await admin.CreateOrganizationAsync(new { name = $"{marker} Lisens AS", orgNumber, status = "Customer" });
        var subscriptionId = $"sub-{marker}";

        // The billed lines find the organization through the subscription, so the mirror is filled first.
        (await admin.PostAsync($"{Licensing}/import", new StringContent(string.Join('\n',
            "Kundenavn;Organisasjonsnummer;KundeID;AbonnementsID;OfferId;Produktnavn;Antall;Status",
            $"{marker} Lisens AS;{orgNumber};csp-{marker};{subscriptionId};CFQ7TTC0LF8Q;Microsoft 365 Business Premium;25;Active"), Encoding.UTF8, "text/csv")))
            .StatusCode.ShouldBe(HttpStatusCode.OK);

        // FR-LIC-03: two readings 30 days apart, both with seats nobody uses.
        var readings = new[] { new LicenseUsageReading(organizationId, $"sku-{marker}", "SPB", 25, 21) };
        await factory.RunJobAsync<ILicensingApi>(api => api.UpsertLicenseUsageAsync(readings, Today.AddDays(-29), CancellationToken.None));
        await factory.RunJobAsync<ILicensingApi>(api => api.UpsertLicenseUsageAsync(readings, Today, CancellationToken.None));

        var usage = await admin.GetFromJsonAsync<JsonElement>($"{Licensing}/usage?organizationId={organizationId}&unusedOnly=true");
        var row = usage.EnumerateArray().ShouldHaveSingleItem();
        row.GetProperty("purchased").GetInt32().ShouldBe(25);
        row.GetProperty("assigned").GetInt32().ShouldBe(21);
        row.GetProperty("unused").GetInt32().ShouldBe(4);
        row.GetProperty("unusedForWholeWindow").GetBoolean().ShouldBeTrue();
        row.GetProperty("snapshotDate").GetString().ShouldBe(Today.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture));

        // Re-reading the same day replaces the reading instead of adding one.
        await factory.RunJobAsync<ILicensingApi>(api => api.UpsertLicenseUsageAsync(
            [new LicenseUsageReading(organizationId, $"sku-{marker}", "SPB", 25, 25)], Today, CancellationToken.None));
        var afterAssigning = await admin.GetFromJsonAsync<JsonElement>($"{Licensing}/usage?organizationId={organizationId}");
        afterAssigning.EnumerateArray().ShouldHaveSingleItem().GetProperty("unused").GetInt32().ShouldBe(0);

        var period = new DateOnly(Today.Year, Today.Month, 1).AddMonths(-1);
        var csv = string.Join('\n',
            "CustomerId;Kundenavn;SubscriptionId;OfferId;Produktnavn;Antall;Enhetspris;Beløp;Valuta;Fakturanummer;ChargeStartDate;ChargeEndDate",
            $"csp-{marker};{marker} Lisens AS;{subscriptionId};CFQ7TTC0LF8Q;Microsoft 365 Business Premium;25;180,50;4 512,50;NOK;G{marker};" +
            $"{period:yyyy-MM-dd};{period.AddMonths(1).AddDays(-1):yyyy-MM-dd}");

        var preview = await (await admin.PostAsync(
            $"{Licensing}/ms-billing/import?dryRun=true", new StringContent(csv, Encoding.UTF8, "text/csv"))).ReadJsonAsync();
        preview.GetProperty("created").GetInt32().ShouldBe(1);
        preview.GetProperty("withoutOrganization").GetInt32().ShouldBe(0);

        // The preview wrote nothing: the period is still empty.
        var beforeImport = await admin.GetFromJsonAsync<JsonElement>($"{Licensing}/reconciliation?year={period.Year}&month={period.Month}");
        beforeImport.GetProperty("rows").EnumerateArray().ShouldNotContain(r => r.GetProperty("organizationId").GetGuid() == organizationId);

        var imported = await (await admin.PostAsync(
            $"{Licensing}/ms-billing/import", new StringContent(csv, Encoding.UTF8, "text/csv"))).ReadJsonAsync();
        imported.GetProperty("created").GetInt32().ShouldBe(1);

        var report = await admin.GetFromJsonAsync<JsonElement>($"{Licensing}/reconciliation?year={period.Year}&month={period.Month}");
        var reconciled = report.GetProperty("rows").EnumerateArray()
            .Single(r => r.TryGetProperty("organizationId", out var id) && id.ValueKind == JsonValueKind.String && id.GetGuid() == organizationId);
        reconciled.GetProperty("microsoftCost").GetDecimal().ShouldBe(4512.50m);
        // Nothing was billed to the customer for the period, which is exactly what the report is meant to surface.
        reconciled.GetProperty("billedRevenue").GetDecimal().ShouldBe(0m);
        reconciled.GetProperty("notBilled").GetBoolean().ShouldBeTrue();

        // A second import of the same file changes nothing (the line key carries invoice, subscription, offer and period).
        var again = await (await admin.PostAsync(
            $"{Licensing}/ms-billing/import", new StringContent(csv, Encoding.UTF8, "text/csv"))).ReadJsonAsync();
        again.GetProperty("created").GetInt32().ShouldBe(0);
        again.GetProperty("unchanged").GetInt32().ShouldBe(1);

        var periods = await admin.GetFromJsonAsync<JsonElement>($"{Licensing}/reconciliation/periods");
        periods.EnumerateArray().Select(p => p.GetString()).ShouldContain(period.ToString("yyyy-MM", CultureInfo.InvariantCulture));

        // Cost is finance data: a role without finance.cost.read never sees the report.
        var sales = factory.ClientAs(CrmRoles.Sales, userKey: "licence-usage-sales");
        (await sales.GetAsync($"{Licensing}/reconciliation?year={period.Year}&month={period.Month}")).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        (await sales.GetAsync($"{Licensing}/usage")).StatusCode.ShouldBe(HttpStatusCode.OK);
    }
}
