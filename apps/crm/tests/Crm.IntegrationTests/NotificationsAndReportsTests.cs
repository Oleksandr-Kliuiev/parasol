using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Crm.Authorization;
using Crm.Contracts.Features;
using Crm.Notifications.Features;
using WireMock.RequestBuilders;
using WireMock.ResponseBuilders;
using static Crm.IntegrationTests.IntegrationTestHelpers;

namespace Crm.IntegrationTests;

/// <summary>Notices reach the responsible person, the digest leaves through Graph, and the dashboard adds up (S8).</summary>
public class NotificationsAndReportsTests(CrmWebFactory factory)
{
    private const string Notifications = "/api/v1/notifications";
    private const string Contracts = "/api/v1/contracts";

    private static readonly DateOnly Today =
        DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, TimeZoneInfo.FindSystemTimeZoneById("Europe/Oslo")).DateTime);

    private static async Task<Guid> UserIdAsync(HttpClient client) =>
        (await client.GetFromJsonAsync<JsonElement>("/bff/user")).GetProperty("id").GetGuid();

    [Fact]
    public async Task A_contract_reminder_becomes_a_notice_for_its_owner_and_a_digest_e_mail()
    {
        var owner = factory.ClientAs(CrmRoles.Sales, userKey: "notify-owner");
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "notify-admin");
        var ownerId = await UserIdAsync(owner);
        var marker = $"N{Guid.NewGuid():N}"[..10];
        var organizationId = await owner.CreateOrganizationAsync(new { name = $"{marker} Varsel AS", status = "Customer" });

        // A contract that ends in 25 days is inside the 30-day reminder step (FR-CON-04).
        var contract = await (await owner.PostAsJsonAsync(Contracts, new
        {
            organizationId, title = $"{marker} Drift", type = "Msp", startDate = Today.AddYears(-1), endDate = Today.AddDays(25),
            autoRenew = false, renewalTermMonths = 0, noticePeriodDays = 30, invoiceFrequency = "Monthly", invoiceTiming = "InAdvance",
            indexation = false, ownerId,
        })).ReadJsonAsync();
        var contractId = contract.GetProperty("id").GetGuid();
        (await owner.PostAsync($"{Contracts}/{contractId}/activate", null)).StatusCode.ShouldBe(HttpStatusCode.OK);

        await factory.RunJobAsync<ContractLifecycleJob>(job => job.RunAsync(CancellationToken.None));
        await factory.ProcessEventsAsync();

        var mine = await owner.GetFromJsonAsync<JsonElement>($"{Notifications}?unreadOnly=true&limit=100");
        var notice = mine.GetProperty("items").EnumerateArray()
            .Single(n => n.GetProperty("parameters").TryGetProperty("organization", out var org) && org.GetString() == $"{marker} Varsel AS");
        notice.GetProperty("kind").GetString().ShouldBe("ContractEnding");
        notice.GetProperty("parameters").GetProperty("days").GetString().ShouldBe("30");
        notice.GetProperty("link").GetString().ShouldBe($"/contracts/{contractId}");
        notice.GetProperty("isUnread").GetBoolean().ShouldBeTrue();
        mine.GetProperty("unread").GetInt32().ShouldBeGreaterThan(0);

        // Nobody else sees another person's notices.
        var other = await admin.GetFromJsonAsync<JsonElement>($"{Notifications}?limit=100");
        other.GetProperty("items").EnumerateArray()
            .Any(n => n.GetProperty("id").GetGuid() == notice.GetProperty("id").GetGuid())
            .ShouldBeFalse();

        // Running the job again does not repeat the notice (the reminder id is the dedupe key).
        await factory.RunJobAsync<ContractLifecycleJob>(job => job.RunAsync(CancellationToken.None));
        await factory.ProcessEventsAsync();
        (await owner.GetFromJsonAsync<JsonElement>($"{Notifications}?unreadOnly=true&limit=100")).GetProperty("items").EnumerateArray()
            .Count(n => n.GetProperty("parameters").TryGetProperty("organization", out var org) && org.GetString() == $"{marker} Varsel AS")
            .ShouldBe(1);

        // The digest goes out at the hour the reader picked, through Graph.
        var hour = TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, TimeZoneInfo.FindSystemTimeZoneById("Europe/Oslo")).Hour;
        (await owner.PutAsJsonAsync($"{Notifications}/preferences", new { emailEnabled = true, digestHour = hour, mutedKinds = Array.Empty<string>() }))
            .StatusCode.ShouldBe(HttpStatusCode.OK);
        factory.Graph.Given(Request.Create().WithPath("/graph/v1.0/users/crm@vardahei.no/sendMail").UsingPost())
            .RespondWith(Response.Create().WithStatusCode(202));

        await factory.RunJobAsync<NotificationDigestJob>(job => job.RunAsync(CancellationToken.None));

        var sent = factory.Graph.LogEntries
            .Select(e => e.RequestMessage)
            .Where(r => r!.Path == "/graph/v1.0/users/crm@vardahei.no/sendMail")
            .Select(r => r!.Body ?? string.Empty)
            .Where(body => body.Contains($"{marker} Varsel AS", StringComparison.Ordinal))
            .ToList();
        sent.ShouldNotBeEmpty();
        sent[0].ShouldContain("https://crm.test.local/contracts/");

        var afterDigest = await owner.GetFromJsonAsync<JsonElement>($"{Notifications}?limit=100");
        afterDigest.GetProperty("items").EnumerateArray()
            .Single(n => n.GetProperty("id").GetGuid() == notice.GetProperty("id").GetGuid())
            .GetProperty("emailStatus").GetString().ShouldBe("Sent");

        // Reading clears it from the bell.
        (await owner.PostAsync($"{Notifications}/{notice.GetProperty("id").GetGuid()}/read", null)).StatusCode.ShouldBe(HttpStatusCode.NoContent);
        (await owner.GetFromJsonAsync<JsonElement>($"{Notifications}?unreadOnly=true&limit=100")).GetProperty("items").EnumerateArray()
            .Any(n => n.GetProperty("id").GetGuid() == notice.GetProperty("id").GetGuid())
            .ShouldBeFalse();
    }

    [Fact]
    public async Task A_muted_kind_stays_in_the_crm_without_an_e_mail()
    {
        var manager = factory.ClientAs(CrmRoles.Sales, userKey: "notify-muted");
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "notify-muted-admin");
        var managerId = await UserIdAsync(manager);
        var marker = $"M{Guid.NewGuid():N}"[..10];
        var orgNumber = TestData.OrgNumber();

        (await manager.PutAsJsonAsync($"{Notifications}/preferences", new
        {
            emailEnabled = true, digestHour = TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, TimeZoneInfo.FindSystemTimeZoneById("Europe/Oslo")).Hour,
            mutedKinds = new[] { "SubscriptionCancellationWindow" },
        })).StatusCode.ShouldBe(HttpStatusCode.OK);

        var organizationId = await manager.CreateOrganizationAsync(new
        {
            name = $"{marker} Lisens AS", status = "Customer", orgNumber, accountManagerId = managerId,
        });

        // A subscription bought today still has its cancellation window open (BR-LIC-02).
        var csv = string.Join('\n',
            "Kundeid;Kundenavn;Organisasjonsnummer;AbonnementsID;OfferId;Produktnavn;Antall;Status;Bindingstid;Startdato;Fornyelsesdato;Kjøpsdato",
            $"csp-{marker};{marker} Lisens AS;{orgNumber};sub-{marker};CFQ7-{marker};Microsoft 365 Business Premium;10;Active;P1Y;{Today:yyyy-MM-dd};{Today.AddYears(1):yyyy-MM-dd};{Today:yyyy-MM-dd}");
        (await admin.PostAsync("/api/v1/licensing/import", new StringContent(csv, Encoding.UTF8, "text/csv"))).StatusCode.ShouldBe(HttpStatusCode.OK);

        await factory.RunJobAsync<NotificationScanJob>(job => job.RunAsync(CancellationToken.None));
        await factory.RunJobAsync<NotificationDigestJob>(job => job.RunAsync(CancellationToken.None));

        var notice = (await manager.GetFromJsonAsync<JsonElement>($"{Notifications}?limit=100")).GetProperty("items").EnumerateArray()
            .Single(n => n.GetProperty("kind").GetString() == "SubscriptionCancellationWindow" &&
                         n.GetProperty("parameters").GetProperty("organization").GetString() == $"{marker} Lisens AS");
        notice.GetProperty("warning").GetBoolean().ShouldBeTrue();
        notice.GetProperty("emailStatus").GetString().ShouldBe("Suppressed");

        // Scanning again adds nothing for the same day.
        await factory.RunJobAsync<NotificationScanJob>(job => job.RunAsync(CancellationToken.None));
        (await manager.GetFromJsonAsync<JsonElement>($"{Notifications}?limit=100")).GetProperty("items").EnumerateArray()
            .Count(n => n.GetProperty("kind").GetString() == "SubscriptionCancellationWindow" &&
                        n.GetProperty("parameters").GetProperty("organization").GetString() == $"{marker} Lisens AS")
            .ShouldBe(1);

        var preferences = await manager.GetFromJsonAsync<JsonElement>($"{Notifications}/preferences");
        preferences.GetProperty("mutedKinds").EnumerateArray().Select(k => k.GetString()).ShouldBe(["SubscriptionCancellationWindow"]);
        preferences.GetProperty("emailAvailable").GetBoolean().ShouldBeTrue();
    }

    [Fact]
    public async Task The_dashboard_adds_up_what_the_modules_know()
    {
        var management = factory.ClientAs(CrmRoles.Management, userKey: "dashboard-management");
        var finance = factory.ClientAs(CrmRoles.Finance, userKey: "dashboard-finance");
        var technician = factory.ClientAs(CrmRoles.Technician, userKey: "dashboard-tech");
        var marker = $"D{Guid.NewGuid():N}"[..10];

        var organizationId = await management.CreateOrganizationAsync(new { name = $"{marker} Dashbord AS", status = "Customer" });
        var product = await CatalogApiTests.CreateProductAsync(finance, CatalogApiTests.Product(CatalogApiTests.Sku("MSP"), $"{marker} drift", 4_000m, 1_000m));
        var contract = await (await management.PostAsJsonAsync(Contracts, new
        {
            organizationId, title = $"{marker} Drift", type = "Msp", startDate = Today.AddMonths(-2), endDate = Today.AddDays(45),
            autoRenew = false, renewalTermMonths = 0, noticePeriodDays = 30, invoiceFrequency = "Monthly", invoiceTiming = "InAdvance", indexation = false,
        })).ReadJsonAsync();
        var contractId = contract.GetProperty("id").GetGuid();
        (await management.PostAsJsonAsync($"{Contracts}/{contractId}/lines", new
        {
            productId = product, quantityModel = "Fixed", quantity = 3m, unitPrice = 4_000m, validFrom = Today.AddMonths(-2),
        })).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await management.PostAsync($"{Contracts}/{contractId}/activate", null)).StatusCode.ShouldBe(HttpStatusCode.OK);

        var dashboard = await management.GetFromJsonAsync<JsonElement>("/api/v1/reports/dashboard?months=3");

        // 3 × 4 000 monthly from this contract is part of the recurring total, and ARR is twelve times the MRR.
        dashboard.GetProperty("recurring").GetProperty("mrr").GetDecimal().ShouldBeGreaterThanOrEqualTo(12_000m);
        dashboard.GetProperty("recurring").GetProperty("arr").GetDecimal()
            .ShouldBe(decimal.Round(dashboard.GetProperty("recurring").GetProperty("mrr").GetDecimal() * 12, 2));
        dashboard.GetProperty("recurring").GetProperty("byType").EnumerateArray().Select(t => t.GetProperty("label").GetString()).ShouldContain("Msp");

        // Every month of the window is present, oldest first, so a chart has no gaps.
        var months = dashboard.GetProperty("revenue").EnumerateArray().ToList();
        months.Count.ShouldBe(3);
        months.Select(m => (m.GetProperty("year").GetInt32(), m.GetProperty("month").GetInt32()))
            .ShouldBe(months.Select(m => (m.GetProperty("year").GetInt32(), m.GetProperty("month").GetInt32())).Order().ToList());

        // The panel lists the soonest renewals and says how many there are (DEV-12). Other classes add contracts ending sooner
        // to the shared database, so this one may be past the shown part: then the panel must be full of earlier ends.
        var renewals = dashboard.GetProperty("renewals").EnumerateArray().ToList();
        var ours = renewals.Where(r => r.GetProperty("contractId").GetGuid() == contractId).ToList();
        if (ours.Count == 1)
        {
            ours[0].GetProperty("organization").GetString().ShouldBe($"{marker} Dashbord AS");
        }
        else
        {
            ours.ShouldBeEmpty();
            dashboard.GetProperty("renewalsTotal").GetInt32().ShouldBeGreaterThan(renewals.Count);
            renewals.ShouldAllBe(r => DateOnly.Parse(r.GetProperty("endDate").GetString()!, CultureInfo.InvariantCulture) <= Today.AddDays(45));
        }
        renewals.ShouldAllBe(r => !string.IsNullOrWhiteSpace(r.GetProperty("organization").GetString()));
        dashboard.GetProperty("licenses").GetProperty("subscriptions").GetInt32().ShouldBeGreaterThanOrEqualTo(0);
        dashboard.GetProperty("service").GetProperty("openTickets").GetInt32().ShouldBeGreaterThanOrEqualTo(0);
        dashboard.GetProperty("pipeline").GetProperty("open").GetInt32().ShouldBeGreaterThanOrEqualTo(0);
        dashboard.GetProperty("utilization").ValueKind.ShouldBe(JsonValueKind.Array);

        // A technician has no dashboard at all; a service lead sees it without money.
        (await technician.GetAsync("/api/v1/reports/dashboard")).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        var lead = await factory.ClientAs(CrmRoles.ServiceLead, userKey: "dashboard-lead").GetFromJsonAsync<JsonElement>("/api/v1/reports/dashboard?months=2");
        lead.GetProperty("recurring").TryGetProperty("mrr", out _).ShouldBeFalse();
        lead.GetProperty("revenue").EnumerateArray().First().TryGetProperty("totalExVat", out _).ShouldBeFalse();
        lead.GetProperty("utilization").ValueKind.ShouldBe(JsonValueKind.Array);
        lead.GetProperty("service").GetProperty("openTickets").GetInt32().ShouldBeGreaterThanOrEqualTo(0);
        _ = CultureInfo.InvariantCulture;
    }
}
