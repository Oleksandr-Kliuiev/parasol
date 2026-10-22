using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crm.Authorization;
using Crm.Billing.Features;
using Crm.Billing.Persistence;
using Crm.Integrations.Core;
using Crm.Integrations.Core.Persistence;
using Crm.Service.Contracts;
using Crm.Service.Domain;
using Crm.Service.Persistence;
using Crm.SharedKernel.Domain;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using static Crm.IntegrationTests.IntegrationTestHelpers;

namespace Crm.IntegrationTests;

/// <summary>
/// DEV-19 AC05: a basis built from an old or incomplete quantity says so, and Finance sees the open ones as one signal that clears
/// by itself. The signal is a global count, so the class shares the collection that runs alone.
/// </summary>
[Collection(OperationalSignalsCollection.Name)]
public sealed class BillingQuantityFreshnessTests(CrmWebFactory factory)
{
    private const string Billing = "/api/v1/billing";
    private const string Contracts = "/api/v1/contracts";
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    // A month in the past, so the reading's age is counted from the period end and not from today.
    private static readonly DateOnly Period = new(2022, 6, 1);
    private static readonly DateOnly PeriodEnd = new(2022, 6, 30);

    private sealed record Customer(Guid OrganizationId, string Marker);

    private static async Task<Customer> DeviceCustomerAsync(HttpClient admin, Guid productId, string prefix)
    {
        var marker = $"{prefix}{Guid.NewGuid():N}"[..10];
        var organizationId = await admin.CreateOrganizationAsync(new { name = $"{marker} Enheter AS", status = "Customer" });
        var contractId = (await (await admin.PostAsJsonAsync(Contracts, new
        {
            organizationId, title = $"{marker} Drift", type = "Msp", startDate = Period, endDate = PeriodEnd,
            autoRenew = false, renewalTermMonths = 0, noticePeriodDays = 30, invoiceFrequency = "Monthly", invoiceTiming = "InAdvance", indexation = false,
        })).ReadJsonAsync()).GetProperty("id").GetGuid();
        (await admin.PostAsJsonAsync($"{Contracts}/{contractId}/lines", new
        {
            productId, quantityModel = "PerAteraDevice", deviceFilter = "Workstations", quantity = 1m, unitPrice = 100m, validFrom = Period,
        })).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await admin.PostAsync($"{Contracts}/{contractId}/activate", null)).StatusCode.ShouldBe(HttpStatusCode.OK);
        return new Customer(organizationId, marker);
    }

    private async Task SnapshotAsync(Guid organizationId, DateOnly date)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ServiceDbContext>();
        db.DeviceCountSnapshots.Add(new DeviceCountSnapshot(organizationId, date, DeviceType.Workstation, 5));
        await db.SaveChangesAsync(Ct);
    }

    /// <summary>The newest finished run of the work-hours import; the last one recorded decides what the bases say.</summary>
    private async Task HoursRunAsync(bool complete)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
        // Later than any run the other tests recorded for the job, so this one is the latest finished run.
        var latest = await db.SyncRuns.Where(r => r.System == "atera" && r.Job == "atera-work-hours").MaxAsync(r => (DateTimeOffset?)r.StartedAt, Ct);
        var started = (latest is { } l && l > DateTimeOffset.UtcNow ? l : DateTimeOffset.UtcNow).AddSeconds(1);
        db.SyncRuns.Add(new SyncRun
        {
            Id = SequentialId.New(), System = "atera", Job = "atera-work-hours", StartedAt = started, FinishedAt = started,
            Status = SyncRunStatus.Succeeded, Failed = complete ? 0 : 2, Message = "synthetic",
        });
        await db.SaveChangesAsync(Ct);
    }

    private async Task<int> SignalAsync()
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var source = new BillingOperationalSignals(scope.ServiceProvider.GetRequiredService<BillingDbContext>(), TimeProvider.System);
        var signal = (await source.ReadAsync(Ct)).Single(s => s.Key == "billing:estimated");
        signal.RequiredPermission.ShouldBe(Permissions.FinanceRead);
        return signal.Count;
    }

    private static async Task<List<JsonElement>> AnomaliesAsync(HttpClient finance, Guid runId, Customer customer)
    {
        var basis = (await finance.GetFromJsonAsync<JsonElement>($"{Billing}/runs/{runId}/bases?search={customer.Marker}"))
            .EnumerateArray().Single(b => b.GetProperty("organization").GetProperty("id").GetGuid() == customer.OrganizationId);
        return basis.GetProperty("anomalies").EnumerateArray().ToList();
    }

    [Fact]
    public async Task AC05_stale_missing_and_incomplete_quantities_are_flagged_on_the_basis_and_the_signal_clears_when_they_are_fresh()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, "freshness-admin");
        var finance = factory.ClientAs(CrmRoles.Finance, "freshness-finance");
        var productId = await CatalogApiTests.CreateProductAsync(finance, CatalogApiTests.Product(CatalogApiTests.Sku("FRS"), "Enhetsdrift", 100m, 50m));
        var stale = await DeviceCustomerAsync(admin, productId, "S");
        var fresh = await DeviceCustomerAsync(admin, productId, "F");
        var live = await DeviceCustomerAsync(admin, productId, "L");
        await SnapshotAsync(stale.OrganizationId, PeriodEnd.AddDays(-10));
        await SnapshotAsync(fresh.OrganizationId, PeriodEnd.AddDays(-1));
        // No snapshot for the third customer: the Atera devices listed now are counted (M40: only Atera's agents are billed per device).
        await factory.RunJobAsync<IServiceApi>(api => api.ReplaceDevicesAsync(
            live.OrganizationId, Crm.Integrations.Atera.AteraTypes.System,
            [new ExternalDevice($"{live.Marker}-1", "PC-1", DeviceType.Workstation, null, true, DateTimeOffset.UtcNow, null)], CancellationToken.None));
        await HoursRunAsync(complete: false);
        var before = await SignalAsync();

        var created = await finance.PostAsJsonAsync($"{Billing}/runs", new { year = Period.Year, month = Period.Month, notes = stale.Marker });
        created.StatusCode.ShouldBe(HttpStatusCode.Created);
        var runId = (await created.ReadJsonAsync()).GetProperty("id").GetGuid();
        (await finance.RunCommandAsync(runId, "collect")).StatusCode.ShouldBe(HttpStatusCode.OK);

        var staleCodes = await AnomaliesAsync(finance, runId, stale);
        var staleAnomaly = staleCodes.Single(a => a.GetProperty("code").GetString() == "BIL_STALE_QUANTITY");
        staleAnomaly.GetProperty("message").GetString()!.ShouldContain("20.06.2022");
        staleAnomaly.GetProperty("args").GetProperty("date").GetString().ShouldBe("20.06.2022");
        (await AnomaliesAsync(finance, runId, live)).ShouldContain(a => a.GetProperty("code").GetString() == "BIL_NO_DEVICE_SNAPSHOT");
        var freshCodes = (await AnomaliesAsync(finance, runId, fresh)).Select(a => a.GetProperty("code").GetString()).ToList();
        freshCodes.ShouldNotContain("BIL_STALE_QUANTITY");
        freshCodes.ShouldNotContain("BIL_NO_DEVICE_SNAPSHOT");
        // The hours import did not finish completely: every basis of the run says hours may be missing.
        foreach (var customer in new[] { stale, fresh, live })
        {
            (await AnomaliesAsync(finance, runId, customer)).ShouldContain(a => a.GetProperty("code").GetString() == "BIL_INCOMPLETE_HOURS");
        }

        (await SignalAsync()).ShouldBe(before + 3);
        var monitoring = await admin.GetFromJsonAsync<JsonElement>("/api/v1/integrations/monitoring", Ct);
        monitoring.GetProperty("exceptions").EnumerateArray().Single(e => e.GetProperty("key").GetString() == "billing:estimated")
            .GetProperty("count").GetInt32().ShouldBe(before + 3);

        // The import completes: the hours note goes away on the next collect, the other two stay until their readings are fresh.
        await HoursRunAsync(complete: true);
        (await finance.RunCommandAsync(runId, "collect")).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await AnomaliesAsync(finance, runId, fresh)).ShouldNotContain(a => a.GetProperty("code").GetString() == "BIL_INCOMPLETE_HOURS");
        (await SignalAsync()).ShouldBe(before + 2);

        await SnapshotAsync(stale.OrganizationId, PeriodEnd);
        await SnapshotAsync(live.OrganizationId, PeriodEnd);
        (await finance.RunCommandAsync(runId, "collect")).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await AnomaliesAsync(finance, runId, stale)).ShouldNotContain(a => a.GetProperty("code").GetString() == "BIL_STALE_QUANTITY");
        (await AnomaliesAsync(finance, runId, live)).ShouldNotContain(a => a.GetProperty("code").GetString() == "BIL_NO_DEVICE_SNAPSHOT");

        // Explicit recovery: nothing of this run is left in the count, and the signal is reported as a zero above the baseline.
        (await SignalAsync()).ShouldBe(before);
        var recovered = await admin.GetFromJsonAsync<JsonElement>("/api/v1/integrations/monitoring", Ct);
        if (before == 0)
        {
            recovered.GetProperty("exceptions").EnumerateArray().ShouldNotContain(e => e.GetProperty("key").GetString() == "billing:estimated");
        }
    }
}
