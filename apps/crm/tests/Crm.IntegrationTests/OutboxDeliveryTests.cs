using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crm.Authorization;
using Crm.Billing.Persistence;
using Crm.Contracts.Contracts;
using Crm.Contracts.Persistence;
using Crm.Customers.Persistence;
using Crm.Infrastructure.Outbox;
using Crm.Infrastructure.Persistence;
using Crm.Integrations.Core;
using Crm.Integrations.Core.Persistence;
using Crm.Sales.Contracts;
using Crm.Sales.Persistence;
using Crm.SharedKernel.Domain;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using static Crm.IntegrationTests.IntegrationTestHelpers;

namespace Crm.IntegrationTests;

/// <summary>
/// The delivery tests drive the outbox themselves, message by message, and pause an integration: no other class may drain
/// the outbox or touch the switches meanwhile.
/// </summary>
[CollectionDefinition(OutboxDeliveryCollection.Name, DisableParallelization = true)]
public sealed class OutboxDeliveryCollection
{
    public const string Name = "outbox-delivery";
}

/// <summary>
/// DEV-07: dead letters and replay, leases with fencing, one effect per handler however often a message arrives, and a
/// corrupt payload that blocks nothing and leaks nothing. "Two workers" are two processors with their own tokens, exactly
/// what two crm-worker replicas are to the database.
/// </summary>
[Collection(OutboxDeliveryCollection.Name)]
public class OutboxDeliveryTests(CrmWebFactory factory)
{
    private const string Outbox = "/api/v1/integrations/outbox";
    private static readonly Type Customers = typeof(CustomersDbContext);
    private static readonly Type Sales = typeof(SalesDbContext);
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task A_message_that_fails_ten_times_is_a_dead_letter_that_a_person_replays_once_the_cause_is_fixed()
    {
        var probe = Guid.NewGuid();
        var note = $"dead-letter-{probe:N}";
        factory.Probes.FailB(probe, int.MaxValue);
        var id = await ProbeAsync(probe, note);
        var processor = Processor();

        for (var attempt = 0; attempt < OutboxMessage.MaxAttempts; attempt++)
        {
            (await DeliverOnceAsync(processor, Customers, id)).ShouldBeFalse();
        }

        var dead = await MessageAsync(Customers, id);
        dead.Status.ShouldBe(OutboxStatus.DeadLetter);
        dead.Attempts.ShouldBe(OutboxMessage.MaxAttempts);
        dead.DeadLetteredAt.ShouldNotBeNull();
        dead.LockedUntil.ShouldBeNull();
        dead.LastError.ShouldNotBeNull().ShouldContain("DeliveryProbeHandlerB: InvalidOperationException");
        // A succeeded at the first attempt and never ran again; B ran every time.
        factory.Probes.Runs(probe, DeliveryProbes.EffectA).ShouldBe(1);
        factory.Probes.Runs(probe, DeliveryProbes.EffectB).ShouldBe(OutboxMessage.MaxAttempts);
        (await EffectsAsync(probe, DeliveryProbes.EffectA)).ShouldBe(1);
        (await EffectsAsync(probe, DeliveryProbes.EffectB)).ShouldBe(0);

        // A dead letter waits for a person: the worker neither claims it nor counts further attempts.
        (await ClaimAsync(processor, Customers, id)).ShouldBeNull();
        await processor.ProcessContextAsync(Customers, Ct);
        (await MessageAsync(Customers, id)).Attempts.ShouldBe(OutboxMessage.MaxAttempts);

        // Visible to an administrator, with the names of the payload's fields but not their values.
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "outbox-admin");
        var listed = await admin.GetFromJsonAsync<JsonElement>($"{Outbox}?module=customers", Ct);
        var item = listed.GetProperty("items").EnumerateArray().Single(i => i.GetProperty("id").GetGuid() == id);
        item.GetProperty("status").GetString().ShouldBe("DeadLetter");
        item.GetProperty("attempts").GetInt32().ShouldBe(OutboxMessage.MaxAttempts);
        item.GetProperty("eventType").GetString().ShouldBe(nameof(DeliveryProbe));
        item.GetProperty("deliveredHandlers").EnumerateArray().Select(h => h.GetString()).ShouldBe([nameof(DeliveryProbeHandlerA)]);
        item.GetProperty("payloadFields").EnumerateArray().Select(f => f.GetString()).ShouldBe(["probeId", "note", "occurredAt"], ignoreOrder: true);
        item.GetProperty("replayRequested").GetBoolean().ShouldBeFalse();
        listed.GetRawText().ShouldNotContain(note);
        listed.GetProperty("counts").EnumerateArray().Single(c => c.GetProperty("module").GetString() == "customers")
            .GetProperty("deadLetter").GetInt32().ShouldBeGreaterThanOrEqualTo(1);

        // The cause is fixed. The replay is asked for with a reason; a second request for the same message is refused.
        factory.Probes.FailB(probe, 0);
        var body = new { messages = new[] { new { module = "customers", id, replays = 0 } }, reason = "Probe B is fixed (DEV-07 test)", expected = 1 };
        (await admin.PostAsJsonAsync($"{Outbox}/replay", body, Ct)).StatusCode.ShouldBe(HttpStatusCode.Accepted);
        var again = await admin.PostAsJsonAsync($"{Outbox}/replay", body, Ct);
        again.StatusCode.ShouldBe(HttpStatusCode.Conflict);
        (await again.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe("OUTBOX_REPLAY_STALE");
        (await admin.GetFromJsonAsync<JsonElement>($"{Outbox}?module=customers", Ct)).GetProperty("items").EnumerateArray()
            .Single(i => i.GetProperty("id").GetGuid() == id).GetProperty("replayRequested").GetBoolean().ShouldBeTrue();

        var (request, audit) = await ReplayRecordAsync(id);
        request.Reason.ShouldBe("Probe B is fixed (DEV-07 test)");
        request.RequestedByName.ShouldNotBeNull().ShouldContain("outbox-admin");
        audit.UserName.ShouldNotBeNull().ShouldContain("outbox-admin");
        audit.Changes.ShouldNotBeNull().ShouldContain("Probe B is fixed (DEV-07 test)");
        audit.Changes.ShouldContain(id.ToString());

        // crm-worker applies the request and delivers the stored payload: only B runs.
        await ApplyAndDeliverAsync(processor, Customers, id);
        var delivered = await MessageAsync(Customers, id);
        delivered.Status.ShouldBe(OutboxStatus.Processed);
        delivered.Replays.ShouldBe(1);
        factory.Probes.Runs(probe, DeliveryProbes.EffectA).ShouldBe(1);
        factory.Probes.Runs(probe, DeliveryProbes.EffectB).ShouldBe(OutboxMessage.MaxAttempts + 1);
        (await EffectsAsync(probe, DeliveryProbes.EffectA)).ShouldBe(1);
        (await EffectsAsync(probe, DeliveryProbes.EffectB)).ShouldBe(1);
    }

    [Fact]
    public async Task Concurrent_bulk_replays_return_one_request_and_per_item_results_without_duplicate_audit()
    {
        var id = await ProbeAsync(Guid.NewGuid());
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            await scope.ServiceProvider.GetRequiredService<CustomersDbContext>().OutboxMessages.Where(m => m.Id == id)
                .ExecuteUpdateAsync(update => update.SetProperty(m => m.Status, OutboxStatus.DeadLetter), Ct);
        }

        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "dev17-replay-race");
        var body = new { messages = new[] { new { module = "customers", id, replays = 0 } }, reason = "DEV-17 verified the handler recovery", expected = 1 };
        var responses = await Task.WhenAll(admin.PostAsJsonAsync($"{Outbox}/replay", body, Ct), admin.PostAsJsonAsync($"{Outbox}/replay", body, Ct));
        responses.Select(r => r.StatusCode).ShouldBe([HttpStatusCode.Accepted, HttpStatusCode.Conflict], ignoreOrder: true);
        foreach (var response in responses)
        {
            var result = await response.ReadJsonAsync();
            var item = result.GetProperty("items").EnumerateArray().Single();
            item.GetProperty("id").GetGuid().ShouldBe(id);
            item.GetProperty("status").GetString().ShouldBe(response.StatusCode == HttpStatusCode.Accepted ? "Requested" : "Unavailable");
        }
        // SingleAsync in the helper also proves there is exactly one request and one audit entry.
        var (request, audit) = await ReplayRecordAsync(id);
        request.Expected.ShouldBe(1);
        audit.Changes.ShouldNotBeNull().ShouldContain(id.ToString());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task A_confirmation_cannot_replay_the_next_generation_after_worker_failure(bool corruptPayload)
    {
        var probe = Guid.NewGuid();
        var id = await DeadLetterAsync(await ProbeAsync(probe));
        factory.Probes.FailB(probe, int.MaxValue);
        if (corruptPayload)
        {
            await using var scope = factory.Services.CreateAsyncScope();
            await scope.ServiceProvider.GetRequiredService<CustomersDbContext>().OutboxMessages.Where(m => m.Id == id)
                .ExecuteUpdateAsync(s => s.SetProperty(m => m.Payload, "{corrupt payload}").SetProperty(m => m.Status, OutboxStatus.Quarantined), Ct);
        }
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "replay-generation");
        var body = new { messages = new[] { new { module = "customers", id, replays = 0 } }, reason = "Investigated the initial delivery failure", expected = 1 };
        (await admin.PostAsJsonAsync($"{Outbox}/replay", body, Ct)).StatusCode.ShouldBe(HttpStatusCode.Accepted);
        var processor = Processor();
        await processor.ProcessContextAsync(Customers, Ct);
        while ((await MessageAsync(Customers, id)).Status == OutboxStatus.Pending)
            (await DeliverOnceAsync(processor, Customers, id)).ShouldBeFalse();
        var failed = await MessageAsync(Customers, id);
        failed.Status.ShouldBe(corruptPayload ? OutboxStatus.Quarantined : OutboxStatus.DeadLetter);
        failed.Replays.ShouldBe(1);
        await ShouldRefuseAsync(admin, body, HttpStatusCode.Conflict, "OUTBOX_REPLAY_STALE");
        var (request, _) = await ReplayRecordAsync(id);
        request.AppliedAt.ShouldNotBeNull();
        // A deliberate new confirmation may retry the new generation, while the repeated original cannot.
        var next = new { messages = new[] { new { module = "customers", id, replays = 1 } }, body.reason, expected = 1 };
        (await admin.PostAsJsonAsync($"{Outbox}/replay", next, Ct)).StatusCode.ShouldBe(HttpStatusCode.Accepted);
    }

    [Fact]
    public async Task A_partial_module_failure_reports_committed_unknown_and_not_requested_items()
    {
        var now = DateTimeOffset.UtcNow;
        var customer = OutboxMessage.For(new DeliveryProbe(Guid.NewGuid(), "partial-first"), now, null);
        var sales = OutboxMessage.For(new DeliveryProbe(Guid.NewGuid(), "partial-second"), now, null);
        var integration = OutboxMessage.For(new DeliveryProbe(Guid.NewGuid(), "partial-third"), now, null);
        foreach (var message in new[] { customer, sales, integration }) message.Status = OutboxStatus.DeadLetter;
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var customersDb = scope.ServiceProvider.GetRequiredService<CustomersDbContext>();
            customersDb.OutboxMessages.Add(customer);
            await customersDb.SaveChangesAsync(Ct);
            var salesDb = scope.ServiceProvider.GetRequiredService<SalesDbContext>();
            salesDb.OutboxMessages.Add(sales);
            await salesDb.SaveChangesAsync(Ct);
            var integrationDb = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
            integrationDb.OutboxMessages.Add(integration);
            await integrationDb.SaveChangesAsync(Ct);
        }
        await using var host = factory.WithWebHostBuilder(builder => builder.ConfigureTestServices(services =>
            services.AddDbContext<SalesDbContext>(options => options.AddInterceptors(new RefuseReplaySave(sales.Id)))));
        var admin = host.CreateClient();
        admin.DefaultRequestHeaders.Add(TestAuthHandler.RolesHeader, CrmRoles.Admin);
        admin.DefaultRequestHeaders.Add(TestAuthHandler.UserHeader, "partial-replay");
        admin.DefaultRequestHeaders.Add("X-CSRF", "1");
        var messages = new[]
        {
            new { module = "customers", id = customer.Id, replays = 0 },
            new { module = "sales", id = sales.Id, replays = 0 },
            new { module = "integration", id = integration.Id, replays = 0 },
        };
        var response = await admin.PostAsJsonAsync($"{Outbox}/replay", new { messages, expected = 3, reason = "DEV-17 partial commit simulation" }, Ct);
        response.StatusCode.ShouldBe(HttpStatusCode.Conflict);
        var body = await response.ReadJsonAsync();
        body.GetProperty("code").GetString().ShouldBe("OUTBOX_REPLAY_PARTIAL");
        var results = body.GetProperty("items").EnumerateArray().ToDictionary(i => i.GetProperty("id").GetGuid(), i => i.GetProperty("status").GetString());
        results[customer.Id].ShouldBe("Requested");
        results[sales.Id].ShouldBe("Unknown");
        results[integration.Id].ShouldBe("NotRequested");
        (await ReplayRecordAsync(customer.Id)).Request.Expected.ShouldBe(1);
        await using var verify = factory.Services.CreateAsyncScope();
        (await verify.ServiceProvider.GetRequiredService<SalesDbContext>().OutboxReplayRequests.CountAsync(r => r.MessageIds.Contains(sales.Id.ToString()), Ct)).ShouldBe(0);
        (await verify.ServiceProvider.GetRequiredService<IntegrationDbContext>().OutboxReplayRequests.CountAsync(r => r.MessageIds.Contains(integration.Id.ToString()), Ct)).ShouldBe(0);
    }

    private sealed class RefuseReplaySave(Guid messageId) : SaveChangesInterceptor
    {
        public override ValueTask<InterceptionResult<int>> SavingChangesAsync(DbContextEventData eventData, InterceptionResult<int> result,
            CancellationToken cancellationToken = default)
        {
            if (eventData.Context is SalesDbContext db && db.ChangeTracker.Entries<OutboxReplayRequest>()
                .Any(e => e.State == EntityState.Added && e.Entity.MessageIds.Contains(messageId.ToString(), StringComparison.Ordinal)))
                throw new InvalidOperationException("Synthetic second-module write failure.");
            return ValueTask.FromResult(result);
        }
    }

    [Fact]
    public async Task Two_workers_after_an_expired_lease_draft_one_contract_and_queue_one_charge()
    {
        var (id, quoteId) = await QuoteAcceptedAsync("AC02");
        var first = Processor();
        var second = Processor();

        var firstToken = (await ClaimAsync(first, Sales, id)).ShouldNotBeNull();
        (await ClaimAsync(second, Sales, id)).ShouldBeNull();
        // The first worker stalls past its lease; the second takes the message over and both deliver at the same time.
        await ExpireLeaseAsync(Sales, id);
        var secondToken = (await ClaimAsync(second, Sales, id)).ShouldNotBeNull();

        var results = await Task.WhenAll(
            first.DeliverAsync(Sales, id, firstToken, Ct),
            second.DeliverAsync(Sales, id, secondToken, Ct));

        results.ShouldBe([false, true]);
        (await MessageAsync(Sales, id)).Status.ShouldBe(OutboxStatus.Processed);
        (await ContractsOfQuoteAsync(quoteId)).ShouldBe(1);
        (await ChargesOfQuoteAsync(quoteId)).ShouldBe(1);
    }

    [Fact]
    public async Task Hours_consumed_for_one_approval_by_two_workers_at_once_are_booked_once()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "outbox-hours");
        var marker = $"H{Guid.NewGuid():N}"[..8];
        var organizationId = await admin.CreateOrganizationAsync(TestData.Organization($"{marker} Timer AS"));
        var bankId = (await (await admin.PostAsJsonAsync("/api/v1/contracts/hour-banks", new
        {
            organizationId, name = $"{marker} 10 t", hours = 10m, validFrom = new DateOnly(2026, 1, 1),
        }, Ct)).ReadJsonAsync()).GetProperty("id").GetGuid();
        var source = $"{Guid.NewGuid()}:1:{bankId}";

        async Task ConsumeAsync()
        {
            await using var scope = factory.Services.CreateAsyncScope();
            await scope.ServiceProvider.GetRequiredService<IContractsApi>()
                .ConsumeHoursAsync(bankId, 2.5m, new DateOnly(2026, 10, 1), "Feilsøking", "TimeEntry", source, Ct);
        }

        await Task.WhenAll(ConsumeAsync(), ConsumeAsync(), ConsumeAsync());

        await using var check = factory.Services.CreateAsyncScope();
        var contracts = check.ServiceProvider.GetRequiredService<ContractsDbContext>();
        (await contracts.HourBankEntries.CountAsync(e => e.SourceType == "TimeEntry" && e.SourceId == source, Ct)).ShouldBe(1);
        (await contracts.HourBanks.AsNoTracking().SingleAsync(b => b.Id == bankId, Ct)).RemainingHours.ShouldBe(7.5m);
    }

    [Fact]
    public async Task After_handler_A_succeeded_and_B_failed_the_retry_runs_only_B()
    {
        var probe = Guid.NewGuid();
        factory.Probes.FailB(probe, 1);
        var id = await ProbeAsync(probe);
        var processor = Processor();

        (await DeliverOnceAsync(processor, Customers, id)).ShouldBeFalse();
        var first = await MessageAsync(Customers, id);
        first.Status.ShouldBe(OutboxStatus.Pending);
        first.Attempts.ShouldBe(1);
        first.NextAttemptAt.ShouldNotBeNull();
        first.DeliveredHandlers.ShouldBe(typeof(DeliveryProbeHandlerA).FullName);
        (await EffectsAsync(probe, DeliveryProbes.EffectA)).ShouldBe(1);
        (await EffectsAsync(probe, DeliveryProbes.EffectB)).ShouldBe(0);

        (await DeliverOnceAsync(processor, Customers, id)).ShouldBeTrue();
        var done = await MessageAsync(Customers, id);
        done.Status.ShouldBe(OutboxStatus.Processed);
        done.Attempts.ShouldBe(2);
        done.LastError.ShouldBeNull();
        factory.Probes.Runs(probe, DeliveryProbes.EffectA).ShouldBe(1);
        factory.Probes.Runs(probe, DeliveryProbes.EffectB).ShouldBe(2);
        (await EffectsAsync(probe, DeliveryProbes.EffectA)).ShouldBe(1);
        (await EffectsAsync(probe, DeliveryProbes.EffectB)).ShouldBe(1);
    }

    [Fact]
    public async Task Late_or_replayed_phase_events_follow_the_phase_as_it_is_now()
    {
        var sales = factory.ClientAs(CrmRoles.Sales, userKey: "outbox-projects");
        var marker = $"F{Guid.NewGuid():N}"[..10];
        var today = DateOnly.FromDateTime(DateTime.UtcNow).ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture);
        var organizationId = await sales.CreateOrganizationAsync(new { name = $"{marker} Fase AS", orgNumber = TestData.OrgNumber(), status = "Customer" });
        var projectId = (await (await sales.PostAsJsonAsync("/api/v1/projects", new
        {
            organizationId, name = $"{marker} Utrulling", type = "AteraRollout", billingModel = "PerPhase", startDate = today, endDate = (string?)null,
            budgetHours = 10m, budgetAmount = 10_000m,
        }, Ct)).ReadJsonAsync()).GetProperty("id").GetGuid();
        var phaseId = (await (await sales.PostAsJsonAsync($"/api/v1/projects/{projectId}/phases", new
        {
            name = "Fase 1", plannedStart = today, plannedEnd = (string?)null, plannedHours = 5m, fee = 10_000m, billOnCompletion = true, productId = (Guid?)null,
        }, Ct)).ReadJsonAsync()).GetProperty("phases").EnumerateArray().Single().GetProperty("id").GetGuid();
        var processor = Processor();

        async Task SetStatusAsync(string status) =>
            (await sales.PostAsJsonAsync($"/api/v1/projects/{projectId}/phases/{phaseId}/status", new { status }, Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);

        async Task<Guid> NewestAsync(string eventType)
        {
            await using var scope = factory.Services.CreateAsyncScope();
            return await scope.ServiceProvider.GetRequiredService<Crm.Projects.Persistence.ProjectsDbContext>().OutboxMessages.AsNoTracking()
                .Where(m => m.Type.Contains(eventType) && m.Payload.Contains(phaseId.ToString()))
                .OrderByDescending(m => m.OccurredAt).Select(m => m.Id).FirstAsync(Ct);
        }

        // An old message delivered again, as a retry or a replay would: same payload, the event's own time inside it.
        async Task<Guid> StaleCopyAsync(Guid id)
        {
            await using var scope = factory.Services.CreateAsyncScope();
            var db = scope.ServiceProvider.GetRequiredService<Crm.Projects.Persistence.ProjectsDbContext>();
            var original = await db.OutboxMessages.AsNoTracking().SingleAsync(m => m.Id == id, Ct);
            var copy = new OutboxMessage { Id = SequentialId.New(DateTimeOffset.UtcNow), Type = original.Type, Payload = original.Payload, OccurredAt = original.OccurredAt };
            db.OutboxMessages.Add(copy);
            await db.SaveChangesAsync(Ct);
            return copy.Id;
        }

        async Task<Crm.Billing.Domain.PendingCharge?> ChargeAsync()
        {
            await using var scope = factory.Services.CreateAsyncScope();
            return await scope.ServiceProvider.GetRequiredService<BillingDbContext>().PendingCharges.IgnoreQueryFilters().AsNoTracking()
                .SingleOrDefaultAsync(c => c.SourceType == "project-phase" && c.SourceLineId == phaseId, Ct);
        }

        var projects = typeof(Crm.Projects.Persistence.ProjectsDbContext);

        // Completed and reopened before Billing heard of either, and the reopening arrives first: nothing is queued.
        await SetStatusAsync("Completed");
        var billable1 = await NewestAsync("ProjectPhaseBillable");
        await SetStatusAsync("Active");
        var cancelled1 = await NewestAsync("ProjectPhaseBillingCancelled");
        (await DeliverOnceAsync(processor, projects, cancelled1)).ShouldBeTrue();
        (await DeliverOnceAsync(processor, projects, billable1)).ShouldBeTrue();
        (await ChargeAsync()).ShouldBeNull();

        // Completed again: the fee waits for the next run.
        await SetStatusAsync("Completed");
        var billable2 = await NewestAsync("ProjectPhaseBillable");
        (await DeliverOnceAsync(processor, projects, billable2)).ShouldBeTrue();
        (await ChargeAsync()).ShouldNotBeNull().IsDeleted.ShouldBeFalse();

        // The old reopening, delivered after the newer completion, takes nothing back.
        (await DeliverOnceAsync(processor, projects, await StaleCopyAsync(cancelled1))).ShouldBeTrue();
        (await ChargeAsync()).ShouldNotBeNull().IsDeleted.ShouldBeFalse();

        // Reopened again: the charge is withdrawn, and the old completion, delivered once more, does not bring it back.
        await SetStatusAsync("Active");
        (await DeliverOnceAsync(processor, projects, await NewestAsync("ProjectPhaseBillingCancelled"))).ShouldBeTrue();
        (await ChargeAsync()).ShouldNotBeNull().IsDeleted.ShouldBeTrue();
        (await DeliverOnceAsync(processor, projects, await StaleCopyAsync(billable2))).ShouldBeTrue();
        var withdrawn = (await ChargeAsync()).ShouldNotBeNull();
        withdrawn.IsDeleted.ShouldBeTrue();
        withdrawn.InvoicedBasisId.ShouldBeNull();
    }

    [Fact]
    public async Task A_handler_that_changes_a_second_module_fails_and_keeps_nothing_of_the_first()
    {
        var probe = Guid.NewGuid();
        Guid id;
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<CustomersDbContext>();
            var message = OutboxMessage.For(new CrossModuleProbe(probe), DateTimeOffset.UtcNow, null);
            db.OutboxMessages.Add(message);
            await db.SaveChangesAsync(Ct);
            id = message.Id;
        }

        (await DeliverOnceAsync(Processor(), Customers, id)).ShouldBeFalse();

        var failed = await MessageAsync(Customers, id);
        failed.Status.ShouldBe(OutboxStatus.Pending);
        failed.LastError.ShouldNotBeNull().ShouldContain("CrossModuleProbeHandler: InvalidOperationException");
        await using var check = factory.Services.CreateAsyncScope();
        var audit = check.ServiceProvider.GetRequiredService<CustomersDbContext>().AuditEntries;
        (await audit.CountAsync(a => a.EntityType == nameof(CrossModuleProbe) && a.EntityId == probe, Ct)).ShouldBe(0);
        (await check.ServiceProvider.GetRequiredService<CustomersDbContext>().InboxReceipts.CountAsync(r => r.MessageId == id, Ct)).ShouldBe(0);
        await DeadLetterAsync(id);
    }

    [Fact]
    public async Task A_worker_that_stops_after_the_business_commit_but_before_the_acknowledgement_causes_no_second_effect()
    {
        var (id, quoteId) = await QuoteAcceptedAsync("AC04");
        var processor = Processor();
        (await DeliverOnceAsync(processor, Sales, id)).ShouldBeTrue();
        (await ContractsOfQuoteAsync(quoteId)).ShouldBe(1);
        (await ChargesOfQuoteAsync(quoteId)).ShouldBe(1);

        // What a crash between the handlers' commits and the acknowledgement leaves behind: the contract, the charge and the
        // receipts are committed, the message itself still says that nothing happened.
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            await scope.ServiceProvider.GetRequiredService<SalesDbContext>().OutboxMessages.Where(m => m.Id == id)
                .ExecuteUpdateAsync(s => s
                    .SetProperty(m => m.Status, OutboxStatus.Pending)
                    .SetProperty(m => m.ProcessedAt, (DateTimeOffset?)null)
                    .SetProperty(m => m.DeliveredHandlers, (string?)null)
                    .SetProperty(m => m.Attempts, 0)
                    .SetProperty(m => m.LockedUntil, (DateTimeOffset?)null)
                    .SetProperty(m => m.LeaseOwner, (Guid?)null), Ct);
        }

        (await DeliverOnceAsync(processor, Sales, id)).ShouldBeTrue();
        var redelivered = await MessageAsync(Sales, id);
        redelivered.Status.ShouldBe(OutboxStatus.Processed);
        redelivered.Attempts.ShouldBe(1);
        (await ContractsOfQuoteAsync(quoteId)).ShouldBe(1);
        (await ChargesOfQuoteAsync(quoteId)).ShouldBe(1);

        // Each handler holds one receipt, in its own module, written in the transaction of its change.
        await using var check = factory.Services.CreateAsyncScope();
        (await check.ServiceProvider.GetRequiredService<ContractsDbContext>().InboxReceipts.Where(r => r.MessageId == id).Select(r => r.Handler).ToListAsync(Ct))
            .ShouldBe(["Crm.Contracts.Features.QuoteAcceptedHandler"]);
        (await check.ServiceProvider.GetRequiredService<BillingDbContext>().InboxReceipts.Where(r => r.MessageId == id).Select(r => r.Handler).ToListAsync(Ct))
            .ShouldBe(["Crm.Billing.Features.QuoteAcceptedChargeHandler"]);
    }

    [Fact]
    public async Task A_worker_whose_lease_was_taken_over_can_neither_finish_nor_release_the_message()
    {
        var probe = Guid.NewGuid();
        var id = await ProbeAsync(probe);
        var old = Processor();
        var current = Processor();
        var oldToken = (await ClaimAsync(old, Customers, id)).ShouldNotBeNull();
        await ExpireLeaseAsync(Customers, id);
        var newToken = (await ClaimAsync(current, Customers, id)).ShouldNotBeNull();
        var held = await MessageAsync(Customers, id);

        (await old.DeliverAsync(Customers, id, oldToken, Ct)).ShouldBeFalse();

        var after = await MessageAsync(Customers, id);
        after.Status.ShouldBe(OutboxStatus.Processing);
        after.LeaseOwner.ShouldBe(newToken);
        after.LockedUntil.ShouldBe(held.LockedUntil);
        after.ProcessedAt.ShouldBeNull();
        after.DeliveredHandlers.ShouldBeNull();
        after.Attempts.ShouldBe(0);

        (await current.DeliverAsync(Customers, id, newToken, Ct)).ShouldBeTrue();
        (await MessageAsync(Customers, id)).Status.ShouldBe(OutboxStatus.Processed);
        (await EffectsAsync(probe, DeliveryProbes.EffectA)).ShouldBe(1);
        (await EffectsAsync(probe, DeliveryProbes.EffectB)).ShouldBe(1);
    }

    [Fact]
    public async Task A_worker_whose_lease_was_taken_over_cannot_record_its_failure_either()
    {
        var probe = Guid.NewGuid();
        factory.Probes.FailB(probe, 1);
        var id = await ProbeAsync(probe);
        var processor = Processor();
        (await DeliverOnceAsync(processor, Customers, id)).ShouldBeFalse();

        // A is done; B failed once. The old worker tries B again and fails, the new worker holds the message meanwhile.
        var old = Processor();
        var current = Processor();
        var oldToken = (await ClaimAsync(old, Customers, id)).ShouldNotBeNull();
        await ExpireLeaseAsync(Customers, id);
        var newToken = (await ClaimAsync(current, Customers, id)).ShouldNotBeNull();
        var held = await MessageAsync(Customers, id);
        factory.Probes.FailB(probe, 1);

        (await old.DeliverAsync(Customers, id, oldToken, Ct)).ShouldBeFalse();

        var after = await MessageAsync(Customers, id);
        after.Status.ShouldBe(OutboxStatus.Processing);
        after.LeaseOwner.ShouldBe(newToken);
        after.LockedUntil.ShouldBe(held.LockedUntil);
        after.Attempts.ShouldBe(1);
        after.NextAttemptAt.ShouldBe(held.NextAttemptAt);

        (await current.DeliverAsync(Customers, id, newToken, Ct)).ShouldBeTrue();
        (await EffectsAsync(probe, DeliveryProbes.EffectA)).ShouldBe(1);
        (await EffectsAsync(probe, DeliveryProbes.EffectB)).ShouldBe(1);
    }

    [Fact]
    public async Task A_long_handler_keeps_its_lease_and_nobody_else_takes_the_message_meanwhile()
    {
        var probe = Guid.NewGuid();
        factory.Probes.PauseA(probe, TimeSpan.FromSeconds(7));
        var id = await ProbeAsync(probe);
        var worker = Processor(lease: TimeSpan.FromSeconds(3));
        var other = Processor(lease: TimeSpan.FromSeconds(3));
        var token = (await ClaimAsync(worker, Customers, id)).ShouldNotBeNull();

        var delivery = worker.DeliverAsync(Customers, id, token, Ct);
        var refused = 0;
        while (!delivery.IsCompleted)
        {
            (await ClaimAsync(other, Customers, id)).ShouldBeNull();
            refused++;
            await Task.Delay(500, Ct);
        }

        (await delivery).ShouldBeTrue();
        refused.ShouldBeGreaterThan(8);
        (await MessageAsync(Customers, id)).Status.ShouldBe(OutboxStatus.Processed);
        (await EffectsAsync(probe, DeliveryProbes.EffectA)).ShouldBe(1);
    }

    [Fact]
    public async Task A_worker_that_loses_its_lease_midway_stops_and_its_uncommitted_work_is_rolled_back()
    {
        var probe = Guid.NewGuid();
        factory.Probes.PauseA(probe, TimeSpan.FromSeconds(30));
        var id = await ProbeAsync(probe);
        var worker = Processor(lease: TimeSpan.FromSeconds(3));
        var token = (await ClaimAsync(worker, Customers, id)).ShouldNotBeNull();

        var delivery = worker.DeliverAsync(Customers, id, token, Ct);
        await Task.Delay(1500, Ct);
        var thief = Guid.NewGuid();
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            await scope.ServiceProvider.GetRequiredService<CustomersDbContext>().OutboxMessages.Where(m => m.Id == id)
                .ExecuteUpdateAsync(s => s.SetProperty(m => m.LeaseOwner, thief), Ct);
        }

        (await delivery.WaitAsync(TimeSpan.FromSeconds(20), Ct)).ShouldBeFalse();
        (await EffectsAsync(probe, DeliveryProbes.EffectA)).ShouldBe(0);
        var row = await MessageAsync(Customers, id);
        row.LeaseOwner.ShouldBe(thief);
        row.Status.ShouldBe(OutboxStatus.Processing);

        // The new holder's lease runs out without a result: the message is delivered, once.
        factory.Probes.PauseA(probe, TimeSpan.Zero);
        await ExpireLeaseAsync(Customers, id);
        (await DeliverOnceAsync(Processor(), Customers, id)).ShouldBeTrue();
        (await EffectsAsync(probe, DeliveryProbes.EffectA)).ShouldBe(1);
        (await EffectsAsync(probe, DeliveryProbes.EffectB)).ShouldBe(1);
    }

    [Fact]
    public async Task A_paused_integration_keeps_its_queue_untouched_until_it_is_resumed()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "outbox-pause");
        var job = factory.Services.GetRequiredService<OutboundProcessorJob>();
        Guid operationId;
        (await admin.PostAsJsonAsync("/api/v1/integrations/atera/pause", new { paused = true, reason = "DEV-07 queue test" }, Ct))
            .StatusCode.ShouldBe(HttpStatusCode.OK);
        try
        {
            await using (var scope = factory.Services.CreateAsyncScope())
            {
                operationId = (await scope.ServiceProvider.GetRequiredService<OutboundQueue>()
                    .EnqueueAsync("atera", "dev07-probe", EntityTypes.Organization, Guid.NewGuid(), null, Ct)).Id;
            }

            await job.RunAsync(Ct);
            await job.RunAsync(Ct);
            var waiting = await OperationAsync(operationId);
            waiting.Status.ShouldBe(OutboundStatus.Pending);
            waiting.Attempts.ShouldBe(0);
            waiting.LockedUntil.ShouldBeNull();
            waiting.LeaseOwner.ShouldBeNull();
        }
        finally
        {
            (await admin.PostAsJsonAsync("/api/v1/integrations/atera/pause", new { paused = false, reason = (string?)null }, Ct))
                .StatusCode.ShouldBe(HttpStatusCode.OK);
        }

        await job.RunAsync(Ct);
        var ran = await OperationAsync(operationId);
        ran.Attempts.ShouldBe(1);
        ran.Status.ShouldBe(OutboundStatus.Failed);
        ran.LastError.ShouldBe("Outbound operation failed (PermanentOutboundException).");
        ran.LeaseOwner.ShouldBeNull();

        // Sending it back and withdrawing it are a person's decisions, recorded with the change.
        var queue = await admin.GetFromJsonAsync<JsonElement>("/api/v1/integrations/outbound?system=atera&limit=200", Ct);
        var operationEtag = queue.GetProperty("items").EnumerateArray().Single(o => o.GetProperty("id").GetGuid() == operationId).GetProperty("etag").GetString()!;
        using var retryRequest = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/integrations/outbound/{operationId}/retry")
        {
            Content = JsonContent.Create(new { reason = "Fixed the synthetic delivery failure" }),
        };
        retryRequest.Headers.TryAddWithoutValidation("If-Match", operationEtag);
        (await admin.SendAsync(retryRequest, Ct)).StatusCode.ShouldBe(HttpStatusCode.NoContent);
        var retried = await OperationAsync(operationId);
        retried.Status.ShouldBe(OutboundStatus.Pending);
        retried.Attempts.ShouldBe(0);

        // While a run holds the operation, it cannot be withdrawn under that run.
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            await scope.ServiceProvider.GetRequiredService<IntegrationDbContext>().OutboundOperations.Where(o => o.Id == operationId)
                .ExecuteUpdateAsync(s => s.SetProperty(o => o.LockedUntil, DateTimeOffset.UtcNow.AddMinutes(5)).SetProperty(o => o.LeaseOwner, Guid.NewGuid()), Ct);
        }

        var running = await admin.PostAsync($"/api/v1/integrations/outbound/{operationId}/cancel", null, Ct);
        running.StatusCode.ShouldBe(HttpStatusCode.Conflict);
        (await running.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe("INT_OUTBOUND_RUNNING");
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            await scope.ServiceProvider.GetRequiredService<IntegrationDbContext>().OutboundOperations.Where(o => o.Id == operationId)
                .ExecuteUpdateAsync(s => s.SetProperty(o => o.LockedUntil, (DateTimeOffset?)null).SetProperty(o => o.LeaseOwner, (Guid?)null), Ct);
        }

        (await admin.PostAsync($"/api/v1/integrations/outbound/{operationId}/cancel", null, Ct)).StatusCode.ShouldBe(HttpStatusCode.NoContent);
        (await OperationAsync(operationId)).Status.ShouldBe(OutboundStatus.Cancelled);
        await using var check = factory.Services.CreateAsyncScope();
        var audit = await check.ServiceProvider.GetRequiredService<IntegrationDbContext>().AuditEntries.AsNoTracking()
            .Where(a => a.EntityType == nameof(OutboundOperation) && a.EntityId == operationId).OrderBy(a => a.Id).ToListAsync(Ct);
        audit.Select(a => a.Action).ShouldBe([AuditActions.Replay, AuditActions.Cancel]);
        audit.ShouldAllBe(a => a.UserName != null && a.UserName.Contains("outbox-pause"));
    }

    [Fact]
    public async Task A_bulk_replay_is_limited_authorized_confirmed_and_audited()
    {
        var probes = Enumerable.Range(0, 3).Select(_ => Guid.NewGuid()).ToList();
        var ids = new List<Guid>();
        foreach (var probe in probes)
        {
            ids.Add(await DeadLetterAsync(await ProbeAsync(probe)));
        }

        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "outbox-bulk");
        var finance = factory.ClientAs(CrmRoles.Finance, userKey: "outbox-finance");
        var messages = ids.Select(id => new { module = "customers", id, replays = 0 }).ToArray();
        var body = new { messages, reason = "Replay after the DEV-07 bulk test", expected = 3 };

        (await finance.GetAsync(Outbox, Ct)).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        (await finance.PostAsJsonAsync($"{Outbox}/replay", body, Ct)).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        var withoutCsrf = await factory.ClientAs(CrmRoles.Admin, userKey: "outbox-bulk", csrf: false).PostAsJsonAsync($"{Outbox}/replay", body, Ct);
        withoutCsrf.StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        (await withoutCsrf.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe("CSRF_HEADER_REQUIRED");

        var tooMany = Enumerable.Range(0, OutboxReplayRequest.MaxMessages + 1).Select(_ => new { module = "customers", id = Guid.NewGuid(), replays = 0 }).ToArray();
        await ShouldRefuseAsync(admin, new { messages = tooMany, reason = body.reason, expected = tooMany.Length }, HttpStatusCode.BadRequest, "OUTBOX_REPLAY_LIMIT");
        await ShouldRefuseAsync(admin, new { messages, reason = "  ", expected = 3 }, HttpStatusCode.BadRequest, "OUTBOX_REPLAY_REASON");
        await ShouldRefuseAsync(admin, new { messages = new[] { new { module = "nowhere", id = ids[0], replays = 0 } }, reason = body.reason, expected = 1 },
            HttpStatusCode.BadRequest, "OUTBOX_UNKNOWN_MODULE");
        await ShouldRefuseAsync(admin, new { messages = new[] { new { module = "customers", id = ids[0] } }, reason = body.reason, expected = 1 },
            HttpStatusCode.Conflict, "OUTBOX_REPLAY_STALE");
        await ShouldRefuseAsync(admin, new { messages = new[] { new { module = "customers", id = ids[0], replays = 1 } }, reason = body.reason, expected = 1 },
            HttpStatusCode.Conflict, "OUTBOX_REPLAY_STALE");
        // The person confirmed a different number than what is selected: nothing is requested.
        await ShouldRefuseAsync(admin, body with { expected = 2 }, HttpStatusCode.Conflict, "OUTBOX_REPLAY_STALE");

        var accepted = await admin.PostAsJsonAsync($"{Outbox}/replay", body, Ct);
        accepted.StatusCode.ShouldBe(HttpStatusCode.Accepted);
        (await accepted.ReadJsonAsync()).GetProperty("requested").GetInt32().ShouldBe(3);

        var (request, audit) = await ReplayRecordAsync(ids[0]);
        request.Expected.ShouldBe(3);
        request.MessageIds.Split(',').Select(Guid.Parse).ShouldBe(ids, ignoreOrder: true);
        audit.Action.ShouldBe(AuditActions.Replay);
        audit.UserName.ShouldNotBeNull().ShouldContain("outbox-bulk");
        audit.Changes.ShouldNotBeNull().ShouldContain("Replay after the DEV-07 bulk test");
        foreach (var id in ids)
        {
            audit.Changes.ShouldContain(id.ToString());
        }

        var processor = Processor();
        foreach (var id in ids)
        {
            await ApplyAndDeliverAsync(processor, Customers, id);
            var delivered = await MessageAsync(Customers, id);
            delivered.Status.ShouldBe(OutboxStatus.Processed);
            delivered.Replays.ShouldBe(1);
        }

        foreach (var probe in probes)
        {
            (await EffectsAsync(probe, DeliveryProbes.EffectA)).ShouldBe(1);
            (await EffectsAsync(probe, DeliveryProbes.EffectB)).ShouldBe(1);
        }
    }

    [Fact]
    public async Task A_handler_failure_keeps_money_and_personal_values_out_of_operator_diagnostics_and_logs()
    {
        const string confidential = "Customer-secret 947321.87 NOK";
        var probe = Guid.NewGuid();
        factory.Probes.FailB(probe, 1);
        var id = await ProbeAsync(probe, confidential);
        var logger = new CapturingLogger<OutboxProcessor>();
        await DeliverOnceAsync(Processor(logger: logger), Customers, id);
        var failed = await MessageAsync(Customers, id);
        failed.LastError.ShouldBe("DeliveryProbeHandlerB: InvalidOperationException");
        string.Join('\n', logger.Lines).ShouldNotContain(confidential);
        string.Join('\n', logger.Lines).ShouldNotContain("947321.87");
    }

    [Fact]
    public async Task A_corrupt_payload_is_quarantined_without_blocking_the_rest_and_without_personal_data_in_the_logs()
    {
        const string personal = "ola.nordmann@example.com";
        var probe = Guid.NewGuid();
        var now = DateTimeOffset.UtcNow;
        // A round takes the oldest due messages of the shared outbox. Dated before anything the other classes of this run
        // left pending, the three below are in that first batch however many messages those classes wrote.
        var past = now.AddHours(-3);
        var probeType = $"{typeof(DeliveryProbe).FullName}, {typeof(DeliveryProbe).Assembly.GetName().Name}";
        var corrupt = new OutboxMessage
        {
            Id = SequentialId.New(now),
            Type = probeType,
            Payload = $$"""{"probeId":"{{personal}}","note":"{{personal}}"}""",
            OccurredAt = past.AddMinutes(-10),
        };
        var unknown = new OutboxMessage
        {
            Id = SequentialId.New(now),
            Type = "Crm.Nowhere.RemovedEvent, Crm.Nowhere",
            Payload = $$"""{"email":"{{personal}}"}""",
            OccurredAt = past.AddMinutes(-9),
        };
        var healthy = OutboxMessage.For(new DeliveryProbe(probe, "healthy") { OccurredAt = past }, now, null);
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<CustomersDbContext>();
            db.OutboxMessages.AddRange(corrupt, unknown, healthy);
            await db.SaveChangesAsync(Ct);
        }

        var logger = new CapturingLogger<OutboxProcessor>();
        var processor = Processor(logger: logger);

        // One round of the worker's loop: the unreadable message is older, and the healthy one is delivered anyway.
        await processor.ProcessContextAsync(Customers, Ct);
        var quarantined = await MessageAsync(Customers, corrupt.Id);
        quarantined.Status.ShouldBe(OutboxStatus.Quarantined);
        quarantined.Attempts.ShouldBe(1);
        quarantined.DeadLetteredAt.ShouldNotBeNull();
        quarantined.LastError.ShouldBe("The payload is not a readable DeliveryProbe (at $.probeId).");
        (await MessageAsync(Customers, healthy.Id)).Status.ShouldBe(OutboxStatus.Processed);
        (await EffectsAsync(probe, DeliveryProbes.EffectA)).ShouldBe(1);

        // A type this image does not know may be known to the next one: retried, then quarantined.
        var unknownRow = await MessageAsync(Customers, unknown.Id);
        unknownRow.Status.ShouldBe(OutboxStatus.Pending);
        unknownRow.Attempts.ShouldBe(1);
        for (var attempt = 1; attempt < OutboxMessage.MaxAttempts; attempt++)
        {
            (await DeliverOnceAsync(processor, Customers, unknown.Id)).ShouldBeFalse();
        }

        var parked = await MessageAsync(Customers, unknown.Id);
        parked.Status.ShouldBe(OutboxStatus.Quarantined);
        parked.Attempts.ShouldBe(OutboxMessage.MaxAttempts);

        // Nothing of either payload reached the log; the quarantine is still diagnosable by id and position.
        logger.Lines.ShouldNotBeEmpty();
        logger.Lines.ShouldAllBe(line => !line.Contains(personal, StringComparison.OrdinalIgnoreCase) && !line.Contains("ola.nordmann", StringComparison.OrdinalIgnoreCase));
        logger.Lines.ShouldContain(line => line.Contains(corrupt.Id.ToString()) && line.Contains("$.probeId"));

        // Nor does the administrators' list show it: field names only.
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "outbox-admin");
        var listed = await admin.GetFromJsonAsync<JsonElement>($"{Outbox}?module=customers&status=Quarantined", Ct);
        listed.GetRawText().ShouldNotContain(personal);
        listed.GetProperty("items").EnumerateArray().Single(i => i.GetProperty("id").GetGuid() == corrupt.Id)
            .GetProperty("payloadFields").EnumerateArray().Select(f => f.GetString()).ShouldBe(["probeId", "note"]);
    }

    [Fact]
    public async Task Rows_from_before_get_an_explicit_state_and_exhausted_ones_become_dead_letters_without_a_replay()
    {
        var now = DateTimeOffset.UtcNow;
        OutboxMessage Legacy(int attempts, DateTimeOffset? processedAt) => new()
        {
            Id = SequentialId.New(now),
            Type = $"{typeof(DeliveryProbe).FullName}, {typeof(DeliveryProbe).Assembly.GetName().Name}",
            Payload = JsonSerializer.Serialize(new DeliveryProbe(Guid.NewGuid(), "legacy"), JsonSerializerOptions.Web),
            OccurredAt = now.AddDays(-2),
            Attempts = attempts,
            ProcessedAt = processedAt,
            LastError = attempts > 0 ? "older image" : null,
        };

        var exhausted = Legacy(OutboxMessage.MaxAttempts, null);
        var delivered = Legacy(1, now.AddDays(-1));
        var waiting = Legacy(3, null);
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<CustomersDbContext>();
            db.OutboxMessages.AddRange(exhausted, delivered, waiting);
            await db.SaveChangesAsync(Ct);
            // An older image left a lease on the exhausted one.
            await db.OutboxMessages.Where(m => m.Id == exhausted.Id).ExecuteUpdateAsync(s => s.SetProperty(m => m.LockedUntil, now.AddMinutes(-30)), Ct);
        }

        await factory.AdminSqlAsync(OutboxMigrationSql.Backfill(CustomersDbContext.SchemaName));
        // Running it again changes nothing.
        await factory.AdminSqlAsync(OutboxMigrationSql.Backfill(CustomersDbContext.SchemaName));

        var dead = await MessageAsync(Customers, exhausted.Id);
        dead.Status.ShouldBe(OutboxStatus.DeadLetter);
        dead.Attempts.ShouldBe(OutboxMessage.MaxAttempts);
        dead.DeadLetteredAt.ShouldNotBeNull();
        dead.LockedUntil.ShouldBeNull();
        (await MessageAsync(Customers, delivered.Id)).Status.ShouldBe(OutboxStatus.Processed);
        var pending = await MessageAsync(Customers, waiting.Id);
        pending.Status.ShouldBe(OutboxStatus.Pending);
        pending.Attempts.ShouldBe(3);
        (await ClaimAsync(Processor(), Customers, exhausted.Id)).ShouldBeNull();
        (await ClaimAsync(Processor(), Customers, delivered.Id)).ShouldBeNull();
    }

    [Fact]
    public async Task Retention_removes_old_deliveries_and_receipts_but_keeps_what_a_replay_may_still_need()
    {
        var now = DateTimeOffset.UtcNow;
        var oldDelivered = OutboxMessage.For(new DeliveryProbe(Guid.NewGuid(), "old"), now.AddDays(-40), null);
        var recentDelivered = OutboxMessage.For(new DeliveryProbe(Guid.NewGuid(), "recent"), now.AddDays(-2), null);
        var oldDead = OutboxMessage.For(new DeliveryProbe(Guid.NewGuid(), "dead"), now.AddDays(-400), null);
        oldDelivered.Status = OutboxStatus.Processed;
        oldDelivered.ProcessedAt = now.AddDays(-35);
        recentDelivered.Status = OutboxStatus.Processed;
        recentDelivered.ProcessedAt = now.AddDays(-1);
        oldDead.Status = OutboxStatus.DeadLetter;
        oldDead.Attempts = OutboxMessage.MaxAttempts;
        oldDead.DeadLetteredAt = now.AddDays(-399);
        var expiredReceipt = new InboxReceipt { MessageId = Guid.NewGuid(), Handler = "Retention.Expired", ProcessedAt = now.AddDays(-200) };
        var receiptOfDeadLetter = new InboxReceipt { MessageId = oldDead.Id, Handler = "Retention.StillNeeded", ProcessedAt = now.AddDays(-399) };
        var recentReceipt = new InboxReceipt { MessageId = Guid.NewGuid(), Handler = "Retention.Recent", ProcessedAt = now.AddDays(-10) };
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<CustomersDbContext>();
            db.OutboxMessages.AddRange(oldDelivered, recentDelivered, oldDead);
            db.InboxReceipts.AddRange(expiredReceipt, receiptOfDeadLetter, recentReceipt);
            await db.SaveChangesAsync(Ct);
        }

        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var result = await scope.ServiceProvider.GetRequiredService<OutboxRetentionJob>().RunAsync(Ct);
            result.Messages.ShouldBeGreaterThanOrEqualTo(1);
            result.Receipts.ShouldBeGreaterThanOrEqualTo(1);
        }

        await using var check = factory.Services.CreateAsyncScope();
        var customers = check.ServiceProvider.GetRequiredService<CustomersDbContext>();
        var left = await customers.OutboxMessages.Where(m => m.Id == oldDelivered.Id || m.Id == recentDelivered.Id || m.Id == oldDead.Id).Select(m => m.Id).ToListAsync(Ct);
        left.ShouldBe([recentDelivered.Id, oldDead.Id], ignoreOrder: true);
        var receipts = await customers.InboxReceipts.Where(r => r.Handler.StartsWith("Retention.")).Select(r => r.Handler).ToListAsync(Ct);
        receipts.ShouldBe(["Retention.StillNeeded", "Retention.Recent"], ignoreOrder: true);
    }

    private OutboxProcessor Processor(TimeSpan? lease = null, ILogger<OutboxProcessor>? logger = null)
    {
        var options = Options.Create(new OutboxOptions { RetryBaseDelay = TimeSpan.Zero, Lease = lease ?? TimeSpan.FromMinutes(2) });
        return logger is null
            ? ActivatorUtilities.CreateInstance<OutboxProcessor>(factory.Services, options)
            : ActivatorUtilities.CreateInstance<OutboxProcessor>(factory.Services, options, logger);
    }

    private async Task<Guid> ProbeAsync(Guid probe, string note = "probe")
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<CustomersDbContext>();
        var message = OutboxMessage.For(new DeliveryProbe(probe, note), DateTimeOffset.UtcNow, null);
        db.OutboxMessages.Add(message);
        await db.SaveChangesAsync(Ct);
        return message.Id;
    }

    private async Task<Guid> DeadLetterAsync(Guid id)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        await scope.ServiceProvider.GetRequiredService<CustomersDbContext>().OutboxMessages.Where(m => m.Id == id)
            .ExecuteUpdateAsync(s => s
                .SetProperty(m => m.Status, OutboxStatus.DeadLetter)
                .SetProperty(m => m.Attempts, OutboxMessage.MaxAttempts)
                .SetProperty(m => m.DeadLetteredAt, DateTimeOffset.UtcNow)
                .SetProperty(m => m.LastError, "Failed ten times (test setup)."), Ct);
        return id;
    }

    /// <summary>A quote accepted with one monthly and one one-time line, as Sales raises it; far in the future, so no test's billing run collects its charge.</summary>
    private async Task<(Guid MessageId, Guid QuoteId)> QuoteAcceptedAsync(string label)
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "outbox-quotes");
        var finance = factory.ClientAs(CrmRoles.Finance, userKey: "outbox-quotes-finance");
        var marker = $"{label}{Guid.NewGuid():N}"[..10];
        var organizationId = await admin.CreateOrganizationAsync(TestData.Organization($"{marker} Levering AS", status: "Customer"));
        var productId = await CatalogApiTests.CreateProductAsync(finance, CatalogApiTests.Product(CatalogApiTests.Sku("OUTBOX"), "Drift"));
        var quoteId = Guid.NewGuid();
        var accepted = new QuoteAccepted(
            quoteId, $"T-{marker}", 1, organizationId, null, null, $"{marker} Drift", new DateOnly(2099, 6, 1), 12,
            [
                new AcceptedQuoteLine(Guid.NewGuid(), productId, "Drift", null, 2m, 500m, 0m, 25m, QuoteLineRecurrence.Monthly),
                new AcceptedQuoteLine(Guid.NewGuid(), null, "Etablering", null, 1m, 9_000m, 0m, 25m, QuoteLineRecurrence.OneTime),
            ]);
        await using var scope = factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<SalesDbContext>();
        var message = OutboxMessage.For(accepted, DateTimeOffset.UtcNow, null);
        db.OutboxMessages.Add(message);
        await db.SaveChangesAsync(Ct);
        return (message.Id, quoteId);
    }

    private async Task<Guid?> ClaimAsync(OutboxProcessor processor, Type contextType, Guid id)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        return await processor.TryClaimAsync((ModuleDbContext)scope.ServiceProvider.GetRequiredService(contextType), id, Ct);
    }

    private async Task<bool> DeliverOnceAsync(OutboxProcessor processor, Type contextType, Guid id)
    {
        var token = (await ClaimAsync(processor, contextType, id)).ShouldNotBeNull($"message {id} could not be claimed");
        return await processor.DeliverAsync(contextType, id, token, Ct);
    }

    /// <summary>One round of the worker for the module (it applies replay requests first), then this message if the round left it.</summary>
    private async Task ApplyAndDeliverAsync(OutboxProcessor processor, Type contextType, Guid id)
    {
        await processor.ProcessContextAsync(contextType, Ct);
        var message = await MessageAsync(contextType, id);
        message.Replays.ShouldBeGreaterThan(0);
        if (message.Status == OutboxStatus.Pending)
        {
            (await DeliverOnceAsync(processor, contextType, id)).ShouldBeTrue();
        }
    }

    private async Task ExpireLeaseAsync(Type contextType, Guid id)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var context = (ModuleDbContext)scope.ServiceProvider.GetRequiredService(contextType);
        await context.OutboxMessages.Where(m => m.Id == id)
            .ExecuteUpdateAsync(s => s.SetProperty(m => m.LockedUntil, DateTimeOffset.UtcNow.AddMinutes(-1)), Ct);
    }

    private async Task<OutboxMessage> MessageAsync(Type contextType, Guid id)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var context = (ModuleDbContext)scope.ServiceProvider.GetRequiredService(contextType);
        return await context.OutboxMessages.AsNoTracking().SingleAsync(m => m.Id == id, Ct);
    }

    private async Task<int> EffectsAsync(Guid probe, string effect)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<CustomersDbContext>().AuditEntries
            .CountAsync(a => a.EntityType == nameof(DeliveryProbe) && a.EntityId == probe && a.Action == effect, Ct);
    }

    private async Task<int> ContractsOfQuoteAsync(Guid quoteId)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<ContractsDbContext>().Contracts.IgnoreQueryFilters().CountAsync(c => c.SourceQuoteId == quoteId, Ct);
    }

    private async Task<int> ChargesOfQuoteAsync(Guid quoteId)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<BillingDbContext>().PendingCharges.IgnoreQueryFilters()
            .CountAsync(c => c.SourceType == "quote" && c.SourceId == quoteId, Ct);
    }

    private async Task<OutboundOperation> OperationAsync(Guid id)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<IntegrationDbContext>().OutboundOperations.AsNoTracking().SingleAsync(o => o.Id == id, Ct);
    }

    private async Task<(OutboxReplayRequest Request, AuditEntry Audit)> ReplayRecordAsync(Guid messageId)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<CustomersDbContext>();
        var request = await db.OutboxReplayRequests.AsNoTracking().SingleAsync(r => r.MessageIds.Contains(messageId.ToString()), Ct);
        var audit = await db.AuditEntries.AsNoTracking().SingleAsync(a => a.EntityId == request.Id && a.Action == AuditActions.Replay, Ct);
        return (request, audit);
    }

    private static async Task ShouldRefuseAsync(HttpClient client, object body, HttpStatusCode status, string code)
    {
        var response = await client.PostAsJsonAsync($"{Outbox}/replay", body, Ct);
        response.StatusCode.ShouldBe(status);
        (await response.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe(code);
    }
}
