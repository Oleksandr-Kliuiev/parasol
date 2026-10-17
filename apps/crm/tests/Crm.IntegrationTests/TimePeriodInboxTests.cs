using System.Data.Common;
using System.Reflection;
using Crm.Authorization;
using Crm.Billing.Contracts;
using Crm.Identity.Contracts;
using Crm.Infrastructure.Persistence;
using Crm.TimeTracking.Contracts;
using Crm.TimeTracking.Features;
using Crm.TimeTracking.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.EntityFrameworkCore.Storage;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using static Crm.IntegrationTests.SourceTaskTestSupport;
using static Crm.IntegrationTests.TimePeriodTestSupport;

namespace Crm.IntegrationTests;

public sealed class TimePeriodInboxTests(CrmWebFactory factory)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;
    [Theory]
    [InlineData(true, "commit")] [InlineData(false, "commit")]
    [InlineData(true, "rollback")] [InlineData(false, "rollback")]
    [InlineData(true, "lost-ack")] [InlineData(false, "lost-ack")]
    public async Task Handlers_join_the_real_inbox_owner_and_hold_admission_through_its_commit_or_rollback(bool invoice, string outcome)
    {
        var date = Date(); var org = await Organization(factory); var employee = await Employee(factory, CrmRoles.ServiceLead);
        var replacement = await Employee(factory, CrmRoles.Technician); var source = Incoming(org, date) with { TechnicianUserId = employee };
        var row = await Seed(factory, org, employee, date, approved: true, source);
        await using (var seed = factory.Services.CreateAsyncScope())
        {
            var db = seed.ServiceProvider.GetRequiredService<TimeTrackingDbContext>();
            var period = new Crm.TimeTracking.Domain.TimePeriod(date.Year, date.Month); period.Close(employee, DateTimeOffset.UtcNow); db.TimePeriods.Add(period); await db.SaveChangesAsync(Ct);
        }
        var messageId = Guid.NewGuid(); var handlerName = invoice ? typeof(BasisExportedHandler).FullName! : typeof(TechnicianMappingHandler).FullName!;
        var ack = new LoseAck(outcome == "lost-ack");
        await using var host = Host(factory, employee, CrmRoles.ServiceLead, services => services.AddDbContext<TimeTrackingDbContext>(o =>
            o.UseSqlServer(sql => sql.ExecutionStrategy(d => new NonRetryingExecutionStrategy(d))).AddInterceptors(ack)));
        await using (var scope = host.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<TimeTrackingDbContext>(); var handling = scope.ServiceProvider.GetRequiredService<MessageHandlingContext>();
            handling.Begin(messageId, handlerName); await handling.ClaimAsync(db, DateTimeOffset.UtcNow, Ct);
            if (invoice)
            {
                var billing = DispatchProxy.Create<ITimeBillingReader, BillingIds>();
                ((BillingIds)billing).Claims = [new(Guid.NewGuid(), org, [row.Id], row.CurrentAllocations.Select(a => a.Id).ToList(), true, true)];
                await new BasisExportedHandler(db, billing, NullLogger<BasisExportedHandler>.Instance).HandleAsync(new(Guid.NewGuid(), org, "synthetic", "1"), Ct);
            }
            else await new TechnicianMappingHandler(db).HandleAsync(new("atera", source.TechnicianExternalId!, replacement), Ct);
            // The handler returned and called its local CommitAsync, but the actual inbox owner has not committed.
            db.Database.CurrentTransaction.ShouldNotBeNull(); (await Probe(factory, date, "Exclusive")).ShouldBe(-1);
            if (outcome == "commit") await handling.CommitAsync(Ct);
            if (outcome == "lost-ack") await Should.ThrowAsync<LostInboxAcknowledgement>(() => handling.CommitAsync(Ct));
            // No owner commit on rollback: disposing this actual message context's DbContext rolls everything back.
        }
        (await Probe(factory, date, "Exclusive")).ShouldBeGreaterThanOrEqualTo(0);
        await using var finalScope = factory.Services.CreateAsyncScope(); var final = finalScope.ServiceProvider.GetRequiredService<TimeTrackingDbContext>();
        var saved = await final.TimeEntries.SingleAsync(e => e.Id == row.Id, Ct); var accepted = outcome != "rollback";
        saved.Status.ShouldBe(invoice && accepted ? TimeEntryStatus.Invoiced : TimeEntryStatus.Approved);
        saved.TechnicianId.ShouldBe(!invoice && accepted ? replacement : employee);
        (await final.InboxReceipts.CountAsync(r => r.MessageId == messageId && r.Handler == handlerName, Ct)).ShouldBe(accepted ? 1 : 0);
        (await final.AuditEntries.CountAsync(a => a.EntityId == row.Id, Ct)).ShouldBe(accepted ? 2 : 1);
        if (accepted)
        {
            await using var repeat = host.Services.CreateAsyncScope(); var handling = repeat.ServiceProvider.GetRequiredService<MessageHandlingContext>();
            handling.Begin(messageId, handlerName);
            await Should.ThrowAsync<MessageAlreadyHandledException>(() => handling.ClaimAsync(repeat.ServiceProvider.GetRequiredService<TimeTrackingDbContext>(), DateTimeOffset.UtcNow, Ct));
        }
    }

    [Fact]
    public async Task Technician_mapping_is_source_scoped_and_does_not_rewrite_manual_history_with_a_colliding_external_id()
    {
        var date = Date(); var org = await Organization(factory); var employee = await Employee(factory, CrmRoles.ServiceLead);
        var source = Incoming(org, date) with { TechnicianUserId = employee };
        var atera = await Seed(factory, org, employee, date, incoming: source);
        var manual = await Seed(factory, org, employee, date, incoming: source with { System = "Crm", ExternalId = Guid.NewGuid().ToString("N") });
        await using var scope = factory.Services.CreateAsyncScope(); var db = scope.ServiceProvider.GetRequiredService<TimeTrackingDbContext>();
        var handler = new TechnicianMappingHandler(db); var next = Guid.NewGuid();
        await handler.HandleAsync(new("unknown", source.TechnicianExternalId!, next), Ct);
        await handler.HandleAsync(new("atera", source.TechnicianExternalId!, next), Ct);
        (await db.TimeEntries.AsNoTracking().SingleAsync(e => e.Id == atera.Id, Ct)).TechnicianId.ShouldBe(next);
        (await db.TimeEntries.AsNoTracking().SingleAsync(e => e.Id == manual.Id, Ct)).TechnicianId.ShouldBe(employee);
    }
    public class BillingIds : DispatchProxy
    {
        internal IReadOnlyList<TimeBillingClaim> Claims { get; set; } = [];
        protected override object? Invoke(MethodInfo? targetMethod, object?[]? args) =>
            targetMethod?.Name is nameof(ITimeBillingReader.ReadExportedBasisAsync) or nameof(ITimeBillingReader.ReadAsync)
                ? Task.FromResult(Claims) : throw new InvalidOperationException("Unexpected Billing call.");
    }
    private sealed class LostInboxAcknowledgement : Exception;
    private sealed class LoseAck(bool enabled) : DbTransactionInterceptor
    {
        public override Task TransactionCommittedAsync(DbTransaction transaction, TransactionEndEventData eventData, CancellationToken cancellationToken = default) =>
            enabled ? throw new LostInboxAcknowledgement() : Task.CompletedTask;
    }
}
