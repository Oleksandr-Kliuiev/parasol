using System.Data.Common;
using Crm.Contracts.Contracts;
using Crm.Contracts.Domain;
using Crm.Contracts.Features;
using Crm.Contracts.Persistence;
using Crm.Customers.Contracts;
using Crm.Customers;
using Crm.Customers.Domain;
using Crm.Customers.Persistence;
using Crm.SharedKernel.Time;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

namespace Crm.IntegrationTests;

[Collection(ContractLifecycleConcurrencyCollection.Name)]
public sealed class ContractLifecycleConcurrencyTests(CrmWebFactory factory)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Two_worker_contexts_create_one_reminder_and_one_domain_event_per_due_contract()
    {
        var clock = new ManualTimeProvider(DateTimeOffset.UtcNow);
        var today = clock.Today();
        var marker = "RACE-" + Guid.NewGuid().ToString("N")[..12];
        Guid id;
        await using (var seed = factory.Services.CreateAsyncScope())
        {
            var db = seed.ServiceProvider.GetRequiredService<ContractsDbContext>();
            var contract = Contract.Create(marker, Guid.NewGuid(), new ContractTerms(marker, ContractType.Msp, today.AddDays(-30), today.AddDays(30),
                false, 0, 0, null, InvoiceFrequency.Monthly, InvoiceTiming.InAdvance, null, false, null, null, Guid.NewGuid(), null)).Value;
            contract.Activate().IsSuccess.ShouldBeTrue();
            db.Contracts.Add(contract);
            await db.SaveChangesAsync(Ct);
            id = contract.Id;
        }
        await using var first = factory.Services.CreateAsyncScope();
        await using var second = factory.Services.CreateAsyncScope();
        var firstDb = first.ServiceProvider.GetRequiredService<ContractsDbContext>();
        var secondDb = second.ServiceProvider.GetRequiredService<ContractsDbContext>();
        var a = new ContractLifecycleJob(firstDb, first.ServiceProvider.GetRequiredService<ICustomersApi>(), clock, NullLogger<ContractLifecycleJob>.Instance);
        var b = new ContractLifecycleJob(secondDb, second.ServiceProvider.GetRequiredService<ICustomersApi>(), clock, NullLogger<ContractLifecycleJob>.Instance);
        await Task.WhenAll(a.RunAsync(Ct), b.RunAsync(Ct));
        await using var verify = factory.Services.CreateAsyncScope();
        var check = verify.ServiceProvider.GetRequiredService<ContractsDbContext>();
        (await check.Reminders.CountAsync(r => r.ContractId == id, Ct)).ShouldBe(1);
        var textId = id.ToString();
        (await check.OutboxMessages.CountAsync(m => m.Type.Contains(nameof(ContractEnding)) && m.Payload.Contains(textId), Ct)).ShouldBe(1);
    }

    [Fact]
    public async Task Assignees_use_one_scoped_query_for_three_then_thirty_new_reminders_and_none_for_repeated_scans()
    {
        var clock = new ManualTimeProvider(DateTimeOffset.UtcNow);
        var today = clock.Today();
        // Other tests share this database. Finish their current reminder work before measuring only this test's additions.
        await using var scope = factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ContractsDbContext>();
        await new ContractLifecycleJob(db, scope.ServiceProvider.GetRequiredService<ICustomersApi>(), clock, NullLogger<ContractLifecycleJob>.Instance).RunAsync(Ct);
        var reads = new CustomerReads();
        await using var customersDb = new CustomersDbContext(new DbContextOptionsBuilder<CustomersDbContext>()
            .UseSqlServer(factory.RuntimeConnectionString).AddInterceptors(reads).Options);
        var customers = new CustomersApi(customersDb, Options.Create(new CustomersOptions()));
        var job = new ContractLifecycleJob(db, customers, clock, NullLogger<ContractLifecycleJob>.Instance);

        foreach (var count in new[] { 3, 30 })
        {
            var marker = "BATCH-" + Guid.NewGuid().ToString("N")[..8];
            var manager = Guid.NewGuid();
            var owner = Guid.NewGuid();
            var expected = new Dictionary<Guid, Guid>();
            Guid notDue;
            await using (var seed = factory.Services.CreateAsyncScope())
            {
                var organizationDb = seed.ServiceProvider.GetRequiredService<CustomersDbContext>();
                var contractsDb = seed.ServiceProvider.GetRequiredService<ContractsDbContext>();
                for (var i = 0; i < count + 2; i++)
                {
                    var organization = Organization.Create(new($"{marker}-{i}", null, null, OrganizationStatus.Customer,
                        null, null, null, null, null, false, manager, null, null, null, null, null)).Value;
                    organizationDb.Organizations.Add(organization);
                    var due = i <= count;
                    var contract = Contract.Create($"{marker}-{i}", organization.Id, new ContractTerms(marker, ContractType.Msp,
                        today.AddDays(-30), today.AddDays(due ? 30 : 70), !due, due ? 0 : 12, due ? 0 : 90, null,
                        InvoiceFrequency.Monthly, InvoiceTiming.InAdvance, null, false, null, null, i == count ? owner : null, null)).Value;
                    contract.Activate().IsSuccess.ShouldBeTrue();
                    contractsDb.Contracts.Add(contract);
                    if (due) expected[contract.Id] = i == count ? owner : manager;
                }
                notDue = contractsDb.ChangeTracker.Entries<Contract>().Select(e => e.Entity).Single(c => c.EndDate == today.AddDays(70)).Id;
                await organizationDb.SaveChangesAsync(Ct);
                await contractsDb.SaveChangesAsync(Ct);
            }

            reads.Clear();
            (await job.RunAsync(Ct)).Reminders.ShouldBe(count + 1);
            reads.Commands.ShouldBe(1, "all new ownerless reminders share one scoped lookup");
            reads.Rows.ShouldBeLessThanOrEqualTo(count + 1, "only ownerless due customers plus end-of-reader, excluding the owned and not-due customers");
            var ids = expected.Keys.ToList();
            var actual = await db.Reminders.AsNoTracking().Where(r => r.ContractId != null && ids.Contains(r.ContractId.Value)).ToListAsync(Ct);
            actual.Count.ShouldBe(count + 1);
            foreach (var reminder in actual) reminder.AssigneeId.ShouldBe(expected[reminder.ContractId!.Value]);
            (await db.Reminders.AnyAsync(r => r.ContractId == notDue, Ct)).ShouldBeFalse();

            reads.Clear();
            (await job.RunAsync(Ct)).Reminders.ShouldBe(0);
            reads.Commands.ShouldBe(0, "deduplicated or not-due reminders do not read customer assignments");
        }
    }

    private sealed class CustomerReads : DbCommandInterceptor
    {
        public int Commands { get; private set; }
        public int Rows { get; private set; }
        public void Clear() { Commands = 0; Rows = 0; }
        public override InterceptionResult DataReaderDisposing(DbCommand command, DataReaderDisposingEventData eventData, InterceptionResult result)
        {
            Commands++;
            Rows += eventData.ReadCount;
            return result;
        }
    }
}

/// <summary>The lifecycle scan acts on all due contracts in the shared fixture; isolate its deliberate concurrent workers from unrelated setup.</summary>
[CollectionDefinition(Name, DisableParallelization = true)]
public sealed class ContractLifecycleConcurrencyCollection
{
    public const string Name = "Contract lifecycle concurrency";
}
