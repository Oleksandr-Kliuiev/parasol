using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crm.Authorization;
using Crm.Contracts.Features;
using Crm.Contracts.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crm.IntegrationTests;

public class ContractsApiTests(CrmWebFactory factory)
{
    private const string Contracts = "/api/v1/contracts";

    private static readonly DateOnly Today = DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, TimeZoneInfo.FindSystemTimeZoneById("Europe/Oslo")).DateTime);

    private static object ContractBody(Guid organizationId, DateOnly start, DateOnly? end, bool autoRenew = true, int noticeDays = 90, Guid? slaPolicyId = null, Guid? ownerId = null) => new
    {
        organizationId,
        title = "Managed services",
        type = "Msp",
        startDate = start,
        endDate = end,
        autoRenew,
        renewalTermMonths = 12,
        noticePeriodDays = noticeDays,
        slaPolicyId,
        invoiceFrequency = "Monthly",
        invoiceTiming = "InAdvance",
        indexation = false,
        ownerId,
    };

    private static object Sla(string name) => new
    {
        name,
        coverage = "Business8x5",
        p1 = new { responseMinutes = 60, resolutionMinutes = 240 },
        p2 = new { responseMinutes = 120, resolutionMinutes = 480 },
        p3 = new { responseMinutes = 480, resolutionMinutes = 1440 },
        p4 = new { responseMinutes = 960, resolutionMinutes = 4800 },
        includedHoursPerMonth = 2m,
        overageRate = 1250m,
        afterHoursMultiplier = 1.5m,
        ateraValue = "Gold",
    };

    private async Task<Guid> CreateContractAsync(HttpClient client, object body)
    {
        var response = await client.PostAsJsonAsync(Contracts, body);
        response.StatusCode.ShouldBe(HttpStatusCode.Created);
        return (await response.ReadJsonAsync()).GetProperty("id").GetGuid();
    }

    private async Task<Guid> UserIdAsync(HttpClient client) =>
        (await client.GetFromJsonAsync<JsonElement>("/bff/user")).GetProperty("id").GetGuid();

    [Fact]
    public async Task Contract_lines_use_price_list_or_individual_prices_and_hide_amounts_from_technicians()
    {
        var sales = factory.ClientAs(CrmRoles.Sales);
        var finance = factory.ClientAs(CrmRoles.Finance);
        var organizationId = await sales.CreateOrganizationAsync(TestData.Organization("Contract Customer AS"));
        var workstation = await CatalogApiTests.CreateProductAsync(finance, CatalogApiTests.Product(CatalogApiTests.Sku("WS")));
        var backup = await CatalogApiTests.CreateProductAsync(finance, CatalogApiTests.Product(CatalogApiTests.Sku("BCK"), "Backup", 1200m, 600m, billingPeriod: "Yearly"));
        var sla = await sales.PostAsJsonAsync($"{Contracts}/sla-policies", Sla($"Gold {Guid.NewGuid():N}"));
        sla.StatusCode.ShouldBe(HttpStatusCode.Created);
        var slaId = (await sla.ReadJsonAsync()).GetProperty("id").GetGuid();

        var id = await CreateContractAsync(sales, ContractBody(organizationId, new DateOnly(2026, 1, 1), new DateOnly(2030, 12, 31), slaPolicyId: slaId));
        (await sales.PostAsJsonAsync($"{Contracts}/{id}/lines", new
        {
            productId = workstation, quantityModel = "PerAteraDevice", deviceFilter = "Workstations", quantity = 23m, unitPrice = (decimal?)null, validFrom = "2026-01-01",
        })).StatusCode.ShouldBe(HttpStatusCode.OK);
        var withBackup = await sales.PostAsJsonAsync($"{Contracts}/{id}/lines", new
        {
            productId = backup, quantityModel = "Fixed", quantity = 1m, unitPrice = 1000m, discountPct = 10m, validFrom = "2026-01-01",
        });
        var contract = await withBackup.ReadJsonAsync();

        contract.GetProperty("number").GetString().ShouldStartWith("K-2026-");
        contract.GetProperty("slaPolicy").GetProperty("id").GetGuid().ShouldBe(slaId);
        var lines = contract.GetProperty("lines").EnumerateArray().ToList();
        var ws = lines.Single(l => l.GetProperty("productId").GetGuid() == workstation);
        ws.GetProperty("priceSource").GetString().ShouldBe("ListPrice");
        ws.GetProperty("amount").GetDecimal().ShouldBe(10_350m);
        lines.Single(l => l.GetProperty("productId").GetGuid() == backup).GetProperty("amount").GetDecimal().ShouldBe(900m);
        contract.GetProperty("monthlyValue").GetDecimal().ShouldBe(10_425m); // 10 350 + 900 / 12

        var asTechnician = await factory.ClientAs(CrmRoles.Technician).GetFromJsonAsync<JsonElement>($"{Contracts}/{id}");
        asTechnician.TryGetProperty("monthlyValue", out _).ShouldBeFalse();
        var technicianLine = asTechnician.GetProperty("lines").EnumerateArray().Single(l => l.GetProperty("productId").GetGuid() == workstation);
        technicianLine.TryGetProperty("amount", out _).ShouldBeFalse();
        technicianLine.GetProperty("quantity").GetDecimal().ShouldBe(23m);
        (await factory.ClientAs(CrmRoles.Technician).PostAsync($"{Contracts}/{id}/activate", null)).StatusCode.ShouldBe(HttpStatusCode.Forbidden);

        // Product used by a contract line cannot be deleted (BR-CAT-03).
        (await finance.DeleteAsync($"/api/v1/catalog/products/{backup}")).StatusCode.ShouldBe(HttpStatusCode.Conflict);
    }

    [Fact]
    public async Task Running_contract_keeps_price_history_and_follows_the_status_flow()
    {
        var sales = factory.ClientAs(CrmRoles.Sales);
        var finance = factory.ClientAs(CrmRoles.Finance);
        var organizationId = await sales.CreateOrganizationAsync(TestData.Organization("Versioned Contract AS"));
        var product = await CatalogApiTests.CreateProductAsync(finance, CatalogApiTests.Product(CatalogApiTests.Sku("WS")));
        var id = await CreateContractAsync(sales, ContractBody(organizationId, new DateOnly(2026, 1, 1), new DateOnly(2026, 12, 31), noticeDays: 90));
        var added = await (await sales.PostAsJsonAsync($"{Contracts}/{id}/lines", new
        {
            productId = product, quantityModel = "Fixed", quantity = 10m, unitPrice = 450m, validFrom = "2026-01-01",
        })).ReadJsonAsync();
        var lineId = added.GetProperty("lines")[0].GetProperty("id").GetGuid();

        (await sales.PostAsync($"{Contracts}/{id}/activate", null)).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await sales.DeleteAsync($"{Contracts}/{id}")).StatusCode.ShouldBe(HttpStatusCode.Conflict);

        var revised = await sales.PostAsJsonAsync($"{Contracts}/{id}/lines/{lineId}/revise", new { quantity = 10m, unitPrice = 480m, effectiveFrom = "2026-07-01" });
        revised.StatusCode.ShouldBe(HttpStatusCode.OK);
        var versions = (await revised.ReadJsonAsync()).GetProperty("lines").EnumerateArray().ToList();
        versions.Count.ShouldBe(2);
        versions.Select(v => v.GetProperty("version").GetInt32()).ShouldBe([1, 2]);
        versions[0].GetProperty("validTo").GetString().ShouldBe("2026-06-30");
        versions[1].GetProperty("unitPrice").GetDecimal().ShouldBe(480m);

        var tooShort = await sales.PostAsJsonAsync($"{Contracts}/{id}/notice", new { noticeDate = "2026-11-15", endDate = "2026-12-31" });
        tooShort.StatusCode.ShouldBe(HttpStatusCode.BadRequest);
        (await tooShort.ReadJsonAsync()).GetProperty("earliestEndDate").GetString().ShouldBe("2027-02-13");

        var notice = await sales.PostAsJsonAsync($"{Contracts}/{id}/notice", new { noticeDate = "2026-09-01", endDate = "2026-12-31" });
        (await notice.ReadJsonAsync()).GetProperty("status").GetString().ShouldBe("NoticeGiven");

        var history = await factory.ClientAs(CrmRoles.Admin).GetFromJsonAsync<JsonElement>($"/api/v1/audit?entityId={id}");
        history.GetProperty("items").EnumerateArray().Count().ShouldBeGreaterThanOrEqualTo(2);
    }

    [Fact]
    public async Task Hour_bank_consumption_warns_the_owner_below_twenty_percent()
    {
        var sales = factory.ClientAs(CrmRoles.Sales, userKey: "hour-bank-owner");
        var ownerId = await UserIdAsync(sales);
        var organizationId = await sales.CreateOrganizationAsync(TestData.Organization("Klippekort Kunde AS"));
        var contractId = await CreateContractAsync(sales, ContractBody(organizationId, Today.AddMonths(-1), null, autoRenew: false, ownerId: ownerId));

        var created = await sales.PostAsJsonAsync($"{Contracts}/hour-banks", new
        {
            organizationId, contractId, name = "Klippekort 20 t", hours = 20m, validFrom = Today.AddMonths(-1), overageRate = 1250m,
        });
        created.StatusCode.ShouldBe(HttpStatusCode.Created);
        var bankId = (await created.ReadJsonAsync()).GetProperty("id").GetGuid();

        await sales.PostAsJsonAsync($"{Contracts}/hour-banks/{bankId}/entries", new { kind = "Consumption", hours = 15.5m, date = Today });
        var afterSecond = await (await sales.PostAsJsonAsync($"{Contracts}/hour-banks/{bankId}/entries", new { kind = "Consumption", hours = 1m, date = Today })).ReadJsonAsync();

        afterSecond.GetProperty("remainingHours").GetDecimal().ShouldBe(3.5m);
        afterSecond.GetProperty("isLow").GetBoolean().ShouldBeTrue();
        afterSecond.GetProperty("entries").EnumerateArray().Count().ShouldBe(3);

        // Events may be claimed by a parallel test's outbox run; poll until the handler has run.
        JsonElement? found = null;
        for (var attempt = 0; attempt < 40 && found is null; attempt++)
        {
            await factory.ProcessEventsAsync();
            var reminders = await sales.GetFromJsonAsync<JsonElement>($"{Contracts}/reminders?mine=true&limit=200");
            found = reminders.GetProperty("items").EnumerateArray()
                .Where(r => r.TryGetProperty("hourBank", out var b) && b.ValueKind == JsonValueKind.Object && b.GetProperty("id").GetGuid() == bankId)
                .Select(r => (JsonElement?)r)
                .FirstOrDefault();
            if (found is null)
            {
                await Task.Delay(250, TestContext.Current.CancellationToken);
            }
        }

        var reminder = found.ShouldNotBeNull();
        reminder.GetProperty("kind").GetString().ShouldBe("HourBankLow");
        reminder.GetProperty("hourBank").GetProperty("remainingHours").GetDecimal().ShouldBe(3.5m);

        (await sales.PostAsync($"{Contracts}/reminders/{reminder.GetProperty("id").GetGuid()}/acknowledge", null)).StatusCode.ShouldBe(HttpStatusCode.NoContent);
        (await sales.GetFromJsonAsync<JsonElement>($"{Contracts}/reminders?mine=true&limit=200")).GetProperty("items").EnumerateArray()
            .ShouldNotContain(r => r.GetProperty("id").GetGuid() == reminder.GetProperty("id").GetGuid());

        // Adjustments need a reason.
        (await sales.PostAsJsonAsync($"{Contracts}/hour-banks/{bankId}/entries", new { kind = "Adjustment", hours = 1m, date = Today }))
            .StatusCode.ShouldBe(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Lifecycle_job_renews_ends_and_reminds_once()
    {
        var sales = factory.ClientAs(CrmRoles.Sales, userKey: "renewal-owner");
        var ownerId = await UserIdAsync(sales);
        var organizationId = await sales.CreateOrganizationAsync(TestData.Organization("Renewal Customer AS"));
        var renewing = await CreateContractAsync(sales, ContractBody(organizationId, Today.AddYears(-1), Today.AddDays(-1), noticeDays: 30, ownerId: ownerId));
        var ending = await CreateContractAsync(sales, ContractBody(organizationId, Today.AddYears(-1), Today.AddDays(-1), autoRenew: false, ownerId: ownerId));
        var soon = await CreateContractAsync(sales, ContractBody(organizationId, Today.AddYears(-1), Today.AddDays(25), autoRenew: false, ownerId: ownerId));
        foreach (var id in new[] { renewing, ending, soon })
        {
            (await sales.PostAsync($"{Contracts}/{id}/activate", null)).StatusCode.ShouldBe(HttpStatusCode.OK);
        }

        await factory.RunJobAsync<ContractLifecycleJob>(job => job.RunAsync(CancellationToken.None));
        await factory.RunJobAsync<ContractLifecycleJob>(job => job.RunAsync(CancellationToken.None));

        var renewed = await sales.GetFromJsonAsync<JsonElement>($"{Contracts}/{renewing}");
        renewed.GetProperty("status").GetString().ShouldBe("Active");
        renewed.GetProperty("endDate").GetString().ShouldBe(Today.AddDays(-1).AddMonths(12).ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture));
        renewed.GetProperty("renewalCount").GetInt32().ShouldBe(1);
        (await sales.GetFromJsonAsync<JsonElement>($"{Contracts}/{ending}")).GetProperty("status").GetString().ShouldBe("Ended");

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<ContractsDbContext>();
        var reminders = await db.Reminders.AsNoTracking().Where(r => r.ContractId == soon).ToListAsync();
        var reminder = reminders.ShouldHaveSingleItem();
        reminder.DaysBefore.ShouldBe(30);
        reminder.AssigneeId.ShouldBe(ownerId);

        var mine = await sales.GetFromJsonAsync<JsonElement>($"{Contracts}/reminders?mine=true&limit=200");
        mine.GetProperty("items").EnumerateArray().ShouldContain(r => r.GetProperty("contract").GetProperty("id").GetGuid() == soon);
        (await sales.GetFromJsonAsync<JsonElement>($"{Contracts}?organizationId={organizationId}&endingWithinDays=60"))
            .GetProperty("items").EnumerateArray().Select(c => c.GetProperty("id").GetGuid()).ShouldBe([soon]);
    }

    [Fact]
    public async Task Contracts_follow_an_organization_merge_and_its_undo()
    {
        var admin = factory.ClientAs(CrmRoles.Admin);
        var target = await admin.CreateOrganizationAsync(TestData.Organization("Merge Target Contracts AS"));
        var source = await admin.CreateOrganizationAsync(new { name = "Merge Source Contracts", status = "Customer" });
        var contract = await CreateContractAsync(admin, ContractBody(source, Today, null, autoRenew: false));

        var merged = await admin.PostAsJsonAsync($"/api/v1/customers/organizations/{target}/merge", new { sourceOrganizationId = source });
        merged.StatusCode.ShouldBe(HttpStatusCode.OK);
        var mergeId = (await merged.ReadJsonAsync()).GetProperty("mergeId").GetGuid();
        async Task<Guid> OrganizationOfContractAsync() =>
            (await admin.GetFromJsonAsync<JsonElement>($"{Contracts}/{contract}")).GetProperty("organization").GetProperty("id").GetGuid();

        await factory.EventuallyAsync(async () => await OrganizationOfContractAsync() == target);
        (await OrganizationOfContractAsync()).ShouldBe(target);

        (await admin.PostAsync($"/api/v1/customers/organizations/merges/{mergeId}/undo", null)).StatusCode.ShouldBe(HttpStatusCode.NoContent);
        await factory.EventuallyAsync(async () => await OrganizationOfContractAsync() == source);
        (await OrganizationOfContractAsync()).ShouldBe(source);
    }
}
