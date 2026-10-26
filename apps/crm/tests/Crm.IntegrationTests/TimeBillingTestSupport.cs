using System.Text.Json;
using Crm.Authorization;
using Crm.Billing.Contracts;
using Crm.Billing.Domain;
using Crm.Billing.Features;
using Crm.Billing.Persistence;
using Crm.TimeTracking.Contracts;
using Crm.TimeTracking.Features;
using Crm.TimeTracking.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using static Crm.IntegrationTests.SourceTaskTestSupport;

namespace Crm.IntegrationTests;

internal static class TimeBillingTestSupport
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;
    internal sealed record Draft(Guid Run, Guid Basis, Guid Organization);

    internal static async Task ApproveTime(CrmWebFactory factory, Guid employee, Guid entry)
    {
        await using var host = Host(factory, employee, CrmRoles.ServiceLead); await using var scope = host.Services.CreateAsyncScope();
        (await scope.ServiceProvider.GetRequiredService<TimeApprovalService>().ApproveAsync([entry], Ct)).Value.Approved.ShouldBe(1);
    }

    internal static async Task<Draft> Prepare(CrmWebFactory factory, Guid org, Guid entry, DateOnly date, bool excludeRate = false)
    {
        await using var scope = factory.Services.CreateAsyncScope(); var db = scope.ServiceProvider.GetRequiredService<BillingDbContext>();
        var allocations = await scope.ServiceProvider.GetRequiredService<TimeTrackingDbContext>().TimeAllocations.AsNoTracking().Where(a => a.TimeEntryId == entry).ToListAsync(Ct);
        var run = BillingRun.Create(date.Year, date.Month, "Synthetic source admission"); var basis = BillingBasis.Create(run, org, null);
        var at = DateTimeOffset.UtcNow;
        var drafts = allocations.GroupBy(a => a.Classification).Select(g => new LineDraft(
            g.Key == TimeClassification.Rate ? BillingGroup.HourlyWork : BillingGroup.Info, null, "Synthetic exact work", g.Sum(a => a.Hours),
            g.Key == TimeClassification.Rate ? 100m : 0m, 0m, 0m,
            JsonSerializer.Serialize(new { timeEntryIds = new[] { entry }, allocationIds = g.Select(a => a.Id).ToList() }), "synthetic:" + g.Key, org,
            g.Select(a => new ChargeClaim(ChargeLedger.TimeKey(a.Id), g.Key == TimeClassification.Rate ? ChargeKind.Time : ChargeKind.TimeInfo,
                a.Amount ?? 0m, ServiceFrom: date, ServiceTo: date)).ToList())).ToList();
        basis.ApplyCollected(drafts, null).IsSuccess.ShouldBeTrue();
        basis.AddManualLine(new(BillingGroup.OneOff, null, "Synthetic separate fixed fee", 1m, 10m, 0m, 0m, null), null, at).IsSuccess.ShouldBeTrue();
        if (excludeRate)
            foreach (var line in basis.CurrentLines.Where(l => l.Group == BillingGroup.HourlyWork).ToList())
                basis.RemoveLine(line.Id, "Synthetic explicit exclusion", null, at).IsSuccess.ShouldBeTrue();
        run.MarkCollected(at, false).IsSuccess.ShouldBeTrue();
        db.BillingRuns.Add(run); db.BillingBases.Add(basis);
        scope.ServiceProvider.GetRequiredService<ChargeLedger>().Sync(basis, drafts, new ChargeSnapshot(run.Id, [], new Dictionary<Guid, DateOnly>()), at);
        await db.SaveChangesAsync(Ct); return new(run.Id, basis.Id, org);
    }

    internal static async Task ApproveBilling(CrmWebFactory factory, Guid finance, Draft draft)
    {
        await using var host = Host(factory, finance, CrmRoles.Finance); await using var scope = host.Services.CreateAsyncScope();
        var service = scope.ServiceProvider.GetRequiredService<BillingService>();
        var etag = (await service.GetRunAsync(draft.Run, Ct)).Value.Etag;
        var result = await service.ApproveAsync(draft.Run, false, etag, Ct);
        result.IsSuccess.ShouldBeTrue(result.Error?.Code);
    }
}
