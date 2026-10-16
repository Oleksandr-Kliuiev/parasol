using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crm.Authorization;
using Crm.Billing.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crm.IntegrationTests;

/// <summary>
/// Charge identity through the API and SQL Server (DEV-01, docs/adr/ADR-011). Every test bills months of its own (2030) and
/// looks only at its own customers, as the database is shared with the rest of the suite.
/// </summary>
public class ChargeIdentityApiTests(CrmWebFactory factory)
{
    private const string Billing = "/api/v1/billing";
    private const string Contracts = "/api/v1/contracts";

    private sealed record Customer(Guid OrganizationId, Guid ContractId, Guid LineId, Guid ProductId, string Marker);

    private static async Task<Customer> CustomerAsync(
        HttpClient admin, HttpClient finance, string prefix, DateOnly contractStart, DateOnly contractEnd, decimal monthlyFee, string? name = null)
    {
        var marker = $"{prefix}{Guid.NewGuid():N}"[..10];
        var organizationId = await admin.CreateOrganizationAsync(new { name = name ?? $"{marker} Avgift AS", status = "Customer" });
        var productId = await CatalogApiTests.CreateProductAsync(finance, CatalogApiTests.Product(CatalogApiTests.Sku("KEY"), "Managed services", monthlyFee, monthlyFee / 2));
        var contractId = (await (await admin.PostAsJsonAsync(Contracts, new
        {
            organizationId, title = $"{marker} Drift", type = "Msp", startDate = contractStart, endDate = contractEnd, autoRenew = false,
            renewalTermMonths = 0, noticePeriodDays = 30, invoiceFrequency = "Monthly", invoiceTiming = "InAdvance", indexation = false,
        })).ReadJsonAsync()).GetProperty("id").GetGuid();
        var line = await (await admin.PostAsJsonAsync($"{Contracts}/{contractId}/lines", new
        {
            productId, quantityModel = "Fixed", quantity = 1m, unitPrice = monthlyFee, validFrom = contractStart,
        })).ReadJsonAsync();
        var lineId = line.GetProperty("lines").EnumerateArray().Single().GetProperty("id").GetGuid();
        (await admin.PostAsync($"{Contracts}/{contractId}/activate", null)).StatusCode.ShouldBe(HttpStatusCode.OK);
        return new Customer(organizationId, contractId, lineId, productId, marker);
    }

    private static async Task<Guid> RunAsync(HttpClient finance, DateOnly period, string marker)
    {
        var created = await finance.PostAsJsonAsync($"{Billing}/runs", new { year = period.Year, month = period.Month, notes = marker });
        created.StatusCode.ShouldBe(HttpStatusCode.Created);
        var runId = (await created.ReadJsonAsync()).GetProperty("id").GetGuid();
        await CollectAsync(finance, runId);
        return runId;
    }

    private static async Task CollectAsync(HttpClient finance, Guid runId) =>
        (await finance.RunCommandAsync(runId, "collect")).StatusCode.ShouldBe(HttpStatusCode.OK);

    private static async Task<Guid> BasisIdAsync(HttpClient finance, Guid runId, Guid organizationId, string marker) =>
        (await finance.GetFromJsonAsync<JsonElement>($"{Billing}/runs/{runId}/bases?search={marker}"))
        .EnumerateArray()
        .Single(b => b.GetProperty("organization").GetProperty("id").GetGuid() == organizationId)
        .GetProperty("id").GetGuid();

    private static async Task<(JsonElement Basis, string Etag)> BasisAsync(HttpClient client, Guid basisId)
    {
        var response = await client.GetAsync($"{Billing}/bases/{basisId}");
        response.StatusCode.ShouldBe(HttpStatusCode.OK);
        return (await response.ReadJsonAsync(), response.Headers.ETag!.Tag);
    }

    private static JsonElement CollectedLine(JsonElement basis) =>
        basis.GetProperty("lines").EnumerateArray().Single(l => l.GetProperty("origin").GetString() == "Collected");

    [Fact]
    public async Task An_override_and_a_manual_line_each_stay_once_through_ten_collects()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "charge-admin");
        var finance = factory.ClientAs(CrmRoles.Finance, userKey: "charge-finance");
        var period = new DateOnly(2030, 1, 1);
        var customer = await CustomerAsync(admin, finance, "K", period, period.AddMonths(1).AddDays(-1), 1_000m);
        var runId = await RunAsync(finance, period, customer.Marker);
        var basisId = await BasisIdAsync(finance, runId, customer.OrganizationId, customer.Marker);

        var (basis, etag) = await BasisAsync(finance, basisId);
        var line = CollectedLine(basis);
        var adjusted = await finance.PutWithETagAsync($"{Billing}/bases/{basisId}/lines/{line.GetProperty("id").GetGuid()}", new
        {
            quantity = 1m, unitPrice = 900m, discountPct = 0m, description = line.GetProperty("description").GetString(), reason = "Price agreed for 2030",
        }, etag);
        adjusted.StatusCode.ShouldBe(HttpStatusCode.OK);
        var withManual = await finance.PostWithETagAsync(
            $"{Billing}/bases/{basisId}/lines", new { description = "Etablering", quantity = 1m, unitPrice = 2_500m }, (await BasisAsync(finance, basisId)).Etag);
        withManual.StatusCode.ShouldBe(HttpStatusCode.OK);

        for (var i = 0; i < 10; i++)
        {
            await CollectAsync(finance, runId);
        }

        var (after, _) = await BasisAsync(finance, basisId);
        after.GetProperty("lines").GetArrayLength().ShouldBe(2);
        after.GetProperty("totalExVat").GetDecimal().ShouldBe(3_400m);
        after.GetProperty("conflicts").GetInt32().ShouldBe(0);
        var overridden = CollectedLine(after);
        overridden.GetProperty("id").GetGuid().ShouldBe(line.GetProperty("id").GetGuid());
        overridden.GetProperty("decision").GetString().ShouldBe("Override");
        overridden.GetProperty("lineTotal").GetDecimal().ShouldBe(900m);
        overridden.GetProperty("sourceLineTotal").GetDecimal().ShouldBe(1_000m);
        overridden.GetProperty("changeReason").GetString().ShouldBe("Price agreed for 2030");
        overridden.GetProperty("changedBy").GetProperty("name").GetString().ShouldBe("Test charge-finance");
        overridden.GetProperty("sourceKey").GetString()!.ShouldStartWith("contract:");
        after.GetProperty("lines").EnumerateArray().Single(l => l.GetProperty("origin").GetString() == "Manual")
            .GetProperty("lineTotal").GetDecimal().ShouldBe(2_500m);

        // Money of the source stays hidden from roles without finance.read (SEC-AZ-04).
        var lead = factory.ClientAs(CrmRoles.ServiceLead, userKey: "charge-lead");
        var asLead = CollectedLine((await BasisAsync(lead, basisId)).Basis);
        asLead.TryGetProperty("sourceLineTotal", out _).ShouldBeFalse();
        asLead.TryGetProperty("sourceUnitPrice", out _).ShouldBeFalse();
    }

    [Fact]
    public async Task A_price_change_at_the_source_after_an_override_waits_for_finance_before_approval()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "charge-admin");
        var finance = factory.ClientAs(CrmRoles.Finance, userKey: "charge-finance");
        var period = new DateOnly(2030, 2, 1);
        var customer = await CustomerAsync(admin, finance, "C", period.AddMonths(-2), period.AddMonths(1).AddDays(-1), 1_000m);
        var runId = await RunAsync(finance, period, customer.Marker);
        var basisId = await BasisIdAsync(finance, runId, customer.OrganizationId, customer.Marker);
        var (basis, etag) = await BasisAsync(finance, basisId);
        var line = CollectedLine(basis);
        (await finance.PutWithETagAsync($"{Billing}/bases/{basisId}/lines/{line.GetProperty("id").GetGuid()}", new
        {
            quantity = 1m, unitPrice = 900m, discountPct = 0m, description = line.GetProperty("description").GetString(), reason = "Loyalty discount",
        }, etag)).StatusCode.ShouldBe(HttpStatusCode.OK);

        // The contract price goes up from the first day of the billed month: same service, same days, other price.
        (await admin.PostAsJsonAsync($"{Contracts}/{customer.ContractId}/lines/{customer.LineId}/revise", new
        {
            quantity = 1m, unitPrice = 1_100m, effectiveFrom = period,
        })).StatusCode.ShouldBe(HttpStatusCode.OK);
        await CollectAsync(finance, runId);

        var (changed, changedEtag) = await BasisAsync(finance, basisId);
        var conflicted = CollectedLine(changed);
        conflicted.GetProperty("conflict").GetString().ShouldBe("SourceChanged");
        conflicted.GetProperty("lineTotal").GetDecimal().ShouldBe(900m);
        conflicted.GetProperty("sourceLineTotal").GetDecimal().ShouldBe(1_100m);
        (await finance.GetFromJsonAsync<JsonElement>($"{Billing}/runs/{runId}")).GetProperty("conflicts").GetInt32().ShouldBe(1);

        var blocked = await finance.RunCommandAsync(runId, "approve");
        blocked.StatusCode.ShouldBe(HttpStatusCode.Conflict);
        (await blocked.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe("BIL_UNRESOLVED_CONFLICTS");
        (await finance.GetFromJsonAsync<JsonElement>($"{Billing}/runs/{runId}")).GetProperty("status").GetString().ShouldBe("Collected");

        (await finance.PostWithETagAsync($"{Billing}/bases/{basisId}/lines/{conflicted.GetProperty("id").GetGuid()}/keep", new { reason = "" }, changedEtag))
            .StatusCode.ShouldBe(HttpStatusCode.BadRequest);
        var kept = await finance.PostWithETagAsync(
            $"{Billing}/bases/{basisId}/lines/{conflicted.GetProperty("id").GetGuid()}/keep", new { reason = "Discount survives the price change" }, changedEtag);
        kept.StatusCode.ShouldBe(HttpStatusCode.OK);
        var resolved = await kept.ReadJsonAsync();
        resolved.GetProperty("conflicts").GetInt32().ShouldBe(0);
        resolved.GetProperty("totalExVat").GetDecimal().ShouldBe(900m);
        (await (await finance.RunCommandAsync(runId, "approve")).ReadJsonAsync()).GetProperty("status").GetString().ShouldBe("Approved");
    }

    [Fact]
    public async Task An_excluded_line_does_not_come_back_and_the_history_says_who_and_why()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "charge-admin");
        var finance = factory.ClientAs(CrmRoles.Finance, userKey: "charge-finance");
        var period = new DateOnly(2030, 3, 1);
        var customer = await CustomerAsync(admin, finance, "X", period, period.AddMonths(1).AddDays(-1), 1_000m);
        var runId = await RunAsync(finance, period, customer.Marker);
        var basisId = await BasisIdAsync(finance, runId, customer.OrganizationId, customer.Marker);
        var (basis, etag) = await BasisAsync(finance, basisId);
        var lineId = CollectedLine(basis).GetProperty("id").GetGuid();

        // A collected line is not deleted without a word: DELETE asks for the reason, exclude records it.
        var deleted = await finance.DeleteWithETagAsync($"{Billing}/bases/{basisId}/lines/{lineId}", etag);
        deleted.StatusCode.ShouldBe(HttpStatusCode.BadRequest);
        (await deleted.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe("BIL_REASON_REQUIRED");
        (await finance.PostWithETagAsync($"{Billing}/bases/{basisId}/lines/{lineId}/exclude", new { reason = "Delivered free of charge" }, etag))
            .StatusCode.ShouldBe(HttpStatusCode.OK);

        for (var i = 0; i < 3; i++)
        {
            await CollectAsync(finance, runId);
        }

        var (after, _) = await BasisAsync(finance, basisId);
        after.GetProperty("totalExVat").GetDecimal().ShouldBe(0m);
        var excluded = after.GetProperty("lines").EnumerateArray().ShouldHaveSingleItem();
        excluded.GetProperty("id").GetGuid().ShouldBe(lineId);
        excluded.GetProperty("decision").GetString().ShouldBe("Exclusion");
        excluded.GetProperty("changeReason").GetString().ShouldBe("Delivered free of charge");
        excluded.GetProperty("changedBy").GetProperty("name").GetString().ShouldBe("Test charge-finance");
        excluded.TryGetProperty("changedAt", out var changedAt).ShouldBeTrue();
        changedAt.ValueKind.ShouldBe(JsonValueKind.String);

        var history = await finance.GetFromJsonAsync<JsonElement>($"/api/v1/audit/entities/billing/BillingLine/{lineId}");
        history.GetProperty("items").EnumerateArray().ShouldContain(e =>
            e.GetProperty("userName").GetString() == "Test charge-finance" &&
            e.GetProperty("changes").GetRawText().Contains("Exclusion", StringComparison.Ordinal) &&
            e.GetProperty("changes").GetRawText().Contains("Delivered free of charge", StringComparison.Ordinal));
    }

    [Fact]
    public async Task A_subsidiary_billed_through_its_parent_keeps_its_customer_and_parallel_collects_do_not_duplicate_it()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "charge-admin");
        var finance = factory.ClientAs(CrmRoles.Finance, userKey: "charge-finance");
        var period = new DateOnly(2030, 4, 1);
        var end = period.AddMonths(1).AddDays(-1);
        var marker = $"G{Guid.NewGuid():N}"[..10];
        var parent = await CustomerAsync(admin, finance, "P", period, end, 1_000m, $"{marker} Konsern AS");
        var child = await CustomerAsync(admin, finance, "D", period, end, 500m, $"{marker} Datter AS");
        var childEtag = (await admin.GetAsync($"/api/v1/customers/organizations/{child.OrganizationId}")).Headers.ETag!.Tag;
        (await admin.PutWithETagAsync($"/api/v1/customers/organizations/{child.OrganizationId}/parent", new { parentId = parent.OrganizationId, billedThroughParent = true }, childEtag))
            .StatusCode.ShouldBe(HttpStatusCode.OK);

        var runId = await RunAsync(finance, period, marker);
        await CollectAsync(finance, runId);
        // Three tabs collect the revision they all saw.
        var seen = await finance.RunETagAsync(runId);
        var responses = await Task.WhenAll(Enumerable.Range(0, 3).Select(_ => finance.PostWithETagAsync($"{Billing}/runs/{runId}/collect", new { }, seen)));

        // Parallel collects never fail with a server error and never leave a second basis or line behind.
        responses.ShouldAllBe(r => r.StatusCode == HttpStatusCode.OK || r.StatusCode == HttpStatusCode.PreconditionFailed || r.StatusCode == HttpStatusCode.Conflict);
        await CollectAsync(finance, runId);
        var bases = (await finance.GetFromJsonAsync<JsonElement>($"{Billing}/runs/{runId}/bases?search={marker}")).EnumerateArray().ToList();
        var basis = bases.ShouldHaveSingleItem();
        basis.GetProperty("organization").GetProperty("id").GetGuid().ShouldBe(parent.OrganizationId);
        var (detail, _) = await BasisAsync(finance, basis.GetProperty("id").GetGuid());
        var lines = detail.GetProperty("lines").EnumerateArray().ToList();
        lines.Count.ShouldBe(2);
        lines.Select(l => l.GetProperty("sourceKey").GetString()).Distinct().Count().ShouldBe(2);
        detail.GetProperty("totalExVat").GetDecimal().ShouldBe(1_500m);
        var childLine = lines.Single(l => l.GetProperty("description").GetString()!.StartsWith($"{marker} Datter AS:", StringComparison.Ordinal));
        childLine.GetProperty("sourceOrganization").GetProperty("id").GetGuid().ShouldBe(child.OrganizationId);
        lines.Single(l => l.GetProperty("id").GetGuid() != childLine.GetProperty("id").GetGuid())
            .GetProperty("sourceOrganization").ValueKind.ShouldBe(JsonValueKind.Null);
    }

    [Fact]
    public async Task An_approved_basis_refuses_every_change_with_the_agreed_code()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "charge-admin");
        var finance = factory.ClientAs(CrmRoles.Finance, userKey: "charge-finance");
        var period = new DateOnly(2030, 5, 1);
        var customer = await CustomerAsync(admin, finance, "L", period, period.AddMonths(1).AddDays(-1), 1_000m);
        var runId = await RunAsync(finance, period, customer.Marker);
        var basisId = await BasisIdAsync(finance, runId, customer.OrganizationId, customer.Marker);
        (await (await finance.RunCommandAsync(runId, "approve")).ReadJsonAsync()).GetProperty("status").GetString().ShouldBe("Approved");
        var (basis, etag) = await BasisAsync(finance, basisId);
        var lineId = CollectedLine(basis).GetProperty("id").GetGuid();
        var url = $"{Billing}/bases/{basisId}/lines";

        var attempts = new[]
        {
            await finance.PutWithETagAsync($"{url}/{lineId}", new { quantity = 1m, unitPrice = 1m, discountPct = 0m, description = "x", reason = "Late" }, etag),
            await finance.PostWithETagAsync($"{url}/{lineId}/exclude", new { reason = "Late" }, etag),
            await finance.PostWithETagAsync($"{url}/{lineId}/revert", new { }, etag),
            await finance.PostWithETagAsync($"{url}/{lineId}/keep", new { reason = "Late" }, etag),
            await finance.PostWithETagAsync(url, new { description = "Late", quantity = 1m, unitPrice = 1m }, etag),
        };

        foreach (var attempt in attempts)
        {
            attempt.StatusCode.ShouldBe(HttpStatusCode.Conflict);
            (await attempt.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe("BIL_BASIS_LOCKED");
        }

        var collect = await finance.RunCommandAsync(runId, "collect");
        collect.StatusCode.ShouldBe(HttpStatusCode.Conflict);
        (await collect.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe("BIL_INVALID_STATUS");
        (await BasisAsync(finance, basisId)).Basis.GetProperty("totalExVat").GetDecimal().ShouldBe(1_000m);
    }

    [Fact]
    public async Task Lines_collected_before_charge_keys_are_replaced_or_held_for_finance_and_never_billed_twice()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "charge-admin");
        var finance = factory.ClientAs(CrmRoles.Finance, userKey: "charge-finance");
        var period = new DateOnly(2030, 6, 1);
        var end = period.AddMonths(1).AddDays(-1);
        var plain = await CustomerAsync(admin, finance, "U", period, end, 1_000m);
        var corrected = await CustomerAsync(admin, finance, "V", period, end, 1_000m);
        var runId = await RunAsync(finance, period, plain.Marker);
        var plainBasis = await BasisIdAsync(finance, runId, plain.OrganizationId, plain.Marker);
        var correctedBasis = await BasisIdAsync(finance, runId, corrected.OrganizationId, corrected.Marker);

        // Put both bases into the shape the application wrote before DEV-01: no charge key, and one line corrected to 900.
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<BillingDbContext>();
            await db.Database.ExecuteSqlInterpolatedAsync($"""
                UPDATE billing.BillingLines SET SourceKey = NULL, SourceSignature = NULL, SourceQuantity = NULL, SourceUnitPrice = NULL,
                    SourceDiscountPct = NULL, SourceDescription = NULL, SourceOrganizationId = NULL WHERE BasisId IN ({plainBasis}, {correctedBasis});
                UPDATE billing.BillingLines SET ManuallyAdjusted = 1, UnitPrice = 900, LineTotal = 900 WHERE BasisId = {correctedBasis};
                UPDATE billing.BillingBases SET TotalExVat = 900 WHERE Id = {correctedBasis};
                INSERT INTO billing.BillingLines (Id, BasisId, [Group], Description, Quantity, UnitPrice, DiscountPct, VatRate, LineTotal, ManuallyAdjusted, CreatedAt, IsDeleted)
                VALUES (NEWID(), {plainBasis}, 'OneOff', 'Added by hand in the old version', 1, 250, 0, 25, 250, 1, SYSDATETIMEOFFSET(), 0);
                """);
        }

        var report = await finance.GetFromJsonAsync<JsonElement>($"{Billing}/legacy-lines");
        report.GetProperty("openPlainLines").GetInt32().ShouldBeGreaterThanOrEqualTo(1);
        report.GetProperty("openCorrectedLines").GetInt32().ShouldBeGreaterThanOrEqualTo(1);

        await CollectAsync(finance, runId);

        // The plain line is replaced by its keyed successor: still one line of 1 000. A line the old version added by hand
        // (no source references) stays as a manual line, without a conflict.
        var (plainAfter, _) = await BasisAsync(finance, plainBasis);
        CollectedLine(plainAfter).GetProperty("sourceKey").GetString()!.ShouldStartWith("contract:");
        var oldManual = plainAfter.GetProperty("lines").EnumerateArray().Single(l => l.GetProperty("origin").GetString() == "Manual");
        oldManual.GetProperty("lineTotal").GetDecimal().ShouldBe(250m);
        plainAfter.GetProperty("conflicts").GetInt32().ShouldBe(0);
        plainAfter.GetProperty("totalExVat").GetDecimal().ShouldBe(1_250m);

        // The corrected line cannot be matched safely: it is held next to the keyed source line and blocks approval.
        var (held, heldEtag) = await BasisAsync(finance, correctedBasis);
        var legacy = held.GetProperty("lines").EnumerateArray().Single(l => l.GetProperty("conflict").GetString() == "LegacyUnmatched");
        legacy.GetProperty("lineTotal").GetDecimal().ShouldBe(900m);
        held.GetProperty("conflicts").GetInt32().ShouldBe(1);
        (await finance.RunCommandAsync(runId, "approve")).StatusCode.ShouldBe(HttpStatusCode.Conflict);

        // Finance drops the old correction: the source is billed once, at its current price.
        var reverted = await finance.PostWithETagAsync($"{Billing}/bases/{correctedBasis}/lines/{legacy.GetProperty("id").GetGuid()}/revert", new { }, heldEtag);
        reverted.StatusCode.ShouldBe(HttpStatusCode.OK);
        var resolved = await reverted.ReadJsonAsync();
        resolved.GetProperty("lines").EnumerateArray().ShouldHaveSingleItem().GetProperty("sourceKey").GetString()!.ShouldStartWith("contract:");
        resolved.GetProperty("totalExVat").GetDecimal().ShouldBe(1_000m);
        resolved.GetProperty("conflicts").GetInt32().ShouldBe(0);
    }

    [Fact]
    public async Task Two_purchases_of_the_same_hour_bank_are_two_charges_and_stay_two()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "charge-admin");
        var finance = factory.ClientAs(CrmRoles.Finance, userKey: "charge-finance");
        var period = new DateOnly(2030, 7, 1);
        var customer = await CustomerAsync(admin, finance, "H", period, period.AddMonths(1).AddDays(-1), 1_000m);
        var hourBankProduct = await CatalogApiTests.CreateProductAsync(finance, CatalogApiTests.Product(
            CatalogApiTests.Sku("KLIPP"), "Klippekort", 1_000m, 400m, type: "HourBank", billingPeriod: "OneTime"));
        (await admin.PostAsJsonAsync($"{Contracts}/{customer.ContractId}/lines", new
        {
            productId = hourBankProduct, quantityModel = "Fixed", quantity = 1m, unitPrice = 1_000m, validFrom = period,
        })).StatusCode.ShouldBe(HttpStatusCode.OK);
        var bankId = (await (await admin.PostAsJsonAsync($"{Contracts}/hour-banks", new
        {
            organizationId = customer.OrganizationId, contractId = customer.ContractId, name = $"{customer.Marker} 10 t", hours = 10m, validFrom = period.AddDays(2),
        })).ReadJsonAsync()).GetProperty("id").GetGuid();
        (await admin.PostAsJsonAsync($"{Contracts}/hour-banks/{bankId}/entries", new { kind = "Purchase", hours = 5m, date = period.AddDays(20) }))
            .StatusCode.ShouldBe(HttpStatusCode.OK);

        var runId = await RunAsync(finance, period, customer.Marker);
        await CollectAsync(finance, runId);

        var basisId = await BasisIdAsync(finance, runId, customer.OrganizationId, customer.Marker);
        var hourBankLines = (await BasisAsync(finance, basisId)).Basis.GetProperty("lines").EnumerateArray()
            .Where(l => l.GetProperty("group").GetString() == "HourBank").ToList();
        hourBankLines.Select(l => l.GetProperty("quantity").GetDecimal()).Order().ShouldBe([5m, 10m]);
        hourBankLines.Select(l => l.GetProperty("sourceKey").GetString()).Distinct().Count().ShouldBe(2);
        hourBankLines.ShouldAllBe(l => l.GetProperty("sourceKey").GetString()!.StartsWith("hourbank:", StringComparison.Ordinal));
    }
}
