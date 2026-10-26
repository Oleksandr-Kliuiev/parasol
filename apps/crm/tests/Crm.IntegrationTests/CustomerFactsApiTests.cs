using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crm.Authorization;
using Crm.Billing.Contracts;
using Microsoft.Extensions.DependencyInjection;

namespace Crm.IntegrationTests;

/// <summary>
/// UX 2026, В6: the customer list says whom to attend to. Every fact is compared with the list behind the matching tab of the
/// customer card, for the same customer and the same caller, so the two cannot tell different stories. The database is shared
/// with classes running in parallel: every customer here carries a marker, and the attention view is read with <c>mine=true</c>
/// for a user of this class's own, except where a test is about the whole list.
/// </summary>
public sealed class CustomerFactsApiTests(CrmWebFactory factory)
{
    private const string Facts = "/api/v1/customers/organizations/facts";
    private const string Attention = "/api/v1/customers/organizations/attention";

    /// <summary>How far ahead an ending contract makes a reason, today included.</summary>
    private const int AttentionDays = 60;

    private static readonly TimeZoneInfo Oslo = TimeZoneInfo.FindSystemTimeZoneById("Europe/Oslo");

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static DateOnly Today => DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, Oslo).DateTime);

    [Fact]
    public async Task Facts_are_the_numbers_the_tabs_of_the_customer_card_show()
    {
        var marker = NewMarker();
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "facts-admin");
        var finance = factory.ClientAs(CrmRoles.Finance, userKey: "facts-finance");
        var customer = await OrganizationAsync(admin, $"{marker} Fakta AS");
        var quiet = await OrganizationAsync(admin, $"{marker} Stille AS");
        var unknown = Guid.NewGuid();
        var now = DateTimeOffset.UtcNow;

        // Work: a task and a meeting past their time (both marked overdue on the timeline), one task later, one without a due time;
        // a completed task and a note are not open.
        await ActivityAsync(admin, customer, "Task", now.AddHours(-2));
        await ActivityAsync(admin, customer, "Meeting", now.AddDays(-1));
        await ActivityAsync(admin, customer, "Task", now.AddDays(3));
        await ActivityAsync(admin, customer, "Task", null);
        var done = await ActivityWithETagAsync(admin, customer, "Task", now.AddDays(-5));
        (await admin.PostWithETagAsync($"/api/v1/activities/{done.Id}/complete", new { }, done.Etag)).StatusCode.ShouldBe(HttpStatusCode.OK);
        await ActivityAsync(admin, customer, "Note", null);

        // Contracts: three active (one open-ended), a draft that is not.
        await ContractAsync(admin, customer, Today.AddDays(45));
        await ContractAsync(admin, customer, Today.AddDays(200));
        await ContractAsync(admin, customer, null);
        await ContractAsync(admin, customer, Today.AddDays(10), activate: false);

        // Hour banks: 6 of 40 left is low (below 20 %); 2 of 10 left is exactly 20 %, not low; a closed bank does not count.
        await HourBankAsync(admin, customer, 40m, 34m);
        await HourBankAsync(admin, customer, 10m, 8m);
        var closed = await HourBankAsync(admin, customer, 5m, 0m);
        (await admin.PostAsync($"/api/v1/contracts/hour-banks/{closed}/close", null, Ct)).StatusCode.ShouldBe(HttpStatusCode.NoContent);

        // Invoices: what the accounting system says is left decides, as on the invoice tab — also for a credited invoice that still
        // shows an amount. Due today is not overdue; nothing left, or a credit note, is not open.
        await InvoicesAsync(
            Invoice($"{marker}-1", customer, 2_500m, Today.AddDays(-1)),
            Invoice($"{marker}-2", customer, 10_000m, Today),
            Invoice($"{marker}-3", customer, 1_000m, Today.AddDays(14)),
            Invoice($"{marker}-4", customer, 0m, Today.AddDays(-10), InvoiceStatus.Paid),
            Invoice($"{marker}-5", customer, -500m, Today.AddDays(-10), InvoiceStatus.Credited),
            Invoice($"{marker}-6", customer, 300m, null),
            Invoice($"{marker}-7", customer, 200m, Today.AddDays(-3), InvoiceStatus.Credited));

        var response = await finance.GetAsync($"{Facts}?ids={customer},{quiet},{unknown}", Ct);
        response.StatusCode.ShouldBe(HttpStatusCode.OK);
        response.Headers.CacheControl!.NoStore.ShouldBeTrue();
        var body = await response.ReadJsonAsync();
        body.GetProperty("asOf").GetString().ShouldBe(Today.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture));
        var items = body.GetProperty("items").EnumerateArray().ToList();
        items.Select(i => i.GetProperty("organizationId").GetGuid()).ShouldBe([customer, quiet, unknown], "one item per id, in the order sent");

        var facts = items[0];
        var work = facts.GetProperty("work");
        (work.GetProperty("open").GetInt32(), work.GetProperty("overdue").GetInt32()).ShouldBe((4, 2));
        var agreements = facts.GetProperty("agreements");
        agreements.GetProperty("active").GetInt32().ShouldBe(3);
        agreements.GetProperty("nextEnd").GetString().ShouldBe(Today.AddDays(45).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture));
        var banks = facts.GetProperty("hourBanks");
        banks.GetProperty("active").GetInt32().ShouldBe(2);
        banks.GetProperty("remainingHours").GetDecimal().ShouldBe(8m);
        banks.GetProperty("purchasedHours").GetDecimal().ShouldBe(50m);
        banks.GetProperty("low").GetBoolean().ShouldBeTrue();
        var invoices = facts.GetProperty("invoices");
        // Open is any amount left, the credit of -500 and the credited 200 included; overdue leaves credited invoices out.
        (invoices.GetProperty("open").GetInt32(), invoices.GetProperty("overdue").GetInt32()).ShouldBe((6, 1));
        invoices.GetProperty("outstanding").GetDecimal().ShouldBe(13_500m);
        invoices.GetProperty("overdueAmount").GetDecimal().ShouldBe(2_500m);

        // The tabs of the customer card, read by the same caller, say the same.
        var timeline = await finance.GetFromJsonAsync<JsonElement>($"/api/v1/activities?organizationId={customer}&open=true&limit=200", Ct);
        timeline.GetProperty("totalCount").GetInt32().ShouldBe(work.GetProperty("open").GetInt32());
        timeline.GetProperty("items").EnumerateArray().Count(a => a.GetProperty("isOverdue").GetBoolean()).ShouldBe(work.GetProperty("overdue").GetInt32());

        var contracts = await finance.GetFromJsonAsync<JsonElement>($"/api/v1/contracts?organizationId={customer}&status=Active&limit=200", Ct);
        contracts.GetProperty("nextCursor").ValueKind.ShouldBe(JsonValueKind.Null);
        var active = contracts.GetProperty("items").EnumerateArray().ToList();
        active.Count.ShouldBe(agreements.GetProperty("active").GetInt32());
        active.Where(c => c.GetProperty("endDate").ValueKind == JsonValueKind.String).Min(c => c.GetProperty("endDate").GetString())
            .ShouldBe(agreements.GetProperty("nextEnd").GetString());

        var bankList = await finance.GetFromJsonAsync<JsonElement>($"/api/v1/contracts/hour-banks?organizationId={customer}&limit=200", Ct);
        bankList.GetProperty("totalCount").GetInt32().ShouldBe(banks.GetProperty("active").GetInt32());
        var listed = bankList.GetProperty("items").EnumerateArray().ToList();
        listed.Sum(b => b.GetProperty("remainingHours").GetDecimal()).ShouldBe(banks.GetProperty("remainingHours").GetDecimal());
        listed.Sum(b => b.GetProperty("purchasedHours").GetDecimal()).ShouldBe(banks.GetProperty("purchasedHours").GetDecimal());
        listed.Any(b => b.GetProperty("isLow").GetBoolean()).ShouldBe(banks.GetProperty("low").GetBoolean());

        var open = await finance.GetFromJsonAsync<JsonElement>($"/api/v1/billing/invoices?organizationId={customer}&openOnly=true&limit=200", Ct);
        open.GetProperty("count").GetInt32().ShouldBe(invoices.GetProperty("open").GetInt32());
        open.GetProperty("outstanding").GetDecimal().ShouldBe(invoices.GetProperty("outstanding").GetDecimal());
        open.GetProperty("overdue").GetDecimal().ShouldBe(invoices.GetProperty("overdueAmount").GetDecimal());
        open.GetProperty("asOf").GetString().ShouldBe(body.GetProperty("asOf").GetString());
        var overdue = await finance.GetFromJsonAsync<JsonElement>($"/api/v1/billing/invoices?organizationId={customer}&overdueOnly=true&limit=200", Ct);
        overdue.GetProperty("count").GetInt32().ShouldBe(invoices.GetProperty("overdue").GetInt32());

        // A customer with nothing, and an id nobody has, get zeros — never a missing part.
        foreach (var empty in items.Skip(1))
        {
            (empty.GetProperty("work").GetProperty("open").GetInt32(), empty.GetProperty("work").GetProperty("overdue").GetInt32()).ShouldBe((0, 0));
            empty.GetProperty("agreements").GetProperty("active").GetInt32().ShouldBe(0);
            empty.GetProperty("agreements").GetProperty("nextEnd").ValueKind.ShouldBe(JsonValueKind.Null);
            empty.GetProperty("hourBanks").GetProperty("active").GetInt32().ShouldBe(0);
            empty.GetProperty("hourBanks").GetProperty("low").GetBoolean().ShouldBeFalse();
            empty.GetProperty("invoices").GetProperty("open").GetInt32().ShouldBe(0);
            empty.GetProperty("invoices").GetProperty("outstanding").GetDecimal().ShouldBe(0m);
        }
    }

    [Fact]
    public async Task A_part_is_null_without_its_permission_and_amounts_need_finance_read()
    {
        var marker = NewMarker();
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "facts-admin");
        var customer = await OrganizationAsync(admin, $"{marker} Roller AS");
        await ActivityAsync(admin, customer, "Task", DateTimeOffset.UtcNow.AddHours(-1));
        await ContractAsync(admin, customer, Today.AddDays(100));
        await HourBankAsync(admin, customer, 10m, 0m);
        await InvoicesAsync(Invoice($"{marker}-1", customer, 1_250m, Today.AddDays(-1)));

        foreach (var role in CrmRoles.All)
        {
            var held = Permissions.ForRoles([role]);
            var client = factory.ClientAs(role, userKey: $"facts-{role}");
            var item = (await FactsOfAsync(client, customer)).GetProperty("items")[0];
            IsShown(item, "work").ShouldBe(held.Contains(Permissions.ActivitiesRead), role);
            IsShown(item, "agreements").ShouldBe(held.Contains(Permissions.ContractsRead), role);
            IsShown(item, "hourBanks").ShouldBe(held.Contains(Permissions.ContractsRead), role);
            IsShown(item, "invoices").ShouldBe(held.Contains(Permissions.BillingRead), role);
            if (!held.Contains(Permissions.BillingRead))
            {
                continue;
            }

            var invoices = item.GetProperty("invoices");
            (invoices.GetProperty("open").GetInt32(), invoices.GetProperty("overdue").GetInt32()).ShouldBe((1, 1), role);
            var money = held.Contains(Permissions.FinanceRead);
            invoices.TryGetProperty("outstanding", out var outstanding).ShouldBe(money, role);
            invoices.TryGetProperty("overdueAmount", out var overdueAmount).ShouldBe(money, role);
            if (money)
            {
                (outstanding.GetDecimal(), overdueAmount.GetDecimal()).ShouldBe((1_250m, 1_250m), role);
            }

            // Exactly as the invoice tab hides the same amounts from the same role.
            var list = await client.GetFromJsonAsync<JsonElement>($"/api/v1/billing/invoices?organizationId={customer}&openOnly=true", Ct);
            list.GetProperty("count").GetInt32().ShouldBe(1, role);
            list.TryGetProperty("outstanding", out _).ShouldBe(money, role);
            list.TryGetProperty("overdue", out _).ShouldBe(money, role);
        }

        // The roles above cover both ways for invoices: one without billing.read exists, and one with it but without finance.read.
        var roles = CrmRoles.All.Select(r => Permissions.ForRoles([r])).ToList();
        roles.Count(p => !p.Contains(Permissions.BillingRead)).ShouldBeGreaterThan(0);
        roles.Count(p => p.Contains(Permissions.BillingRead) && !p.Contains(Permissions.FinanceRead)).ShouldBeGreaterThan(0);
    }

    [Fact]
    public async Task Facts_need_one_to_fifty_different_ids()
    {
        var client = factory.ClientAs(CrmRoles.ReadOnly, userKey: "facts-validation");
        var ids = Enumerable.Range(0, 51).Select(_ => Guid.NewGuid()).ToList();
        foreach (var query in new[]
                 {
                     string.Empty, "?ids=", "?ids=%20", "?ids=not-a-guid", $"?ids={ids[0]},{ids[0]}", $"?ids={ids[0]},",
                     $"?ids={ids[0]};{ids[1]}", $"?ids={string.Join(',', ids)}",
                 })
        {
            var response = await client.GetAsync(Facts + query, Ct);
            response.StatusCode.ShouldBe(HttpStatusCode.BadRequest, query);
            (await response.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe("CUS_FACTS_INVALID", query);
        }

        var fifty = await FactsOfAsync(client, [.. ids.Take(50)]);
        fifty.GetProperty("items").EnumerateArray().Select(i => i.GetProperty("organizationId").GetGuid()).ShouldBe(ids.Take(50));

        // Spaces around an id are allowed; the order is the one sent.
        var spaced = await client.GetAsync($"{Facts}?ids={ids[1]},%20{ids[0]}", Ct);
        spaced.StatusCode.ShouldBe(HttpStatusCode.OK);
        (await spaced.ReadJsonAsync()).GetProperty("items").EnumerateArray().Select(i => i.GetProperty("organizationId").GetGuid()).ShouldBe([ids[1], ids[0]]);
    }

    [Fact]
    public async Task Both_views_need_customers_read_and_a_signed_in_user()
    {
        var outsider = factory.ClientAs("Crm.Unknown", userKey: "facts-nobody");
        (await outsider.GetAsync($"{Facts}?ids={Guid.NewGuid()}", Ct)).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        (await outsider.GetAsync($"{Attention}?mine=true", Ct)).StatusCode.ShouldBe(HttpStatusCode.Forbidden);

        using var anonymous = factory.AnonymousClient();
        (await anonymous.GetAsync($"{Facts}?ids={Guid.NewGuid()}", Ct)).StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
        (await anonymous.GetAsync($"{Attention}?mine=true", Ct)).StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Attention_orders_my_customers_by_urgency_with_the_reasons_the_caller_may_see()
    {
        var marker = NewMarker();
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "facts-admin");
        // One user seen through three roles: the roles come with each request, the account manager stays the same person.
        var key = $"attention-{marker}";
        var sales = factory.ClientAs(CrmRoles.Sales, userKey: key);
        var lead = factory.ClientAs(CrmRoles.ServiceLead, userKey: key);
        var technician = factory.ClientAs(CrmRoles.Technician, userKey: key);
        var me = await sales.UserIdAsync();
        var now = DateTimeOffset.UtcNow;
        async Task<Guid> Mine(string name) => await OrganizationAsync(admin, $"{marker} {name}", me);

        var a = await Mine("A storfaktura");
        await InvoicesAsync(Invoice($"{marker}-a", a, 9_000m, Today.AddDays(-5)));
        await ContractAsync(admin, a, Today.AddDays(30));
        var b = await Mine("B tre fakturaer");
        await InvoicesAsync(Invoice($"{marker}-b1", b, 100m, Today.AddDays(-2)), Invoice($"{marker}-b2", b, 100m, Today.AddDays(-2)),
            Invoice($"{marker}-b3", b, 100m, Today.AddDays(-2)));
        var c = await Mine("C to oppgaver");
        await ActivityAsync(admin, c, "Task", now.AddHours(-3));
        await ActivityAsync(admin, c, "Task", now.AddHours(-3));
        var n = await Mine("N oppgave og klippekort");
        await ActivityAsync(admin, n, "Task", now.AddHours(-3));
        await HourBankAsync(admin, n, 10m, 9m);
        var d = await Mine("D en oppgave");
        await ActivityAsync(admin, d, "Task", now.AddHours(-3));
        var endsToday = await Mine("I slutter i dag");
        await ContractAsync(admin, endsToday, Today);
        var e = await Mine("E slutter snart");
        await ContractAsync(admin, e, Today.AddDays(10));
        var f = await Mine("F slutter om 60 dager");
        await ContractAsync(admin, f, Today.AddDays(AttentionDays));
        var beta = await Mine("Gb lite igjen");
        await HourBankAsync(admin, beta, 10m, 9m);
        var alfa = await Mine("ga lite igjen");
        await HourBankAsync(admin, alfa, 10m, 9m);

        // None of these needs attention: past the window, due today, not yet due, already past, exactly at the threshold, deleted.
        await ContractAsync(admin, await Mine("H om 61 dager"), Today.AddDays(AttentionDays + 1));
        await InvoicesAsync(Invoice($"{marker}-j", await Mine("J forfaller i dag"), 500m, Today));
        await ActivityAsync(admin, await Mine("K senere"), "Task", now.AddDays(2));
        await ContractAsync(admin, await Mine("P sluttet i går"), Today.AddDays(-1));
        await HourBankAsync(admin, await Mine("Q akkurat 20 prosent"), 10m, 8m);
        var deleted = await Mine("L slettet");
        await InvoicesAsync(Invoice($"{marker}-l", deleted, 50m, Today.AddDays(-1)));
        (await admin.DeleteAsync($"/api/v1/customers/organizations/{deleted}", Ct)).StatusCode.ShouldBe(HttpStatusCode.NoContent);
        // Someone else's customer is not mine.
        await InvoicesAsync(Invoice($"{marker}-m", await OrganizationAsync(admin, $"{marker} M annen", null), 70m, Today.AddDays(-1)));

        // With finance.read, overdue invoices go by the amount; ties further down by name (Norwegian order, case ignored).
        var bySales = await AttentionAsync(sales, mine: true);
        Ids(bySales).ShouldBe([a, b, c, n, d, endsToday, e, f, alfa, beta]);
        bySales.GetProperty("total").GetInt32().ShouldBe(10);
        bySales.GetProperty("asOf").GetString().ShouldBe(Today.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture));
        Reasons(bySales, a).ShouldBe(["OverdueInvoices", "AgreementEnding"]);
        Reasons(bySales, n).ShouldBe(["OverdueWork", "HourBankLow"]);
        Reasons(bySales, f).ShouldBe(["AgreementEnding"]);
        Reasons(bySales, alfa).ShouldBe(["HourBankLow"]);
        var first = bySales.GetProperty("items")[0].GetProperty("organization");
        first.GetProperty("name").GetString().ShouldBe($"{marker} A storfaktura");
        first.GetProperty("status").GetString().ShouldBe("Customer");
        first.GetProperty("accountManager").GetProperty("id").GetGuid().ShouldBe(me);
        first.GetProperty("accountManager").GetProperty("displayName").GetString().ShouldBe($"Test {key}");
        await ShouldMatchFactsAsync(sales, bySales);

        // Without finance.read the order cannot reveal money: overdue invoices go by how many, and no amount is shown.
        var byLead = await AttentionAsync(lead, mine: true);
        Ids(byLead).ShouldBe([b, a, c, n, d, endsToday, e, f, alfa, beta]);
        byLead.GetProperty("items").EnumerateArray().Count(i => i.GetProperty("facts").GetProperty("invoices").TryGetProperty("overdueAmount", out _)).ShouldBe(0);
        await ShouldMatchFactsAsync(lead, byLead);

        // Without billing.read overdue invoices are no reason: B drops out, A stays for its ending contract.
        var byTechnician = await AttentionAsync(technician, mine: true);
        Ids(byTechnician).ShouldBe([c, n, d, endsToday, e, a, f, alfa, beta]);
        byTechnician.GetProperty("total").GetInt32().ShouldBe(9);
        Reasons(byTechnician, a).ShouldBe(["AgreementEnding"]);
        byTechnician.GetProperty("items").EnumerateArray().ShouldAllBe(i => i.GetProperty("facts").GetProperty("invoices").ValueKind == JsonValueKind.Null);
        await ShouldMatchFactsAsync(technician, byTechnician);
    }

    [Fact]
    public async Task Attention_shows_the_first_fifty_and_counts_every_customer_that_qualifies()
    {
        var marker = NewMarker();
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "facts-admin");
        var sales = factory.ClientAs(CrmRoles.Sales, userKey: $"attention-many-{marker}");
        var me = await sales.UserIdAsync();
        var invoices = new List<ExternalInvoice>();
        var byAmount = new Dictionary<decimal, Guid>();
        for (var i = 1; i <= 52; i++)
        {
            var organizationId = await OrganizationAsync(admin, $"{marker} Kunde {i:00}", me);
            byAmount[i * 10m] = organizationId;
            invoices.Add(Invoice($"{marker}-{i}", organizationId, i * 10m, Today.AddDays(-1)));
        }

        await InvoicesAsync([.. invoices]);

        var attention = await AttentionAsync(sales, mine: true);
        attention.GetProperty("total").GetInt32().ShouldBe(52);
        Ids(attention).ShouldBe(Enumerable.Range(3, 50).Reverse().Select(i => byAmount[i * 10m]));
        attention.GetProperty("items")[0].GetProperty("facts").GetProperty("invoices").GetProperty("overdueAmount").GetDecimal().ShouldBe(520m);
    }

    [Fact]
    public async Task Attention_for_everyone_includes_other_account_managers_and_never_a_deleted_customer()
    {
        var marker = NewMarker();
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "facts-admin");
        // Amounts no other test comes near, so these two would lead the whole list.
        var unmanaged = await OrganizationAsync(admin, $"{marker} Uten ansvarlig AS", null);
        var deleted = await OrganizationAsync(admin, $"{marker} Slettet AS", null);
        await InvoicesAsync(
            Invoice($"{marker}-u", unmanaged, 900_000_000_000m, Today.AddDays(-1)),
            Invoice($"{marker}-d", deleted, 950_000_000_000m, Today.AddDays(-1)));
        (await admin.DeleteAsync($"/api/v1/customers/organizations/{deleted}", Ct)).StatusCode.ShouldBe(HttpStatusCode.NoContent);

        foreach (var everyone in new[] { await AttentionAsync(admin, mine: null), await AttentionAsync(admin, mine: false) })
        {
            Ids(everyone).First().ShouldBe(unmanaged);
            Ids(everyone).ShouldNotContain(deleted);
            everyone.GetProperty("total").GetInt32().ShouldBeGreaterThanOrEqualTo(everyone.GetProperty("items").GetArrayLength());
            everyone.GetProperty("items")[0].GetProperty("organization").GetProperty("accountManager").ValueKind.ShouldBe(JsonValueKind.Null);
        }

        Ids(await AttentionAsync(admin, mine: true)).ShouldNotContain(unmanaged);
    }

    private static string NewMarker() => $"F{Guid.NewGuid():N}"[..10];

    private static async Task<Guid> OrganizationAsync(HttpClient admin, string name, Guid? accountManagerId = null) =>
        await admin.CreateOrganizationAsync(new { name, status = "Customer", accountManagerId });

    private static async Task<Guid> ActivityAsync(HttpClient client, Guid organizationId, string type, DateTimeOffset? dueAt) =>
        (await ActivityWithETagAsync(client, organizationId, type, dueAt)).Id;

    // Completing a task needs the version the caller saw (If-Match), as every write does.
    private static async Task<(Guid Id, string Etag)> ActivityWithETagAsync(HttpClient client, Guid organizationId, string type, DateTimeOffset? dueAt)
    {
        var response = await client.PostAsJsonAsync("/api/v1/activities/", new
        {
            type, organizationId, subject = $"{type} {Guid.NewGuid():N}", dueAt, priority = "Normal",
            durationMinutes = type == "Meeting" ? 30 : (int?)null,
        }, Ct);
        response.StatusCode.ShouldBe(HttpStatusCode.Created);
        var body = await response.ReadJsonAsync();
        return (body.GetProperty("id").GetGuid(), body.GetProperty("etag").GetString()!);
    }

    private static async Task<Guid> ContractAsync(HttpClient client, Guid organizationId, DateOnly? endDate, bool activate = true)
    {
        // No automatic renewal: the daily lifecycle job, which other classes run, ends a contract past its date instead of moving it.
        var response = await client.PostAsJsonAsync("/api/v1/contracts", new
        {
            organizationId, title = "Drift", type = "Msp", startDate = Today.AddMonths(-2), endDate, autoRenew = false, renewalTermMonths = 0,
            noticePeriodDays = 0, invoiceFrequency = "Monthly", invoiceTiming = "InAdvance", indexation = false,
        }, Ct);
        response.StatusCode.ShouldBe(HttpStatusCode.Created);
        var id = (await response.ReadJsonAsync()).GetProperty("id").GetGuid();
        if (activate)
        {
            (await client.PostAsync($"/api/v1/contracts/{id}/activate", null, Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
        }

        return id;
    }

    /// <summary>A bank of <paramref name="hours"/> with <paramref name="used"/> consumed; it is low below 20 % left (the default).</summary>
    private static async Task<Guid> HourBankAsync(HttpClient client, Guid organizationId, decimal hours, decimal used)
    {
        var created = await client.PostAsJsonAsync("/api/v1/contracts/hour-banks", new
        {
            organizationId, name = "Klippekort", hours, validFrom = Today.AddMonths(-1),
        }, Ct);
        created.StatusCode.ShouldBe(HttpStatusCode.Created);
        var id = (await created.ReadJsonAsync()).GetProperty("id").GetGuid();
        if (used > 0)
        {
            (await client.PostAsJsonAsync($"/api/v1/contracts/hour-banks/{id}/entries", new { kind = "Consumption", hours = used, date = Today }, Ct))
                .StatusCode.ShouldBe(HttpStatusCode.OK);
        }

        return id;
    }

    /// <summary>Invoices come from the accounting system's sync in production; the test writes them the way the sync does.</summary>
    private async Task InvoicesAsync(params ExternalInvoice[] invoices)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        await scope.ServiceProvider.GetRequiredService<IBillingApi>().UpsertInvoicesAsync(invoices, Ct);
    }

    private static ExternalInvoice Invoice(string number, Guid organizationId, decimal outstanding, DateOnly? due, InvoiceStatus status = InvoiceStatus.Sent) =>
        new("poweroffice", number, null, null, organizationId, Today.AddDays(-40), due, Math.Max(outstanding, 0m) + 100m, outstanding, status, null);

    private static async Task<JsonElement> FactsOfAsync(HttpClient client, params Guid[] ids)
    {
        var response = await client.GetAsync($"{Facts}?ids={string.Join(',', ids)}", Ct);
        response.StatusCode.ShouldBe(HttpStatusCode.OK);
        return await response.ReadJsonAsync();
    }

    private static async Task<JsonElement> AttentionAsync(HttpClient client, bool? mine)
    {
        var response = await client.GetAsync(mine is { } only ? $"{Attention}?mine={(only ? "true" : "false")}" : Attention, Ct);
        response.StatusCode.ShouldBe(HttpStatusCode.OK);
        response.Headers.CacheControl!.NoStore.ShouldBeTrue();
        return await response.ReadJsonAsync();
    }

    /// <summary>The facts shown with each customer are the facts the list asks for, for the same caller.</summary>
    private static async Task ShouldMatchFactsAsync(HttpClient client, JsonElement attention)
    {
        var shown = attention.GetProperty("items").EnumerateArray().ToList();
        var facts = (await FactsOfAsync(client, [.. shown.Select(i => i.GetProperty("organization").GetProperty("id").GetGuid())]))
            .GetProperty("items").EnumerateArray().ToList();
        foreach (var (item, expected) in shown.Zip(facts))
        {
            foreach (var part in new[] { "work", "agreements", "hourBanks", "invoices" })
            {
                item.GetProperty("facts").GetProperty(part).GetRawText().ShouldBe(expected.GetProperty(part).GetRawText(), part);
            }
        }
    }

    private static bool IsShown(JsonElement item, string part)
    {
        item.TryGetProperty(part, out var value).ShouldBeTrue($"{part} is always in the item, as an object or null");
        value.ValueKind.ShouldBeOneOf(JsonValueKind.Object, JsonValueKind.Null);
        return value.ValueKind == JsonValueKind.Object;
    }

    private static List<Guid> Ids(JsonElement attention) =>
        attention.GetProperty("items").EnumerateArray().Select(i => i.GetProperty("organization").GetProperty("id").GetGuid()).ToList();

    private static List<string> Reasons(JsonElement attention, Guid organizationId) =>
        attention.GetProperty("items").EnumerateArray()
            .Single(i => i.GetProperty("organization").GetProperty("id").GetGuid() == organizationId)
            .GetProperty("reasons").EnumerateArray().Select(r => r.GetString()!).ToList();
}
