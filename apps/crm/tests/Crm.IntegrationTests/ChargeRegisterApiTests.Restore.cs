using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crm.Authorization;
using Crm.Billing.Domain;
using Crm.Billing.Persistence;
using Crm.Integrations.Core;
using Crm.Integrations.Core.Persistence;
using Crm.SharedKernel.Documents;
using Crm.SharedKernel.Operations;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using WireMock.RequestBuilders;
using static Crm.IntegrationTests.IntegrationTestHelpers;

namespace Crm.IntegrationTests;

/// <summary>
/// DEV-13: a database restored to a point before an order was sent forgets the send; the external effect journal outside the
/// database does not. Repeated processing after the restore creates no second order — whether PowerOffice still finds the
/// first one or not — and the operator's reconciliation holds what the journal shows before the worker resumes. These tests
/// bill months of 2035 only.
/// </summary>
public partial class ChargeRegisterApiTests
{
    [Fact]
    public async Task DEV13_AC04_after_a_restore_an_order_PowerOffice_does_not_find_is_not_created_again_the_journal_holds_the_basis()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "register-admin");
        var finance = factory.ClientAs(CrmRoles.Finance, userKey: "register-finance");
        var period = new DateOnly(2035, 2, 1);
        var customer = await CustomerAsync(admin, finance, "J", period, period.AddMonths(1).AddDays(-1), 2_600m);
        StubOrders(customer, 88_101);
        var runId = await RunAsync(finance, period, customer.Marker);
        (await (await finance.RunCommandAsync(runId, "approve")).ReadJsonAsync()).GetProperty("status").GetString().ShouldBe("Approved");
        (await factory.WaitForRunExportAsync(finance, runId)).ShouldBeOneOf("Exported", "ExportedWithErrors");
        var basisId = (await BasisOfAsync(finance, runId, customer))!.Value.GetProperty("id").GetGuid();
        (await BasisAsync(finance, basisId)).Basis.GetProperty("orderNo").GetString().ShouldBe("88101");
        OrdersPosted(customer).ShouldBe(1);
        var journal = factory.Services.GetRequiredService<IExternalEffectJournal>();
        var entries = (await journal.ForEntityAsync("BillingBasis", basisId, CancellationToken.None)).Where(e => e.Kind == "sales-order").ToList();
        entries.Select(e => e.Phase).ShouldBe([EffectPhase.Sending, EffectPhase.Sent]);
        entries[^1].Reference.ShouldBe("88101");

        // Restored from a backup taken before the send was recorded (as in AC06) — and this time PowerOffice does not find the
        // order by its reference: renumbered, archived, or its search lags behind.
        await RestoreBeforeTheSendAsync(basisId, keepOperation: false);
        factory.PowerOffice.Given(Request.Create().WithPath("/v2/SalesOrders").UsingGet().WithParam("externalImportReferences", await ReferenceAsync(basisId)))
            .AtPriority(1)
            .RespondWith(JsonReply(Array.Empty<object>()));

        for (var attempt = 0; attempt < 10 && (await BasisAsync(finance, basisId)).Basis.GetProperty("status").GetString() == "Approved"; attempt++)
        {
            await factory.ProcessEventsAndOutboundAsync();
        }

        // The journal remembers the order: the basis waits for Finance with the number PowerOffice gave, nothing is sent again.
        (await BasisAsync(finance, basisId)).Basis.GetProperty("status").GetString().ShouldBe("ReconciliationRequired");
        OrdersPosted(customer).ShouldBe(1);
        (await AttemptsAsync(basisId)).ShouldContain(a => a.Result == "ReconciliationRequired" && a.Message!.Contains("88101"));
        (await ChargesAsync(c => c.BasisId == basisId)).ShouldHaveSingleItem().Status.ShouldBe(ChargeStatus.ReconciliationRequired);

        // Finance confirms the order the journal named.
        var (_, etag) = await BasisAsync(finance, basisId);
        var reconciled = await finance.PostWithETagAsync($"{Billing}/bases/{basisId}/reconcile", new { created = true, orderNo = "88101", reason = "Funnet i PowerOffice" }, etag);
        reconciled.StatusCode.ShouldBe(HttpStatusCode.OK);
        (await ChargesAsync(c => c.BasisId == basisId)).ShouldHaveSingleItem().Status.ShouldBe(ChargeStatus.ExportConfirmed);
    }

    [Fact]
    public async Task DEV13_AC04_an_attempt_finance_settled_does_not_hold_the_next_send()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "register-admin");
        var finance = factory.ClientAs(CrmRoles.Finance, userKey: "register-finance");
        var period = new DateOnly(2035, 3, 1);
        var customer = await CustomerAsync(admin, finance, "S", period, period.AddMonths(1).AddDays(-1), 2_700m);
        // The first send gets no answer: the journal keeps an attempt without an outcome, the basis waits for Finance.
        StubOrders(customer, 0, status: 500);
        var runId = await RunAsync(finance, period, customer.Marker);
        (await (await finance.RunCommandAsync(runId, "approve")).ReadJsonAsync()).GetProperty("status").GetString().ShouldBe("Approved");
        await factory.ProcessEventsAndOutboundAsync();
        var basisId = (await BasisOfAsync(finance, runId, customer))!.Value.GetProperty("id").GetGuid();
        await AgeTheSendAsync(basisId);
        await RunPendingOperationsAsync(basisId);
        (await BasisAsync(finance, basisId)).Basis.GetProperty("status").GetString().ShouldBe("ReconciliationRequired");
        OrdersPosted(customer).ShouldBe(1);

        // Finance finds no order in PowerOffice and sends the basis again: that decision settles the open attempt.
        var (_, heldEtag) = await BasisAsync(finance, basisId);
        (await finance.PostWithETagAsync($"{Billing}/bases/{basisId}/reconcile", new { created = false, reason = "Ingen ordre i PowerOffice" }, heldEtag))
            .StatusCode.ShouldBe(HttpStatusCode.OK);
        factory.PowerOffice.Given(Request.Create().WithPath("/v2/SalesOrders").UsingPost().WithBody(new WireMock.Matchers.WildcardMatcher($"*{customer.OrganizationId:N}*")))
            .AtPriority(0)
            .RespondWith(JsonReply(new { Id = 88_201, OrderNo = 88_201, CustomerId = 1, Status = "Draft" }));
        (await finance.PostAsync($"{Billing}/bases/{basisId}/retry", null)).StatusCode.ShouldBe(HttpStatusCode.OK);
        for (var attempt = 0; attempt < 10 && (await BasisAsync(finance, basisId)).Basis.GetProperty("status").GetString() != "Exported"; attempt++)
        {
            await factory.ProcessEventsAndOutboundAsync();
            await RunPendingOperationsAsync(basisId);
        }

        var (exported, _) = await BasisAsync(finance, basisId);
        exported.GetProperty("status").GetString().ShouldBe("Exported");
        exported.GetProperty("orderNo").GetString().ShouldBe("88201");
        OrdersPosted(customer).ShouldBe(2);
    }

    [Fact]
    public async Task DEV13_AC04_the_restore_reconciliation_holds_what_the_journal_shows_sent_after_the_restore_point()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "register-admin");
        var finance = factory.ClientAs(CrmRoles.Finance, userKey: "register-finance");
        var period = new DateOnly(2035, 4, 1);
        var customer = await CustomerAsync(admin, finance, "K", period, period.AddMonths(1).AddDays(-1), 2_800m);
        StubOrders(customer, 88_301);
        var runId = await RunAsync(finance, period, customer.Marker);
        var restorePoint = DateTimeOffset.UtcNow;
        (await (await finance.RunCommandAsync(runId, "approve")).ReadJsonAsync()).GetProperty("status").GetString().ShouldBe("Approved");
        (await factory.WaitForRunExportAsync(finance, runId)).ShouldBeOneOf("Exported", "ExportedWithErrors");
        var basisId = (await BasisOfAsync(finance, runId, customer))!.Value.GetProperty("id").GetGuid();
        OrdersPosted(customer).ShouldBe(1);

        // Restored to the moment the order waited in the outbound queue: the restored copy would send it again.
        await RestoreBeforeTheSendAsync(basisId, keepOperation: true);
        var switchStore = new TestDocumentStore();
        try
        {
            await using var host = factory.WithWebHostBuilder(builder => builder.ConfigureTestServices(services =>
                services.AddSingleton<IDocumentStore>(new SplitDocumentStore(switchStore, factory.Documents))));
            var operatorClient = QuoteDocumentsTests.Client(host, CrmRoles.Admin, "register-admin");
            var reconcile = new { restorePoint, apply = false };

            // Reconciling while the worker could send would race with it: maintenance comes first.
            var early = await operatorClient.PostAsJsonAsync("/api/v1/operations/restore/reconcile", reconcile);
            early.StatusCode.ShouldBe(HttpStatusCode.Conflict);
            (await early.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe("MAINTENANCE_REQUIRED");
            var maintenance = await (await operatorClient.PutAsJsonAsync("/api/v1/operations/maintenance",
                new { mode = "ReadOnly", reason = "DEV-13 test: reconciling a restore", reference = "DEV-13" })).ReadJsonAsync();

            // The dry run reports and changes nothing.
            var dryRun = await operatorClient.PostAsJsonAsync("/api/v1/operations/restore/reconcile", reconcile);
            dryRun.StatusCode.ShouldBe(HttpStatusCode.OK, await dryRun.Content.ReadAsStringAsync());
            var preview = await dryRun.ReadJsonAsync();
            preview.GetProperty("applied").GetBoolean().ShouldBeFalse();
            preview.GetProperty("effects").GetInt32().ShouldBeGreaterThanOrEqualTo(4);
            var previewLines = preview.GetProperty("reconciliation").EnumerateArray().ToList();
            previewLines.ShouldContain(l => l.GetProperty("area").GetString() == "billing" && l.GetProperty("subject").GetString() == $"basis {basisId}"
                && l.GetProperty("finding").GetString()!.Contains("88301") && l.GetProperty("needsPerson").GetBoolean());
            previewLines.ShouldContain(l => l.GetProperty("area").GetString() == "integrations" && l.GetProperty("subject").GetString()!.EndsWith($"BillingBasis {basisId}"));
            preview.GetProperty("checks").EnumerateArray().ShouldContain(l => l.GetProperty("area").GetString() == "database" && !l.GetProperty("needsPerson").GetBoolean());
            preview.GetProperty("checks").EnumerateArray().ShouldContain(l => l.GetProperty("area").GetString() == "keys" && !l.GetProperty("needsPerson").GetBoolean());
            (await BasisAsync(finance, basisId)).Basis.GetProperty("status").GetString().ShouldBe("Approved");
            (await OperationAsync(basisId)).Status.ShouldBe(OutboundStatus.Pending);

            // Applied: the basis waits for Finance with the order number, the operation is held with the evidence.
            var applied = await (await operatorClient.PostAsJsonAsync("/api/v1/operations/restore/reconcile", new { restorePoint, apply = true })).ReadJsonAsync();
            applied.GetProperty("applied").GetBoolean().ShouldBeTrue();
            (await BasisAsync(finance, basisId)).Basis.GetProperty("status").GetString().ShouldBe("ReconciliationRequired");
            var held = await OperationAsync(basisId);
            held.Status.ShouldBe(OutboundStatus.Failed);
            held.LastError!.ShouldStartWith("Held after a database restore");
            var reports = await operatorClient.GetFromJsonAsync<JsonElement>("/api/v1/operations/restore/reports");
            var reportId = applied.GetProperty("id").GetString()!;
            reports.EnumerateArray().ShouldContain(r => r.GetProperty("id").GetString() == reportId && r.GetProperty("needsPerson").GetInt32() > 0);
            (await operatorClient.GetFromJsonAsync<JsonElement>($"/api/v1/operations/restore/reports/{reportId}")).GetProperty("restorePoint").GetDateTimeOffset()
                .ShouldBe(restorePoint, TimeSpan.FromMilliseconds(1));

            // The worker resumes after the maintenance: nothing goes to PowerOffice a second time.
            (await operatorClient.PutAsJsonAsync("/api/v1/operations/maintenance",
                new { mode = "Normal", reason = "DEV-13 test: reconciliation done", reference = "DEV-13", expectedKey = maintenance.GetProperty("key").GetString() }))
                .StatusCode.ShouldBe(HttpStatusCode.OK);
            await factory.ProcessEventsAndOutboundAsync();
            OrdersPosted(customer).ShouldBe(1);
            (await BasisAsync(finance, basisId)).Basis.GetProperty("status").GetString().ShouldBe("ReconciliationRequired");
        }
        finally
        {
            if (Directory.Exists(switchStore.Root))
            {
                Directory.Delete(switchStore.Root, recursive: true);
            }
        }
    }

    /// <summary>
    /// What the database administrator puts back from a backup taken before the send was recorded: the basis waits to be sent,
    /// its charge is committed. With <paramref name="keepOperation"/> the outbound operation waits in the queue (the backup is
    /// from after the approval was delivered); without it the approval event is undelivered and no operation exists (AC06).
    /// </summary>
    private async Task RestoreBeforeTheSendAsync(Guid basisId, bool keepOperation)
    {
        if (keepOperation)
        {
            await factory.AdminSqlWithoutBillingTriggersAsync($"""
                UPDATE billing.BillingBases SET Status = N'Approved', OrderNo = NULL, ExportedAt = NULL, SendStartedAt = NULL WHERE Id = {basisId};
                DELETE FROM billing.BillingExportAttempts WHERE BasisId = {basisId};
                UPDATE billing.Charges SET Status = N'Committed' WHERE BasisId = {basisId};
                UPDATE integration.OutboundOperations SET Status = N'Pending', Attempts = 0, CompletedAt = NULL, Result = NULL, LastError = NULL,
                    LockedUntil = NULL, LeaseOwner = NULL, NextAttemptAt = SYSDATETIMEOFFSET()
                WHERE EntityId = {basisId};
                """);
            return;
        }

        await factory.AdminSqlWithoutBillingTriggersAsync($"""
            UPDATE billing.BillingBases SET Status = N'Approved', OrderNo = NULL, ExportedAt = NULL, SendStartedAt = NULL WHERE Id = {basisId};
            DELETE FROM billing.BillingExportAttempts WHERE BasisId = {basisId};
            UPDATE billing.Charges SET Status = N'Committed' WHERE BasisId = {basisId};
            DELETE r FROM integration.InboxReceipts r JOIN billing.OutboxMessages m ON m.Id = r.MessageId
            WHERE m.Type LIKE N'%BillingBasisApproved%' AND m.Payload LIKE {"%" + basisId + "%"};
            UPDATE billing.OutboxMessages SET Status = N'Pending', ProcessedAt = NULL, LockedUntil = NULL, LeaseOwner = NULL,
                DeliveredHandlers = NULL, Attempts = 0, NextAttemptAt = NULL
            WHERE Type LIKE N'%BillingBasisApproved%' AND Payload LIKE {"%" + basisId + "%"};
            DELETE FROM integration.OutboundOperations WHERE EntityId = {basisId};
            """);
    }

    /// <summary>Runs this basis's waiting operations now, whatever their backoff.</summary>
    private async Task RunPendingOperationsAsync(Guid basisId)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var outbound = scope.ServiceProvider.GetRequiredService<OutboundProcessorJob>();
        var operations = await scope.ServiceProvider.GetRequiredService<IntegrationDbContext>().OutboundOperations.AsNoTracking()
            .Where(o => o.EntityId == basisId && o.Status == OutboundStatus.Pending).Select(o => o.Id).ToListAsync();
        foreach (var operation in operations)
        {
            await outbound.ExecuteOneAsync(operation, CancellationToken.None);
        }
    }

    private async Task<OutboundOperation> OperationAsync(Guid basisId)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<IntegrationDbContext>().OutboundOperations.AsNoTracking()
            .Where(o => o.EntityId == basisId).OrderByDescending(o => o.CreatedAt).FirstAsync();
    }

    private async Task<List<BillingExportAttempt>> AttemptsAsync(Guid basisId)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<BillingDbContext>().ExportAttempts.AsNoTracking()
            .Where(a => a.BasisId == basisId).OrderBy(a => a.At).ToListAsync();
    }
}
