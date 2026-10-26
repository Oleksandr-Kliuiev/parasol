using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crm.Authorization;
using Crm.Backup.Contracts;
using Crm.Billing.Features;
using Crm.Billing.Persistence;
using Crm.Security.Contracts;
using Crm.Security.Domain;
using Crm.Security.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using static Crm.IntegrationTests.IntegrationTestHelpers;

namespace Crm.IntegrationTests;

/// <summary>
/// M43 on SQL Server: a contract line priced per Huntress agent or per backup seat is billed with what Huntress and CloudAlly counted on
/// the last day read on or before the end of the period; an old count says so and no count bills the estimate and says so (DEV-19,
/// never a block). The customer's card shows the same counts against the contract and CloudAlly's bill lines, their money for cost
/// readers only. The estimated-quantity signal is a global count, so the class shares the collection that runs alone.
/// </summary>
[Collection(OperationalSignalsCollection.Name)]
public sealed class ServiceQuantityBillingTests(CrmWebFactory factory)
{
    private const string Billing = "/api/v1/billing";
    private const string Contracts = "/api/v1/contracts";
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    // A month in the past no other class bills, so a reading's age is counted from the period's end.
    private static readonly DateOnly Period = new(2023, 2, 1);
    private static readonly DateOnly PeriodEnd = new(2023, 2, 28);

    private sealed record Customer(Guid OrganizationId, string Marker);

    [Fact]
    public async Task Agents_and_seats_are_billed_from_the_last_day_read_and_an_old_or_missing_count_says_so()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, "quantities-admin");
        var finance = factory.ClientAs(CrmRoles.Finance, "quantities-finance");
        var agents = await CatalogApiTests.CreateProductAsync(finance, CatalogApiTests.Product(CatalogApiTests.Sku("HNT"), "Huntress per agent", 60m, 30m));
        var seats = await CatalogApiTests.CreateProductAsync(finance, CatalogApiTests.Product(CatalogApiTests.Sku("BKP"), "Backup per seat", 40m, 20m));
        var counted = await CustomerAsync(admin, agents, seats, "C", Period, PeriodEnd);
        var stale = await CustomerAsync(admin, agents, seats, "S", Period, PeriodEnd);
        var missing = await CustomerAsync(admin, agents, seats, "M", Period, PeriodEnd);
        // Two Huntress organizations of one customer add up; a day after the period is never what the period bills.
        await AgentsAsync(counted.OrganizationId, PeriodEnd.AddDays(-1), (TestData.AteraId(), 7), (TestData.AteraId(), 5));
        await AgentsAsync(counted.OrganizationId, PeriodEnd.AddDays(1), (TestData.AteraId(), 99));
        // A person is billed once per account however many services back them up; accounts add up.
        await SeatsAsync(counted.OrganizationId, PeriodEnd, ("acc-c1", "MS365", 9), ("acc-c1", "ONEDRIVE", 8), ("acc-c2", "MS365", 2));
        await AgentsAsync(stale.OrganizationId, PeriodEnd.AddDays(-10), (TestData.AteraId(), 4));
        await SeatsAsync(stale.OrganizationId, PeriodEnd.AddDays(-10), ("acc-s1", "MS365", 6));
        var before = await SignalAsync();

        var created = await finance.PostAsJsonAsync($"{Billing}/runs", new { year = Period.Year, month = Period.Month, notes = counted.Marker }, Ct);
        created.StatusCode.ShouldBe(HttpStatusCode.Created, await created.Content.ReadAsStringAsync(Ct));
        var runId = (await created.ReadJsonAsync()).GetProperty("id").GetGuid();
        (await finance.RunCommandAsync(runId, "collect")).StatusCode.ShouldBe(HttpStatusCode.OK);

        var (countedLines, countedAnomalies) = await BasisAsync(finance, runId, counted);
        countedLines.ShouldBe([("Huntress per agent", 12m), ("Backup per seat", 11m)], ignoreOrder: true);
        countedAnomalies.ShouldNotContain(a => a.Code.StartsWith("BIL_NO_", StringComparison.Ordinal) || a.Code == "BIL_STALE_QUANTITY");

        var (staleLines, staleAnomalies) = await BasisAsync(finance, runId, stale);
        staleLines.ShouldBe([("Huntress per agent", 4m), ("Backup per seat", 6m)], ignoreOrder: true);
        staleAnomalies.Where(a => a.Code == "BIL_STALE_QUANTITY").Select(a => a.Date).ShouldBe(["18.02.2023", "18.02.2023"]);

        var (missingLines, missingAnomalies) = await BasisAsync(finance, runId, missing);
        missingLines.ShouldBe([("Huntress per agent", 3m), ("Backup per seat", 4m)], ignoreOrder: true, "the contract's estimates");
        missingAnomalies.Select(a => a.Code).ShouldContain("BIL_NO_AGENT_READING");
        missingAnomalies.Select(a => a.Code).ShouldContain("BIL_NO_SEAT_READING");
        missingAnomalies.Single(a => a.Code == "BIL_NO_AGENT_READING").Product.ShouldBe("Huntress per agent");

        // The run bills every customer whose contract covers the month, another class's too, so the signal is compared with the
        // run's own estimated bases: the stale and the missing one are among them. (Whether the counted one is depends on what other
        // classes left in the shared database, an incomplete hours import for the month; its own counts were checked above.)
        var estimated = await EstimatedBasesAsync(runId);
        estimated.ShouldContain(stale.OrganizationId);
        estimated.ShouldContain(missing.OrganizationId);
        (await SignalAsync()).ShouldBe(before + estimated.Count, "every estimated basis of the run counts once, a missing count among them");
    }

    [Fact]
    public async Task The_card_shows_what_the_services_count_against_the_contract_and_cloudallys_bill_money_to_cost_readers_only()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, "quantities-card");
        var finance = factory.ClientAs(CrmRoles.Finance, "quantities-card-finance");
        var agents = await CatalogApiTests.CreateProductAsync(finance, CatalogApiTests.Product(CatalogApiTests.Sku("HNT"), "Huntress per agent", 60m, 30m));
        var today = DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, TimeZoneInfo.FindSystemTimeZoneById("Europe/Oslo")).DateTime);
        var customer = await CustomerAsync(admin, agents, null, "Q", today.AddDays(-40), null);
        await AgentsAsync(customer.OrganizationId, today, (TestData.AteraId(), 21));
        await SeatsAsync(customer.OrganizationId, today.AddDays(-5), ("acc-q1", "MS365", 14));

        var card = await admin.GetFromJsonAsync<JsonElement>($"{Billing}/organizations/{customer.OrganizationId}/service-quantities", Ct);
        var services = card.GetProperty("services").EnumerateArray().ToDictionary(s => s.GetProperty("model").GetString()!);
        var huntress = services["PerHuntressAgent"];
        (huntress.GetProperty("status").GetString(), huntress.GetProperty("count").GetInt32(), huntress.GetProperty("stale").GetBoolean())
            .ShouldBe(("Counted", 21, false));
        var line = huntress.GetProperty("lines").EnumerateArray().ShouldHaveSingleItem();
        (line.GetProperty("estimate").GetDecimal(), line.GetProperty("billed").GetDecimal()).ShouldBe((3m, 21m));
        var cloudAlly = services["PerBackupSeat"];
        (cloudAlly.GetProperty("status").GetString(), cloudAlly.GetProperty("count").GetInt32(), cloudAlly.GetProperty("stale").GetBoolean())
            .ShouldBe(("NotOnContract", 14, true));
        cloudAlly.GetProperty("billLines").EnumerateArray().ShouldHaveSingleItem().GetProperty("price").GetDecimal().ShouldBe(2.5m);
        services["PerAteraDevice"].GetProperty("status").GetString().ShouldBe("None");

        // Sales reads billing but not what the partner pays: the counts stay, the money of CloudAlly's bill is removed by the server.
        var sales = factory.ClientAs(CrmRoles.Sales, "quantities-sales");
        var asSales = await sales.GetFromJsonAsync<JsonElement>($"{Billing}/organizations/{customer.OrganizationId}/service-quantities", Ct);
        var bill = asSales.GetProperty("services").EnumerateArray().Single(s => s.GetProperty("model").GetString() == "PerBackupSeat")
            .GetProperty("billLines").EnumerateArray().ShouldHaveSingleItem();
        bill.GetProperty("seats").GetInt32().ShouldBe(14);
        bill.TryGetProperty("price", out _).ShouldBeFalse();
        bill.TryGetProperty("total", out _).ShouldBeFalse();
        (await factory.ClientAs(CrmRoles.Technician, "quantities-tech").GetAsync($"{Billing}/organizations/{customer.OrganizationId}/service-quantities", Ct))
            .StatusCode.ShouldBe(HttpStatusCode.Forbidden);
    }

    private static async Task<Customer> CustomerAsync(HttpClient admin, Guid agents, Guid? seats, string prefix, DateOnly start, DateOnly? end)
    {
        var marker = $"{prefix}{Guid.NewGuid():N}"[..10];
        var organizationId = await admin.CreateOrganizationAsync(new { name = $"{marker} Tjenester AS", status = "Customer" });
        var contractId = (await (await admin.PostAsJsonAsync(Contracts, new
        {
            organizationId, title = $"{marker} Drift", type = "Msp", startDate = start, endDate = end,
            autoRenew = false, renewalTermMonths = 0, noticePeriodDays = 30, invoiceFrequency = "Monthly", invoiceTiming = "InAdvance", indexation = false,
        }, Ct)).ReadJsonAsync()).GetProperty("id").GetGuid();
        (await admin.PostAsJsonAsync($"{Contracts}/{contractId}/lines", new
        {
            productId = agents, quantityModel = "PerHuntressAgent", quantity = 3m, unitPrice = 60m, validFrom = start,
        }, Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
        if (seats is { } seatProduct)
        {
            (await admin.PostAsJsonAsync($"{Contracts}/{contractId}/lines", new
            {
                productId = seatProduct, quantityModel = "PerBackupSeat", quantity = 4m, unitPrice = 40m, validFrom = start,
            }, Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
        }

        (await admin.PostAsync($"{Contracts}/{contractId}/activate", null, Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
        return new Customer(organizationId, marker);
    }

    /// <summary>The day's agent counts of the customer's Huntress organizations, as the hourly read stores them.</summary>
    private async Task AgentsAsync(Guid organizationId, DateOnly day, params (long Huntress, int Billable)[] organizations)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<SecurityDbContext>();
        foreach (var (huntress, billable) in organizations)
        {
            db.UsageDays.Add(UsageDay.From(new ExternalUsage(SecuritySources.Huntress, huntress, organizationId, $"Org {huntress}", billable + 1, billable, 0, 0, 0,
                null, null, null), day, DateTimeOffset.UtcNow));
        }

        await db.SaveChangesAsync(Ct);
    }

    /// <summary>The day's bill lines of the customer's CloudAlly accounts, as the nightly read stores them.</summary>
    private Task SeatsAsync(Guid organizationId, DateOnly day, params (string Account, string Source, int Seats)[] lines) =>
        factory.RunJobAsync<IBackupApi>(api => api.ApplyBillsAsync(BackupSources.CloudAlly, day,
            [.. lines.Select(l => new ExternalBackupBillLine(l.Account, organizationId, "BACKUP", l.Source, l.Source == "MS365" ? "Exchange" : "OneDrive", l.Seats,
                l.Seats, 2.5m, 2.5m * l.Seats, "EUR", "MONTHLY", null))], Ct));

    /// <summary>The customers of the run whose basis carries a code of an estimated quantity, the way the signal reads them.</summary>
    private async Task<List<Guid>> EstimatedBasesAsync(Guid runId)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var bases = await scope.ServiceProvider.GetRequiredService<BillingDbContext>().BillingBases.AsNoTracking()
            .Where(b => b.RunId == runId)
            .Select(b => new { b.OrganizationId, b.AnomaliesJson })
            .ToListAsync(Ct);
        return [.. bases.Where(b => b.AnomaliesJson is { } json && BillingOperationalSignals.EstimatedCodes.Any(code => json.Contains(code, StringComparison.Ordinal)))
            .Select(b => b.OrganizationId)];
    }

    private async Task<int> SignalAsync()
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var source = new BillingOperationalSignals(scope.ServiceProvider.GetRequiredService<BillingDbContext>(), TimeProvider.System);
        return (await source.ReadAsync(Ct)).Single(s => s.Key == "billing:estimated").Count;
    }

    private static async Task<(List<(string Product, decimal Quantity)> Lines, List<(string Code, string? Date, string? Product)> Anomalies)> BasisAsync(
        HttpClient finance, Guid runId, Customer customer)
    {
        var basis = (await finance.GetFromJsonAsync<JsonElement>($"{Billing}/runs/{runId}/bases?search={customer.Marker}", Ct))
            .EnumerateArray().Single(b => b.GetProperty("organization").GetProperty("id").GetGuid() == customer.OrganizationId);
        var anomalies = basis.GetProperty("anomalies").EnumerateArray().Select(a => (
            a.GetProperty("code").GetString()!,
            a.TryGetProperty("args", out var args) && args.ValueKind == JsonValueKind.Object && args.TryGetProperty("date", out var date) ? date.GetString() : null,
            a.TryGetProperty("args", out var named) && named.ValueKind == JsonValueKind.Object && named.TryGetProperty("product", out var product) ? product.GetString() : null))
            .ToList();
        var detail = await finance.GetFromJsonAsync<JsonElement>($"{Billing}/bases/{basis.GetProperty("id").GetGuid()}", Ct);
        var lines = detail.GetProperty("lines").EnumerateArray()
            .Select(l => (l.GetProperty("description").GetString()!.Split(" (")[0].Split(',')[0].Trim(), l.GetProperty("quantity").GetDecimal()))
            .ToList();
        return (lines, anomalies);
    }
}
