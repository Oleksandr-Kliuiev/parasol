using System.Collections.Concurrent;
using System.Data.Common;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crm.Authorization;
using Crm.Billing.Contracts;
using Crm.Billing.Persistence;
using Crm.Contracts.Contracts;
using Crm.Contracts.Domain;
using Crm.Contracts.Persistence;
using Crm.Licensing.Contracts;
using Crm.Licensing.Domain;
using Crm.Licensing.Persistence;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using static Crm.IntegrationTests.IntegrationTestHelpers;

namespace Crm.IntegrationTests;

/// <summary>DEV-16: real SQL proves the collector's portfolio reads stay constant as the run grows, with unchanged charges.</summary>
public sealed class BillingCollectionPerformanceTests(CrmWebFactory factory)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Collection_reads_each_scoped_portfolio_once_for_three_then_twelve_customers()
    {
        var period = new DateOnly(2082, 11, 1);
        var marker = "DEV16-" + Guid.NewGuid().ToString("N")[..8];
        var admin = factory.ClientAs(CrmRoles.Admin);
        var finance = factory.ClientAs(CrmRoles.Finance);
        var productId = await ProductAsync(finance, marker);
        var extraProductId = await ProductAsync(finance, marker + "-extra");
        var organizations = new List<Guid>();
        for (var i = 0; i < 3; i++) organizations.Add(await SeedCustomerAsync(admin, marker + i, productId, extraProductId, period));
        var run = await finance.PostAsJsonAsync("/api/v1/billing/runs", new { year = period.Year, month = period.Month, notes = marker }, Ct);
        run.StatusCode.ShouldBe(HttpStatusCode.Created);
        var runId = (await run.ReadJsonAsync()).GetProperty("id").GetGuid();
        var commands = new SqlReadCounter();
        await using var host = factory.WithWebHostBuilder(builder => builder.ConfigureTestServices(services =>
        {
            services.AddDbContext<LicensingDbContext>(options => options.AddInterceptors(commands));
            services.AddDbContext<ContractsDbContext>(options => options.AddInterceptors(commands));
            services.AddDbContext<BillingDbContext>(options => options.AddInterceptors(commands));
        }));
        var measured = host.CreateClient();
        measured.DefaultRequestHeaders.Add(TestAuthHandler.RolesHeader, CrmRoles.Finance);
        measured.DefaultRequestHeaders.Add(TestAuthHandler.UserHeader, "dev16-measured-billing");
        measured.DefaultRequestHeaders.Add("X-CSRF", "1");
        commands.Clear();
        (await measured.RunCommandAsync(runId, "collect")).StatusCode.ShouldBe(HttpStatusCode.OK);
        var smaller = commands.Count("[licensing].[CspSubscriptions]");
        smaller.ShouldBe(2, "one scoped quantity query and one batch unmapped-offer query, independent of customer count");
        commands.Count("[contracts].[ContractLines]").ShouldBe(2, "billable lines and the batch contracted-products lookup");
        for (var i = 3; i < 12; i++) organizations.Add(await SeedCustomerAsync(admin, marker + i, productId, extraProductId, period));
        commands.Clear();
        (await measured.RunCommandAsync(runId, "collect")).StatusCode.ShouldBe(HttpStatusCode.OK);
        commands.Count("[licensing].[CspSubscriptions]").ShouldBe(smaller);
        commands.Count("[contracts].[ContractLines]").ShouldBe(2);
        await using var scope = factory.Services.CreateAsyncScope();
        var bases = await scope.ServiceProvider.GetRequiredService<BillingDbContext>().BillingBases.AsNoTracking().Include(b => b.Lines)
            .Where(b => b.RunId == runId && organizations.Contains(b.OrganizationId)).ToListAsync(Ct);
        bases.Count.ShouldBe(12);
        foreach (var basis in bases)
        {
            basis.TotalExVat.ShouldBe(50m);
            basis.BilledLines.ShouldHaveSingleItem().Quantity.ShouldBe(5m);
            basis.Anomalies.Select(a => a.Code).ShouldContain("BIL_SUBSCRIPTION_NOT_CONTRACTED");
            basis.Anomalies.Select(a => a.Code).ShouldContain("BIL_SUBSCRIPTION_NOT_MAPPED");
        }
        // The dashboard/margin contracts return SQL aggregates, never every billing line to aggregate in memory.
        await using var reportsScope = host.Services.CreateAsyncScope();
        var reporting = reportsScope.ServiceProvider.GetRequiredService<IBillingApi>();
        commands.Clear();
        var revenues = await reporting.GetRevenueByOrganizationAsync(period, period, Ct);
        revenues.Where(r => organizations.Contains(r.OrganizationId)).Count().ShouldBe(12);
        var month = (await reporting.GetRevenueAsync(period, period, Ct)).ShouldHaveSingleItem();
        month.ByProduct[productId].ShouldBe(600m);
        var split = (await reporting.GetRevenueSplitAsync(period, period, Ct)).ShouldHaveSingleItem();
        (split.ApprovedExVat + split.PendingExVat).ShouldBe(month.TotalExVat);
        var billedLicenses = await reporting.GetBilledLicensesAsync(period, period, Ct);
        billedLicenses.Where(l => organizations.Contains(l.OrganizationId)).Sum(l => l.Amount).ShouldBe(600m);
        await reporting.GetInvoiceTotalsAsync(period, Ct);
        var aggregateSql = commands.Reads.Where(sql => sql.Contains("[billing].[BillingLines]", StringComparison.Ordinal) ||
            sql.Contains("[billing].[Invoices]", StringComparison.Ordinal)).ToList();
        aggregateSql.Count.ShouldBe(5);
        aggregateSql.ShouldAllBe(sql => sql.Contains("GROUP BY", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Scoped_licensing_queries_exclude_other_customers_and_select_only_the_latest_eligible_reading()
    {
        var day = new DateOnly(2082, 10, 31);
        var marker = "SCOPED-" + Guid.NewGuid().ToString("N")[..8];
        var finance = factory.ClientAs(CrmRoles.Finance);
        var productId = await ProductAsync(finance, marker);
        var selected = Guid.NewGuid();
        var unrelated = Guid.NewGuid();
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<LicensingDbContext>();
            foreach (var organization in new[] { selected, unrelated })
            {
                db.CspSubscriptions.Add(Subscription(organization, productId, marker + organization, 5, day));
                db.CspSubscriptions.Add(Subscription(organization, null, marker + "-unmapped-" + organization, 2, day));
                foreach (var (offset, assignedCount) in new[] { (-15, 90), (-5, 8), (-1, 7), (1, 99) })
                    db.LicenseSnapshots.Add(LicenseSnapshot.Create(new(organization, marker, marker, 10, assignedCount), day.AddDays(offset), DateTimeOffset.UtcNow));
            }
            await db.SaveChangesAsync(Ct);
        }
        var commands = new SqlReadCounter();
        await using var host = factory.WithWebHostBuilder(builder => builder.ConfigureTestServices(services =>
            services.AddDbContext<LicensingDbContext>(options => options.AddInterceptors(commands))));
        await using var measured = host.Services.CreateAsyncScope();
        var licensing = measured.ServiceProvider.GetRequiredService<ILicensingApi>();
        commands.Clear();
        var quantities = await licensing.GetSubscriptionQuantitiesAsync([selected], day, Ct);
        quantities.ShouldHaveSingleItem().OrganizationId.ShouldBe(selected);
        quantities[0].Quantity.ShouldBe(5);
        commands.RowReads("[licensing].[CspSubscriptions]").ShouldBeLessThanOrEqualTo(2);
        commands.Clear();
        var unmapped = await licensing.GetUnmappedOfferNamesAsync([selected], day, Ct);
        unmapped.Keys.ShouldBe([selected]);
        unmapped[selected].ShouldHaveSingleItem().ShouldContain("-unmapped-");
        commands.RowReads("[licensing].[CspSubscriptions]").ShouldBeLessThanOrEqualTo(2);
        commands.Clear();
        var assigned = await licensing.GetAssignedLicensesAsync([selected], day, Ct);
        assigned.ShouldHaveSingleItem().OrganizationId.ShouldBe(selected);
        assigned[0].Assigned.ShouldBe(7);
        assigned[0].SnapshotDate.ShouldBe(day.AddDays(-1));
        commands.Count("[licensing].[LicenseSnapshots]").ShouldBe(1);
        commands.RowReads("[licensing].[LicenseSnapshots]").ShouldBeLessThanOrEqualTo(2, "one latest scoped row plus end-of-reader, not two weeks of snapshots");
        // Empty batches must not fall back to a full-portfolio query.
        commands.Clear();
        (await licensing.GetSubscriptionQuantitiesAsync([], day, Ct)).ShouldBeEmpty();
        (await licensing.GetUnmappedOfferNamesAsync(Array.Empty<Guid>(), day, Ct)).ShouldBeEmpty();
        (await licensing.GetAssignedLicensesAsync([], day, Ct)).ShouldBeEmpty();
        commands.Reads.ShouldBeEmpty();
    }

    private async Task<Guid> SeedCustomerAsync(HttpClient admin, string marker, Guid productId, Guid extraProductId, DateOnly period)
    {
        var organizationId = await admin.CreateOrganizationAsync(new { name = marker, status = "Customer" });
        await using var scope = factory.Services.CreateAsyncScope();
        var contracts = scope.ServiceProvider.GetRequiredService<ContractsDbContext>();
        var contract = Contract.Create(marker, organizationId, new ContractTerms(marker, ContractType.Mixed, period, period.AddMonths(1).AddDays(-1),
            false, 0, 0, null, InvoiceFrequency.Monthly, InvoiceTiming.InAdvance, null, false, null, null, null, null)).Value;
        contract.AddLine(new LineTerms(productId, null, QuantityModel.PerSubscription, DeviceFilter.All, 1, 10m, 0, period, period.AddMonths(1).AddDays(-1))).IsSuccess.ShouldBeTrue();
        contract.Activate().IsSuccess.ShouldBeTrue();
        contracts.Contracts.Add(contract);
        await contracts.SaveChangesAsync(Ct);
        var licensing = scope.ServiceProvider.GetRequiredService<LicensingDbContext>();
        licensing.CspSubscriptions.AddRange(Subscription(organizationId, productId, marker, 5, period),
            Subscription(organizationId, extraProductId, marker + "-extra", 2, period), Subscription(organizationId, null, marker + "-unmapped", 1, period));
        await licensing.SaveChangesAsync(Ct);
        return organizationId;
    }

    private static CspSubscription Subscription(Guid organization, Guid? product, string key, int quantity, DateOnly start)
    {
        var row = CspSubscription.From(new ExternalSubscription(SubscriptionSource.Manual, organization.ToString(), null, null, null,
            key, key, key, null, quantity, SubscriptionStatus.Active, SubscriptionTerm.P1M, SubscriptionBillingCycle.Monthly,
            start, start.AddMonths(1).AddDays(-1), null, false, null, null), TimeSpan.FromDays(7), DateTimeOffset.UtcNow);
        row.LinkOrganization(organization);
        row.LinkProduct(product);
        return row;
    }

    private static Task<Guid> ProductAsync(HttpClient finance, string offer) => CatalogApiTests.CreateProductAsync(finance, new
    {
        sku = CatalogApiTests.Sku("DEV16"), name = offer, type = "MicrosoftLicense", businessLine = "Microsoft", unit = "License",
        billingPeriod = "Monthly", vatRate = 25m, listPrice = 10m, unitCost = 1m, microsoftOfferId = offer,
    });

    private sealed class SqlReadCounter : DbCommandInterceptor
    {
        private readonly ConcurrentQueue<string> _reads = new();
        private readonly ConcurrentQueue<(string Sql, int Count)> _rowReads = new();
        public IReadOnlyCollection<string> Reads => _reads.ToArray();
        public int Count(string table) => _reads.Count(sql => sql.Contains(table, StringComparison.Ordinal));
        public int RowReads(string table) => _rowReads.Where(r => r.Sql.Contains(table, StringComparison.Ordinal)).Sum(r => r.Count);
        public void Clear() { _reads.Clear(); _rowReads.Clear(); }
        public override InterceptionResult DataReaderDisposing(DbCommand command, DataReaderDisposingEventData eventData, InterceptionResult result)
        {
            _rowReads.Enqueue((command.CommandText, eventData.ReadCount));
            return result;
        }
        public override ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(DbCommand command, CommandEventData eventData,
            InterceptionResult<DbDataReader> result, CancellationToken cancellationToken = default)
        {
            _reads.Enqueue(command.CommandText);
            return ValueTask.FromResult(result);
        }
    }
}
