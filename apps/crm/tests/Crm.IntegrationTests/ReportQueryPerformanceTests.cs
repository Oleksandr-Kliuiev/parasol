using System.Data.Common;
using Crm.Customers.Contracts;
using Crm.Customers.Domain;
using Crm.Customers.Features.Search;
using Crm.Customers.Persistence;
using Crm.Licensing.Contracts;
using Crm.Licensing.Domain;
using Crm.Licensing.Features;
using Crm.Licensing.Persistence;
using Crm.Service.Contracts;
using Crm.Service.Domain;
using Crm.Service.Features;
using Crm.Service.Persistence;
using Crm.SharedKernel.Application;
using Crm.TimeTracking.Contracts;
using Crm.TimeTracking.Domain;
using Crm.TimeTracking.Features;
using Crm.TimeTracking.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;

namespace Crm.IntegrationTests;

/// <summary>DEV-16: measure SQL commands and reader operations, not just the size of an already truncated API response.</summary>
[Collection(ReportQueryPerformanceCollection.Name)]
public sealed class ReportQueryPerformanceTests(CrmWebFactory factory)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Theory]
    [InlineData(2, 2064)]
    [InlineData(1000, 2065)]
    public async Task Microsoft_costs_materialize_only_customer_totals_and_preserve_overlap_currency_credits_and_rounding(int linesPerCustomer, int year)
    {
        var from = new DateOnly(year, 4, 1);
        var to = from.AddMonths(1).AddDays(-1);
        var first = Guid.NewGuid();
        var second = Guid.NewGuid();
        var fallback = Guid.NewGuid();
        var absent = Guid.NewGuid();
        var marker = Guid.NewGuid().ToString("N");
        var ordinal = 0;
        var importedAt = new DateTimeOffset(year, 5, 1, 0, 0, 0, TimeSpan.Zero);
        MsBilledLine Line(Guid? org, DateOnly start, DateOnly end, decimal total, string currency) =>
            MsBilledLine.Create(new(MsBillingSource.Csv, start, end, $"{marker}-{ordinal++}", "synthetic",
                null, null, "offer", null, 1m, total, total, currency), org, importedAt);
        await using var scope = factory.Services.CreateAsyncScope();
        var seed = scope.ServiceProvider.GetRequiredService<LicensingDbContext>();
        for (var i = 0; i < linesPerCustomer; i++)
        {
            seed.MsBilledLines.Add(Line(first, from, to, 1.005m, "nok")); // ToEven: 1.00, not 1.01.
            seed.MsBilledLines.Add(Line(second, from, to, 2.015m, "eur")); // ToEven: 2.02.
        }
        seed.MsBilledLines.AddRange(
            Line(first, from.AddMonths(-1), from, 0.015m, "NOK"), // inclusive left overlap: 0.02
            Line(first, to, to.AddMonths(1), -0.015m, "NOK"), // inclusive right overlap credit: -0.02
            Line(first, from.AddMonths(-1), to.AddMonths(1), 0.025m, "NOK"), // encompassing range: 0.02
            Line(fallback, from, to, -2.015m, ""), // domain fallback NOK and negative ToEven
            Line(first, from.AddMonths(-1), from.AddDays(-1), 999m, "USD"),
            Line(second, to.AddDays(1), to.AddMonths(1), 999m, "USD"),
            Line(absent, to.AddDays(1), to.AddMonths(1), 999m, "USD"),
            Line(null, from, to, 999m, "USD"));
        await seed.SaveChangesAsync(Ct);

        var probe = new QueryProbe();
        await using var db = new LicensingDbContext(new DbContextOptionsBuilder<LicensingDbContext>()
            .UseSqlServer(factory.RuntimeConnectionString).AddInterceptors(probe).Options);
        var api = ActivatorUtilities.CreateInstance<LicensingService>(scope.ServiceProvider, db);
        var actual = (await api.GetMsCostsAsync(from, to, Ct)).ToDictionary(r => r.OrganizationId);
        actual.Count.ShouldBe(3);
        actual[first].ShouldBe(new MsCostByOrganization(first, linesPerCustomer + 0.02m, "NOK", linesPerCustomer + 3));
        actual[second].ShouldBe(new MsCostByOrganization(second, linesPerCustomer * 2.02m, "EUR", linesPerCustomer));
        actual[fallback].ShouldBe(new MsCostByOrganization(fallback, -2.02m, "NOK", 1));
        actual.ContainsKey(absent).ShouldBeFalse();
        probe.AssertBounded(1, 4); // three customer aggregate rows plus end-of-reader, independent of source row count

        probe.Clear();
        (await api.GetMsCostsAsync(from.AddMonths(6), to.AddMonths(6), Ct)).ShouldBeEmpty();
        probe.AssertBounded(1, 1);
        Console.WriteLine($"DEV-16 Microsoft cost rows={linesPerCustomer * 2 + 8}: 1 SQL/<=4 reader calls, three customer totals.");
    }

    [Theory]
    [InlineData(2, 2060)]
    [InlineData(200, 2061)]
    public async Task Time_reports_aggregate_before_materializing_and_preserve_split_withdrawn_and_deleted_hours(int entries, int year)
    {
        var date = new DateOnly(year, 2, 12);
        var org = Guid.NewGuid();
        var technician = Guid.NewGuid();
        var project = Guid.NewGuid();
        await using var scope = factory.Services.CreateAsyncScope();
        var seed = scope.ServiceProvider.GetRequiredService<TimeTrackingDbContext>();
        TimeEntry New(decimal hours, DateOnly? on = null) => TimeEntry.CreateManual(new(
            org, technician, on ?? date, hours, null, true, false, false, "Synthetic report performance", null, null, null, project)).Value;
        for (var i = 0; i < entries; i++)
        {
            var entry = New(10m);
            entry.Approve(null, DateTimeOffset.UtcNow, null,
            [
                new(entry.Id, TimeClassification.Rate, 1m, 1.25m, 100m, null),
                new(entry.Id, TimeClassification.Covered, 2m, 0m, null, null),
                new(entry.Id, TimeClassification.HourBank, 3m, 0m, null, Guid.NewGuid()),
                new(entry.Id, TimeClassification.NonBillable, 4m, 0m, null, null),
            ]);
            seed.TimeEntries.Add(entry);
        }

        seed.TimeEntries.Add(New(2.5m));
        var withdrawn = New(1.25m);
        withdrawn.Approve(null, DateTimeOffset.UtcNow, null, [new(withdrawn.Id, TimeClassification.Rate, 1.25m, 9m, 1000m, null)]);
        withdrawn.Withdraw().IsSuccess.ShouldBeTrue();
        seed.TimeEntries.Add(withdrawn);
        var deleted = New(24m);
        deleted.MarkDeleted();
        seed.TimeEntries.Add(deleted);
        // Other months belong to the project but must not enter this month's utilization or customer totals.
        seed.TimeEntries.Add(New(5m, date.AddMonths(-1)));
        await seed.SaveChangesAsync(Ct);

        var probe = new QueryProbe();
        await using var db = new TimeTrackingDbContext(new DbContextOptionsBuilder<TimeTrackingDbContext>()
            .UseSqlServer(factory.RuntimeConnectionString).AddInterceptors(probe).Options);
        var api = new TimeImportService(db, scope.ServiceProvider.GetRequiredService<TimeApprovalService>(), scope.ServiceProvider.GetRequiredService<Crm.Infrastructure.Persistence.TimeBankTransaction>(), scope.ServiceProvider.GetRequiredService<TimeBillingGuard>(),
            scope.ServiceProvider.GetRequiredService<Crm.Identity.Contracts.IUserDirectory>());
        var utilization = (await api.GetUtilizationAsync(year, 2, Ct)).Single(row => row.TechnicianId == technician);
        utilization.BilledHours.ShouldBe(entries * 1.25m);
        utilization.CoveredHours.ShouldBe(entries * 2m);
        utilization.HourBankHours.ShouldBe(entries * 3m);
        utilization.NonBillableHours.ShouldBe(entries * 4m + 3.75m);
        utilization.TotalHours.ShouldBe(entries * 10.25m + 3.75m);
        probe.AssertBounded(2, 4); // two groups plus the two end-of-reader calls, independent of entry count

        probe.Clear();
        var customer = (await api.GetHoursByOrganizationAsync(date.AddDays(-11), date.AddDays(16), Ct)).Single(row => row.OrganizationId == org);
        customer.Hours.ShouldBe(entries * 10m);
        customer.BilledHours.ShouldBe(entries * 1.25m);
        customer.Amount.ShouldBe(entries * 125m);
        probe.AssertBounded(2, 4);

        probe.Clear();
        var actual = (await api.GetProjectHoursAsync([project], Ct)).ShouldHaveSingleItem();
        actual.Hours.ShouldBe(entries * 10m + 8.75m);
        actual.BillableHours.ShouldBe(actual.Hours);
        actual.Amount.ShouldBe(entries * 125m);
        probe.AssertBounded(1, 2);
        Console.WriteLine($"DEV-16 time rows={entries}: utilization 2 SQL/<=4 reader calls; customer totals 2 SQL/<=4; project 1 SQL/<=2.");
    }

    [Fact]
    public async Task Sql_technician_groups_are_one_row_per_person_and_keep_ordinal_names_without_an_id()
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<TimeTrackingDbContext>();
        var technician = Guid.NewGuid(); var unnamed = Guid.NewGuid(); var tag = Guid.NewGuid().ToString("N")[..8];
        void Add(Guid? id, string? name) => db.TimeEntries.Add(TimeEntry.FromSource(new("atera", Guid.NewGuid().ToString(), Guid.NewGuid(), null, null, null,
            id, null, name, new DateOnly(2062, 3, 5), null, null, 1m, null, true, false, null)));
        foreach (var name in new string?[] { "Tech", "tech", "Tech ", null, "—" }) Add(technician, name);
        foreach (var name in new string?[] { null, "—" }) Add(unnamed, name);
        foreach (var name in new[] { $"Tech {tag}", $"tech {tag}", $"Tech {tag} " }) Add(null, name);

        await db.SaveChangesAsync(Ct);
        var rows = await scope.ServiceProvider.GetRequiredService<ITimeTrackingApi>().GetUtilizationAsync(2062, 3, Ct);
        // Name variants and nameless hours of one person meet by the id; the name is the ordinal first of the busiest.
        var person = rows.Where(row => row.TechnicianId == technician).ShouldHaveSingleItem();
        person.TechnicianName.ShouldBe("Tech");
        person.TotalHours.ShouldBe(5m);
        var placeholder = rows.Where(row => row.TechnicianId == unnamed).ShouldHaveSingleItem();
        placeholder.TechnicianName.ShouldBe("—");
        placeholder.TotalHours.ShouldBe(2m);
        // Without an id the SQL grouping still matches the old ordinal one, case and trailing spaces included.
        var byName = rows.Where(row => row.TechnicianId == null && row.TechnicianName.Contains(tag, StringComparison.Ordinal)).ToDictionary(row => row.TechnicianName);
        byName.Keys.Order(StringComparer.Ordinal).ShouldBe([$"Tech {tag}", $"Tech {tag} ", $"tech {tag}"]);
        byName.Values.ShouldAllBe(row => row.TotalHours == 1m);
    }

    [Fact]
    public async Task Service_dashboard_counts_all_tickets_without_reading_each_ticket()
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var seed = scope.ServiceProvider.GetRequiredService<ServiceDbContext>();
        var system = "perf-" + Guid.NewGuid().ToString("N")[..12];
        for (var i = 0; i < 400; i++)
        {
            seed.Tickets.Add(Ticket.From(new(system, i, Guid.NewGuid(), null, "Synthetic ticket", i % 4 == 0 ? "Closed" : "Open",
                null, null, null, null, i % 2 == 0 ? null : Guid.NewGuid(), null, null, null, DateTimeOffset.UtcNow,
                null, null, null, null), DateTimeOffset.UtcNow));
        }

        await seed.SaveChangesAsync(Ct);
        var expectedOpen = await seed.Tickets.CountAsync(t => t.IsOpen, Ct);
        var expectedUnassigned = await seed.Tickets.CountAsync(t => t.IsOpen && t.TechnicianUserId == null, Ct);
        var probe = new QueryProbe();
        await using var db = new ServiceDbContext(new DbContextOptionsBuilder<ServiceDbContext>()
            .UseSqlServer(factory.RuntimeConnectionString).AddInterceptors(probe).Options);
        var result = await new ServiceApi(db, TimeProvider.System).GetLoadAsync(Ct);
        result.OpenTickets.ShouldBe(expectedOpen);
        result.UnassignedTickets.ShouldBe(expectedUnassigned);
        // One ticket row, at most two alert severities, two device states; each reader also reads end-of-stream.
        probe.AssertBounded(3, 8);
    }

    [Theory]
    [InlineData(2)]
    [InlineData(100)]
    public async Task Device_counts_use_each_customers_latest_snapshot_and_a_bounded_live_fallback(int customers)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var seed = scope.ServiceProvider.GetRequiredService<ServiceDbContext>();
        var ids = Enumerable.Range(0, customers).Select(_ => Guid.NewGuid()).ToList();
        var date = new DateOnly(2063, 1, 10);
        foreach (var id in ids)
        {
            seed.DeviceCountSnapshots.AddRange(new(id, date.AddDays(-8), DeviceType.Server, 2),
                new(id, date.AddDays(-1), DeviceType.Server, 3), new(id, date.AddDays(1), DeviceType.Server, 99));
        }

        var fallback = Guid.NewGuid();
        var empty = Guid.NewGuid();
        // Billed per device are Atera's agents only (M40), so the live fallback counts an Atera device.
        seed.Devices.Add(Device.From("atera", fallback, new(Guid.NewGuid().ToString(), "Synthetic device", DeviceType.Workstation, null, true, null, null), DateTimeOffset.UtcNow));
        ids.AddRange([fallback, empty]);
        await seed.SaveChangesAsync(Ct);
        var probe = new QueryProbe();
        await using var db = new ServiceDbContext(new DbContextOptionsBuilder<ServiceDbContext>()
            .UseSqlServer(factory.RuntimeConnectionString).AddInterceptors(probe).Options);
        var api = new ServiceApi(db, TimeProvider.System);
        var batch = await api.GetDeviceCountsAsync(ids, date, Ct);
        batch.Count.ShouldBe(ids.Count);
        foreach (var id in ids.Take(customers)) batch[id][DeviceType.Server].ShouldBe(3);
        batch[fallback][DeviceType.Workstation].ShouldBe(1);
        batch[empty].ShouldBeEmpty();
        probe.AssertBounded(2, customers + 3);
        foreach (var id in ids)
        {
            var individual = await api.GetDeviceCountsAsync(id, date, Ct);
            batch[id].OrderBy(x => x.Key).ShouldBe(individual.OrderBy(x => x.Key));
        }
    }

    [Fact]
    public async Task Customer_search_reads_only_the_requested_results_in_one_query_per_provider()
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var seed = scope.ServiceProvider.GetRequiredService<CustomersDbContext>();
        var marker = "PerfSearch" + Guid.NewGuid().ToString("N")[..8];
        for (var i = 0; i < 40; i++)
        {
            seed.Organizations.Add(Organization.Create(new($"{marker} {i:D3}", null, null, OrganizationStatus.Prospect,
                null, null, null, null, null, false, null, null, null, null, null, null)).Value);
            seed.Contacts.Add(Contact.Create(new(marker, $"{i:D3}", null, null, null, null)).Value);
        }

        await seed.SaveChangesAsync(Ct);
        var probe = new QueryProbe();
        await using var db = new CustomersDbContext(new DbContextOptionsBuilder<CustomersDbContext>()
            .UseSqlServer(factory.RuntimeConnectionString).AddInterceptors(probe).Options);
        (await new OrganizationSearchProvider(db).SearchAsync(SearchTerm.Parse(marker)!, 5, Ct)).Count.ShouldBe(5);
        probe.AssertBounded(1, 6);
        probe.Clear();
        (await new ContactSearchProvider(db).SearchAsync(SearchTerm.Parse(marker)!, 5, Ct)).Count.ShouldBe(5);
        probe.AssertBounded(1, 6);
    }

    private sealed class QueryProbe : DbCommandInterceptor
    {
        private readonly List<int> _reads = [];
        public override InterceptionResult DataReaderDisposing(DbCommand command, DataReaderDisposingEventData eventData, InterceptionResult result)
        {
            _reads.Add(eventData.ReadCount);
            return result;
        }

        public void Clear() => _reads.Clear();

        public void AssertBounded(int commands, int maxReads)
        {
            _reads.Count.ShouldBe(commands, "one command per aggregate, never per source row or customer");
            _reads.Sum().ShouldBeLessThanOrEqualTo(maxReads, "SQL should return grouped or limited rows; includes end-of-reader calls");
        }
    }
}

[CollectionDefinition(Name, DisableParallelization = true)]
public sealed class ReportQueryPerformanceCollection
{
    public const string Name = "Report query performance";
}
