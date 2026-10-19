using System.Net.Http.Json;
using System.Reflection;
using System.Text.Json;
using Crm.Authorization;
using Crm.Contracts.Contracts;
using Crm.TimeTracking.Contracts;
using Crm.TimeTracking.Domain;
using Crm.TimeTracking.Features;
using Crm.TimeTracking.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using static Crm.IntegrationTests.SourceTaskTestSupport;
using static Crm.IntegrationTests.TimePeriodTestSupport;

namespace Crm.IntegrationTests;

public sealed class TimePeriodWriterTests(CrmWebFactory factory)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;
    [Theory]
    [InlineData("update")] [InlineData("adjust")] [InlineData("delete")]
    [InlineData("approve")] [InlineData("withdraw")] [InlineData("import")]
    public async Task Every_financial_writer_holds_its_month_admission_until_owning_commit(string operation)
    {
        var date = Date(); var org = await Organization(factory); var employee = await Employee(factory, CrmRoles.ServiceLead);
        var incoming = operation == "import" ? Incoming(org, date) : null;
        var row = await Seed(factory, org, employee, date, approved: operation is "withdraw" or "import", incoming);
        var gate = new SaveGate(date, period: false); var closeGate = new LockGate(date);
        await using var host = Host(factory, employee, CrmRoles.ServiceLead, services => services.AddDbContext<TimeTrackingDbContext>(o => o.AddInterceptors(gate)));
        await using var closer = Host(factory, employee, CrmRoles.ServiceLead, services => services.AddDbContext<TimeTrackingDbContext>(o => o.AddInterceptors(closeGate)));
        await using var scope = host.Services.CreateAsyncScope(); await using var closeScope = closer.Services.CreateAsyncScope();
        var service = scope.ServiceProvider.GetRequiredService<TimeEntryService>(); var approvals = scope.ServiceProvider.GetRequiredService<TimeApprovalService>();
        async Task Write()
        {
            if (operation == "update")
            {
                var before = (await service.ListAsync(new(null, null, null, null, org, null, null, null, false, 50, null), Ct)).Items.Single();
                (await service.UpdateAsync(row.Id, Request(org, date) with { Hours = 2m }, before.Etag, Ct)).IsSuccess.ShouldBeTrue();
            }
            if (operation == "adjust") (await service.AdjustAsync(row.Id, new(false, "Reviewed", true), Ct)).IsSuccess.ShouldBeTrue();
            if (operation == "delete") (await service.DeleteAsync(row.Id, Ct)).IsSuccess.ShouldBeTrue();
            if (operation == "approve") (await approvals.ApproveAsync([row.Id], Ct)).Value.Approved.ShouldBe(1);
            if (operation == "withdraw") (await approvals.WithdrawAsync([row.Id], Ct)).Value.ShouldBe(1);
            if (operation == "import") (await scope.ServiceProvider.GetRequiredService<ITimeTrackingApi>().ImportAsync([incoming! with { Hours = 2m }], Ct)).Updated.ShouldBe(1);
        }
        var pending = Write(); Task<Crm.SharedKernel.Results.Result<PeriodDto>>? closing = null;
        try
        {
            await gate.Entered.Task.WaitAsync(TimeSpan.FromSeconds(10), Ct);
            (await Probe(factory, date, "Exclusive")).ShouldBe(-1);
            closing = closeScope.ServiceProvider.GetRequiredService<TimeEntryService>().ClosePeriodAsync(date.Year, date.Month, Ct);
            await closeGate.Entered.Task.WaitAsync(TimeSpan.FromSeconds(10), Ct); closing.IsCompleted.ShouldBeFalse();
        }
        finally { gate.Resume.TrySetResult(); }
        await pending; var result = await closing!;
        if (operation is "delete" or "approve") result.IsSuccess.ShouldBeTrue();
        else result.Error!.Code.ShouldBe("TIM_UNAPPROVED_ENTRIES");
        (await Probe(factory, date, "Exclusive")).ShouldBeGreaterThanOrEqualTo(0);
    }

    [Fact]
    public async Task A_mixed_open_closed_withdrawal_reverses_no_hour_bank_before_the_complete_batch_is_validated()
    {
        var date = Date(); var org = await Organization(factory); var employee = await Employee(factory, CrmRoles.ServiceLead);
        var open = await Seed(factory, org, employee, date, approved: true); var closed = await Seed(factory, org, employee, date.AddMonths(1), approved: true);
        await using (var seedScope = factory.Services.CreateAsyncScope())
        {
            var db = seedScope.ServiceProvider.GetRequiredService<TimeTrackingDbContext>();
            foreach (var id in new[] { open.Id, closed.Id })
            {
                var row = await db.TimeEntries.Include(e => e.Allocations).SingleAsync(e => e.Id == id, Ct);
                row.Withdraw(); row.Approve(employee, DateTimeOffset.UtcNow, null, [new(row.Id, TimeClassification.HourBank, 1m, 1m, null, Guid.NewGuid())]);
            }
            var period = new TimePeriod(date.Year, date.Month + 1); period.Close(employee, DateTimeOffset.UtcNow); db.TimePeriods.Add(period); await db.SaveChangesAsync(Ct);
        }
        var proxy = DispatchProxy.Create<IContractsApi, ReversalProbe>(); var counter = (ReversalProbe)proxy;
        await using var host = Host(factory, employee, CrmRoles.ServiceLead, services => services.AddScoped<IContractsApi>(_ => proxy));
        await using var scope = host.Services.CreateAsyncScope();
        (await scope.ServiceProvider.GetRequiredService<TimeApprovalService>().WithdrawAsync([open.Id, closed.Id], Ct)).Error!.Code.ShouldBe("TIM_PERIOD_CLOSED");
        counter.Calls.ShouldBe(0);
        await using var finalScope = factory.Services.CreateAsyncScope();
        (await finalScope.ServiceProvider.GetRequiredService<TimeTrackingDbContext>().TimeEntries.Where(e => e.Id == open.Id || e.Id == closed.Id).Select(e => e.Status).ToListAsync(Ct))
            .ShouldAllBe(status => status == TimeEntryStatus.Approved);
    }

    [Fact]
    public async Task Competing_approvals_for_different_entries_share_one_month_coverage_budget()
    {
        var date = Date(); var org = await Organization(factory); var employee = await Employee(factory, CrmRoles.ServiceLead);
        using var admin = factory.ClientAs(CrmRoles.Admin);
        var response = await admin.PostAsJsonAsync("/api/v1/contracts/sla-policies", new { name = "Synthetic coverage " + Guid.NewGuid().ToString("N"), coverage = "Business8x5",
            p1 = new { responseMinutes = 60, resolutionMinutes = 240 }, p2 = new { responseMinutes = 120, resolutionMinutes = 480 },
            p3 = new { responseMinutes = 480, resolutionMinutes = 1440 }, p4 = new { responseMinutes = 960, resolutionMinutes = 2880 },
            includedHoursPerMonth = 1m, overageRate = 100m, afterHoursMultiplier = 1.5m, coveredWorkTypes = "Remote" });
        response.EnsureSuccessStatusCode(); var sla = await response.Content.ReadFromJsonAsync<JsonElement>(Ct);
        response = await admin.PostAsJsonAsync("/api/v1/contracts", new { organizationId = org, title = "Synthetic contract", type = "Msp", startDate = date.AddYears(-1),
            autoRenew = false, renewalTermMonths = 0, noticePeriodDays = 30, slaPolicyId = sla.GetProperty("id").GetGuid(), invoiceFrequency = "Monthly", invoiceTiming = "InAdvance", indexation = false });
        response.EnsureSuccessStatusCode(); var contract = await response.Content.ReadFromJsonAsync<JsonElement>(Ct);
        (await admin.PostAsync($"/api/v1/contracts/{contract.GetProperty("id").GetGuid()}/activate", null, Ct)).EnsureSuccessStatusCode();
        var a = await Seed(factory, org, employee, date); var b = await Seed(factory, org, employee, date);
        var gate = new SaveGate(date, false); var wait = new LockGate(date);
        await using var firstHost = Host(factory, employee, CrmRoles.ServiceLead, services => services.AddDbContext<TimeTrackingDbContext>(o => o.AddInterceptors(gate)));
        await using var secondHost = Host(factory, employee, CrmRoles.ServiceLead, services => services.AddDbContext<TimeTrackingDbContext>(o => o.AddInterceptors(wait)));
        await using var firstScope = firstHost.Services.CreateAsyncScope(); await using var secondScope = secondHost.Services.CreateAsyncScope();
        var first = firstScope.ServiceProvider.GetRequiredService<TimeApprovalService>().ApproveAsync([a.Id], Ct);
        Task<Crm.SharedKernel.Results.Result<ApprovalSummary>>? second = null;
        try
        {
            await gate.Entered.Task.WaitAsync(TimeSpan.FromSeconds(10), Ct);
            second = secondScope.ServiceProvider.GetRequiredService<TimeApprovalService>().ApproveAsync([b.Id], Ct);
            await wait.Entered.Task.WaitAsync(TimeSpan.FromSeconds(10), Ct);
            (await Probe(factory, date, "Exclusive")).ShouldBe(-1); second.IsCompleted.ShouldBeFalse();
        }
        finally { gate.Resume.TrySetResult(); }
        (await first).Value.Approved.ShouldBe(1); (await second!).Value.Approved.ShouldBe(1);
        await using var finalScope = factory.Services.CreateAsyncScope(); var final = finalScope.ServiceProvider.GetRequiredService<TimeTrackingDbContext>();
        var ids = new[] { a.Id, b.Id };
        (await final.TimeAllocations.Where(x => ids.Contains(x.TimeEntryId) && x.Classification == TimeClassification.Covered).SumAsync(x => x.Hours, Ct)).ShouldBe(1m);
        (await final.TimeAllocations.Where(x => ids.Contains(x.TimeEntryId) && x.Classification == TimeClassification.Rate).SumAsync(x => x.Hours, Ct)).ShouldBe(1m);
    }
    public class ReversalProbe : DispatchProxy
    {
        internal int Calls { get; private set; }
        protected override object? Invoke(MethodInfo? targetMethod, object?[]? args)
        { if (targetMethod?.Name != nameof(IContractsApi.ReverseConsumptionAsync)) throw new InvalidOperationException("Unexpected Contracts call."); Calls++; return Task.CompletedTask; }
    }
}
