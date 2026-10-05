using Crm.Infrastructure.Outbox;
using Crm.Infrastructure.Persistence;
using Microsoft.Extensions.Logging.Abstractions;

namespace Crm.UnitTests;

/// <summary>Retry timing, lease keeping and the data step of the outbox migration (DEV-07).</summary>
public class OutboxDeliveryTests
{
    [Fact]
    public void Retries_wait_longer_each_time_with_jitter_and_never_longer_than_the_cap()
    {
        var options = new OutboxOptions { RetryBaseDelay = TimeSpan.FromSeconds(10), MaxRetryDelay = TimeSpan.FromHours(1) };

        for (var i = 0; i < 200; i++)
        {
            OutboxProcessor.RetryDelay(options, 1).TotalSeconds.ShouldBeInRange(8, 12);
            OutboxProcessor.RetryDelay(options, 2).TotalSeconds.ShouldBeInRange(16, 24);
            OutboxProcessor.RetryDelay(options, 5).TotalSeconds.ShouldBeInRange(128, 192);
            OutboxProcessor.RetryDelay(options, 9).TotalSeconds.ShouldBeInRange(2048, 3072);
            OutboxProcessor.RetryDelay(options, 40).TotalSeconds.ShouldBeInRange(2880, 4320);
        }

        // Jitter: one outage does not bring every message back in the same second.
        Enumerable.Range(0, 50).Select(_ => OutboxProcessor.RetryDelay(options, 3)).Distinct().Count().ShouldBeGreaterThan(10);
        // Ten attempts reach a dead letter after roughly 85 minutes of waiting, not within one minute.
        Enumerable.Range(1, OutboxMessage.MaxAttempts - 1).Sum(n => OutboxProcessor.RetryDelay(options, n).TotalMinutes).ShouldBeGreaterThan(60);
    }

    [Fact]
    public async Task A_lease_is_renewed_while_the_work_runs_and_the_work_is_cancelled_once_it_is_lost()
    {
        var renewals = 0;
        await using (var kept = new LeaseRenewal(TimeSpan.FromMilliseconds(150), TimeProvider.System,
                         _ => Task.FromResult(Interlocked.Increment(ref renewals) > 0), NullLogger.Instance, CancellationToken.None))
        {
            await Task.Delay(400);
            kept.Token.IsCancellationRequested.ShouldBeFalse();
            kept.Lost.ShouldBeFalse();
        }

        renewals.ShouldBeGreaterThanOrEqualTo(3);

        var calls = 0;
        await using var lost = new LeaseRenewal(TimeSpan.FromMilliseconds(150), TimeProvider.System,
            _ => Task.FromResult(Interlocked.Increment(ref calls) < 2), NullLogger.Instance, CancellationToken.None);
        await Should.ThrowAsync<OperationCanceledException>(() => Task.Delay(TimeSpan.FromSeconds(5), lost.Token));
        lost.Lost.ShouldBeTrue();
    }

    [Fact]
    public async Task A_renewal_that_could_not_be_written_is_not_a_lost_lease()
    {
        var calls = 0;
        await using var renewal = new LeaseRenewal(TimeSpan.FromMilliseconds(150), TimeProvider.System, _ =>
        {
            // The database hiccups twice, then answers that the lease is still held.
            return Interlocked.Increment(ref calls) <= 2 ? throw new TimeoutException("no answer") : Task.FromResult(true);
        }, NullLogger.Instance, CancellationToken.None);

        await Task.Delay(400);
        renewal.Lost.ShouldBeFalse();
        renewal.Token.IsCancellationRequested.ShouldBeFalse();
        calls.ShouldBeGreaterThanOrEqualTo(3);
    }

    [Fact]
    public async Task Stopping_the_host_cancels_the_work_without_calling_the_lease_lost()
    {
        using var stopping = new CancellationTokenSource();
        await using var renewal = new LeaseRenewal(TimeSpan.FromMinutes(2), TimeProvider.System, _ => Task.FromResult(true), NullLogger.Instance, stopping.Token);
        await stopping.CancelAsync();
        renewal.Token.IsCancellationRequested.ShouldBeTrue();
        renewal.Lost.ShouldBeFalse();
    }

    [Fact]
    public void The_migration_step_touches_only_rows_in_the_default_state_and_refuses_odd_schema_names()
    {
        var sql = OutboxMigrationSql.Backfill("billing");
        sql.ShouldContain("UPDATE [billing].[OutboxMessages] SET [Status] = N'Processed'");
        sql.ShouldContain("[Status] = N'DeadLetter'");
        sql.ShouldContain($"[Attempts] >= {OutboxMessage.MaxAttempts}");
        // No automatic replay: attempts are left as they are, and only rows nobody decided on yet are changed.
        sql.ShouldNotContain("[Attempts] = 0");
        System.Text.RegularExpressions.Regex.Count(sql, @"WHERE \[Status\] = N'Pending'").ShouldBe(2);
        Should.Throw<InvalidOperationException>(() => OutboxMigrationSql.Backfill("billing]; DROP TABLE x; --"));
    }

    [Fact]
    public void Only_a_concrete_domain_event_of_the_application_resolves_from_the_name_in_the_table()
    {
        var resolver = new OutboxEventTypeResolver();
        var known = typeof(Crm.Sales.Contracts.OpportunityLost);
        resolver.Resolve($"{known.FullName}, {known.Assembly.GetName().Name}").ShouldBe(known);
        // The assembly-qualified form with version and key is accepted as well.
        resolver.Resolve(known.AssemblyQualifiedName).ShouldBe(known);

        foreach (var hostile in new[]
        {
            "System.Diagnostics.Process, System.Diagnostics.Process",       // a framework type: neither Crm.* nor an event
            "System.IO.FileInfo, System.Private.CoreLib",
            "System.String",                                                // no assembly at all
            $"{typeof(OutboxMessage).FullName}, Crm.Infrastructure",        // an application type that is not an event
            $"{typeof(Crm.SharedKernel.Domain.DomainEvent).FullName}, Crm.SharedKernel", // the abstract base
            "Crm.Evil.Thing, Crm.Evil",                                     // a Crm.* name nobody ships
            "Newtonsoft.Json.JsonConvert, Newtonsoft.Json",
            "", "   ", "not a type", new string('x', 600),
        })
        {
            resolver.Resolve(hostile).ShouldBeNull(hostile);
        }

        resolver.Resolve(null).ShouldBeNull();
    }
}
