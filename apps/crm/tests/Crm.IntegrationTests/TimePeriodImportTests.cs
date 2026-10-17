using Crm.Authorization;
using Crm.TimeTracking.Contracts;
using Crm.TimeTracking.Domain;
using Crm.TimeTracking.Features;
using Crm.TimeTracking.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using static Crm.IntegrationTests.SourceTaskTestSupport;
using static Crm.IntegrationTests.TimePeriodTestSupport;

namespace Crm.IntegrationTests;

public sealed class TimePeriodImportTests(CrmWebFactory factory)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;
    [Theory]
    [InlineData(false, false)] [InlineData(false, true)] [InlineData(true, false)] [InlineData(true, true)]
    public async Task Source_move_retains_the_financial_snapshot_if_either_old_or_new_month_is_closed(bool approved, bool closeOld)
    {
        var date = Date(); var org = await Organization(factory); var employee = await Employee(factory, CrmRoles.ServiceLead);
        var source = Incoming(org, date); var row = await Seed(factory, org, employee, date, approved, source);
        await using var host = Host(factory, employee, CrmRoles.ServiceLead); await using var scope = host.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<TimeTrackingDbContext>();
        var closedDate = closeOld ? date : date.AddMonths(1);
        var period = new TimePeriod(closedDate.Year, closedDate.Month); period.Close(employee, DateTimeOffset.UtcNow); db.TimePeriods.Add(period); await db.SaveChangesAsync(Ct);
        var result = await scope.ServiceProvider.GetRequiredService<ITimeTrackingApi>().ImportAsync([source with { WorkDate = date.AddMonths(1), Hours = 2m }], Ct);
        result.Updated.ShouldBe(0); result.NeedsReview.ShouldBe(1);
        var saved = await db.TimeEntries.AsNoTracking().Include(e => e.Allocations).SingleAsync(e => e.Id == row.Id, Ct);
        saved.WorkDate.ShouldBe(date); saved.Hours.ShouldBe(1m); saved.Status.ShouldBe(approved ? TimeEntryStatus.Approved : TimeEntryStatus.New);
        saved.ReviewNote.ShouldNotBeNull(); saved.CurrentAllocations.Count().ShouldBe(approved ? 1 : 0);
    }

    [Fact]
    public async Task New_late_source_rows_have_an_explicit_review_note_in_closed_history()
    {
        var date = Date(); var org = await Organization(factory); var employee = await Employee(factory, CrmRoles.ServiceLead);
        await using var host = Host(factory, employee, CrmRoles.ServiceLead); await using var scope = host.Services.CreateAsyncScope();
        (await scope.ServiceProvider.GetRequiredService<TimeEntryService>().ClosePeriodAsync(date.Year, date.Month, Ct)).IsSuccess.ShouldBeTrue();
        var source = Incoming(org, date);
        var api = scope.ServiceProvider.GetRequiredService<ITimeTrackingApi>();
        var result = await api.ImportAsync([source, source], Ct); result.Created.ShouldBe(1); result.NeedsReview.ShouldBe(1);
        var repeated = await api.ImportAsync([source], Ct); repeated.Unchanged.ShouldBe(1); repeated.Created.ShouldBe(0);
        var db = scope.ServiceProvider.GetRequiredService<TimeTrackingDbContext>();
        var row = await db.TimeEntries.AsNoTracking().SingleAsync(e => e.OrganizationId == org, Ct);
        row.ReviewNote.ShouldBe("Arrived after the period was closed.");
        (await scope.ServiceProvider.GetRequiredService<TimeEntryService>().ClosePeriodAsync(date.Year, date.Month, Ct)).IsSuccess.ShouldBeTrue();
    }
}
