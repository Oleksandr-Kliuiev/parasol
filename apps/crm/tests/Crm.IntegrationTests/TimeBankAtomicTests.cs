using System.Data.Common;
using Crm.Authorization;
using Crm.Contracts.Contracts;
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

public sealed class TimeBankAtomicTests(CrmWebFactory factory)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;
    [Fact]
    public async Task A_batch_reads_its_own_bank_movements_and_commits_both_time_allocations_together()
    {
        var (org, employee, bank, a, date) = await Setup(factory, 6);
        await using var host = Host(factory, employee, CrmRoles.ServiceLead); await using var scope = host.Services.CreateAsyncScope();
        var b = (await scope.ServiceProvider.GetRequiredService<TimeEntryService>().CreateAsync(Request(org, date) with { Hours = 6m }, Ct)).Value.Id;
        (await scope.ServiceProvider.GetRequiredService<TimeApprovalService>().ApproveAsync([a, b], Ct)).Value.Approved.ShouldBe(2);
        await using var final = factory.Services.CreateAsyncScope(); var time = final.ServiceProvider.GetRequiredService<TimeTrackingDbContext>();
        var ids = new[] { a, b };
        (await time.TimeAllocations.Where(x => ids.Contains(x.TimeEntryId) && x.Classification == TimeClassification.HourBank).SumAsync(x => x.Hours, Ct)).ShouldBe(10m);
        (await time.TimeAllocations.Where(x => ids.Contains(x.TimeEntryId) && x.Classification == TimeClassification.Rate).SumAsync(x => x.Hours, Ct)).ShouldBe(2m);
        (await final.ServiceProvider.GetRequiredService<ContractsDbContext>().HourBanks.SingleAsync(x => x.Id == bank, Ct)).UsedHours.ShouldBe(10m);
    }
    [Fact]
    public async Task Failure_after_multiple_bank_saves_rolls_back_every_bank_time_audit_and_outbox_effect()
    {
        var (org, employee, bank, a, date) = await Setup(factory, 2);
        Guid b;
        await using (var host = Host(factory, employee, CrmRoles.ServiceLead))
        {
            await using var scope = host.Services.CreateAsyncScope();
            b = (await scope.ServiceProvider.GetRequiredService<TimeEntryService>().CreateAsync(Request(org, date), Ct)).Value.Id;
        }
        int beforeAudit, beforeOutbox;
        await using (var before = factory.Services.CreateAsyncScope())
        {
            var contracts = before.ServiceProvider.GetRequiredService<ContractsDbContext>();
            beforeAudit = await contracts.AuditEntries.CountAsync(x => x.EntityId == bank, Ct);
            beforeOutbox = await contracts.OutboxMessages.CountAsync(x => x.Payload.Contains(bank.ToString()), Ct);
        }
        await using (var host = Host(factory, employee, CrmRoles.ServiceLead, services => services.AddDbContext<TimeTrackingDbContext>(o => o.AddInterceptors(new FailSave(a, TimeEntryStatus.Approved)))))
        {
            await using var scope = host.Services.CreateAsyncScope();
            await Should.ThrowAsync<InjectedFailure>(() => scope.ServiceProvider.GetRequiredService<TimeApprovalService>().ApproveAsync([a, b], Ct));
        }
        await using var final = factory.Services.CreateAsyncScope(); var db = final.ServiceProvider.GetRequiredService<TimeTrackingDbContext>(); var bankDb = final.ServiceProvider.GetRequiredService<ContractsDbContext>();
        var ids = new[] { a, b };
        (await db.TimeEntries.Where(x => ids.Contains(x.Id)).Select(x => x.Status).ToListAsync(Ct)).ShouldAllBe(status => status == TimeEntryStatus.New);
        (await db.TimeAllocations.CountAsync(x => ids.Contains(x.TimeEntryId), Ct)).ShouldBe(0);
        (await db.AuditEntries.CountAsync(x => ids.Contains(x.EntityId), Ct)).ShouldBe(2);
        (await bankDb.HourBanks.SingleAsync(x => x.Id == bank, Ct)).UsedHours.ShouldBe(0m);
        (await bankDb.HourBankEntries.CountAsync(x => x.HourBankId == bank && x.SourceType == "TimeEntry", Ct)).ShouldBe(0);
        (await bankDb.AuditEntries.CountAsync(x => x.EntityId == bank, Ct)).ShouldBe(beforeAudit);
        (await bankDb.OutboxMessages.CountAsync(x => x.Payload.Contains(bank.ToString()), Ct)).ShouldBe(beforeOutbox);
    }
    [Fact]
    public async Task Lost_owner_commit_acknowledgement_adopts_the_accepted_status_without_spending_or_auditing_twice()
    {
        var (_, employee, bank, entry, _) = await Setup(factory, 2); var ack = new LoseAck(entry);
        await using (var host = Host(factory, employee, CrmRoles.ServiceLead, services => services.AddDbContext<TimeTrackingDbContext>(o => o.AddInterceptors(ack))))
        {
            await using var scope = host.Services.CreateAsyncScope();
            await Should.ThrowAsync<InjectedFailure>(() => scope.ServiceProvider.GetRequiredService<TimeApprovalService>().ApproveAsync([entry], Ct));
        }
        await using (var host = Host(factory, employee, CrmRoles.ServiceLead))
        {
            await using var scope = host.Services.CreateAsyncScope();
            var result = (await scope.ServiceProvider.GetRequiredService<TimeApprovalService>().ApproveAsync([entry], Ct)).Value;
            result.Approved.ShouldBe(0); result.Skipped.ShouldBe(1);
        }
        ack.Commits.ShouldBe(1);
        await using var final = factory.Services.CreateAsyncScope(); var db = final.ServiceProvider.GetRequiredService<TimeTrackingDbContext>(); var banks = final.ServiceProvider.GetRequiredService<ContractsDbContext>();
        (await db.TimeEntries.SingleAsync(x => x.Id == entry, Ct)).ApprovalCount.ShouldBe(1);
        (await db.AuditEntries.CountAsync(x => x.EntityId == entry, Ct)).ShouldBe(2);
        (await db.TimeAllocations.Where(x => x.TimeEntryId == entry && x.HourBankId == bank).SumAsync(x => x.Hours, Ct)).ShouldBe(2m);
        (await banks.HourBanks.SingleAsync(x => x.Id == bank, Ct)).UsedHours.ShouldBe(2m);
        (await banks.HourBankEntries.CountAsync(x => x.HourBankId == bank && x.SourceType == "TimeEntry", Ct)).ShouldBe(1);
    }
    [Fact]
    public async Task A_source_change_failure_rolls_back_the_implicit_withdrawal_and_keeps_the_accepted_snapshot()
    {
        var (org, employee, bank, _, date) = await Setup(factory, 1);
        var source = Incoming(org, date) with { Hours = 2m, TechnicianUserId = employee }; Guid entry;
        await using (var host = Host(factory, employee, CrmRoles.ServiceLead))
        {
            await using var scope = host.Services.CreateAsyncScope();
            (await scope.ServiceProvider.GetRequiredService<ITimeTrackingApi>().ImportAsync([source], Ct)).Created.ShouldBe(1);
            entry = (await scope.ServiceProvider.GetRequiredService<TimeTrackingDbContext>().TimeEntries.AsNoTracking().SingleAsync(x => x.Source == TimeSource.Atera && x.ExternalId == source.ExternalId, Ct)).Id;
            (await scope.ServiceProvider.GetRequiredService<TimeApprovalService>().ApproveAsync([entry], Ct)).Value.Approved.ShouldBe(1);
        }
        await using (var host = Host(factory, employee, CrmRoles.ServiceLead, services => services.AddDbContext<TimeTrackingDbContext>(o => o.AddInterceptors(new FailSave(entry, TimeEntryStatus.New)))))
        {
            await using var scope = host.Services.CreateAsyncScope();
            await Should.ThrowAsync<InjectedFailure>(() => scope.ServiceProvider.GetRequiredService<ITimeTrackingApi>().ImportAsync([source with { Hours = 3m }], Ct));
        }
        await using var final = factory.Services.CreateAsyncScope(); var db = final.ServiceProvider.GetRequiredService<TimeTrackingDbContext>();
        var row = await db.TimeEntries.Include(x => x.Allocations).SingleAsync(x => x.Id == entry, Ct);
        row.Status.ShouldBe(TimeEntryStatus.Approved); row.Hours.ShouldBe(2m); row.CurrentAllocations.Sum(x => x.Hours).ShouldBe(2m);
        (await final.ServiceProvider.GetRequiredService<ContractsDbContext>().HourBanks.SingleAsync(x => x.Id == bank, Ct)).UsedHours.ShouldBe(2m);
    }
    [Theory]
    [InlineData(false)] [InlineData(true)]
    public async Task Legacy_partial_approval_is_not_hidden_by_a_depleted_or_closed_bank(bool closeBank)
    {
        var (_, employee, bank, entry, date) = await Setup(factory, 1);
        await using (var legacy = factory.Services.CreateAsyncScope())
        {
            var api = legacy.ServiceProvider.GetRequiredService<IContractsApi>();
            (await api.ConsumeHoursAsync(bank, 10m, date, "Synthetic old partial operation", "TimeEntry", $"{entry}:1:{bank}", Ct))!.Hours.ShouldBe(10m);
        }
        if (closeBank)
        {
            using var admin = factory.ClientAs(CrmRoles.Admin);
            (await admin.PostAsync($"/api/v1/contracts/hour-banks/{bank}/close", null, Ct)).EnsureSuccessStatusCode();
        }
        await using var host = Host(factory, employee, CrmRoles.ServiceLead); await using var scope = host.Services.CreateAsyncScope();
        (await scope.ServiceProvider.GetRequiredService<TimeApprovalService>().ApproveAsync([entry], Ct)).Error!.Code.ShouldBe("TIM_BANK_RECONCILIATION_REQUIRED");
        await using var final = factory.Services.CreateAsyncScope();
        (await final.ServiceProvider.GetRequiredService<TimeTrackingDbContext>().TimeEntries.SingleAsync(x => x.Id == entry, Ct)).Status.ShouldBe(TimeEntryStatus.New);
        (await final.ServiceProvider.GetRequiredService<ContractsDbContext>().HourBanks.SingleAsync(x => x.Id == bank, Ct)).UsedHours.ShouldBe(10m);
    }
    [Fact]
    public async Task Repeating_a_confirmed_legacy_reversal_finishes_time_without_returning_hours_twice()
    {
        var (_, employee, bank, entry, _) = await Setup(factory, 2);
        await using (var host = Host(factory, employee, CrmRoles.ServiceLead))
        {
            await using var scope = host.Services.CreateAsyncScope();
            (await scope.ServiceProvider.GetRequiredService<TimeApprovalService>().ApproveAsync([entry], Ct)).Value.Approved.ShouldBe(1);
        }
        await using (var legacy = factory.Services.CreateAsyncScope())
            await legacy.ServiceProvider.GetRequiredService<IContractsApi>().ReverseConsumptionAsync("TimeEntry", $"{entry}:1:{bank}", Ct);
        await using (var host = Host(factory, employee, CrmRoles.ServiceLead))
        {
            await using var scope = host.Services.CreateAsyncScope();
            (await scope.ServiceProvider.GetRequiredService<TimeApprovalService>().WithdrawAsync([entry], Ct)).Value.ShouldBe(1);
        }
        await using var final = factory.Services.CreateAsyncScope(); var banks = final.ServiceProvider.GetRequiredService<ContractsDbContext>();
        (await banks.HourBanks.SingleAsync(x => x.Id == bank, Ct)).UsedHours.ShouldBe(0m);
        (await banks.HourBankEntries.CountAsync(x => x.HourBankId == bank && x.SourceType == "TimeEntryReversal", Ct)).ShouldBe(1);
        (await final.ServiceProvider.GetRequiredService<TimeTrackingDbContext>().TimeEntries.SingleAsync(x => x.Id == entry, Ct)).Status.ShouldBe(TimeEntryStatus.New);
    }
    private sealed class InjectedFailure : Exception;
    private sealed class FailSave(Guid id, TimeEntryStatus status) : SaveChangesInterceptor
    {
        public override ValueTask<InterceptionResult<int>> SavingChangesAsync(DbContextEventData eventData, InterceptionResult<int> result, CancellationToken cancellationToken = default)
        {
            if (eventData.Context is TimeTrackingDbContext db && db.ChangeTracker.Entries<TimeEntry>().Any(x => x.Entity.Id == id && x.Entity.Status == status && x.State == EntityState.Modified)) throw new InjectedFailure();
            return ValueTask.FromResult(result);
        }
    }
    private sealed class LoseAck(Guid id) : DbTransactionInterceptor
    {
        internal int Commits { get; private set; }
        public override Task TransactionCommittedAsync(DbTransaction transaction, TransactionEndEventData eventData, CancellationToken cancellationToken = default)
        {
            if (eventData.Context is TimeTrackingDbContext db && db.TimeEntries.Local.Any(x => x.Id == id)) { Commits++; throw new InjectedFailure(); }
            return Task.CompletedTask;
        }
    }
}
