using System.Globalization;
using System.Linq.Expressions;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crm.Authorization;
using Crm.Billing.Domain;
using Crm.Billing.Persistence;
using Crm.Integrations.Core;
using Crm.Integrations.Core.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using WireMock.Matchers;
using WireMock.RequestBuilders;
using WireMock.ResponseBuilders;
using static Crm.IntegrationTests.IntegrationTestHelpers;

namespace Crm.IntegrationTests;

/// <summary>
/// The charge register across runs through the API and SQL Server (DEV-03, docs/adr/ADR-013). Every test bills months of its
/// own (2032–2034) and looks only at its own customers, as the database is shared with the rest of the suite.
/// </summary>
public class ChargeRegisterApiTests(CrmWebFactory factory)
{
    private const string Billing = "/api/v1/billing";
    private const string Contracts = "/api/v1/contracts";

    private sealed record Customer(Guid OrganizationId, Guid ContractId, Guid LineId, Guid ProductId, string Marker);

    /// <summary>A customer with one contract line in advance from <paramref name="start"/>; linked to PowerOffice unless told otherwise.</summary>
    private async Task<Customer> CustomerAsync(
        HttpClient admin, HttpClient finance, string prefix, DateOnly start, DateOnly end, decimal fee, string frequency = "Monthly", bool link = true)
    {
        var marker = $"{prefix}{Guid.NewGuid():N}"[..10];
        var organizationId = await admin.CreateOrganizationAsync(new { name = $"{marker} Register AS", status = "Customer" });
        var productId = await CatalogApiTests.CreateProductAsync(finance, CatalogApiTests.Product(CatalogApiTests.Sku("REG"), "Managed services", fee, decimal.Round(fee / 2, 2)));
        var contractId = (await (await admin.PostAsJsonAsync(Contracts, new
        {
            organizationId, title = $"{marker} Drift", type = "Msp", startDate = start, endDate = end, autoRenew = false, renewalTermMonths = 0,
            noticePeriodDays = 30, invoiceFrequency = frequency, invoiceTiming = "InAdvance", indexation = false,
        })).ReadJsonAsync()).GetProperty("id").GetGuid();
        var line = await (await admin.PostAsJsonAsync($"{Contracts}/{contractId}/lines", new
        {
            productId, quantityModel = "Fixed", quantity = 1m, unitPrice = fee, validFrom = start,
        })).ReadJsonAsync();
        var lineId = line.GetProperty("lines").EnumerateArray().Single().GetProperty("id").GetGuid();
        (await admin.PostAsync($"{Contracts}/{contractId}/activate", null)).StatusCode.ShouldBe(HttpStatusCode.OK);
        if (link)
        {
            BillingApiTests.StubToken(factory);
            await BillingApiTests.LinkAsync(admin, "Organization", organizationId, "Customer", Random.Shared.NextInt64(600_000, 699_999).ToString(CultureInfo.InvariantCulture));
            await BillingApiTests.LinkAsync(admin, "Product", productId, "Product", Random.Shared.NextInt64(10_000, 99_999).ToString(CultureInfo.InvariantCulture));
        }

        return new Customer(organizationId, contractId, lineId, productId, marker);
    }

    private void StubOrders(Customer customer, int orderNo, int status = 200) =>
        factory.PowerOffice.Given(Request.Create().WithPath("/v2/SalesOrders").UsingPost().WithBody(new WildcardMatcher($"*{customer.OrganizationId:N}*")))
            .AtPriority(1)
            .RespondWith(status == 200
                ? JsonReply(new { Id = orderNo, OrderNo = orderNo, CustomerId = 1, Status = "Draft" })
                : Response.Create().WithStatusCode(status).WithBody("{\"error\":\"try later\"}"));

    private int OrdersPosted(Customer customer) => factory.PowerOffice.LogEntries.Count(e =>
        e.RequestMessage!.Method == "POST" && e.RequestMessage.Path == "/v2/SalesOrders" &&
        (e.RequestMessage.Body ?? string.Empty).Contains(customer.OrganizationId.ToString("N"), StringComparison.Ordinal));

    private static async Task<Guid> RunAsync(HttpClient finance, DateOnly period, string marker, bool supplementary = false, bool collect = true)
    {
        var created = await finance.PostAsJsonAsync($"{Billing}/runs", new { year = period.Year, month = period.Month, notes = marker, supplementary });
        created.StatusCode.ShouldBe(HttpStatusCode.Created, await created.Content.ReadAsStringAsync());
        var runId = (await created.ReadJsonAsync()).GetProperty("id").GetGuid();
        if (collect)
        {
            (await finance.RunCommandAsync(runId, "collect")).StatusCode.ShouldBe(HttpStatusCode.OK);
        }

        return runId;
    }

    private static async Task<JsonElement?> BasisOfAsync(HttpClient finance, Guid runId, Customer customer)
    {
        var bases = (await finance.GetFromJsonAsync<JsonElement>($"{Billing}/runs/{runId}/bases?search={customer.Marker}")).EnumerateArray()
            .Where(b => b.GetProperty("organization").GetProperty("id").GetGuid() == customer.OrganizationId)
            .ToList();
        return bases.Count == 0 ? null : await finance.GetFromJsonAsync<JsonElement>($"{Billing}/bases/{bases.Single().GetProperty("id").GetGuid()}");
    }

    private static async Task<(JsonElement Basis, string Etag)> BasisAsync(HttpClient finance, Guid basisId)
    {
        var read = await finance.GetAsync($"{Billing}/bases/{basisId}");
        read.StatusCode.ShouldBe(HttpStatusCode.OK);
        return (await read.ReadJsonAsync(), read.Headers.ETag!.Tag);
    }

    private async Task<List<Charge>> ChargesAsync(Expression<Func<Charge, bool>> where)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<BillingDbContext>().Charges.AsNoTracking().Where(where).ToListAsync();
    }

    private async Task ApproveExportAndCloseAsync(HttpClient finance, Guid runId)
    {
        (await (await finance.RunCommandAsync(runId, "approve")).ReadJsonAsync()).GetProperty("status").GetString().ShouldBe("Approved");
        (await factory.WaitForRunExportAsync(finance, runId)).ShouldBeOneOf("Exported", "ExportedWithErrors");
        (await finance.PostAsync($"{Billing}/runs/{runId}/close", null)).StatusCode.ShouldBe(HttpStatusCode.OK);
    }

    private static async Task<Guid> ApprovedTimeAsync(HttpClient technician, HttpClient lead, Guid organizationId, DateOnly workDate, decimal hours, string workType)
    {
        var entry = await (await technician.PostAsJsonAsync("/api/v1/time/entries", new
        {
            organizationId, workDate, hours, workType, billable = true, onsite = false, afterHours = false, description = $"Arbeid {workDate:dd.MM}",
        })).ReadJsonAsync();
        var entryId = entry.GetProperty("id").GetGuid();
        (await lead.PostAsJsonAsync("/api/v1/time/approve", new { entryIds = new[] { entryId } })).StatusCode.ShouldBe(HttpStatusCode.OK);
        return entryId;
    }

    [Fact]
    public async Task AC01_a_supplementary_run_of_a_billed_and_closed_month_bills_only_what_no_run_billed_yet()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "register-admin");
        var finance = factory.ClientAs(CrmRoles.Finance, userKey: "register-finance");
        var lead = factory.ClientAs(CrmRoles.ServiceLead, userKey: "register-lead");
        var technician = factory.ClientAs(CrmRoles.Technician, userKey: "register-tech");
        var period = new DateOnly(2032, 1, 1);
        var customer = await CustomerAsync(admin, finance, "S", period, period.AddMonths(1).AddDays(-1), 5_000m);
        StubOrders(customer, 32_001);

        // An hourly product of this test's own work type, and three approved hours in the month.
        var workType = $"Remote-{customer.Marker}";
        var hourProduct = await CatalogApiTests.CreateProductAsync(finance, new
        {
            sku = CatalogApiTests.Sku("HRS"), name = "Support hour", type = "HourlyService", businessLine = "Consulting", unit = "Hour",
            billingPeriod = "OneTime", vatRate = 25m, listPrice = 1_000m, unitCost = 400m, ateraWorkType = workType,
        });
        await BillingApiTests.LinkAsync(admin, "Product", hourProduct, "Product", Random.Shared.NextInt64(10_000, 99_999).ToString(CultureInfo.InvariantCulture));
        await ApprovedTimeAsync(technician, lead, customer.OrganizationId, new DateOnly(2032, 1, 12), 3m, workType);

        // 1. The month is billed, exported and closed: 5 000 + 3 h × 1 000.
        var regular = await RunAsync(finance, period, customer.Marker);
        (await BasisOfAsync(finance, regular, customer))!.Value.GetProperty("totalExVat").GetDecimal().ShouldBe(8_000m);
        await ApproveExportAndCloseAsync(finance, regular);
        OrdersPosted(customer).ShouldBe(1);
        var billed = await ChargesAsync(c => c.PayerOrganizationId == customer.OrganizationId && c.Status != ChargeStatus.Released);
        billed.Count.ShouldBe(2);
        billed.ShouldAllBe(c => c.Status == ChargeStatus.ExportConfirmed && c.RunId == regular);
        billed.Select(c => c.Kind).OrderBy(k => k).ShouldBe([ChargeKind.Contract, ChargeKind.Time]);

        // 2. No second regular run for a billed month.
        var again = await finance.PostAsJsonAsync($"{Billing}/runs", new { year = period.Year, month = period.Month, notes = customer.Marker });
        again.StatusCode.ShouldBe(HttpStatusCode.Conflict);
        (await again.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe("BIL_PERIOD_ALREADY_BILLED");

        // 3. Two hours are approved late; a supplementary run bills them and nothing that left with the first order.
        await ApprovedTimeAsync(technician, lead, customer.OrganizationId, new DateOnly(2032, 1, 28), 2m, workType);
        var supplementary = await RunAsync(finance, period, customer.Marker, supplementary: true);
        (await finance.GetFromJsonAsync<JsonElement>($"{Billing}/runs/{supplementary}")).GetProperty("kind").GetString().ShouldBe("Supplementary");
        var late = (await BasisOfAsync(finance, supplementary, customer))!.Value;
        late.GetProperty("totalExVat").GetDecimal().ShouldBe(2_000m);
        var lines = late.GetProperty("lines").EnumerateArray().ToList();
        lines.ShouldHaveSingleItem().GetProperty("group").GetString().ShouldBe("HourlyWork");
        lines[0].GetProperty("quantity").GetDecimal().ShouldBe(2m);

        // Collected again, still the same; the register holds each obligation once.
        (await finance.RunCommandAsync(supplementary, "collect")).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await BasisOfAsync(finance, supplementary, customer))!.Value.GetProperty("totalExVat").GetDecimal().ShouldBe(2_000m);
        var all = await ChargesAsync(c => c.PayerOrganizationId == customer.OrganizationId && c.Status != ChargeStatus.Released);
        all.Count.ShouldBe(3);
        all.GroupBy(c => c.Key).ShouldAllBe(g => g.Count() == 1);
        all.Single(c => c.RunId == supplementary).Status.ShouldBe(ChargeStatus.Reserved);
    }

    [Fact]
    public async Task AC02_two_runs_collecting_at_the_same_moment_reserve_a_queued_item_on_one_basis_only()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "register-admin");
        var finance = factory.ClientAs(CrmRoles.Finance, userKey: "register-finance");
        var first = new DateOnly(2034, 1, 1);
        var second = new DateOnly(2034, 2, 1);
        // Billed monthly in both runs, so the customer has a basis in each.
        var customer = await CustomerAsync(admin, finance, "C", first, second.AddMonths(1).AddDays(-1), 1_000m, link: false);

        // A one-time item waiting for a run, as an accepted quote leaves it.
        Guid queuedId;
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<BillingDbContext>();
            var queued = PendingCharge.Create(customer.OrganizationId, null, $"{customer.Marker} Etablering", 1m, 12_500m, 0m, 25m, "quote", Guid.NewGuid(), Guid.NewGuid(), new DateOnly(2034, 1, 15));
            db.PendingCharges.Add(queued);
            await db.SaveChangesAsync();
            queuedId = queued.Id;
        }

        var runA = await RunAsync(finance, first, customer.Marker, collect: false);
        var runB = await RunAsync(finance, second, customer.Marker, collect: false);
        var key = $"pending:{queuedId:N}";

        for (var round = 0; round < 5; round++)
        {
            var responses = await Task.WhenAll(finance.RunCommandAsync(runA, "collect"), finance.RunCommandAsync(runB, "collect"));
            responses.ShouldAllBe(r => r.StatusCode == HttpStatusCode.OK);

            var holders = await ChargesAsync(c => c.Key == key && c.Status != ChargeStatus.Released);
            var holder = holders.ShouldHaveSingleItem();
            holder.RunId.ShouldBeOneOf(runA, runB);

            // The item is on exactly one basis; the other run's basis says where it went.
            var onA = (await BasisOfAsync(finance, runA, customer))!.Value;
            var onB = (await BasisOfAsync(finance, runB, customer))!.Value;
            var withItem = new[] { onA, onB }.Count(b => b.GetProperty("lines").EnumerateArray().Any(l => l.GetProperty("group").GetString() == "OneOff"));
            withItem.ShouldBe(1);
            var without = holder.RunId == runA ? onB : onA;
            without.GetProperty("anomalies").EnumerateArray().ShouldContain(a => a.GetProperty("code").GetString() == "BIL_CHARGE_RESERVED_ELSEWHERE");
        }

        // The database refuses a second active charge for the same obligation, whatever writes it.
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<BillingDbContext>();
            var duplicate = () => db.Database.ExecuteSqlInterpolatedAsync($"""
                INSERT INTO billing.Charges (Id, [Key], Kind, SourceOrganizationId, PayerOrganizationId, Currency, Amount, Status, StatusChangedAt, CreatedAt, IsDeleted)
                VALUES (NEWID(), {key}, N'OneOff', {customer.OrganizationId}, {customer.OrganizationId}, N'NOK', 12500, N'Reserved', SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(), 0)
                """);
            (await Should.ThrowAsync<Microsoft.Data.SqlClient.SqlException>(duplicate)).Message.ShouldContain("IX_Charges_Key");
        }
    }

    [Fact]
    public async Task AC03_a_quarter_across_the_year_end_is_billed_once_and_a_change_to_monthly_never_bills_its_days_again()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "register-admin");
        var finance = factory.ClientAs(CrmRoles.Finance, userKey: "register-finance");

        // Quarterly in advance from November: the November run bills November–January, December and January bill nothing.
        var november = new DateOnly(2032, 11, 1);
        var quarterly = await CustomerAsync(admin, finance, "Q", november, new DateOnly(2033, 1, 31), 9_000m, frequency: "Quarterly", link: false);
        var runNov = await RunAsync(finance, november, quarterly.Marker);
        var quarter = (await BasisOfAsync(finance, runNov, quarterly))!.Value.GetProperty("lines").EnumerateArray().ShouldHaveSingleItem();
        quarter.GetProperty("description").GetString()!.ShouldContain("01.11.2032–31.01.2033");
        quarter.GetProperty("lineTotal").GetDecimal().ShouldBe(9_000m);
        (await (await finance.RunCommandAsync(runNov, "approve")).ReadJsonAsync()).GetProperty("status").GetString().ShouldBe("Approved");
        (await BasisOfAsync(finance, await RunAsync(finance, new DateOnly(2032, 12, 1), quarterly.Marker), quarterly)).ShouldBeNull();
        (await BasisOfAsync(finance, await RunAsync(finance, new DateOnly(2033, 1, 1), quarterly.Marker), quarterly)).ShouldBeNull();

        // Quarterly from March, billed and approved for March–May; then the contract changes to monthly. April and May are
        // already held by the quarter, June is not.
        var march = new DateOnly(2033, 3, 1);
        var changing = await CustomerAsync(admin, finance, "F", march, new DateOnly(2033, 6, 30), 6_000m, frequency: "Quarterly", link: false);
        var runMar = await RunAsync(finance, march, changing.Marker);
        (await BasisOfAsync(finance, runMar, changing))!.Value.GetProperty("lines").EnumerateArray().ShouldHaveSingleItem()
            .GetProperty("description").GetString()!.ShouldContain("01.03.2033–31.05.2033");
        (await (await finance.RunCommandAsync(runMar, "approve")).ReadJsonAsync()).GetProperty("status").GetString().ShouldBe("Approved");

        var read = await admin.GetAsync($"{Contracts}/{changing.ContractId}");
        var contract = await read.ReadJsonAsync();
        (await admin.PutWithETagAsync($"{Contracts}/{changing.ContractId}", new
        {
            organizationId = changing.OrganizationId, title = contract.GetProperty("title").GetString(), type = "Msp", startDate = march,
            endDate = new DateOnly(2033, 6, 30), autoRenew = false, renewalTermMonths = 0, noticePeriodDays = 30, slaPolicyId = (Guid?)null,
            invoiceFrequency = "Monthly", invoiceTiming = "InAdvance", priceCategory = (string?)null, indexation = false,
            nextIndexationDate = (DateOnly?)null, customerReference = (string?)null, ownerId = (Guid?)null, notes = (string?)null,
        }, read.Headers.ETag!.Tag)).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await BasisOfAsync(finance, await RunAsync(finance, new DateOnly(2033, 4, 1), changing.Marker), changing)).ShouldBeNull();
        var june = (await BasisOfAsync(finance, await RunAsync(finance, new DateOnly(2033, 6, 1), changing.Marker), changing))!.Value;
        june.GetProperty("lines").EnumerateArray().ShouldHaveSingleItem().GetProperty("description").GetString()!.ShouldContain("01.06.2033–30.06.2033");

        // Never two active charges of one series on the same day.
        var contractCharges = await ChargesAsync(c => c.PayerOrganizationId == changing.OrganizationId && c.Kind == ChargeKind.Contract && c.Status != ChargeStatus.Released);
        contractCharges.Count.ShouldBe(2);
        contractCharges.OrderBy(c => c.ServiceFrom).Select(c => (c.ServiceFrom!.Value, c.ServiceTo!.Value))
            .ShouldBe([(march, new DateOnly(2033, 5, 31)), (new DateOnly(2033, 6, 1), new DateOnly(2033, 6, 30))]);
    }

    [Fact]
    public async Task AC03_a_change_in_the_middle_of_the_month_bills_each_version_for_its_own_days_once()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "register-admin");
        var finance = factory.ClientAs(CrmRoles.Finance, userKey: "register-finance");
        var period = new DateOnly(2032, 5, 1);
        var customer = await CustomerAsync(admin, finance, "M", period, period.AddMonths(1).AddDays(-1), 3_100m);
        StubOrders(customer, 32_005);
        (await admin.PostAsJsonAsync($"{Contracts}/{customer.ContractId}/lines/{customer.LineId}/revise", new
        {
            quantity = 2m, unitPrice = 3_100m, discountPct = (decimal?)null, description = (string?)null, effectiveFrom = new DateOnly(2032, 5, 16),
            deviceFilter = (string?)null,
        })).StatusCode.ShouldBe(HttpStatusCode.OK);

        // 1–15 May at one licence and 16–31 May at two, each prorated by its days (BR-BIL-11): the unit price carries 15/31 and 16/31.
        var runId = await RunAsync(finance, period, customer.Marker);
        (await finance.RunCommandAsync(runId, "collect")).StatusCode.ShouldBe(HttpStatusCode.OK);
        var basis = (await BasisOfAsync(finance, runId, customer))!.Value;
        var lines = basis.GetProperty("lines").EnumerateArray().OrderBy(l => l.GetProperty("sourceKey").GetString(), StringComparer.Ordinal).ToList();
        lines.Count.ShouldBe(2);
        lines.Select(l => l.GetProperty("sourceKey").GetString()![^21..]).OrderBy(k => k, StringComparer.Ordinal)
            .ShouldBe(["2032-05-01:2032-05-15", "2032-05-16:2032-05-31"]);
        var firstHalf = decimal.Round(3_100m * decimal.Round(15m / 31m, 4), 2);
        var secondHalf = decimal.Round(3_100m * decimal.Round(16m / 31m, 4), 2);
        basis.GetProperty("totalExVat").GetDecimal().ShouldBe(firstHalf + (2 * secondHalf));

        await ApproveExportAndCloseAsync(finance, runId);
        var supplementary = await RunAsync(finance, period, customer.Marker, supplementary: true);
        (await BasisOfAsync(finance, supplementary, customer)).ShouldBeNull();
    }

    [Fact]
    public async Task AC04_cancelling_before_the_send_frees_the_charge_and_an_unknown_send_waits_for_reconciliation()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "register-admin");
        var finance = factory.ClientAs(CrmRoles.Finance, userKey: "register-finance");
        var period = new DateOnly(2032, 6, 1);
        var end = period.AddMonths(1).AddDays(-1);
        var found = await CustomerAsync(admin, finance, "A", period, end, 2_000m);
        var unlinked = await CustomerAsync(admin, finance, "B", period, end, 3_000m, link: false);
        var missing = await CustomerAsync(admin, finance, "N", period, end, 4_000m);
        // PowerOffice answers both sends with a server error: nobody knows whether the orders exist.
        StubOrders(found, 0, status: 500);
        StubOrders(missing, 0, status: 500);

        var runId = await RunAsync(finance, period, found.Marker);
        (await (await finance.RunCommandAsync(runId, "approve")).ReadJsonAsync()).GetProperty("status").GetString().ShouldBe("Approved");
        await factory.ProcessEventsAndOutboundAsync();

        var foundBasisId = (await BasisOfAsync(finance, runId, found))!.Value.GetProperty("id").GetGuid();
        var missingBasisId = (await BasisOfAsync(finance, runId, missing))!.Value.GetProperty("id").GetGuid();
        var unlinkedBasisId = (await BasisOfAsync(finance, runId, unlinked))!.Value.GetProperty("id").GetGuid();

        // The send started and got no answer: the basis is not cancelled, its order may exist.
        var (afterSend, sendEtag) = await BasisAsync(finance, foundBasisId);
        afterSend.GetProperty("sendStarted").GetBoolean().ShouldBeTrue();
        var refused = await finance.PostWithETagAsync($"{Billing}/bases/{foundBasisId}/cancel", new { reason = "Feil kunde" }, sendEtag);
        refused.StatusCode.ShouldBe(HttpStatusCode.Conflict);
        (await refused.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe("BIL_RECONCILE_FIRST");

        // The next attempt looks the order up, does not find it and holds the basis for a person instead of sending again.
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var outbound = scope.ServiceProvider.GetRequiredService<OutboundProcessorJob>();
            var operations = await scope.ServiceProvider.GetRequiredService<IntegrationDbContext>().OutboundOperations.AsNoTracking()
                .Where(o => (o.EntityId == foundBasisId || o.EntityId == missingBasisId) && o.Status == OutboundStatus.Pending).Select(o => o.Id).ToListAsync();
            foreach (var operation in operations)
            {
                await outbound.ExecuteOneAsync(operation, CancellationToken.None);
            }
        }

        foreach (var basisId in new[] { foundBasisId, missingBasisId })
        {
            (await BasisAsync(finance, basisId)).Basis.GetProperty("status").GetString().ShouldBe("ReconciliationRequired");
        }

        OrdersPosted(found).ShouldBe(1);
        OrdersPosted(missing).ShouldBe(1);
        (await ChargesAsync(c => c.BasisId == foundBasisId)).ShouldHaveSingleItem().Status.ShouldBe(ChargeStatus.ReconciliationRequired);
        var (held, heldEtag) = await BasisAsync(finance, missingBasisId);
        (await finance.PostWithETagAsync($"{Billing}/bases/{missingBasisId}/cancel", new { reason = "Feil kunde" }, heldEtag)).StatusCode.ShouldBe(HttpStatusCode.Conflict);
        (await finance.PostWithETagAsync($"{Billing}/bases/{missingBasisId}/reconcile", new { created = true, reason = "Sjekket" }, heldEtag)).StatusCode
            .ShouldBe(HttpStatusCode.BadRequest);

        // Finance found the first order in PowerOffice; the second does not exist and the basis is cancelled.
        var (_, foundEtag) = await BasisAsync(finance, foundBasisId);
        var reconciled = await finance.PostWithETagAsync($"{Billing}/bases/{foundBasisId}/reconcile", new { created = true, orderNo = "77001", reason = "Funnet i PowerOffice" }, foundEtag);
        reconciled.StatusCode.ShouldBe(HttpStatusCode.OK);
        (await reconciled.ReadJsonAsync()).GetProperty("orderNo").GetString().ShouldBe("77001");
        (await ChargesAsync(c => c.BasisId == foundBasisId)).ShouldHaveSingleItem().Status.ShouldBe(ChargeStatus.ExportConfirmed);

        var notCreated = await finance.PostWithETagAsync($"{Billing}/bases/{missingBasisId}/reconcile", new { created = false, reason = "Ingen ordre i PowerOffice" }, held.GetProperty("etag").GetString()!);
        notCreated.StatusCode.ShouldBe(HttpStatusCode.OK);
        var afterCheck = await notCreated.ReadJsonAsync();
        afterCheck.GetProperty("status").GetString().ShouldBe("Failed");
        (await finance.PostWithETagAsync($"{Billing}/bases/{missingBasisId}/cancel", new { reason = "Fakturert manuelt" }, afterCheck.GetProperty("etag").GetString()!))
            .StatusCode.ShouldBe(HttpStatusCode.OK);

        // The unlinked customer failed before anything was sent: cancelling it simply frees the month.
        var (failed, failedEtag) = await BasisAsync(finance, unlinkedBasisId);
        failed.GetProperty("status").GetString().ShouldBe("Failed");
        failed.GetProperty("sendStarted").GetBoolean().ShouldBeFalse();
        (await finance.PostWithETagAsync($"{Billing}/bases/{unlinkedBasisId}/reconcile", new { created = false, reason = "x" }, failedEtag)).StatusCode
            .ShouldBe(HttpStatusCode.Conflict);
        (await finance.PostWithETagAsync($"{Billing}/bases/{unlinkedBasisId}/cancel", new { reason = "Mangler i PowerOffice" }, failedEtag)).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await ChargesAsync(c => c.BasisId == unlinkedBasisId)).ShouldHaveSingleItem().Status.ShouldBe(ChargeStatus.Released);
        (await ChargesAsync(c => c.BasisId == missingBasisId)).ShouldHaveSingleItem().Status.ShouldBe(ChargeStatus.Released);

        // A supplementary run bills the two freed months again, and not the one PowerOffice has.
        (await factory.WaitForRunExportAsync(finance, runId)).ShouldBeOneOf("Exported", "ExportedWithErrors");
        (await finance.PostAsync($"{Billing}/runs/{runId}/close", null)).StatusCode.ShouldBe(HttpStatusCode.OK);
        var supplementary = await RunAsync(finance, period, found.Marker, supplementary: true);
        (await BasisOfAsync(finance, supplementary, found)).ShouldBeNull();
        (await BasisOfAsync(finance, supplementary, unlinked))!.Value.GetProperty("totalExVat").GetDecimal().ShouldBe(3_000m);
        (await BasisOfAsync(finance, supplementary, missing))!.Value.GetProperty("totalExVat").GetDecimal().ShouldBe(4_000m);
    }

    [Fact]
    public async Task AC05_a_purchase_read_again_is_the_same_charge_and_two_purchases_of_one_package_stay_two()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "register-admin");
        var finance = factory.ClientAs(CrmRoles.Finance, userKey: "register-finance");
        var period = new DateOnly(2032, 7, 1);
        var customer = await CustomerAsync(admin, finance, "H", period, period.AddMonths(1).AddDays(-1), 3_000m);
        StubOrders(customer, 32_007);
        var hourBankProduct = await CatalogApiTests.CreateProductAsync(finance, CatalogApiTests.Product(
            CatalogApiTests.Sku("KLIPP"), "Klippekort", 1_000m, 400m, type: "HourBank", billingPeriod: "OneTime"));
        await BillingApiTests.LinkAsync(admin, "Product", hourBankProduct, "Product", Random.Shared.NextInt64(10_000, 99_999).ToString(CultureInfo.InvariantCulture));
        (await admin.PostAsJsonAsync($"{Contracts}/{customer.ContractId}/lines", new
        {
            productId = hourBankProduct, quantityModel = "Fixed", quantity = 1m, unitPrice = 1_000m, validFrom = period,
        })).StatusCode.ShouldBe(HttpStatusCode.OK);
        var bank = await (await admin.PostAsJsonAsync($"{Contracts}/hour-banks", new
        {
            organizationId = customer.OrganizationId, contractId = customer.ContractId, name = $"{customer.Marker} 10 t", hours = 10m, validFrom = new DateOnly(2032, 7, 5),
        })).ReadJsonAsync();
        var bankId = bank.GetProperty("id").GetGuid();
        (await admin.PostAsJsonAsync($"{Contracts}/hour-banks/{bankId}/entries", new { kind = "Purchase", hours = 5m, date = new DateOnly(2032, 7, 20), description = "Påfyll" }))
            .StatusCode.ShouldBe(HttpStatusCode.OK);

        // Two purchases of the same package are two charges; collecting three times changes nothing.
        var runId = await RunAsync(finance, period, customer.Marker);
        for (var i = 0; i < 2; i++)
        {
            (await finance.RunCommandAsync(runId, "collect")).StatusCode.ShouldBe(HttpStatusCode.OK);
        }

        var basis = (await BasisOfAsync(finance, runId, customer))!.Value;
        basis.GetProperty("totalExVat").GetDecimal().ShouldBe(3_000m + 10_000m + 5_000m);
        var purchases = basis.GetProperty("lines").EnumerateArray().Where(l => l.GetProperty("group").GetString() == "HourBank").ToList();
        purchases.Select(l => l.GetProperty("quantity").GetDecimal()).OrderBy(q => q).ShouldBe([5m, 10m]);
        purchases.Select(l => l.GetProperty("sourceKey").GetString()).Distinct().Count().ShouldBe(2);
        (await ChargesAsync(c => c.PayerOrganizationId == customer.OrganizationId && c.Kind == ChargeKind.HourBankPurchase && c.Status != ChargeStatus.Released))
            .Count.ShouldBe(2);

        // Exported and closed, the purchases are read again by a supplementary run and bill nothing; a third purchase does.
        await ApproveExportAndCloseAsync(finance, runId);
        (await admin.PostAsJsonAsync($"{Contracts}/hour-banks/{bankId}/entries", new { kind = "Purchase", hours = 2m, date = new DateOnly(2032, 7, 30), description = "Påfyll 2" }))
            .StatusCode.ShouldBe(HttpStatusCode.OK);
        var supplementary = await RunAsync(finance, period, customer.Marker, supplementary: true);
        var late = (await BasisOfAsync(finance, supplementary, customer))!.Value;
        late.GetProperty("lines").EnumerateArray().ShouldHaveSingleItem().GetProperty("quantity").GetDecimal().ShouldBe(2m);
        late.GetProperty("totalExVat").GetDecimal().ShouldBe(2_000m);
    }

    [Fact]
    public async Task AC06_after_a_restore_from_before_the_export_was_recorded_the_existing_order_is_found_and_nothing_is_sent_twice()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "register-admin");
        var finance = factory.ClientAs(CrmRoles.Finance, userKey: "register-finance");
        var period = new DateOnly(2032, 8, 1);
        var customer = await CustomerAsync(admin, finance, "R", period, period.AddMonths(1).AddDays(-1), 2_500m);
        StubOrders(customer, 88_001);

        var runId = await RunAsync(finance, period, customer.Marker);
        (await (await finance.RunCommandAsync(runId, "approve")).ReadJsonAsync()).GetProperty("status").GetString().ShouldBe("Approved");
        (await factory.WaitForRunExportAsync(finance, runId)).ShouldBeOneOf("Exported", "ExportedWithErrors");
        var basisId = (await BasisOfAsync(finance, runId, customer))!.Value.GetProperty("id").GetGuid();
        var (exported, _) = await BasisAsync(finance, basisId);
        exported.GetProperty("orderNo").GetString().ShouldBe("88001");
        var key = (await ChargesAsync(c => c.BasisId == basisId)).ShouldHaveSingleItem().Key;
        OrdersPosted(customer).ShouldBe(1);

        // The database comes back from a backup taken before the send was recorded: the basis waits to be sent, its charge is
        // committed, the approval event was never delivered and no outbound operation exists. PowerOffice has the order.
        var reference = await ReferenceAsync(basisId);
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<BillingDbContext>();
            await db.Database.ExecuteSqlInterpolatedAsync($"""
                UPDATE billing.BillingBases SET Status = N'Approved', OrderNo = NULL, ExportedAt = NULL, SendStartedAt = NULL WHERE Id = {basisId};
                DELETE FROM billing.BillingExportAttempts WHERE BasisId = {basisId};
                UPDATE billing.Charges SET Status = N'Committed' WHERE BasisId = {basisId};
                UPDATE billing.OutboxMessages SET ProcessedAt = NULL, LockedUntil = NULL
                WHERE Type LIKE N'%BillingBasisApproved%' AND Payload LIKE {"%" + basisId + "%"};
                """);
            var integration = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
            await integration.OutboundOperations.Where(o => o.EntityId == basisId).ExecuteDeleteAsync();
        }

        factory.PowerOffice.Given(Request.Create().WithPath("/v2/SalesOrders").UsingGet().WithParam("externalImportReferences", reference))
            .AtPriority(1)
            .RespondWith(JsonReply(new[] { new { Id = 88_001, OrderNo = 88_001, CustomerId = 1, ExternalImportReference = reference, Status = "Draft" } }));

        // The worker delivers the approval again; the send finds the order by its reference instead of creating another.
        for (var attempt = 0; attempt < 10 && (await BasisAsync(finance, basisId)).Basis.GetProperty("status").GetString() != "Exported"; attempt++)
        {
            await factory.ProcessEventsAndOutboundAsync();
        }

        var (restored, _) = await BasisAsync(finance, basisId);
        restored.GetProperty("status").GetString().ShouldBe("Exported");
        restored.GetProperty("orderNo").GetString().ShouldBe("88001");
        OrdersPosted(customer).ShouldBe(1);
        (await ChargesAsync(c => c.Key == key && c.Status != ChargeStatus.Released)).ShouldHaveSingleItem().Status.ShouldBe(ChargeStatus.ExportConfirmed);
    }

    private async Task<string> ReferenceAsync(Guid basisId)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<BillingDbContext>().BillingBases.Where(b => b.Id == basisId).Select(b => b.IdempotencyKey).SingleAsync();
    }

    [Fact]
    public async Task AC07_lines_billed_before_the_register_are_reported_with_their_amounts_and_hold_their_days_until_finance_decides()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "register-admin");
        var finance = factory.ClientAs(CrmRoles.Finance, userKey: "register-finance");
        var period = new DateOnly(2032, 9, 1);
        var end = period.AddMonths(1).AddDays(-1);
        var customer = await CustomerAsync(admin, finance, "L", period, end, 4_000m, link: false);
        var neighbour = await CustomerAsync(admin, finance, "K", period, end, 1_500m, link: false);

        // The month was billed by the previous version: a closed run, an exported basis and a line without a charge key that
        // names the contract line. The backfill made it a legacy charge, as the migration does (ADR-013).
        var legacyRun = Guid.NewGuid();
        var legacyBasis = Guid.NewGuid();
        var legacyLine = Guid.NewGuid();
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<BillingDbContext>();
            var refs = JsonSerializer.Serialize(new { contractId = customer.ContractId, contractLineId = customer.LineId });
            await db.Database.ExecuteSqlInterpolatedAsync($"""
                INSERT INTO billing.BillingRuns (Id, PeriodStart, PeriodEnd, Kind, Status, CollectedAt, ApprovedAt, RequiresSecondApproval, ExportedAt, ClosedAt, Notes, ContentRevision, ApprovedRevision, ApprovedDigest, CreatedAt, IsDeleted)
                VALUES ({legacyRun}, {period}, {end}, N'Regular', N'Closed', SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(), 0, SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(), {customer.Marker}, 0, 0, N'legacy', SYSDATETIMEOFFSET(), 0);
                INSERT INTO billing.BillingBases (Id, RunId, OrganizationId, IdempotencyKey, TotalExVat, PreviousPeriodTotal, Status, OrderNo, ExportedAt, Revision, CreatedAt, IsDeleted)
                VALUES ({legacyBasis}, {legacyRun}, {customer.OrganizationId}, {"legacy-" + legacyBasis}, 4000, 0, N'Exported', N'5501', SYSDATETIMEOFFSET(), 0, SYSDATETIMEOFFSET(), 0);
                INSERT INTO billing.BillingLines (Id, BasisId, [Group], ProductId, Description, Quantity, UnitPrice, DiscountPct, VatRate, LineTotal, SourceRefs, ManuallyAdjusted, Origin, Decision, Conflict, CreatedAt, IsDeleted)
                VALUES ({legacyLine}, {legacyBasis}, N'Subscription', {customer.ProductId}, N'Managed services (01.09.2032–30.09.2032)', 1, 4000, 0, 25, 4000, {refs}, 0, N'Collected', N'None', N'None', SYSDATETIMEOFFSET(), 0);
                """);
            db.Charges.Add(Charge.Legacy($"legacy:{legacyLine:N}", customer.OrganizationId, legacyRun, legacyBasis, legacyLine, 4_000m, period, end, customer.LineId,
                "Unprovable: billed before charge keys and its references prove no obligation.", DateTimeOffset.UtcNow));
            await db.SaveChangesAsync();
        }

        // The report names the customer, the month, the line and its amount; others than Finance do not see it.
        (await factory.ClientAs(CrmRoles.ServiceLead, userKey: "register-lead").GetAsync($"{Billing}/charges/legacy")).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        var report = await finance.GetFromJsonAsync<JsonElement>($"{Billing}/charges/legacy");
        var item = report.GetProperty("items").EnumerateArray().Single(i => i.GetProperty("organization").GetProperty("id").GetGuid() == customer.OrganizationId);
        item.GetProperty("amount").GetDecimal().ShouldBe(4_000m);
        item.GetProperty("periodStart").GetString().ShouldBe("2032-09-01");
        item.GetProperty("description").GetString()!.ShouldStartWith("Managed services");
        report.GetProperty("count").GetInt32().ShouldBeGreaterThanOrEqualTo(1);
        report.GetProperty("amount").GetDecimal().ShouldBeGreaterThanOrEqualTo(4_000m);
        report.GetProperty("byReason").EnumerateArray().ShouldContain(g => g.GetProperty("reason").GetString()!.StartsWith("Unprovable", StringComparison.Ordinal));

        // A supplementary run of the month leaves the line out while it is unresolved, and bills the neighbour.
        var supplementary = await RunAsync(finance, period, customer.Marker, supplementary: true);
        (await BasisOfAsync(finance, supplementary, customer)).ShouldBeNull();
        (await BasisOfAsync(finance, supplementary, neighbour))!.Value.GetProperty("totalExVat").GetDecimal().ShouldBe(1_500m);

        // Finance finds it never reached the customer: released, and the next collect bills the month.
        var chargeId = item.GetProperty("id").GetGuid();
        (await finance.PostAsJsonAsync($"{Billing}/charges/{chargeId}/legacy-decision", new { billed = false, reason = "Ikke fakturert i gammelt system" }))
            .StatusCode.ShouldBe(HttpStatusCode.PreconditionRequired);
        (await finance.PostWithETagAsync($"{Billing}/charges/{chargeId}/legacy-decision", new { billed = false, reason = "Ikke fakturert i gammelt system" }, item.GetProperty("etag").GetString()!))
            .StatusCode.ShouldBe(HttpStatusCode.NoContent);
        var again = await finance.GetFromJsonAsync<JsonElement>($"{Billing}/charges/legacy");
        again.GetProperty("items").EnumerateArray().ShouldNotContain(i => i.GetProperty("id").GetGuid() == chargeId);
        (await finance.RunCommandAsync(supplementary, "collect")).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await BasisOfAsync(finance, supplementary, customer))!.Value.GetProperty("totalExVat").GetDecimal().ShouldBe(4_000m);
    }

    [Fact]
    public async Task An_exported_line_is_corrected_by_a_new_charge_that_refers_to_it_and_a_credit_stays_in_the_accounting_system()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "register-admin");
        var finance = factory.ClientAs(CrmRoles.Finance, userKey: "register-finance");
        var period = new DateOnly(2032, 10, 1);
        var customer = await CustomerAsync(admin, finance, "K", period, period.AddMonths(1).AddDays(-1), 6_000m);
        StubOrders(customer, 32_010);
        var runId = await RunAsync(finance, period, customer.Marker);
        var open = (await BasisOfAsync(finance, runId, customer))!.Value;
        var openLine = open.GetProperty("lines").EnumerateArray().Single().GetProperty("id").GetGuid();
        var notYet = await finance.PostAsJsonAsync($"{Billing}/bases/{open.GetProperty("id").GetGuid()}/lines/{openLine}/corrections", new { amount = 500m, reason = "Glemt tillegg" });
        notYet.StatusCode.ShouldBe(HttpStatusCode.Conflict);
        (await notYet.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe("BIL_NOT_EXPORTED");

        (await (await finance.RunCommandAsync(runId, "approve")).ReadJsonAsync()).GetProperty("status").GetString().ShouldBe("Approved");
        (await factory.WaitForRunExportAsync(finance, runId)).ShouldBeOneOf("Exported", "ExportedWithErrors");
        var basisId = open.GetProperty("id").GetGuid();
        var url = $"{Billing}/bases/{basisId}/lines/{openLine}/corrections";

        var credit = await finance.PostAsJsonAsync(url, new { amount = -500m, reason = "Rabatt" });
        credit.StatusCode.ShouldBe(HttpStatusCode.Conflict);
        (await credit.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe("BIL_CREDIT_NOT_ENABLED");
        (await factory.ClientAs(CrmRoles.ServiceLead, userKey: "register-lead").PostAsJsonAsync(url, new { amount = 500m, reason = "x" })).StatusCode
            .ShouldBe(HttpStatusCode.Forbidden);

        var added = await finance.PostAsJsonAsync(url, new { amount = 500m, reason = "Glemt tillegg for ekstra lisens" });
        added.StatusCode.ShouldBe(HttpStatusCode.Created);
        var correction = await added.ReadJsonAsync();
        correction.GetProperty("amount").GetDecimal().ShouldBe(500m);
        correction.GetProperty("correctsLineId").GetGuid().ShouldBe(openLine);

        // The exported order is untouched; the next run that collects the correction bills it once, pointing at the line.
        (await BasisAsync(finance, basisId)).Basis.GetProperty("totalExVat").GetDecimal().ShouldBe(6_000m);
        var correctionId = correction.GetProperty("id").GetGuid();
        var nextRun = await RunAsync(finance, new DateOnly(2033, 8, 1), customer.Marker, collect: false);
        (await finance.RunCommandAsync(nextRun, "collect")).StatusCode.ShouldBe(HttpStatusCode.OK);
        var holder = await factory.QueuedChargeBasisAsync(finance, nextRun, c => c.Id == correctionId);
        holder.GetProperty("lines").EnumerateArray().ShouldContain(l => l.GetProperty("lineTotal").GetDecimal() == 500m && l.GetProperty("group").GetString() == "OneOff");
        var charge = (await ChargesAsync(c => c.Key == $"pending:{correctionId:N}" && c.Status != ChargeStatus.Released)).ShouldHaveSingleItem();
        charge.CorrectsLineId.ShouldBe(openLine);
        charge.Amount.ShouldBe(500m);
    }

    [Fact]
    public async Task A_project_phase_completed_again_after_a_reopen_brings_back_the_same_queued_item()
    {
        var sales = factory.ClientAs(CrmRoles.Sales, userKey: "register-sales");
        var marker = $"J{Guid.NewGuid():N}"[..10];
        var organizationId = await sales.CreateOrganizationAsync(new { name = $"{marker} Prosjekt AS", orgNumber = TestData.OrgNumber(), status = "Customer" });
        var project = await (await sales.PostAsJsonAsync("/api/v1/projects", new
        {
            organizationId, name = $"{marker} Migrering", type = "M365Migration", billingModel = "PerPhase", startDate = "2026-09-01", endDate = (string?)null,
            budgetHours = 10m, budgetAmount = 10_000m,
        })).ReadJsonAsync();
        var projectId = project.GetProperty("id").GetGuid();
        var withPhase = await (await sales.PostAsJsonAsync($"/api/v1/projects/{projectId}/phases", new
        {
            name = "Pilot", plannedStart = (string?)null, plannedEnd = (string?)null, plannedHours = 5m, fee = 7_000m, billOnCompletion = true, productId = (Guid?)null,
        })).ReadJsonAsync();
        var phaseId = withPhase.GetProperty("phases").EnumerateArray().Single().GetProperty("id").GetGuid();
        async Task SetStatusAsync(string status) =>
            (await sales.PostAsJsonAsync($"/api/v1/projects/{projectId}/phases/{phaseId}/status", new { status })).StatusCode.ShouldBe(HttpStatusCode.OK);
        async Task<PendingCharge?> QueuedAsync()
        {
            await using var scope = factory.Services.CreateAsyncScope();
            return await scope.ServiceProvider.GetRequiredService<BillingDbContext>().PendingCharges.IgnoreQueryFilters().AsNoTracking()
                .SingleOrDefaultAsync(c => c.SourceType == "project-phase" && c.SourceLineId == phaseId);
        }

        await SetStatusAsync("Completed");
        await factory.EventuallyAsync(async () => await QueuedAsync() is { IsDeleted: false });
        var first = (await QueuedAsync())!;

        await SetStatusAsync("Active");
        await factory.EventuallyAsync(async () => await QueuedAsync() is { IsDeleted: true });

        // Before the fix the handler inserted a second row and the unique index failed it on every delivery.
        await SetStatusAsync("Completed");
        await factory.EventuallyAsync(async () => await QueuedAsync() is { IsDeleted: false });
        var again = (await QueuedAsync())!;
        again.Id.ShouldBe(first.Id);
        again.UnitPrice.ShouldBe(7_000m);
        await using var check = factory.Services.CreateAsyncScope();
        (await check.ServiceProvider.GetRequiredService<Crm.Projects.Persistence.ProjectsDbContext>().OutboxMessages.AsNoTracking()
            .CountAsync(m => m.Payload.Contains(phaseId.ToString()) && m.LastError != null)).ShouldBe(0);
    }

    [Fact]
    public async Task An_order_made_by_hand_during_an_incident_is_recorded_so_no_later_run_bills_it_again()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "register-admin");
        var finance = factory.ClientAs(CrmRoles.Finance, userKey: "register-finance");
        var period = new DateOnly(2033, 9, 1);
        // Not linked: the export fails before anything is sent, as when PowerOffice was out of reach (runbook 07).
        var customer = await CustomerAsync(admin, finance, "I", period, period.AddMonths(1).AddDays(-1), 3_300m, link: false);
        var runId = await RunAsync(finance, period, customer.Marker);
        (await (await finance.RunCommandAsync(runId, "approve")).ReadJsonAsync()).GetProperty("status").GetString().ShouldBe("Approved");
        (await factory.WaitForRunExportAsync(finance, runId)).ShouldBeOneOf("Exported", "ExportedWithErrors");
        var basisId = (await BasisOfAsync(finance, runId, customer))!.Value.GetProperty("id").GetGuid();
        var (failed, etag) = await BasisAsync(finance, basisId);
        failed.GetProperty("status").GetString().ShouldBe("Failed");

        // Finance invoiced it by hand in PowerOffice and records that order instead of cancelling the basis.
        var recorded = await finance.PostWithETagAsync($"{Billing}/bases/{basisId}/reconcile", new { created = true, orderNo = "manual-2033-09", reason = "Fakturert manuelt under hendelse" }, etag);
        recorded.StatusCode.ShouldBe(HttpStatusCode.OK);
        (await recorded.ReadJsonAsync()).GetProperty("status").GetString().ShouldBe("Exported");
        (await ChargesAsync(c => c.BasisId == basisId)).ShouldHaveSingleItem().Status.ShouldBe(ChargeStatus.ExportConfirmed);

        (await finance.PostAsync($"{Billing}/runs/{runId}/close", null)).StatusCode.ShouldBe(HttpStatusCode.OK);
        var supplementary = await RunAsync(finance, period, customer.Marker, supplementary: true);
        (await BasisOfAsync(finance, supplementary, customer)).ShouldBeNull();
    }
}
