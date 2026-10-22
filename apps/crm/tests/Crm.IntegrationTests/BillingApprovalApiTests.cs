using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crm.Authorization;
using Crm.Billing.Contracts;
using Crm.Billing.Domain;
using Crm.Billing.Features;
using Crm.Billing.Persistence;
using Crm.Identity.Persistence;
using Crm.Infrastructure.Persistence;
using Crm.Integrations.Core.Persistence;
using Crm.SharedKernel.Application;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using WireMock.Matchers;
using WireMock.RequestBuilders;
using static Crm.IntegrationTests.IntegrationTestHelpers;

namespace Crm.IntegrationTests;

/// <summary>
/// Approvals of one content revision through the API and SQL Server (DEV-02, docs/adr/ADR-012). Every test bills a month of
/// its own (2031) and looks only at its own customers, as the database is shared with the rest of the suite.
/// </summary>
public class BillingApprovalApiTests(CrmWebFactory factory)
{
    private const string Billing = "/api/v1/billing";
    private const string Contracts = "/api/v1/contracts";
    private const decimal Threshold = 200_000m;

    private sealed record Customer(Guid OrganizationId, Guid ProductId, string Marker);

    /// <summary>A customer with one contract line billed monthly in advance, for exactly <paramref name="period"/>.</summary>
    private static async Task<Customer> CustomerAsync(HttpClient admin, HttpClient finance, string prefix, DateOnly period, decimal monthlyFee)
    {
        var marker = $"{prefix}{Guid.NewGuid():N}"[..10];
        var organizationId = await admin.CreateOrganizationAsync(new { name = $"{marker} Godkjenning AS", status = "Customer" });
        var productId = await CatalogApiTests.CreateProductAsync(
            finance, CatalogApiTests.Product(CatalogApiTests.Sku("APR"), "Managed services", monthlyFee, decimal.Round(monthlyFee / 2, 2)));
        var contractId = (await (await admin.PostAsJsonAsync(Contracts, new
        {
            organizationId, title = $"{marker} Drift", type = "Msp", startDate = period, endDate = period.AddMonths(1).AddDays(-1),
            autoRenew = false, renewalTermMonths = 0, noticePeriodDays = 30, invoiceFrequency = "Monthly", invoiceTiming = "InAdvance",
            indexation = false,
        })).ReadJsonAsync()).GetProperty("id").GetGuid();
        (await admin.PostAsJsonAsync($"{Contracts}/{contractId}/lines", new
        {
            productId, quantityModel = "Fixed", quantity = 1m, unitPrice = monthlyFee, validFrom = period,
        })).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await admin.PostAsync($"{Contracts}/{contractId}/activate", null)).StatusCode.ShouldBe(HttpStatusCode.OK);
        return new Customer(organizationId, productId, marker);
    }

    private static async Task<Guid> CollectedRunAsync(HttpClient finance, DateOnly period, string marker)
    {
        var created = await finance.PostAsJsonAsync($"{Billing}/runs", new { year = period.Year, month = period.Month, notes = marker });
        created.StatusCode.ShouldBe(HttpStatusCode.Created);
        var runId = (await created.ReadJsonAsync()).GetProperty("id").GetGuid();
        (await finance.RunCommandAsync(runId, "collect")).StatusCode.ShouldBe(HttpStatusCode.OK);
        return runId;
    }

    private static async Task<JsonElement> RunAsync(HttpClient client, Guid runId) =>
        await client.GetFromJsonAsync<JsonElement>($"{Billing}/runs/{runId}");

    private static async Task<JsonElement> BasisOfAsync(HttpClient finance, Guid runId, Customer customer) =>
        (await finance.GetFromJsonAsync<JsonElement>($"{Billing}/runs/{runId}/bases?search={customer.Marker}"))
        .EnumerateArray()
        .Single(b => b.GetProperty("organization").GetProperty("id").GetGuid() == customer.OrganizationId);

    private static async Task<(JsonElement Basis, string Etag)> BasisAsync(HttpClient finance, Guid basisId)
    {
        var read = await finance.GetAsync($"{Billing}/bases/{basisId}");
        read.StatusCode.ShouldBe(HttpStatusCode.OK);
        return (await read.ReadJsonAsync(), read.Headers.ETag!.Tag);
    }

    private static async Task<string> CodeAsync(HttpResponseMessage response) => (await response.ReadJsonAsync()).GetProperty("code").GetString()!;

    /// <summary>
    /// The run of a test month also carries other tests' open-ended contracts. None of them may lift a basis over the
    /// threshold, or a boundary test would prove nothing; the test says so instead of passing by accident.
    /// </summary>
    private static async Task NoOtherBasisAboveTheThresholdAsync(HttpClient finance, Guid runId, Customer customer)
    {
        var others = (await finance.GetFromJsonAsync<JsonElement>($"{Billing}/runs/{runId}/bases"))
            .EnumerateArray()
            .Where(b => b.GetProperty("organization").GetProperty("id").GetGuid() != customer.OrganizationId)
            .Where(b => b.GetProperty("totalExVat").GetDecimal() > Threshold)
            .Select(b => b.GetProperty("organization").GetProperty("name").GetString())
            .ToList();
        others.ShouldBeEmpty("another test's basis above the threshold shares this run");
    }

    private async Task<(int RunApproved, int BasisApproved)> ApprovalEventsAsync(Guid runId, Guid basisId)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<BillingDbContext>();
        var run = runId.ToString();
        var basis = basisId.ToString();
        return (
            await db.OutboxMessages.CountAsync(m => m.Type.Contains("BillingRunApproved") && m.Payload.Contains(run)),
            await db.OutboxMessages.CountAsync(m => m.Type.Contains("BillingBasisApproved") && m.Payload.Contains(basis)));
    }

    /// <summary>The digest of the run's bases as SQL Server holds them now, computed by the same code the approval uses.</summary>
    private async Task<(string Digest, BillingRun Run)> StoredAsync(Guid runId)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<BillingDbContext>();
        var bases = await db.BillingBases.AsNoTracking().Include(b => b.Lines).Where(b => b.RunId == runId).ToListAsync();
        var run = await db.BillingRuns.AsNoTracking().Include(r => r.Approvals).SingleAsync(r => r.Id == runId);
        return (BillingContentDigest.Compute(bases), run);
    }

    [Theory]
    [InlineData(1, "199999.99", false)]
    [InlineData(2, "200000", false)]
    [InlineData(3, "200000.01", true)]
    public async Task AC02_a_second_person_is_needed_only_when_a_customer_basis_is_strictly_above_200000_excluding_VAT(int month, string amount, bool secondNeeded)
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "approval-admin");
        var finance = factory.ClientAs(CrmRoles.Finance, userKey: "approval-finance");
        var management = factory.ClientAs(CrmRoles.Management, userKey: "approval-management");
        var period = new DateOnly(2031, month, 1);
        var fee = decimal.Parse(amount, CultureInfo.InvariantCulture);
        var customer = await CustomerAsync(admin, finance, "B", period, fee);
        var runId = await CollectedRunAsync(finance, period, customer.Marker);
        (await BasisOfAsync(finance, runId, customer)).GetProperty("totalExVat").GetDecimal().ShouldBe(fee);
        await NoOtherBasisAboveTheThresholdAsync(finance, runId, customer);
        (await RunAsync(finance, runId)).GetProperty("requiresSecondApproval").GetBoolean().ShouldBe(secondNeeded);

        if (!secondNeeded)
        {
            // Nothing above the threshold: a second approval is not asked for, and not accepted either.
            var unasked = await management.RunCommandAsync(runId, "second-approve");
            unasked.StatusCode.ShouldBe(HttpStatusCode.Conflict);
            (await CodeAsync(unasked)).ShouldBe("BIL_NO_SECOND_APPROVAL");
        }

        var first = await finance.RunCommandAsync(runId, "approve");
        first.StatusCode.ShouldBe(HttpStatusCode.OK);
        (await first.ReadJsonAsync()).GetProperty("status").GetString().ShouldBe(secondNeeded ? "InReview" : "Approved");

        if (secondNeeded)
        {
            var second = await management.RunCommandAsync(runId, "second-approve");
            second.StatusCode.ShouldBe(HttpStatusCode.OK);
            (await second.ReadJsonAsync()).GetProperty("status").GetString().ShouldBe("Approved");
        }

        var approved = await RunAsync(finance, runId);
        var approvals = approved.GetProperty("approvals").EnumerateArray().ToList();
        approvals.Count.ShouldBe(secondNeeded ? 2 : 1);
        approvals.ShouldAllBe(a => a.GetProperty("valid").GetBoolean());
        approvals.Select(a => a.GetProperty("contentRevision").GetInt32()).Distinct().ShouldHaveSingleItem()
            .ShouldBe(approved.GetProperty("contentRevision").GetInt32());
        approved.GetProperty("approvedRevision").GetInt32().ShouldBe(approved.GetProperty("contentRevision").GetInt32());
    }

    [Fact]
    public async Task AC03_a_manual_line_of_300000_after_a_collect_below_the_threshold_cannot_pass_with_one_approval()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "approval-admin");
        var finance = factory.ClientAs(CrmRoles.Finance, userKey: "approval-finance");
        var management = factory.ClientAs(CrmRoles.Management, userKey: "approval-management");
        var period = new DateOnly(2031, 4, 1);
        var customer = await CustomerAsync(admin, finance, "C", period, 10_000m);
        var runId = await CollectedRunAsync(finance, period, customer.Marker);
        await NoOtherBasisAboveTheThresholdAsync(finance, runId, customer);
        var collected = await RunAsync(finance, runId);
        collected.GetProperty("requiresSecondApproval").GetBoolean().ShouldBeFalse();
        var revision = collected.GetProperty("contentRevision").GetInt32();

        var basisId = (await BasisOfAsync(finance, runId, customer)).GetProperty("id").GetGuid();
        var (_, etag) = await BasisAsync(finance, basisId);
        var added = await finance.PostWithETagAsync(
            $"{Billing}/bases/{basisId}/lines", new { description = "Prosjektleveranse", quantity = 1m, unitPrice = 300_000m, reason = "Avtalt leveranse" }, etag);
        added.StatusCode.ShouldBe(HttpStatusCode.OK);
        (await added.ReadJsonAsync()).GetProperty("totalExVat").GetDecimal().ShouldBe(310_000m);

        // The run says at once what its content needs now, in the list as well, and the change is a new revision.
        var changed = await RunAsync(finance, runId);
        changed.GetProperty("requiresSecondApproval").GetBoolean().ShouldBeTrue();
        changed.GetProperty("contentRevision").GetInt32().ShouldBe(revision + 1);
        (await finance.GetFromJsonAsync<JsonElement>($"{Billing}/runs?year={period.Year}&limit=200")).GetProperty("items").EnumerateArray()
            .Single(r => r.GetProperty("id").GetGuid() == runId).GetProperty("requiresSecondApproval").GetBoolean().ShouldBeTrue();

        var first = await finance.RunCommandAsync(runId, "approve");
        first.StatusCode.ShouldBe(HttpStatusCode.OK);
        (await first.ReadJsonAsync()).GetProperty("status").GetString().ShouldBe("InReview");
        (await ApprovalEventsAsync(runId, basisId)).ShouldBe((0, 0));

        // Finance cannot give the second approval (no right), and the same person never can (BR-BIL-04).
        (await finance.PostWithETagAsync($"{Billing}/runs/{runId}/second-approve", new { }, await finance.RunETagAsync(runId))).StatusCode
            .ShouldBe(HttpStatusCode.Forbidden);

        var second = await management.RunCommandAsync(runId, "second-approve");
        second.StatusCode.ShouldBe(HttpStatusCode.OK);
        (await second.ReadJsonAsync()).GetProperty("status").GetString().ShouldBe("Approved");
        (await ApprovalEventsAsync(runId, basisId)).ShouldBe((1, 1));
    }

    [Fact]
    public async Task AC04_collect_and_both_approvals_need_the_current_etag_and_a_stale_one_changes_nothing()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "approval-admin");
        var finance = factory.ClientAs(CrmRoles.Finance, userKey: "approval-finance");
        var management = factory.ClientAs(CrmRoles.Management, userKey: "approval-management");
        var period = new DateOnly(2031, 5, 1);
        var customer = await CustomerAsync(admin, finance, "D", period, 250_000m);
        var runId = await CollectedRunAsync(finance, period, customer.Marker);

        foreach (var (client, command) in new[] { (finance, "collect"), (finance, "approve"), (management, "second-approve") })
        {
            var missing = await client.PostAsync($"{Billing}/runs/{runId}/{command}", null);
            missing.StatusCode.ShouldBe(HttpStatusCode.PreconditionRequired, command);
        }

        // Finance looks at the run; meanwhile a line of a basis changes, which is a new revision of the run.
        var seen = await finance.RunETagAsync(runId);
        var basisId = (await BasisOfAsync(finance, runId, customer)).GetProperty("id").GetGuid();
        var (_, basisEtag) = await BasisAsync(finance, basisId);
        (await finance.PostWithETagAsync($"{Billing}/bases/{basisId}/lines", new { description = "Tillegg", quantity = 1m, unitPrice = 1_000m, reason = "Tillegg" }, basisEtag))
            .StatusCode.ShouldBe(HttpStatusCode.OK);
        var before = await RunAsync(finance, runId);

        foreach (var (client, command) in new[] { (finance, "approve"), (management, "second-approve"), (finance, "collect") })
        {
            var stale = await client.PostWithETagAsync($"{Billing}/runs/{runId}/{command}", new { }, seen);
            stale.StatusCode.ShouldBe(HttpStatusCode.PreconditionFailed, command);
            (await CodeAsync(stale)).ShouldBe("CONCURRENCY_CONFLICT");
        }

        var after = await RunAsync(finance, runId);
        after.GetProperty("status").GetString().ShouldBe("Collected");
        after.GetProperty("approvals").GetArrayLength().ShouldBe(0);
        after.GetProperty("contentRevision").GetInt32().ShouldBe(before.GetProperty("contentRevision").GetInt32());
        after.GetProperty("etag").GetString().ShouldBe(before.GetProperty("etag").GetString());
        (await ApprovalEventsAsync(runId, basisId)).ShouldBe((0, 0));
    }

    [Fact]
    public async Task AC04_a_line_change_racing_the_releasing_approval_never_passes_unnoticed()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "approval-admin");
        var finance = factory.ClientAs(CrmRoles.Finance, userKey: "approval-finance");
        var period = new DateOnly(2031, 6, 1);
        var customer = await CustomerAsync(admin, finance, "E", period, 5_000m);
        var runId = await CollectedRunAsync(finance, period, customer.Marker);
        var basisId = (await BasisOfAsync(finance, runId, customer)).GetProperty("id").GetGuid();

        var approvalWon = false;
        for (var round = 1; round <= 20 && !approvalWon; round++)
        {
            var runEtag = await finance.RunETagAsync(runId);
            var (_, basisEtag) = await BasisAsync(finance, basisId);
            var approve = finance.PostWithETagAsync($"{Billing}/runs/{runId}/approve", new { }, runEtag);
            var change = finance.PostWithETagAsync(
                $"{Billing}/bases/{basisId}/lines", new { description = $"Runde {round}", quantity = 1m, unitPrice = 100m, reason = "Samtidig endring" }, basisEtag);
            var responses = await Task.WhenAll(approve, change);
            var codes = responses.Select(r => r.StatusCode).ToList();

            // Exactly one of the two wins; the loser is refused, never applied on top of the other.
            codes.Count(c => c == HttpStatusCode.OK).ShouldBe(1, $"round {round}: {string.Join(", ", codes)}");
            codes.Where(c => c != HttpStatusCode.OK).ShouldAllBe(c => c == HttpStatusCode.PreconditionFailed || c == HttpStatusCode.Conflict);

            var (digest, run) = await StoredAsync(runId);
            approvalWon = responses[0].StatusCode == HttpStatusCode.OK;
            if (approvalWon)
            {
                // What SQL Server holds now is exactly the content that was approved.
                run.Status.ShouldBe(BillingRunStatus.Approved);
                run.ApprovedDigest.ShouldBe(digest);
                run.ApprovedRevision.ShouldBe(run.ContentRevision);
            }
            else
            {
                run.Status.ShouldBe(BillingRunStatus.Collected);
                run.Approvals.ShouldBeEmpty();
            }
        }

        if (!approvalWon)
        {
            // The change won every round; the approval of the last content still has to hold what SQL Server holds.
            (await finance.RunCommandAsync(runId, "approve")).StatusCode.ShouldBe(HttpStatusCode.OK);
            var (digest, run) = await StoredAsync(runId);
            run.ApprovedDigest.ShouldBe(digest);
        }

        (await RunAsync(finance, runId)).GetProperty("status").GetString().ShouldBe("Approved");
    }

    [Fact]
    public async Task AC04_a_line_change_racing_a_first_approval_either_fails_or_visibly_sets_the_approval_aside()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "approval-admin");
        var finance = factory.ClientAs(CrmRoles.Finance, userKey: "approval-finance");
        var otherFinance = factory.ClientAs(CrmRoles.Finance, userKey: "approval-finance-2");
        var period = new DateOnly(2031, 7, 1);
        var customer = await CustomerAsync(admin, finance, "F", period, 250_000m);
        var runId = await CollectedRunAsync(finance, period, customer.Marker);
        var basisId = (await BasisOfAsync(finance, runId, customer)).GetProperty("id").GetGuid();

        for (var round = 1; round <= 6; round++)
        {
            var runEtag = await finance.RunETagAsync(runId);
            var (_, basisEtag) = await BasisAsync(otherFinance, basisId);
            var responses = await Task.WhenAll(
                finance.PostWithETagAsync($"{Billing}/runs/{runId}/approve", new { }, runEtag),
                otherFinance.PostWithETagAsync(
                    $"{Billing}/bases/{basisId}/lines", new { description = $"Runde {round}", quantity = 1m, unitPrice = 100m, reason = "Samtidig endring" }, basisEtag));
            responses.Count(r => r.StatusCode == HttpStatusCode.OK).ShouldBeGreaterThanOrEqualTo(1);

            // Whatever the order, an approval that still counts is about the content SQL Server holds now.
            var (digest, run) = await StoredAsync(runId);
            foreach (var valid in run.Approvals.Where(a => a.InvalidatedAt is null))
            {
                valid.ContentRevision.ShouldBe(run.ContentRevision);
                valid.ContentDigest.ShouldBe(digest);
            }

            if (responses.All(r => r.StatusCode == HttpStatusCode.OK))
            {
                // Both went through: the change came second and set the approval aside, with the reason shown to the user.
                var view = await RunAsync(finance, runId);
                view.GetProperty("status").GetString().ShouldBe("Collected");
                var setAside = view.GetProperty("approvals").EnumerateArray().Last();
                setAside.GetProperty("valid").GetBoolean().ShouldBeFalse();
                setAside.GetProperty("invalidationReason").GetString().ShouldBe(ApprovalResetReasons.LinesChanged);
            }

            if (run.Status == BillingRunStatus.InReview)
            {
                // The approval won this round; set it aside for the next one by changing a line on purpose.
                var (_, etag) = await BasisAsync(otherFinance, basisId);
                (await otherFinance.PostWithETagAsync($"{Billing}/bases/{basisId}/lines", new { description = "Reset", quantity = 1m, unitPrice = 1m, reason = "Reset" }, etag))
                    .StatusCode.ShouldBe(HttpStatusCode.OK);
            }
        }
    }

    [Fact]
    public async Task AC05_repeated_approvals_open_tabs_and_a_redelivered_event_queue_one_export_and_one_order()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "approval-admin");
        var finance = factory.ClientAs(CrmRoles.Finance, userKey: "approval-finance");
        var period = new DateOnly(2031, 8, 1);
        BillingApiTests.StubToken(factory);
        var customer = await CustomerAsync(admin, finance, "G", period, 7_000m);
        var customerNo = TestExternalIds.Number(700_000, 799_999);
        await BillingApiTests.LinkAsync(admin, "Organization", customer.OrganizationId, "Customer", customerNo.ToString(CultureInfo.InvariantCulture));
        await BillingApiTests.LinkAsync(admin, "Product", customer.ProductId, "Product", TestExternalIds.Next(10_000, 99_999));
        var orderMatcher = new WildcardMatcher($"*{customer.OrganizationId:N}*");
        factory.PowerOffice.Given(Request.Create().WithPath("/v2/SalesOrders").UsingPost().WithBody(orderMatcher))
            .AtPriority(1)
            .RespondWith(JsonReply(new { Id = 9_801, OrderNo = 9_801, CustomerId = customerNo, Status = "Draft" }));
        int OrdersPosted() => factory.PowerOffice.LogEntries.Count(e =>
            e.RequestMessage!.Method == "POST" && e.RequestMessage.Path == "/v2/SalesOrders" &&
            (e.RequestMessage.Body ?? string.Empty).Contains(customer.OrganizationId.ToString("N"), StringComparison.Ordinal));

        var runId = await CollectedRunAsync(finance, period, customer.Marker);
        var basisId = (await BasisOfAsync(finance, runId, customer)).GetProperty("id").GetGuid();

        // Four tabs approve the revision they all show.
        var seen = await finance.RunETagAsync(runId);
        var tabs = await Task.WhenAll(Enumerable.Range(0, 4).Select(_ => finance.PostWithETagAsync($"{Billing}/runs/{runId}/approve", new { }, seen)));
        tabs.Count(r => r.StatusCode == HttpStatusCode.OK).ShouldBe(1);
        tabs.Where(r => r.StatusCode != HttpStatusCode.OK).ShouldAllBe(r => r.StatusCode == HttpStatusCode.PreconditionFailed || r.StatusCode == HttpStatusCode.Conflict);

        // Approving the approved run again is refused.
        var again = await finance.RunCommandAsync(runId, "approve");
        again.StatusCode.ShouldBe(HttpStatusCode.Conflict);
        (await CodeAsync(again)).ShouldBe("BIL_INVALID_STATUS");
        (await ApprovalEventsAsync(runId, basisId)).ShouldBe((1, 1));
        (await RunAsync(finance, runId)).GetProperty("approvals").GetArrayLength().ShouldBe(1);

        // The worker sends the basis once.
        (await factory.WaitForRunExportAsync(finance, runId)).ShouldBeOneOf("Exported", "ExportedWithErrors");
        (await BasisAsync(finance, basisId)).Basis.GetProperty("status").GetString().ShouldBe("Exported");
        OrdersPosted().ShouldBe(1);

        // The worker dies after the handlers committed but before it acknowledged: what it leaves is a message still in
        // processing, a lease that runs out and nothing noted (DEV-07). The approval events are delivered a second time.
        async Task<List<OutboxMessage>> ApprovalMessagesAsync()
        {
            await using var scope = factory.Services.CreateAsyncScope();
            var run = runId.ToString();
            var basis = basisId.ToString();
            return await scope.ServiceProvider.GetRequiredService<BillingDbContext>().OutboxMessages.AsNoTracking()
                .Where(m => (m.Type.Contains("BillingBasisApproved") && m.Payload.Contains(basis)) || (m.Type.Contains("BillingRunApproved") && m.Payload.Contains(run)))
                .ToListAsync();
        }

        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var ids = (await ApprovalMessagesAsync()).Select(m => m.Id).ToList();
            ids.Count.ShouldBe(2);
            await scope.ServiceProvider.GetRequiredService<BillingDbContext>().OutboxMessages.Where(m => ids.Contains(m.Id))
                .ExecuteUpdateAsync(s => s
                    .SetProperty(m => m.Status, OutboxStatus.Processing)
                    .SetProperty(m => m.ProcessedAt, (DateTimeOffset?)null)
                    .SetProperty(m => m.DeliveredHandlers, (string?)null)
                    .SetProperty(m => m.LeaseOwner, Guid.NewGuid())
                    .SetProperty(m => m.LockedUntil, DateTimeOffset.UtcNow.AddMinutes(-1)));
        }

        for (var attempt = 0; attempt < 10 && (await ApprovalMessagesAsync()).Any(m => m.Status != OutboxStatus.Processed); attempt++)
        {
            await factory.ProcessEventsAndOutboundAsync();
            await Task.Delay(100);
        }

        // Each handler finds its receipt: the second delivery queues no second operation, and no second order goes out.
        (await ApprovalMessagesAsync()).ShouldAllBe(m => m.Status == OutboxStatus.Processed);
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            (await scope.ServiceProvider.GetRequiredService<IntegrationDbContext>().OutboundOperations.AsNoTracking()
                    .Where(o => o.EntityId == basisId).ToListAsync())
                .ShouldHaveSingleItem().Status.ShouldBe(OutboundStatus.Succeeded);
        }

        OrdersPosted().ShouldBe(1);
        var exported = (await BasisAsync(finance, basisId)).Basis;
        exported.GetProperty("orderNo").GetString().ShouldBe("9801");
        exported.GetProperty("attempts").EnumerateArray().Count(a => a.GetProperty("result").GetString() == "Exported").ShouldBe(1);
    }

    [Fact]
    public async Task Two_bases_finishing_at_once_both_get_the_run_status_right_although_their_updates_collide()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "approval-admin");
        var finance = factory.ClientAs(CrmRoles.Finance, userKey: "approval-finance");
        var period = new DateOnly(2031, 12, 1);
        var customer = await CustomerAsync(admin, finance, "R", period, 4_000m);
        var runId = await CollectedRunAsync(finance, period, customer.Marker);
        (await finance.RunCommandAsync(runId, "approve")).StatusCode.ShouldBe(HttpStatusCode.OK);

        // This worker read the run; another basis of the same run updated it in between (DEV-07, found in DEV-15). The later
        // writer reads the run again instead of failing after its export already happened.
        await using var scope = factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<BillingDbContext>();
        (await db.BillingRuns.SingleAsync(r => r.Id == runId)).Status.ShouldBe(BillingRunStatus.Approved);
        await using (var other = factory.Services.CreateAsyncScope())
        {
            (await other.ServiceProvider.GetRequiredService<BillingDbContext>().BillingRuns.Where(r => r.Id == runId)
                .ExecuteUpdateAsync(s => s.SetProperty(r => r.ModifiedAt, DateTimeOffset.UtcNow))).ShouldBe(1);
        }

        await BillingApi.UpdateRunStatusAsync(db, runId, DateTimeOffset.UtcNow, CancellationToken.None);

        await using var check = factory.Services.CreateAsyncScope();
        (await check.ServiceProvider.GetRequiredService<BillingDbContext>().BillingRuns.AsNoTracking().SingleAsync(r => r.Id == runId))
            .Status.ShouldBe(BillingRunStatus.Exporting);
    }

    [Fact]
    public async Task AC06_a_refused_approval_changes_no_signature_status_basis_or_outbox_message()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "approval-admin");
        var finance = factory.ClientAs(CrmRoles.Finance, userKey: "approval-finance");
        var period = new DateOnly(2031, 9, 1);
        var customer = await CustomerAsync(admin, finance, "H", period, 300_000m);
        var runId = await CollectedRunAsync(finance, period, customer.Marker);
        var basisId = (await BasisOfAsync(finance, runId, customer)).GetProperty("id").GetGuid();

        // Admin holds both approval rights and gives the second approval.
        (await admin.RunCommandAsync(runId, "second-approve")).StatusCode.ShouldBe(HttpStatusCode.OK);
        var before = await RunAsync(finance, runId);
        before.GetProperty("status").GetString().ShouldBe("InReview");

        // Every refusal leaves the run exactly as it was.
        var sameAdmin = await admin.RunCommandAsync(runId, "approve");
        sameAdmin.StatusCode.ShouldBe(HttpStatusCode.Conflict);
        (await CodeAsync(sameAdmin)).ShouldBe("BIL_SAME_APPROVER");

        var secondAgain = await admin.RunCommandAsync(runId, "second-approve");
        secondAgain.StatusCode.ShouldBe(HttpStatusCode.Conflict);
        (await CodeAsync(secondAgain)).ShouldBe("BIL_SAME_APPROVER");

        var stale = await finance.PostWithETagAsync($"{Billing}/runs/{runId}/approve", new { }, "\"AAAAAAAAB9E=\"");
        stale.StatusCode.ShouldBe(HttpStatusCode.PreconditionFailed);

        var after = await RunAsync(finance, runId);
        after.GetProperty("status").GetString().ShouldBe("InReview");
        after.GetProperty("etag").GetString().ShouldBe(before.GetProperty("etag").GetString());
        after.GetProperty("approvedBy").ValueKind.ShouldBe(JsonValueKind.Null);
        after.GetProperty("secondApprovedBy").GetProperty("name").GetString().ShouldBe("Test approval-admin");
        var approvals = after.GetProperty("approvals").EnumerateArray().ToList();
        approvals.ShouldHaveSingleItem().GetProperty("kind").GetString().ShouldBe("Second");
        approvals[0].GetProperty("valid").GetBoolean().ShouldBeTrue();
        (await BasisAsync(finance, basisId)).Basis.GetProperty("status").GetString().ShouldBe("Draft");
        (await ApprovalEventsAsync(runId, basisId)).ShouldBe((0, 0));

        // Another person completes it.
        var released = await finance.RunCommandAsync(runId, "approve");
        released.StatusCode.ShouldBe(HttpStatusCode.OK);
        (await released.ReadJsonAsync()).GetProperty("status").GetString().ShouldBe("Approved");
        (await ApprovalEventsAsync(runId, basisId)).ShouldBe((1, 1));
    }

    [Fact]
    public async Task Approvals_set_aside_by_a_change_or_a_collect_stay_visible_with_the_reason()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "approval-admin");
        var finance = factory.ClientAs(CrmRoles.Finance, userKey: "approval-finance");
        var management = factory.ClientAs(CrmRoles.Management, userKey: "approval-management");
        var period = new DateOnly(2031, 10, 1);
        var customer = await CustomerAsync(admin, finance, "I", period, 250_000m);
        var runId = await CollectedRunAsync(finance, period, customer.Marker);
        var basisId = (await BasisOfAsync(finance, runId, customer)).GetProperty("id").GetGuid();

        (await finance.RunCommandAsync(runId, "approve")).StatusCode.ShouldBe(HttpStatusCode.OK);
        var (_, etag) = await BasisAsync(finance, basisId);
        (await finance.PostWithETagAsync($"{Billing}/bases/{basisId}/lines", new { description = "Tillegg", quantity = 1m, unitPrice = 500m, reason = "Tillegg" }, etag))
            .StatusCode.ShouldBe(HttpStatusCode.OK);

        var afterChange = await RunAsync(finance, runId);
        afterChange.GetProperty("status").GetString().ShouldBe("Collected");
        afterChange.GetProperty("approvedBy").ValueKind.ShouldBe(JsonValueKind.Null);
        var changed = afterChange.GetProperty("approvals").EnumerateArray().ShouldHaveSingleItem();
        changed.GetProperty("valid").GetBoolean().ShouldBeFalse();
        changed.GetProperty("invalidationReason").GetString().ShouldBe(ApprovalResetReasons.LinesChanged);
        changed.GetProperty("approvedBy").GetProperty("name").GetString().ShouldBe("Test approval-finance");
        changed.GetProperty("contentRevision").GetInt32().ShouldBe(afterChange.GetProperty("contentRevision").GetInt32() - 1);

        (await management.RunCommandAsync(runId, "second-approve")).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await finance.RunCommandAsync(runId, "collect")).StatusCode.ShouldBe(HttpStatusCode.OK);

        var afterCollect = await RunAsync(finance, runId);
        afterCollect.GetProperty("status").GetString().ShouldBe("Collected");
        afterCollect.GetProperty("secondApprovedBy").ValueKind.ShouldBe(JsonValueKind.Null);
        var history = afterCollect.GetProperty("approvals").EnumerateArray().ToList();
        history.Count.ShouldBe(2);
        history.ShouldAllBe(a => !a.GetProperty("valid").GetBoolean());
        history[1].GetProperty("kind").GetString().ShouldBe("Second");
        history[1].GetProperty("invalidationReason").GetString().ShouldBe(ApprovalResetReasons.Recollected);

        // Cancelling a basis of an open run is a change of content as well.
        await NoOtherBasisAboveTheThresholdAsync(finance, runId, customer);
        (await management.RunCommandAsync(runId, "second-approve")).StatusCode.ShouldBe(HttpStatusCode.OK);
        var (_, cancelEtag) = await BasisAsync(finance, basisId);
        (await finance.PostWithETagAsync($"{Billing}/bases/{basisId}/cancel", new { reason = "Fakturert manuelt" }, cancelEtag)).StatusCode.ShouldBe(HttpStatusCode.OK);
        var afterCancel = await RunAsync(finance, runId);
        afterCancel.GetProperty("approvals").EnumerateArray().Last().GetProperty("invalidationReason").GetString().ShouldBe(ApprovalResetReasons.BasisCancelled);
        afterCancel.GetProperty("requiresSecondApproval").GetBoolean().ShouldBeFalse();
    }

    [Fact]
    public async Task An_approval_needs_an_active_signed_in_person_even_while_the_sign_in_cache_still_trusts_them()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "approval-admin");
        var finance = factory.ClientAs(CrmRoles.Finance, userKey: "approval-finance");
        var leaverKey = $"approval-leaver-{Guid.NewGuid():N}";
        var leaver = factory.ClientAs(CrmRoles.Finance, userKey: leaverKey);
        var period = new DateOnly(2031, 11, 1);
        var customer = await CustomerAsync(admin, finance, "J", period, 2_000m);
        var runId = await CollectedRunAsync(finance, period, customer.Marker);
        var leaverEtag = await leaver.RunETagAsync(runId);

        // The Entra sync deactivates the user.
        Guid leaverId;
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var identity = scope.ServiceProvider.GetRequiredService<IdentityDbContext>();
            var user = await identity.Users.SingleAsync(u => u.ObjectId == $"test-{leaverKey}");
            leaverId = user.Id;
            user.Deactivate().ShouldBeTrue();
            await identity.SaveChangesAsync();
        }

        // Through the API the account is refused before any handler runs.
        var refused = await leaver.PostWithETagAsync($"{Billing}/runs/{runId}/approve", new { }, leaverEtag);
        refused.StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
        (await CodeAsync(refused)).ShouldBe("USER_INACTIVE");

        // In production the active flag is cached for a minute; the approval itself reads the account again.
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var asLeaver = ActivatorUtilities.CreateInstance<BillingService>(scope.ServiceProvider, new FixedUser(leaverId));
            var inactive = await asLeaver.ApproveAsync(runId, second: false, leaverEtag, CancellationToken.None);
            inactive.Error!.Code.ShouldBe("BIL_APPROVER_INACTIVE");
        }

        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var anonymous = ActivatorUtilities.CreateInstance<BillingService>(scope.ServiceProvider, new FixedUser(null));
            (await anonymous.ApproveAsync(runId, second: false, leaverEtag, CancellationToken.None)).Error!.Code.ShouldBe("BIL_APPROVER_REQUIRED");
        }

        var unchanged = await RunAsync(finance, runId);
        unchanged.GetProperty("status").GetString().ShouldBe("Collected");
        unchanged.GetProperty("approvals").GetArrayLength().ShouldBe(0);
        unchanged.GetProperty("etag").GetString().ShouldBe(leaverEtag);
    }

    private sealed class FixedUser(Guid? userId) : ICurrentUser
    {
        public Guid? UserId => userId;

        public string DisplayName => "Fixed user";

        public bool IsAuthenticated => userId is not null;

        public bool HasPermission(string permission) => true;
    }
}
