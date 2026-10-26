using System.Data.Common;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crm.Activities.Contracts;
using Crm.Activities.Domain;
using Crm.Activities.Features;
using Crm.Activities.Persistence;
using Crm.Authorization;
using Crm.Customers.Contracts;
using Crm.Customers.Persistence;
using Crm.SharedKernel.Domain;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using static Crm.IntegrationTests.SourceTaskTestSupport;

namespace Crm.IntegrationTests;

public sealed class SourceTaskPersistenceTests(CrmWebFactory factory)
{
    [Fact]
    public async Task A_lost_commit_acknowledgement_replays_the_durable_receipt_instead_of_creating_another_task()
    {
        var organization = await Organization(factory); var employee = await Employee(factory, CrmRoles.Technician); var source = Source();
        var fault = new LostCommitOnce();
        await using var host = Host(factory, employee, configure: services => services.AddDbContext<ActivitiesDbContext>(o => o.AddInterceptors(fault)));
        var draft = new SourceTaskDraft(source, organization, employee, null, ActivityPriority.Normal);
        await Should.ThrowAsync<SyntheticLostAcknowledgement>(() => Create(host, draft));
        var replay = (await Create(host, draft)).Value;
        replay.Created.ShouldBeFalse(); replay.IsAvailable.ShouldBeTrue();
        await using var scope = factory.Services.CreateAsyncScope(); var db = scope.ServiceProvider.GetRequiredService<ActivitiesDbContext>();
        (await db.SourceTaskLinks.CountAsync(l => l.SourceKey == SourceTaskIdentityRules.Key(source))).ShouldBe(1);
        (await db.Activities.CountAsync(a => a.Id == replay.ActivityId)).ShouldBe(1);
        (await db.AuditEntries.CountAsync(a => a.EntityType == nameof(Activity) && a.EntityId == replay.ActivityId)).ShouldBe(1);
        (await db.OutboxMessages.CountAsync(m => m.Type.Contains(nameof(ActivityLogged)) && m.Payload.Contains(replay.ActivityId.ToString()))).ShouldBe(1);
    }

    [Fact]
    public async Task A_failed_save_rolls_back_the_task_receipt_audit_and_event_together()
    {
        var organization = await Organization(factory); var employee = await Employee(factory, CrmRoles.Technician); var source = Source();
        await using var host = Host(factory, employee, configure: services => services.AddDbContext<ActivitiesDbContext>(o => o.AddInterceptors(new RefuseSourceSave())));
        await Should.ThrowAsync<SyntheticRefusedSave>(() => Create(host, new(source, organization, employee, null, ActivityPriority.Normal)));
        await using var scope = factory.Services.CreateAsyncScope(); var db = scope.ServiceProvider.GetRequiredService<ActivitiesDbContext>();
        (await db.SourceTaskLinks.CountAsync(l => l.SourceKey == SourceTaskIdentityRules.Key(source))).ShouldBe(0);
        (await db.Activities.CountAsync(a => a.OrganizationId == organization)).ShouldBe(0);
        (await db.AuditEntries.CountAsync(a => a.Module == "activities" && a.Changes != null && a.Changes.Contains(organization.ToString()))).ShouldBe(0);
        (await db.OutboxMessages.CountAsync(m => m.Type.Contains(nameof(ActivityLogged)) && m.Payload.Contains(organization.ToString()))).ShouldBe(0);
    }

    [Fact]
    public async Task The_customers_read_lease_makes_merge_wait_for_task_commit_and_then_the_receipt_follows_the_same_task()
    {
        var sourceOrganization = await Organization(factory); var targetOrganization = await Organization(factory);
        var employee = await Employee(factory, CrmRoles.Technician); var source = Source();
        var pause = new PauseSourceSave(); var update = new ObserveCustomerUpdate();
        await using var host = Host(factory, employee, configure: services =>
        {
            services.AddDbContext<ActivitiesDbContext>(o => o.AddInterceptors(pause));
            services.AddDbContext<CustomersDbContext>(o => o.AddInterceptors(update));
        });
        var pendingTask = Create(host, new(source, sourceOrganization, employee, null, ActivityPriority.Normal));
        await pause.Entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        using var client = host.CreateClient(); client.DefaultRequestHeaders.Add(TestAuthHandler.RolesHeader, CrmRoles.Management);
        client.DefaultRequestHeaders.Add(TestAuthHandler.UserHeader, "source-task-merge-" + Guid.NewGuid().ToString("N"));
        client.DefaultRequestHeaders.Add("X-CSRF", "1");
        var pendingMerge = client.PostAsJsonAsync($"/api/v1/customers/organizations/{targetOrganization}/merge", new { sourceOrganizationId = sourceOrganization });
        try
        {
            var progress = await Task.WhenAny(update.Entered.Task, pendingMerge).WaitAsync(TimeSpan.FromSeconds(5));
            if (progress == pendingMerge)
            {
                (await pendingMerge).StatusCode.ShouldBe(HttpStatusCode.OK, "The merge must reach its SQL write before testing its row lock.");
                update.Entered.Task.IsCompleted.ShouldBeTrue("The merge completed without reaching the expected SQL write barrier.");
            }
            (await Task.WhenAny(pendingMerge, Task.Delay(250))).ShouldNotBe(pendingMerge);
        }
        finally { pause.Resume.TrySetResult(); }
        var task = (await pendingTask).Value; var mergeResponse = await pendingMerge; mergeResponse.StatusCode.ShouldBe(HttpStatusCode.OK);
        var merge = await mergeResponse.Content.ReadFromJsonAsync<JsonElement>();
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var handler = scope.ServiceProvider.GetServices<IDomainEventHandler<OrganizationsMerged>>().OfType<ActivitiesMergeHandler>().Single();
            await handler.HandleAsync(new(merge.GetProperty("mergeId").GetGuid(), targetOrganization, sourceOrganization), default);
        }
        (await Find(host, source, sourceOrganization)).Error!.Code.ShouldBe("ACT_SOURCE_TASK_CUSTOMER_CHANGED");
        var moved = (await Find(host, source, targetOrganization)).Value!;
        moved.ActivityId.ShouldBe(task.ActivityId); moved.OrganizationId.ShouldBe(targetOrganization);
        (await Create(host, new(source, targetOrganization, employee, null, ActivityPriority.High))).Value.Created.ShouldBeFalse();
    }

    [Fact]
    public async Task A_missing_customer_leaves_no_receipt_or_task()
    {
        var employee = await Employee(factory, CrmRoles.Technician); await using var host = Host(factory, employee); var source = Source();
        (await Create(host, new(source, Guid.NewGuid(), employee, null, ActivityPriority.Normal))).Error!.Code.ShouldBe("CUS_ORGANIZATION_UNAVAILABLE");
        await using var scope = factory.Services.CreateAsyncScope();
        (await scope.ServiceProvider.GetRequiredService<ActivitiesDbContext>().SourceTaskLinks.CountAsync(l => l.SourceKey == SourceTaskIdentityRules.Key(source))).ShouldBe(0);
    }

    private sealed class SyntheticLostAcknowledgement : Exception { }
    private sealed class SyntheticRefusedSave : Exception { }

    private sealed class LostCommitOnce : DbTransactionInterceptor
    {
        private int _remaining = 1;
        public override Task TransactionCommittedAsync(DbTransaction transaction, TransactionEndEventData eventData, CancellationToken cancellationToken = default)
        {
            if (eventData.Context is ActivitiesDbContext db && db.SourceTaskLinks.Local.Count != 0 && Interlocked.Exchange(ref _remaining, 0) == 1)
                throw new SyntheticLostAcknowledgement();
            return Task.CompletedTask;
        }
    }

    private sealed class RefuseSourceSave : SaveChangesInterceptor
    {
        public override ValueTask<InterceptionResult<int>> SavingChangesAsync(DbContextEventData eventData, InterceptionResult<int> result, CancellationToken cancellationToken = default)
        {
            if (eventData.Context is ActivitiesDbContext db && db.ChangeTracker.Entries<SourceTaskLink>().Any(e => e.State == EntityState.Added))
                throw new SyntheticRefusedSave();
            return ValueTask.FromResult(result);
        }
    }

    private sealed class PauseSourceSave : SaveChangesInterceptor
    {
        public TaskCompletionSource Entered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource Resume { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public override async ValueTask<InterceptionResult<int>> SavingChangesAsync(DbContextEventData eventData, InterceptionResult<int> result, CancellationToken cancellationToken = default)
        {
            if (eventData.Context is ActivitiesDbContext db && db.ChangeTracker.Entries<SourceTaskLink>().Any(e => e.State == EntityState.Added))
            {
                Entered.TrySetResult(); await Resume.Task.WaitAsync(cancellationToken);
            }
            return result;
        }
    }

    private sealed class ObserveCustomerUpdate : DbCommandInterceptor
    {
        public TaskCompletionSource Entered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public override ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(DbCommand command, CommandEventData eventData,
            InterceptionResult<DbDataReader> result, CancellationToken cancellationToken = default)
        {
            if (command.CommandText.Contains("UPDATE [customers].[Organizations]", StringComparison.Ordinal)) Entered.TrySetResult();
            return ValueTask.FromResult(result);
        }
    }
}
