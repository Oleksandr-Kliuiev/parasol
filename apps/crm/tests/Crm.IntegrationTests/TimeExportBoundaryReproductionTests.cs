using System.Text.Json;
using Crm.Authorization;
using Crm.Billing.Contracts;
using Crm.Billing.Domain;
using Crm.Billing.Features;
using Crm.Billing.Persistence;
using Crm.Contracts.Persistence;
using Crm.TimeTracking.Contracts;
using Crm.TimeTracking.Domain;
using Crm.TimeTracking.Features;
using Crm.TimeTracking.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using static Crm.IntegrationTests.SourceTaskTestSupport;
using static Crm.IntegrationTests.TimeBankTestSupport;
using static Crm.IntegrationTests.TimePeriodTestSupport;

namespace Crm.IntegrationTests;

// Diagnostic injection into an owned, synthetic SQL fixture. No provider is contacted and no outbox is drained.
// These scenarios deliberately withhold terminal delivery; other classes drain the shared outbox.
[Collection(DatabaseAdministrationCollection.Name)]
public sealed class TimeExportBoundaryReproductionTests(CrmWebFactory factory)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Theory]
    [InlineData(false)] [InlineData(true)]
    public async Task A_send_started_or_exported_basis_prevents_refunding_its_hours_before_terminal_event_delivery(bool exported)
    {
        var (org, employee, bank, entry, date) = await Setup(factory, 2);
        await Approve(employee, entry);
        var basis = await ExportSnapshot(org, entry, date, exported);
        await using (var before = factory.Services.CreateAsyncScope())
            (await before.ServiceProvider.GetRequiredService<TimeTrackingDbContext>().TimeEntries.AsNoTracking().SingleAsync(e => e.Id == entry, Ct)).Status.ShouldBe(TimeEntryStatus.Approved, "The regression specifically requires terminal delivery to remain delayed.");
        await using var host = Host(factory, employee, CrmRoles.ServiceLead);
        await using var scope = host.Services.CreateAsyncScope();
        var result = await scope.ServiceProvider.GetRequiredService<TimeApprovalService>().WithdrawAsync([entry], Ct);
        var time = scope.ServiceProvider.GetRequiredService<TimeTrackingDbContext>();
        var status = (await time.TimeEntries.AsNoTracking().SingleAsync(e => e.Id == entry, Ct)).Status;
        var used = (await scope.ServiceProvider.GetRequiredService<ContractsDbContext>().HourBanks.AsNoTracking().SingleAsync(b => b.Id == bank, Ct)).UsedHours;
        Console.WriteLine(JsonSerializer.Serialize(new { diagnostic = exported ? "exported-before-inbox" : "sending-before-inbox", withdrawalAccepted = result.IsSuccess, status = status.ToString(), bankUsed = used }));
        result.IsSuccess.ShouldBeFalse("An already sent or possibly sent immutable basis must fence a bank refund before its asynchronous terminal event.");
        status.ShouldBe(TimeEntryStatus.Approved); used.ShouldBe(2m);
        (await scope.ServiceProvider.GetRequiredService<IBillingApi>().GetInvoicedTimeEntryIdsAsync(basis, Ct)).Count.ShouldBe(exported ? 1 : 0);
    }

    [Fact]
    public async Task A_changed_source_preserves_the_exported_snapshot_while_the_terminal_event_is_delayed()
    {
        var (org, employee, bank, _, date) = await Setup(factory, 1);
        var source = Incoming(org, date) with { Hours = 2m, TechnicianUserId = employee }; Guid entry;
        await using (var host = Host(factory, employee, CrmRoles.ServiceLead))
        {
            await using var scope = host.Services.CreateAsyncScope();
            (await scope.ServiceProvider.GetRequiredService<ITimeTrackingApi>().ImportAsync([source], Ct)).Created.ShouldBe(1);
            entry = (await scope.ServiceProvider.GetRequiredService<TimeTrackingDbContext>().TimeEntries.AsNoTracking().SingleAsync(e => e.Source == TimeSource.Atera && e.ExternalId == source.ExternalId, Ct)).Id;
        }
        await Approve(employee, entry); await ExportSnapshot(org, entry, date, true);
        await using var updateHost = Host(factory, employee, CrmRoles.ServiceLead);
        await using var updateScope = updateHost.Services.CreateAsyncScope();
        var result = await updateScope.ServiceProvider.GetRequiredService<ITimeTrackingApi>().ImportAsync([source with { Hours = 3m }], Ct);
        var saved = await updateScope.ServiceProvider.GetRequiredService<TimeTrackingDbContext>().TimeEntries.AsNoTracking().SingleAsync(e => e.Id == entry, Ct);
        var used = (await updateScope.ServiceProvider.GetRequiredService<ContractsDbContext>().HourBanks.AsNoTracking().SingleAsync(b => b.Id == bank, Ct)).UsedHours;
        Console.WriteLine(JsonSerializer.Serialize(new { diagnostic = "source-changed-before-inbox", result.Updated, result.NeedsReview, saved.Hours, status = saved.Status.ToString(), bankUsed = used }));
        saved.Hours.ShouldBe(2m, "A delayed terminal event does not authorize replacing work already included in an exported basis.");
        saved.Status.ShouldBe(TimeEntryStatus.Approved); saved.ReviewNote.ShouldNotBeNull(); used.ShouldBe(2m);
    }

    [Fact]
    public async Task A_delayed_export_event_does_not_mark_a_different_legacy_approval_revision_invoiced()
    {
        var (org, employee, _, entry, date) = await Setup(factory, 2);
        await Approve(employee, entry); var basis = await ExportSnapshot(org, entry, date, true);
        // Deliberately seed a pre-fix historical revision directly, bypassing command admission.
        await using (var legacy = factory.Services.CreateAsyncScope())
        {
            var db = legacy.ServiceProvider.GetRequiredService<TimeTrackingDbContext>();
            var row = await db.TimeEntries.Include(e => e.Allocations).SingleAsync(e => e.Id == entry, Ct);
            row.Withdraw().IsSuccess.ShouldBeTrue();
            row.Update(new(org, employee, date, 3m, "Remote", true, false, false, "Synthetic legacy revision", null, null, null, null)).IsSuccess.ShouldBeTrue();
            var allocation = new TimeAllocation(entry, TimeClassification.Rate, 3m, 3m, 100m, null);
            row.Approve(employee, DateTimeOffset.UtcNow, null, [allocation]); db.TimeAllocations.Add(allocation);
            await db.SaveChangesAsync(Ct);
        }
        await using var handlerScope = factory.Services.CreateAsyncScope();
        var time = handlerScope.ServiceProvider.GetRequiredService<TimeTrackingDbContext>();
        await new Crm.TimeTracking.Features.BasisExportedHandler(time, handlerScope.ServiceProvider.GetRequiredService<ITimeBillingReader>(),
            NullLogger<Crm.TimeTracking.Features.BasisExportedHandler>.Instance).HandleAsync(new(basis, org, "synthetic", "1"), Ct);
        var saved = await time.TimeEntries.AsNoTracking().SingleAsync(e => e.Id == entry, Ct);
        Console.WriteLine(JsonSerializer.Serialize(new { diagnostic = "old-event-new-approval", saved.ApprovalCount, saved.Hours, status = saved.Status.ToString() }));
        saved.Status.ShouldBe(TimeEntryStatus.Approved, "An event for the old exported allocation must not mark a different approval revision invoiced merely because EntryId matches.");
        saved.ReviewNote.ShouldNotBeNull();
    }

    private async Task Approve(Guid employee, Guid entry)
    {
        await using var host = Host(factory, employee, CrmRoles.ServiceLead); await using var scope = host.Services.CreateAsyncScope();
        (await scope.ServiceProvider.GetRequiredService<TimeApprovalService>().ApproveAsync([entry], Ct)).Value.Approved.ShouldBe(1);
    }

    private async Task<Guid> ExportSnapshot(Guid org, Guid entry, DateOnly date, bool exported)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var time = scope.ServiceProvider.GetRequiredService<TimeTrackingDbContext>();
        var allocation = await time.TimeAllocations.AsNoTracking().SingleAsync(a => a.TimeEntryId == entry, Ct);
        var db = scope.ServiceProvider.GetRequiredService<BillingDbContext>(); var ledger = scope.ServiceProvider.GetRequiredService<ChargeLedger>();
        var run = BillingRun.Create(date.Year, date.Month, "Synthetic delayed delivery");
        var basis = BillingBasis.Create(run, org, null); var at = DateTimeOffset.UtcNow;
        var refs = JsonSerializer.Serialize(new { timeEntryIds = new[] { entry }, allocationIds = new[] { allocation.Id } });
        var draft = new LineDraft(BillingGroup.Info, null, "Synthetic prepaid work", 2m, 0m, 0m, 0m, refs, "info:HourBank",
            Claims: [new(ChargeLedger.TimeKey(allocation.Id), ChargeKind.TimeInfo, 0m, ServiceFrom: date, ServiceTo: date)]);
        basis.ApplyCollected([draft], null).IsSuccess.ShouldBeTrue();
        basis.AddManualLine(new(BillingGroup.OneOff, null, "Synthetic separate fixed fee", 1m, 10m, 0m, 0m, null), null, at).IsSuccess.ShouldBeTrue();
        db.BillingRuns.Add(run); db.BillingBases.Add(basis);
        ledger.Sync(basis, [draft], new ChargeSnapshot(run.Id, [], new Dictionary<Guid, DateOnly>()), at);
        await db.SaveChangesAsync(Ct);
        basis.Approve().IsSuccess.ShouldBeTrue(); await ledger.CommitAsync(run.Id, [basis], at, Ct); await db.SaveChangesAsync(Ct);
        var api = scope.ServiceProvider.GetRequiredService<IBillingApi>();
        (await api.MarkExportSendingAsync(basis.Id, "synthetic", null, Ct)).ShouldBeTrue();
        if (exported) await api.MarkExportedAsync(basis.Id, "synthetic", "1", null, Ct);
        return basis.Id;
    }
}
