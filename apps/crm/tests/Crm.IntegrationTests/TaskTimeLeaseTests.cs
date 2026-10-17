using System.Data.Common;
using System.Net;
using Crm.Activities.Persistence;
using Crm.Authorization;
using Crm.Integrations.Core.Persistence;
using Crm.Service.Persistence;
using Crm.TimeTracking.Domain;
using Crm.TimeTracking.Features;
using Crm.TimeTracking.Persistence;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using static Crm.IntegrationTests.SourceTaskTestSupport;

namespace Crm.IntegrationTests;

public sealed class TaskTimeLeaseTests(CrmWebFactory factory)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Verified_time_holds_exact_task_ticket_and_owner_until_financial_commit_against_ordinary_sql_mutations()
    {
        var org = await Organization(factory); var employee = await Employee(factory, CrmRoles.Technician);
        var task = await ActivityTicketTests.Task(factory, org, Guid.NewGuid()); var ticket = await WorkTicketTestSupport.Create(factory, org);
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<ActivitiesDbContext>();
            (await db.Activities.SingleAsync(a => a.Id == task, Ct)).LinkTicket(ticket.Id); await db.SaveChangesAsync(Ct);
        }
        var gate = new BeforeTimeSave(org);
        await using var host = Host(factory, employee, configure: services =>
            services.AddDbContext<TimeTrackingDbContext>(options => options.AddInterceptors(gate)));
        await using var writeScope = host.Services.CreateAsyncScope();
        var pending = writeScope.ServiceProvider.GetRequiredService<TimeEntryService>().CreateAsync(TaskTimeEntryTests.Request(org, ticket.Id, task), Ct);
        try
        {
            await gate.Entered.Task.WaitAsync(TimeSpan.FromSeconds(10), Ct);
            // LOCK_TIMEOUT is an authoritative SQL negative control: ordinary module mutations cannot commit through
            // these read leases. No extra application lock or retry expectation is involved.
            await Blocked($"UPDATE [activities].[Activities] SET [Subject]=N'Synthetic blocked edit' WHERE [Id]='{task}'");
            await Blocked($"DELETE FROM [service].[Tickets] WHERE [Id]='{ticket.Id}'");
            await Blocked($"DELETE FROM [integration].[ExternalLinks] WHERE [EntityId]='{org}' AND [System]=N'atera'");
        }
        finally { gate.Resume.TrySetResult(); }
        var result = await pending; result.IsSuccess.ShouldBeTrue(); result.Value.SourceActivityId.ShouldBe(task); result.Value.TicketId.ShouldBe(ticket.Id);
        await using var finalScope = factory.Services.CreateAsyncScope(); var time = finalScope.ServiceProvider.GetRequiredService<TimeTrackingDbContext>();
        (await time.TimeEntries.CountAsync(e => e.OrganizationId == org, Ct)).ShouldBe(1);
        (await finalScope.ServiceProvider.GetRequiredService<ActivitiesDbContext>().Activities.SingleAsync(a => a.Id == task, Ct)).Subject.ShouldBe("Synthetic employee-authored work");
        (await finalScope.ServiceProvider.GetRequiredService<ServiceDbContext>().Tickets.AnyAsync(t => t.Id == ticket.Id, Ct)).ShouldBeTrue();
        (await finalScope.ServiceProvider.GetRequiredService<IntegrationDbContext>().ExternalLinks.AnyAsync(l => l.EntityId == org && l.System == "atera", Ct)).ShouldBeTrue();
    }

    [Fact]
    public async Task Lost_acknowledgement_after_time_commit_does_not_replay_the_financial_callback_or_duplicate_time_and_audit()
    {
        var org = await Organization(factory); var employee = await Employee(factory, CrmRoles.Technician);
        var ticket = await WorkTicketTestSupport.Create(factory, org); var lost = new LoseTimeCommit(org);
        await using var host = Host(factory, employee, configure: services =>
            services.AddDbContext<TimeTrackingDbContext>(options => options.AddInterceptors(lost)));
        await using var scope = host.Services.CreateAsyncScope();
        await Should.ThrowAsync<SyntheticLostAcknowledgement>(() => scope.ServiceProvider.GetRequiredService<TimeEntryService>()
            .CreateAsync(TaskTimeEntryTests.Request(org, ticket.Id, null), Ct));
        lost.Commits.ShouldBe(1);
        await using var finalScope = factory.Services.CreateAsyncScope(); var db = finalScope.ServiceProvider.GetRequiredService<TimeTrackingDbContext>();
        var row = (await db.TimeEntries.Where(e => e.OrganizationId == org).ToListAsync(Ct)).ShouldHaveSingleItem();
        row.TicketId.ShouldBe(ticket.Id); row.TechnicianId.ShouldBe(employee);
        (await db.AuditEntries.CountAsync(a => a.EntityType == nameof(TimeEntry) && a.EntityId == row.Id, Ct)).ShouldBe(1);
    }

    private async Task Blocked(string sql)
    {
        await using var connection = new SqlConnection(factory.AdminConnectionString); await connection.OpenAsync(Ct);
        await using var command = connection.CreateCommand(); command.CommandText = "SET LOCK_TIMEOUT 250; " + sql;
        var error = await Should.ThrowAsync<SqlException>(() => command.ExecuteNonQueryAsync(Ct)); error.Number.ShouldBe(1222);
    }
    private sealed class BeforeTimeSave(Guid org) : SaveChangesInterceptor
    {
        public TaskCompletionSource Entered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource Resume { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public override async ValueTask<InterceptionResult<int>> SavingChangesAsync(DbContextEventData eventData,
            InterceptionResult<int> result, CancellationToken cancellationToken = default)
        {
            if (eventData.Context is TimeTrackingDbContext db && db.ChangeTracker.Entries<TimeEntry>().Any(e => e.Entity.OrganizationId == org && e.State == EntityState.Added))
            { Entered.TrySetResult(); await Resume.Task.WaitAsync(cancellationToken); }
            return result;
        }
    }
    private sealed class SyntheticLostAcknowledgement : Exception { }
    private sealed class LoseTimeCommit(Guid org) : DbTransactionInterceptor
    {
        public int Commits { get; private set; }
        public override Task TransactionCommittedAsync(DbTransaction transaction, TransactionEndEventData eventData, CancellationToken cancellationToken = default)
        {
            if (eventData.Context is TimeTrackingDbContext db && db.TimeEntries.Local.Any(e => e.OrganizationId == org))
            { Commits++; throw new SyntheticLostAcknowledgement(); }
            return System.Threading.Tasks.Task.CompletedTask;
        }
    }
}
