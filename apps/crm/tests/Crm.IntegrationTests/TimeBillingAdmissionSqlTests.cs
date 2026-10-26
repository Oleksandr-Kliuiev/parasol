using Crm.Authorization;
using Crm.Billing.Contracts;
using Crm.Billing.Domain;
using Crm.Billing.Features;
using Crm.Billing.Persistence;
using Crm.Contracts.Persistence;
using Crm.TimeTracking.Contracts;
using Crm.TimeTracking.Features;
using Crm.TimeTracking.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using static Crm.IntegrationTests.SourceTaskTestSupport;
using static Crm.IntegrationTests.TimeBankTestSupport;
using static Crm.IntegrationTests.TimeBillingTestSupport;
using static Crm.IntegrationTests.TimePeriodTestSupport;

namespace Crm.IntegrationTests;

// These scenarios deliberately withhold terminal delivery; other classes drain the shared outbox.
[Collection(DatabaseAdministrationCollection.Name)]
public sealed class TimeBillingAdmissionSqlTests(CrmWebFactory factory)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Draft_does_not_freeze_time_but_stale_source_cannot_be_approved_and_leaves_no_partial_signature()
    {
        var (org, employee, _, entry, date) = await Setup(factory, 2); await ApproveTime(factory, employee, entry);
        var draft = await Prepare(factory, org, entry, date); var finance = await Employee(factory, CrmRoles.Finance);
        await using (var timeHost = Host(factory, employee, CrmRoles.ServiceLead))
        {
            await using var scope = timeHost.Services.CreateAsyncScope();
            (await scope.ServiceProvider.GetRequiredService<TimeApprovalService>().WithdrawAsync([entry], Ct)).Value.ShouldBe(1);
        }
        await using (var host = Host(factory, finance, CrmRoles.Finance))
        {
            await using var scope = host.Services.CreateAsyncScope(); var service = scope.ServiceProvider.GetRequiredService<BillingService>();
            var etag = (await service.GetRunAsync(draft.Run, Ct)).Value.Etag;
            (await service.ApproveAsync(draft.Run, false, etag, Ct)).Error!.Code.ShouldBe("TIM_BILLING_SOURCE_CHANGED");
            // A later save in the same scope cannot accidentally persist a refused signature.
            await scope.ServiceProvider.GetRequiredService<BillingDbContext>().SaveChangesAsync(Ct);
        }
        await using var final = factory.Services.CreateAsyncScope(); var db = final.ServiceProvider.GetRequiredService<BillingDbContext>();
        (await db.BillingRuns.SingleAsync(r => r.Id == draft.Run, Ct)).Status.ShouldBe(BillingRunStatus.Collected);
        (await db.BillingApprovals.CountAsync(a => a.RunId == draft.Run, Ct)).ShouldBe(0);
    }

    [Fact]
    public async Task Approval_holds_actual_month_admission_until_its_billing_save_and_durable_claim_blocks_the_next_refund()
    {
        var (org, employee, bank, entry, date) = await Setup(factory, 2); await ApproveTime(factory, employee, entry);
        var draft = await Prepare(factory, org, entry, date); var finance = await Employee(factory, CrmRoles.Finance); var gate = new BillingSaveGate(draft.Run);
        await using var host = Host(factory, finance, CrmRoles.Finance, services => services.AddDbContext<BillingDbContext>(o => o.AddInterceptors(gate)));
        await using var scope = host.Services.CreateAsyncScope(); var service = scope.ServiceProvider.GetRequiredService<BillingService>();
        var etag = (await service.GetRunAsync(draft.Run, Ct)).Value.Etag;
        var pending = service.ApproveAsync(draft.Run, false, etag, Ct);
        try { await gate.Entered.Task.WaitAsync(TimeSpan.FromSeconds(15), Ct); (await Probe(factory, date, "Exclusive")).ShouldBe(-1); }
        finally { gate.Resume.TrySetResult(); }
        (await pending).IsSuccess.ShouldBeTrue(); (await Probe(factory, date, "Exclusive")).ShouldBeGreaterThanOrEqualTo(0);
        await using var writer = Host(factory, employee, CrmRoles.ServiceLead); await using var writerScope = writer.Services.CreateAsyncScope();
        (await writerScope.ServiceProvider.GetRequiredService<TimeApprovalService>().WithdrawAsync([entry], Ct)).Error!.Code.ShouldBe("TIM_BILLING_COMMITTED");
        (await writerScope.ServiceProvider.GetRequiredService<ContractsDbContext>().HourBanks.AsNoTracking().SingleAsync(b => b.Id == bank, Ct)).UsedHours.ShouldBe(2m);
    }

    [Fact]
    public async Task Failed_billing_save_releases_the_read_lease_and_does_not_freeze_an_unaccepted_basis()
    {
        var (org, employee, _, entry, date) = await Setup(factory, 2); await ApproveTime(factory, employee, entry);
        var draft = await Prepare(factory, org, entry, date); var finance = await Employee(factory, CrmRoles.Finance);
        await using (var host = Host(factory, finance, CrmRoles.Finance, services => services.AddDbContext<BillingDbContext>(o => o.AddInterceptors(new FailBillingSave(draft.Run)))))
        {
            await using var scope = host.Services.CreateAsyncScope(); var service = scope.ServiceProvider.GetRequiredService<BillingService>();
            var etag = (await service.GetRunAsync(draft.Run, Ct)).Value.Etag;
            await Should.ThrowAsync<InjectedBillingFailure>(() => service.ApproveAsync(draft.Run, false, etag, Ct));
        }
        (await Probe(factory, date, "Exclusive")).ShouldBeGreaterThanOrEqualTo(0);
        await using var writer = Host(factory, employee, CrmRoles.ServiceLead); await using var writerScope = writer.Services.CreateAsyncScope();
        (await writerScope.ServiceProvider.GetRequiredService<TimeApprovalService>().WithdrawAsync([entry], Ct)).Value.ShouldBe(1);
    }

    [Fact]
    public async Task Finance_cancellation_of_an_unsent_basis_releases_its_time_without_rewriting_its_approved_lines()
    {
        var (org, employee, _, entry, date) = await Setup(factory, 2); await ApproveTime(factory, employee, entry);
        var draft = await Prepare(factory, org, entry, date); var finance = await Employee(factory, CrmRoles.Finance); await ApproveBilling(factory, finance, draft);
        await using (var host = Host(factory, finance, CrmRoles.Finance))
        {
            await using var scope = host.Services.CreateAsyncScope(); var service = scope.ServiceProvider.GetRequiredService<BillingService>();
            var basis = (await service.GetBasisAsync(draft.Basis, Ct)).Value;
            (await service.CancelAsync(draft.Basis, new("Synthetic customer correction"), basis.Etag, Ct)).IsSuccess.ShouldBeTrue();
        }
        await using var writer = Host(factory, employee, CrmRoles.ServiceLead); await using var writerScope = writer.Services.CreateAsyncScope();
        (await writerScope.ServiceProvider.GetRequiredService<TimeApprovalService>().WithdrawAsync([entry], Ct)).Value.ShouldBe(1);
    }

    [Fact]
    public async Task Exporting_included_prepaid_info_does_not_lose_an_explicitly_excluded_rate_allocation()
    {
        var (org, employee, _, entry, date) = await Setup(factory, 12);
        var workType = "M25-partial-" + Guid.NewGuid().ToString("N");
        using (var financeClient = factory.ClientAs(CrmRoles.Finance))
            await CatalogApiTests.CreateProductAsync(financeClient, new { sku = CatalogApiTests.Sku("M25"), name = "Synthetic excluded hours",
                type = "HourlyService", businessLine = "Consulting", unit = "Hour", billingPeriod = "OneTime", vatRate = 25m,
                listPrice = 100m, unitCost = 0m, ateraWorkType = workType });
        await using (var editor = Host(factory, employee, CrmRoles.ServiceLead))
        {
            await using var editScope = editor.Services.CreateAsyncScope(); var service = editScope.ServiceProvider.GetRequiredService<TimeEntryService>();
            var current = (await service.ListAsync(new(null, null, null, null, org, null, null, null, false, 50, null), Ct)).Items.Single();
            (await service.UpdateAsync(entry, Request(org, date) with { Hours = 12m, WorkType = workType }, current.Etag, Ct)).IsSuccess.ShouldBeTrue();
        }
        await ApproveTime(factory, employee, entry);
        var draft = await Prepare(factory, org, entry, date, excludeRate: true); var finance = await Employee(factory, CrmRoles.Finance); await ApproveBilling(factory, finance, draft);
        await using var scope = factory.Services.CreateAsyncScope(); var api = scope.ServiceProvider.GetRequiredService<IBillingApi>();
        (await api.MarkExportSendingAsync(draft.Basis, "synthetic", null, Ct)).ShouldBeTrue();
        await api.MarkExportedAsync(draft.Basis, "synthetic", "1", null, Ct);
        var time = scope.ServiceProvider.GetRequiredService<TimeTrackingDbContext>(); var reader = scope.ServiceProvider.GetRequiredService<ITimeBillingReader>();
        await new Crm.TimeTracking.Features.BasisExportedHandler(time, reader, NullLogger<Crm.TimeTracking.Features.BasisExportedHandler>.Instance)
            .HandleAsync(new(draft.Basis, org, "synthetic", "1"), Ct);
        (await time.TimeEntries.AsNoTracking().SingleAsync(e => e.Id == entry, Ct)).Status.ShouldBe(TimeEntryStatus.Approved);
        var remaining = (await scope.ServiceProvider.GetRequiredService<ITimeTrackingApi>().GetBillableTimeAsync(date, date, Ct)).Where(t => t.EntryId == entry).ToList();
        remaining.ShouldContain(t => t.Classification == TimeClassification.HourBank && t.Invoiced && t.Hours == 10m);
        remaining.ShouldContain(t => t.Classification == TimeClassification.Rate && !t.Invoiced && t.Hours == 2m);

        // Exercise the real consumer, not only its source DTO: the supplementary collect must retain the unbilled 2h.
        await using var financeHost = Host(factory, finance, CrmRoles.Finance); await using var financeScope = financeHost.Services.CreateAsyncScope();
        var billing = financeScope.ServiceProvider.GetRequiredService<BillingService>();
        (await billing.CloseAsync(draft.Run, Ct)).IsSuccess.ShouldBeTrue();
        var next = (await billing.CreateRunAsync(new(date.Year, date.Month, "Synthetic remaining hours", true), Ct)).Value;
        (await billing.CollectAsync(next.Id, next.Etag, Ct)).IsSuccess.ShouldBeTrue();
        var collected = (await billing.ListBasesAsync(new(next.Id, false, null, null), Ct)).Value.Single(b => b.Organization.Id == org);
        var lines = (await billing.GetBasisAsync(collected.Id, Ct)).Value.Lines;
        lines.ShouldContain(l => l.Group == BillingGroup.HourlyWork && l.Quantity == 2m && l.UnitPrice == 100m);
        lines.ShouldNotContain(l => l.Group == BillingGroup.Info);
    }

    [Fact]
    public async Task Lost_billing_commit_acknowledgement_keeps_the_durable_admission_and_one_signature()
    {
        var (org, employee, _, entry, date) = await Setup(factory, 2); await ApproveTime(factory, employee, entry);
        var draft = await Prepare(factory, org, entry, date); var finance = await Employee(factory, CrmRoles.Finance);
        await using (var host = Host(factory, finance, CrmRoles.Finance, services => services.AddDbContext<BillingDbContext>(o => o.AddInterceptors(new LostBillingAck()))))
        {
            await using var scope = host.Services.CreateAsyncScope(); var service = scope.ServiceProvider.GetRequiredService<BillingService>();
            var etag = (await service.GetRunAsync(draft.Run, Ct)).Value.Etag;
            await Should.ThrowAsync<InjectedBillingFailure>(() => service.ApproveAsync(draft.Run, false, etag, Ct));
        }
        (await Probe(factory, date, "Exclusive")).ShouldBeGreaterThanOrEqualTo(0);
        await using var writer = Host(factory, employee, CrmRoles.ServiceLead); await using var writerScope = writer.Services.CreateAsyncScope();
        (await writerScope.ServiceProvider.GetRequiredService<TimeApprovalService>().WithdrawAsync([entry], Ct)).Error!.Code.ShouldBe("TIM_BILLING_COMMITTED");
        (await writerScope.ServiceProvider.GetRequiredService<BillingDbContext>().BillingApprovals.CountAsync(a => a.RunId == draft.Run, Ct)).ShouldBe(1);
    }

    [Theory]
    [InlineData("not-json")] [InlineData("{\"timeEntryIds\":\"not-an-array\"}")] [InlineData("{\"timeEntryIds\":[]}")]
    public async Task Broken_historical_time_references_are_scoped_review_facts_not_a_false_empty_result(string refs)
    {
        var (org, employee, _, entry, date) = await Setup(factory, 2); await ApproveTime(factory, employee, entry);
        var draft = await Prepare(factory, org, entry, date);
        await using (var legacy = factory.Services.CreateAsyncScope())
        {
            var db = legacy.ServiceProvider.GetRequiredService<BillingDbContext>();
            var basis = await db.BillingBases.Include(b => b.Lines).SingleAsync(b => b.Id == draft.Basis, Ct);
            var old = basis.CurrentLines.Single(l => l.Group == BillingGroup.Info);
            basis.ApplyCollected([new(old.Group, old.ProductId, old.Description, old.Quantity, old.UnitPrice, old.DiscountPct, old.VatRate,
                refs, old.SourceKey, org)], null).IsSuccess.ShouldBeTrue();
            await db.SaveChangesAsync(Ct);
            basis.Approve().IsSuccess.ShouldBeTrue(); await legacy.ServiceProvider.GetRequiredService<ChargeLedger>().CommitAsync(draft.Run, [basis], DateTimeOffset.UtcNow, Ct);
            await db.SaveChangesAsync(Ct);
        }
        await using var scope = factory.Services.CreateAsyncScope();
        var facts = await scope.ServiceProvider.GetRequiredService<ITimeBillingReader>().ReadAsync([new(entry, org)], Ct);
        facts.ShouldHaveSingleItem().Proven.ShouldBeFalse();
        (await scope.ServiceProvider.GetRequiredService<ITimeBillingReader>().ReadAsync([new(Guid.NewGuid(), Guid.NewGuid())], Ct)).ShouldBeEmpty();
        var finance = await Employee(factory, CrmRoles.Finance);
        await using var financeHost = Host(factory, finance, CrmRoles.Finance); await using var financeScope = financeHost.Services.CreateAsyncScope();
        var service = financeScope.ServiceProvider.GetRequiredService<BillingService>();
        var etag = (await service.GetRunAsync(draft.Run, Ct)).Value.Etag;
        (await service.CollectAsync(draft.Run, etag, Ct)).Error!.Code.ShouldBe("TIM_BILLING_SOURCE_CHANGED");
    }

    private sealed class InjectedBillingFailure : Exception;
    private sealed class LostBillingAck : DbTransactionInterceptor
    {
        public override Task TransactionCommittedAsync(System.Data.Common.DbTransaction transaction, TransactionEndEventData eventData, CancellationToken cancellationToken = default) =>
            throw new InjectedBillingFailure();
    }
    private sealed class FailBillingSave(Guid run) : SaveChangesInterceptor
    {
        public override ValueTask<InterceptionResult<int>> SavingChangesAsync(DbContextEventData e, InterceptionResult<int> result, CancellationToken cancellationToken = default)
        {
            if (e.Context is BillingDbContext db && db.ChangeTracker.Entries<BillingRun>().Any(r => r.Entity.Id == run && r.Entity.Status == BillingRunStatus.Approved)) throw new InjectedBillingFailure();
            return ValueTask.FromResult(result);
        }
    }
    private sealed class BillingSaveGate(Guid run) : SaveChangesInterceptor
    {
        internal TaskCompletionSource Entered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal TaskCompletionSource Resume { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public override async ValueTask<InterceptionResult<int>> SavingChangesAsync(DbContextEventData e, InterceptionResult<int> result, CancellationToken cancellationToken = default)
        {
            if (e.Context is BillingDbContext db && db.ChangeTracker.Entries<BillingRun>().Any(r => r.Entity.Id == run && r.Entity.Status == BillingRunStatus.Approved))
            { Entered.TrySetResult(); await Resume.Task.WaitAsync(cancellationToken); }
            return result;
        }
    }
}
