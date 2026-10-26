using System.Net.Http.Json;
using System.Text.Json;
using Crm.Authorization;
using Crm.Contracts.Persistence;
using Crm.TimeTracking.Contracts;
using Crm.TimeTracking.Domain;
using Crm.TimeTracking.Features;
using Crm.TimeTracking.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using static Crm.IntegrationTests.SourceTaskTestSupport;
using static Crm.IntegrationTests.TimePeriodTestSupport;
using static Crm.IntegrationTests.TimeBankTestSupport;

namespace Crm.IntegrationTests;

public sealed class TimeBankFailureReproductionTests(CrmWebFactory factory)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;
    [Theory]
    [InlineData(2, 1)] [InlineData(1, 2)]
    public async Task Failed_approval_followed_by_an_edit_and_retry_keeps_bank_movements_equal_to_time_allocations(int initial, int corrected)
    {
        var (org, employee, bank, entry, date) = await Setup(factory, initial);
        var fault = new FailTimeSave(entry, TimeEntryStatus.Approved);
        await using (var host = Host(factory, employee, CrmRoles.ServiceLead, services => services.AddDbContext<TimeTrackingDbContext>(o => o.AddInterceptors(fault))))
        {
            await using var scope = host.Services.CreateAsyncScope();
            await Should.ThrowAsync<SyntheticTimeSaveFailure>(() => scope.ServiceProvider.GetRequiredService<TimeApprovalService>().ApproveAsync([entry], Ct));
        }
        fault.Calls.ShouldBe(1);
        await using var retryHost = Host(factory, employee, CrmRoles.ServiceLead); await using var retryScope = retryHost.Services.CreateAsyncScope();
        var service = retryScope.ServiceProvider.GetRequiredService<TimeEntryService>();
        var before = (await service.ListAsync(new(null, null, null, null, org, null, null, null, false, 50, null), Ct)).Items.Single();
        before.Status.ShouldBe(TimeEntryStatus.New);
        (await service.UpdateAsync(entry, Request(org, date) with { Hours = corrected }, before.Etag, Ct)).IsSuccess.ShouldBeTrue();
        (await retryScope.ServiceProvider.GetRequiredService<TimeApprovalService>().ApproveAsync([entry], Ct)).Value.Approved.ShouldBe(1);
        await Check(bank, entry, $"approve-{initial}-then-{corrected}");
    }

    [Fact]
    public async Task Failed_withdrawal_keeps_the_bank_consistent_with_the_still_approved_time_snapshot()
    {
        var (_, employee, bank, entry, _) = await Setup(factory, 2);
        await using (var host = Host(factory, employee, CrmRoles.ServiceLead))
        {
            await using var scope = host.Services.CreateAsyncScope();
            (await scope.ServiceProvider.GetRequiredService<TimeApprovalService>().ApproveAsync([entry], Ct)).Value.Approved.ShouldBe(1);
        }
        var fault = new FailTimeSave(entry, TimeEntryStatus.New);
        await using (var host = Host(factory, employee, CrmRoles.ServiceLead, services => services.AddDbContext<TimeTrackingDbContext>(o => o.AddInterceptors(fault))))
        {
            await using var scope = host.Services.CreateAsyncScope();
            await Should.ThrowAsync<SyntheticTimeSaveFailure>(() => scope.ServiceProvider.GetRequiredService<TimeApprovalService>().WithdrawAsync([entry], Ct));
        }
        fault.Calls.ShouldBe(1);
        await Check(bank, entry, "withdraw-before-time-save");
    }
    private async Task Check(Guid bank, Guid entry, string scenario)
    {
        await using var scope = factory.Services.CreateAsyncScope(); var time = scope.ServiceProvider.GetRequiredService<TimeTrackingDbContext>(); var contracts = scope.ServiceProvider.GetRequiredService<ContractsDbContext>();
        var used = (await contracts.HourBanks.AsNoTracking().SingleAsync(b => b.Id == bank, Ct)).UsedHours;
        var allocated = await time.TimeAllocations.Where(a => a.TimeEntryId == entry && a.HourBankId == bank).SumAsync(a => a.Hours, Ct);
        Console.WriteLine(JsonSerializer.Serialize(new { diagnostic = scenario, bankUsed = used, allocatedHours = allocated }));
        used.ShouldBe(allocated, "The accepted Time snapshot and actual prepaid-bank movement must agree.");
    }
    private sealed class SyntheticTimeSaveFailure : Exception;
    private sealed class FailTimeSave(Guid id, TimeEntryStatus state) : SaveChangesInterceptor
    {
        internal int Calls { get; private set; }
        public override ValueTask<InterceptionResult<int>> SavingChangesAsync(DbContextEventData eventData,
            InterceptionResult<int> result, CancellationToken cancellationToken = default)
        {
            if (eventData.Context is TimeTrackingDbContext db && db.ChangeTracker.Entries<TimeEntry>().Any(e => e.Entity.Id == id && e.Entity.Status == state && e.State == EntityState.Modified))
            { Calls++; throw new SyntheticTimeSaveFailure(); }
            return ValueTask.FromResult(result);
        }
    }
}
