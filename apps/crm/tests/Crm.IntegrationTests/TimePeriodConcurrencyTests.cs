using Crm.Authorization;
using Crm.TimeTracking.Domain;
using Crm.TimeTracking.Features;
using Crm.TimeTracking.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using static Crm.IntegrationTests.SourceTaskTestSupport;
using static Crm.IntegrationTests.TimePeriodTestSupport;

namespace Crm.IntegrationTests;

public sealed class TimePeriodConcurrencyTests(CrmWebFactory factory)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;
    [Theory]
    [InlineData(true)] [InlineData(false)]
    public async Task Missing_period_row_is_fenced_until_owning_commit_in_both_close_create_orderings(bool closeFirst)
    {
        var date = Date(); var org = await Organization(factory); var employee = await Employee(factory, CrmRoles.ServiceLead);
        var firstGate = new SaveGate(date, closeFirst); var secondGate = new LockGate(date);
        await using var firstHost = Host(factory, employee, CrmRoles.ServiceLead, services => services.AddDbContext<TimeTrackingDbContext>(o => o.AddInterceptors(firstGate)));
        await using var secondHost = Host(factory, employee, CrmRoles.ServiceLead, services => services.AddDbContext<TimeTrackingDbContext>(o => o.AddInterceptors(secondGate)));
        await using var firstScope = firstHost.Services.CreateAsyncScope(); await using var secondScope = secondHost.Services.CreateAsyncScope();
        var first = firstScope.ServiceProvider.GetRequiredService<TimeEntryService>(); var second = secondScope.ServiceProvider.GetRequiredService<TimeEntryService>();
        var closing = closeFirst ? first.ClosePeriodAsync(date.Year, date.Month, Ct) : null;
        var writing = closeFirst ? null : first.CreateAsync(Request(org, date, Guid.NewGuid()), Ct);
        try
        {
            await firstGate.Entered.Task.WaitAsync(TimeSpan.FromSeconds(10), Ct);
            (await Probe(factory, date, closeFirst ? "Shared" : "Exclusive")).ShouldBe(-1);
            if (closeFirst) writing = second.CreateAsync(Request(org, date, Guid.NewGuid()), Ct);
            else closing = second.ClosePeriodAsync(date.Year, date.Month, Ct);
            await secondGate.Entered.Task.WaitAsync(TimeSpan.FromSeconds(10), Ct);
            if (closeFirst) writing!.IsCompleted.ShouldBeFalse(); else closing!.IsCompleted.ShouldBeFalse();
        }
        finally { firstGate.Resume.TrySetResult(); }
        var closed = await closing!; var written = await writing!;
        if (closeFirst) { closed.IsSuccess.ShouldBeTrue(); written.Error!.Code.ShouldBe("TIM_PERIOD_CLOSED"); }
        else { written.IsSuccess.ShouldBeTrue(); closed.Error!.Code.ShouldBe("TIM_UNAPPROVED_ENTRIES"); }
        await using var finalScope = factory.Services.CreateAsyncScope(); var db = finalScope.ServiceProvider.GetRequiredService<TimeTrackingDbContext>();
        (await db.TimeEntries.CountAsync(e => e.OrganizationId == org, Ct)).ShouldBe(closeFirst ? 0 : 1);
        (await db.TimePeriods.AnyAsync(p => p.Year == date.Year && p.Month == date.Month && p.IsClosed, Ct)).ShouldBe(closeFirst);
        (await Probe(factory, date, "Exclusive")).ShouldBeGreaterThanOrEqualTo(0);
    }

    [Fact]
    public async Task A_move_after_discovery_refuses_the_old_command_before_mutation_instead_of_locking_a_new_month_out_of_order()
    {
        var date = Date(); var org = await Organization(factory); var employee = await Employee(factory, CrmRoles.ServiceLead);
        var row = await Seed(factory, org, employee, date); var gate = new LockGate(date, pause: true);
        await using var delayedHost = Host(factory, employee, CrmRoles.ServiceLead, services => services.AddDbContext<TimeTrackingDbContext>(o => o.AddInterceptors(gate)));
        await using var normalHost = Host(factory, employee, CrmRoles.ServiceLead);
        await using var delayedScope = delayedHost.Services.CreateAsyncScope(); await using var normalScope = normalHost.Services.CreateAsyncScope();
        var delayed = delayedScope.ServiceProvider.GetRequiredService<TimeEntryService>().AdjustAsync(row.Id, new(false, "Must not persist", false), Ct);
        try
        {
            await gate.Entered.Task.WaitAsync(TimeSpan.FromSeconds(10), Ct);
            var service = normalScope.ServiceProvider.GetRequiredService<TimeEntryService>();
            var before = (await service.ListAsync(new(null, null, null, null, org, null, null, null, false, 50, null), Ct)).Items.Single(e => e.Id == row.Id);
            (await service.UpdateAsync(row.Id, Request(org, date.AddMonths(1)), before.Etag, Ct)).IsSuccess.ShouldBeTrue();
        }
        finally { gate.Resume.TrySetResult(); }
        (await delayed).Error!.Code.ShouldBe("TIM_WORK_CHANGED");
        await using var finalScope = factory.Services.CreateAsyncScope(); var db = finalScope.ServiceProvider.GetRequiredService<TimeTrackingDbContext>();
        var saved = await db.TimeEntries.SingleAsync(e => e.Id == row.Id, Ct); saved.WorkDate.ShouldBe(date.AddMonths(1)); saved.WorkType.ShouldBe("Remote"); saved.Billable.ShouldBeTrue();
    }

    [Fact]
    public async Task A_foreign_closed_entry_still_returns_forbidden_before_disclosing_period_or_deletion_state()
    {
        var date = Date(); var org = await Organization(factory);
        var owner = await Employee(factory, CrmRoles.Technician); var other = await Employee(factory, CrmRoles.Technician);
        var row = await Seed(factory, org, owner, date, approved: true);
        await using (var seed = factory.Services.CreateAsyncScope())
        {
            var db = seed.ServiceProvider.GetRequiredService<TimeTrackingDbContext>();
            var period = new TimePeriod(date.Year, date.Month); period.Close(owner, DateTimeOffset.UtcNow); db.TimePeriods.Add(period); await db.SaveChangesAsync(Ct);
        }
        await using var host = Host(factory, other, CrmRoles.Technician); await using var scope = host.Services.CreateAsyncScope();
        (await scope.ServiceProvider.GetRequiredService<TimeEntryService>().DeleteAsync(row.Id, Ct)).Error!.Code.ShouldBe("TIM_NOT_OWNER");
    }

    [Fact]
    public async Task Closing_twice_creates_one_period_audit_and_event_and_reopen_requires_a_reason()
    {
        var date = Date(); var employee = await Employee(factory, CrmRoles.ServiceLead);
        await using var host = Host(factory, employee, CrmRoles.ServiceLead); await using var scope = host.Services.CreateAsyncScope();
        var service = scope.ServiceProvider.GetRequiredService<TimeEntryService>();
        (await service.ClosePeriodAsync(date.Year, date.Month, Ct)).IsSuccess.ShouldBeTrue();
        (await service.ClosePeriodAsync(date.Year, date.Month, Ct)).IsSuccess.ShouldBeTrue();
        var db = scope.ServiceProvider.GetRequiredService<TimeTrackingDbContext>(); var period = await db.TimePeriods.SingleAsync(p => p.Year == date.Year && p.Month == date.Month, Ct);
        (await db.AuditEntries.CountAsync(a => a.EntityId == period.Id, Ct)).ShouldBe(1);
        (await db.OutboxMessages.CountAsync(o => o.Type.Contains("TimePeriodClosed") && o.Payload.Contains(date.Year.ToString()), Ct)).ShouldBe(1);
        (await service.ReopenPeriodAsync(date.Year, date.Month, " ", Ct)).Error!.Code.ShouldBe("TIM_REASON_REQUIRED");
        (await service.ReopenPeriodAsync(date.Year, date.Month, "Synthetic reviewed correction", Ct)).IsSuccess.ShouldBeTrue();
        (await Probe(factory, date, "Exclusive")).ShouldBeGreaterThanOrEqualTo(0);
    }
}
