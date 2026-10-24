using System.Buffers.Text;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Crm.Authorization;
using Crm.Billing.Contracts;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crm.IntegrationTests;

/// <summary>
/// DEV-12 (A11, A16): totals cover the whole filter, not the page, and every matching record can be reached page by page —
/// equal dates and equal numbers included — without a role that may not see money learning it from the totals or the cursor.
/// </summary>
public sealed class ListCompletenessTests(CrmWebFactory factory)
{
    private const string Invoices = "/api/v1/billing/invoices";

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task AC01_the_debt_of_501_and_more_invoices_counts_every_invoice_whatever_the_page_size()
    {
        var customer = await InvoicesAsync(520);

        foreach (var limit in new[] { 25, 100 })
        {
            var first = await factory.ClientAs(CrmRoles.Finance).GetFromJsonAsync<JsonElement>($"{Invoices}?organizationId={customer.OrganizationId}&limit={limit}", Ct);
            first.GetProperty("count").GetInt32().ShouldBe(520);
            first.GetProperty("outstanding").GetDecimal().ShouldBe(customer.Outstanding);
            first.GetProperty("overdue").GetDecimal().ShouldBe(customer.Overdue);
            first.GetProperty("invoices").GetArrayLength().ShouldBe(limit);
            first.GetProperty("nextCursor").GetString().ShouldNotBeNullOrEmpty();
            first.GetProperty("asOf").GetString().ShouldNotBeNullOrEmpty();
        }
    }

    [Fact]
    public async Task AC02_all_pages_together_return_every_invoice_exactly_once_even_with_equal_dates_and_numbers()
    {
        var customer = await InvoicesAsync(260);
        foreach (var limit in new[] { 7, 25 })
        {
            var (ids, rows) = await AllPagesAsync(factory.ClientAs(CrmRoles.Finance), $"{Invoices}?organizationId={customer.OrganizationId}", limit);
            ids.Count.ShouldBe(260);
            ids.Distinct().Count().ShouldBe(260, "no invoice twice");
            ids.ToHashSet().SetEquals(customer.Ids).ShouldBeTrue("and none missing");
            // Newest first by date, then number: the order the cursor continues.
            rows.Zip(rows.Skip(1)).ShouldAllBe(pair =>
                string.CompareOrdinal(pair.First.Date, pair.Second.Date) > 0 ||
                (pair.First.Date == pair.Second.Date && string.Compare(pair.First.Number, pair.Second.Number, StringComparison.OrdinalIgnoreCase) >= 0));
        }
    }

    [Fact]
    public async Task AC03_a_filter_changes_the_totals_and_the_list_together()
    {
        var customer = await InvoicesAsync(130);
        var finance = factory.ClientAs(CrmRoles.Finance);
        var all = await finance.GetFromJsonAsync<JsonElement>($"{Invoices}?organizationId={customer.OrganizationId}&limit=10", Ct);
        var open = await finance.GetFromJsonAsync<JsonElement>($"{Invoices}?organizationId={customer.OrganizationId}&openOnly=true&limit=10", Ct);
        var overdue = await finance.GetFromJsonAsync<JsonElement>($"{Invoices}?organizationId={customer.OrganizationId}&overdueOnly=true&limit=10", Ct);

        all.GetProperty("count").GetInt32().ShouldBe(130);
        open.GetProperty("count").GetInt32().ShouldBe(customer.Open);
        overdue.GetProperty("count").GetInt32().ShouldBe(customer.OverdueCount);
        (open.GetProperty("outstanding").GetDecimal(), overdue.GetProperty("outstanding").GetDecimal()).ShouldBe((customer.Outstanding, customer.Overdue));
        overdue.GetProperty("overdue").GetDecimal().ShouldBe(customer.Overdue, "every overdue invoice is overdue");

        // The pages of each filter add up to its count.
        (await AllPagesAsync(finance, $"{Invoices}?organizationId={customer.OrganizationId}&openOnly=true", 10)).Ids.Count.ShouldBe(customer.Open);
        (await AllPagesAsync(finance, $"{Invoices}?organizationId={customer.OrganizationId}&overdueOnly=true", 10)).Ids.Count.ShouldBe(customer.OverdueCount);
    }

    [Fact]
    public async Task AC04_a_role_without_finance_sees_no_amount_in_the_totals_the_rows_or_the_cursor()
    {
        var customer = await InvoicesAsync(30);
        var lead = await factory.ClientAs(CrmRoles.ServiceLead).GetFromJsonAsync<JsonElement>($"{Invoices}?organizationId={customer.OrganizationId}&limit=10", Ct);

        lead.GetProperty("count").GetInt32().ShouldBe(30, "how many is not money");
        lead.TryGetProperty("outstanding", out _).ShouldBeFalse();
        lead.TryGetProperty("overdue", out _).ShouldBeFalse();
        lead.GetProperty("invoices").EnumerateArray().All(i => !i.TryGetProperty("outstanding", out _) && !i.TryGetProperty("totalIncVat", out _))
            .ShouldBeTrue("no amount on any row");
        // The cursor carries the last row's date, number and id — nothing else.
        using var cursor = JsonDocument.Parse(Encoding.UTF8.GetString(Base64Url.DecodeFromChars(lead.GetProperty("nextCursor").GetString())));
        var last = lead.GetProperty("invoices").EnumerateArray().Last();
        cursor.RootElement.EnumerateObject().Select(p => p.Name).ShouldBe(["SortKey", "Id", "Then"], ignoreOrder: true);
        (cursor.RootElement.GetProperty("SortKey").GetString(), cursor.RootElement.GetProperty("Then").GetString(), cursor.RootElement.GetProperty("Id").GetGuid())
            .ShouldBe((last.GetProperty("invoiceDate").GetString(), last.GetProperty("invoiceNo").GetString(), last.GetProperty("id").GetGuid()));
    }

    [Fact]
    public async Task AC06_an_invoice_arriving_between_two_pages_neither_repeats_nor_hides_the_others()
    {
        var customer = await InvoicesAsync(60);
        var finance = factory.ClientAs(CrmRoles.Finance);
        var url = $"{Invoices}?organizationId={customer.OrganizationId}&limit=25";
        var first = await finance.GetFromJsonAsync<JsonElement>(url, Ct);
        var seen = Ids(first).ToList();

        // A newer invoice arrives from PowerOffice while the user reads page one.
        await UpsertAsync([Invoice("poweroffice", $"{customer.Marker}-NEW", customer.OrganizationId, DateOnly.FromDateTime(DateTime.UtcNow), 100m, 100m, null)]);

        string? next = first.GetProperty("nextCursor").GetString();
        while (next is not null)
        {
            var page = await finance.GetFromJsonAsync<JsonElement>($"{url}&cursor={Uri.EscapeDataString(next)}", Ct);
            seen.AddRange(Ids(page));
            page.GetProperty("count").GetInt32().ShouldBe(61, "the totals are those of the moment of each answer");
            next = page.GetProperty("nextCursor").ValueKind == JsonValueKind.Null ? null : page.GetProperty("nextCursor").GetString();
        }

        seen.Distinct().Count().ShouldBe(seen.Count, "no invoice twice");
        seen.ToHashSet().IsSupersetOf(customer.Ids).ShouldBeTrue("none of the earlier invoices hidden by the newcomer");
    }

    [Fact]
    public async Task AC05_quotes_and_projects_past_the_old_limits_of_300_and_200_can_all_be_reached()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "dev12-admin");
        var marker = $"M{Guid.NewGuid():N}"[..9];
        var organizationId = await admin.CreateOrganizationAsync(new { name = $"{marker} Mange AS", status = "Customer" });
        var today = DateOnly.FromDateTime(DateTime.UtcNow).ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture);
        var quoteIds = await CreateManyAsync(305, i => admin.PostAsJsonAsync("/api/v1/sales/quotes", new { organizationId, title = $"{marker} Tilbud {i}", termMonths = 12 }, Ct));
        var projectIds = await CreateManyAsync(205, i => admin.PostAsJsonAsync("/api/v1/projects", new
        {
            organizationId, name = $"{marker} Prosjekt {i}", type = "Other", billingModel = "TimeAndMaterial", startDate = today, budgetHours = 1m, budgetAmount = 0m,
        }, Ct));

        foreach (var (url, expected) in new[] { ($"/api/v1/sales/quotes?organizationId={organizationId}", quoteIds), ($"/api/v1/projects?organizationId={organizationId}", projectIds) })
        {
            var first = await admin.GetFromJsonAsync<JsonElement>($"{url}&limit=50", Ct);
            first.GetProperty("totalCount").GetInt32().ShouldBe(expected.Count, url);
            var ids = await ItemIdsAsync(admin, url, 50);
            ids.Count.ShouldBe(expected.Count, url);
            ids.ToHashSet().SetEquals(expected).ShouldBeTrue(url);
        }
    }

    [Fact]
    public async Task The_latest_version_of_a_quote_is_known_even_when_its_versions_fall_on_two_pages()
    {
        var sales = factory.ClientAs(CrmRoles.Sales, userKey: "dev12-sales");
        var marker = $"V{Guid.NewGuid():N}"[..9];
        var organizationId = await sales.CreateOrganizationAsync(new { name = $"{marker} Versjoner AS", status = "Prospect" });
        var quoteId = (await (await sales.PostAsJsonAsync("/api/v1/sales/quotes", new
        {
            organizationId, title = $"{marker} Pakke", termMonths = 12,
            lines = new object[] { new { name = "Drift", quantity = 1m, unitPrice = 1_000m, discountPct = 0m, recurrence = "Monthly" } },
        }, Ct)).ReadJsonAsync()).GetProperty("id").GetGuid();
        (await (await sales.PostAsync($"/api/v1/sales/quotes/{quoteId}/submit", null, Ct)).ReadJsonAsync()).GetProperty("status").GetString().ShouldBe("Ready");
        var second = (await (await sales.PostAsync($"/api/v1/sales/quotes/{quoteId}/revise", null, Ct)).ReadJsonAsync()).GetProperty("id").GetGuid();

        var first = await sales.GetFromJsonAsync<JsonElement>($"/api/v1/sales/quotes?organizationId={organizationId}&limit=1", Ct);
        var newest = first.GetProperty("items").EnumerateArray().Single();
        (newest.GetProperty("id").GetGuid(), newest.GetProperty("isLatestVersion").GetBoolean()).ShouldBe((second, true));
        var next = await sales.GetFromJsonAsync<JsonElement>(
            $"/api/v1/sales/quotes?organizationId={organizationId}&limit=1&cursor={Uri.EscapeDataString(first.GetProperty("nextCursor").GetString()!)}", Ct);
        var older = next.GetProperty("items").EnumerateArray().Single();
        (older.GetProperty("id").GetGuid(), older.GetProperty("isLatestVersion").GetBoolean()).ShouldBe((quoteId, false), "the page holds only it, the quote does not");
    }

    [Fact]
    public async Task AC02_leads_created_in_the_same_instant_are_each_paged_exactly_once()
    {
        var sales = factory.ClientAs(CrmRoles.Sales, userKey: "dev12-leads");
        var marker = $"E{Guid.NewGuid():N}"[..9];
        var ids = await CreateManyAsync(45, i => sales.PostAsJsonAsync("/api/v1/sales/leads", new { companyName = $"{marker} Lead {i}", contactName = "Kari", email = (string?)null, phone = (string?)null, source = "Web", ownerId = (Guid?)null, notes = (string?)null }, Ct));
        // The same creation time for all of them: only the id orders them.
        await factory.AdminSqlAsync($"UPDATE sales.Leads SET CreatedAt = '2026-01-02T03:04:05.1234567+00:00' WHERE CompanyName LIKE N'{marker} Lead %';");

        var first = await sales.GetFromJsonAsync<JsonElement>($"/api/v1/sales/leads?search={marker}&limit=7", Ct);
        first.GetProperty("totalCount").GetInt32().ShouldBe(45);
        var paged = await ItemIdsAsync(sales, $"/api/v1/sales/leads?search={marker}", 7);
        paged.Count.ShouldBe(45);
        paged.ToHashSet().SetEquals(ids).ShouldBeTrue();
    }

    [Fact]
    public async Task AC01_the_board_counts_and_forecasts_every_open_deal_and_each_column_continues_to_the_last_card()
    {
        var sales = factory.ClientAs(CrmRoles.Sales, userKey: $"dev12-board-{Guid.NewGuid():N}"[..24]);
        var marker = $"B{Guid.NewGuid():N}"[..9];
        var organizationId = await sales.CreateOrganizationAsync(new { name = $"{marker} Salgstrakt AS", status = "Prospect" });
        var stage = (await sales.GetFromJsonAsync<JsonElement>("/api/v1/sales/stages", Ct)).EnumerateArray()
            .First(s => !s.GetProperty("isWon").GetBoolean() && !s.GetProperty("isLost").GetBoolean()).GetProperty("id").GetGuid();
        var start = DateOnly.FromDateTime(DateTime.UtcNow).AddMonths(1);
        var me = await sales.UserIdAsync();
        var ids = await CreateManyAsync(520, i => sales.PostAsJsonAsync("/api/v1/sales/opportunities", new
        {
            organizationId, contactId = (Guid?)null, name = $"{marker} Avtale {i}", businessLine = "Msp", stageId = stage, probability = 50,
            expectedCloseDate = start.AddDays(i % 400).ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture),
            oneOffAmount = 0m, mrr = 100m, termMonths = 12, ownerId = me, source = "Web", competitor = (string?)null,
        }, Ct));
        // Ten of them quiet for two months.
        var quiet = string.Join(",", ids.Take(10).Select(id => $"'{id}'"));
        await factory.AdminSqlAsync($"UPDATE sales.Opportunities SET LastActivityAt = DATEADD(day, -60, SYSDATETIMEOFFSET()) WHERE Id IN ({quiet});");

        var board = await sales.GetFromJsonAsync<JsonElement>("/api/v1/sales/pipeline?mine=true", Ct);
        var column = board.GetProperty("columns").EnumerateArray().Single(c => c.GetProperty("stageId").GetGuid() == stage);
        column.GetProperty("count").GetInt32().ShouldBe(520);
        column.GetProperty("forecast").GetDecimal().ShouldBe(520 * 600m, "every deal: (0 + 100 × 12) × 50 %");
        board.GetProperty("stale").GetInt32().ShouldBe(10);
        board.GetProperty("forecast").EnumerateArray().Count().ShouldBeLessThanOrEqualTo(12, "a named twelve-month horizon");
        var cards = column.GetProperty("opportunities").EnumerateArray().Select(o => o.GetProperty("id").GetGuid()).ToList();
        cards.Count.ShouldBe(50);

        // The rest of the column through the deals list, with the board's filters, the stage and the column's cursor.
        var cursor = column.GetProperty("nextCursor").GetString();
        while (cursor is not null)
        {
            var page = await sales.GetFromJsonAsync<JsonElement>(
                $"/api/v1/sales/opportunities?mine=true&stageId={stage}&status=Open&limit=50&cursor={Uri.EscapeDataString(cursor)}", Ct);
            page.GetProperty("totalCount").GetInt32().ShouldBe(520);
            cards.AddRange(page.GetProperty("items").EnumerateArray().Select(o => o.GetProperty("id").GetGuid()));
            cursor = page.GetProperty("nextCursor").ValueKind == JsonValueKind.Null ? null : page.GetProperty("nextCursor").GetString();
        }

        cards.Count.ShouldBe(520);
        cards.ToHashSet().SetEquals(ids).ShouldBeTrue("every card exactly once");
    }

    [Fact]
    public async Task AC01_the_sla_report_measures_every_ticket_of_the_month_and_counts_every_breach()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "dev12-sla");
        var marker = $"S{Guid.NewGuid():N}"[..9];
        var organizationId = await admin.CreateOrganizationAsync(new { name = $"{marker} Mange saker AS", status = "Customer" });
        var sla = await (await admin.PostAsJsonAsync("/api/v1/contracts/sla-policies", new
        {
            name = $"{marker} Gold", coverage = "Always24x7",
            p1 = new { responseMinutes = 60, resolutionMinutes = 240 }, p2 = new { responseMinutes = 120, resolutionMinutes = 480 },
            p3 = new { responseMinutes = 480, resolutionMinutes = 1440 }, p4 = new { responseMinutes = 960, resolutionMinutes = 4800 },
            includedHoursPerMonth = 0m, afterHoursMultiplier = 1.5m,
        }, Ct)).ReadJsonAsync();
        var contract = await (await admin.PostAsJsonAsync("/api/v1/contracts", new
        {
            organizationId, title = $"{marker} Drift", type = "Msp", startDate = "2026-01-01", endDate = (string?)null, autoRenew = false, renewalTermMonths = 0,
            noticePeriodDays = 90, slaPolicyId = sla.GetProperty("id").GetGuid(), invoiceFrequency = "Monthly", invoiceTiming = "InAdvance", indexation = false,
        }, Ct)).ReadJsonAsync();
        (await admin.PostAsync($"/api/v1/contracts/{contract.GetProperty("id").GetGuid()}/activate", null, Ct)).StatusCode.ShouldBe(System.Net.HttpStatusCode.OK);

        // 5100 tickets in August — more than the old cap of 5000 — fifteen of them answered after two hours against a one-hour P1 target.
        var first = TestData.AteraIds(5100);
        var tickets = Enumerable.Range(0, 5100).Select(i =>
        {
            var created = new DateTimeOffset(2026, 8, 1 + i % 28, 9, 0, 0, TimeSpan.Zero).AddMinutes(i % 60);
            var late = i < 15;
            return new Crm.Service.Contracts.ExternalTicket("atera", first + i, organizationId, null, $"{marker} sak {i}", "Closed", late ? "Critical" : "High",
                null, null, null, null, null, null, null, created, created.AddMinutes(late ? 120 : 30), created.AddHours(1), null, null);
        }).ToList();
        foreach (var batch in tickets.Chunk(1000))
        {
            await factory.RunJobAsync<Crm.Service.Contracts.IServiceApi>(api => api.UpsertTicketsAsync(batch, CancellationToken.None));
        }

        var report = await admin.GetFromJsonAsync<JsonElement>($"/api/v1/service/sla-report?year=2026&month=8&organizationId={organizationId}", Ct);
        report.GetProperty("tickets").GetInt32().ShouldBe(5100);
        var row = report.GetProperty("organizations").EnumerateArray().Single();
        (row.GetProperty("tickets").GetInt32(), row.GetProperty("responseMeasured").GetInt32(), row.GetProperty("responseMet").GetInt32())
            .ShouldBe((5100, 5100, 5085));
        row.GetProperty("breachCount").GetInt32().ShouldBe(15);
        var listed = row.GetProperty("breaches").EnumerateArray().ToList();
        listed.Count.ShouldBe(10, "the worst ten are listed; the count says how many there are");
        listed.ShouldAllBe(b => b.GetProperty("title").GetString()!.StartsWith(marker, StringComparison.Ordinal));
    }

    [Fact]
    public async Task AC04_an_overdue_notice_shows_its_amount_only_to_a_reader_who_may_see_money()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "dev12-notice-admin");
        var technician = factory.ClientAs(CrmRoles.Technician, userKey: $"dev12-tech-{Guid.NewGuid():N}"[..24]);
        var sales = factory.ClientAs(CrmRoles.Sales, userKey: $"dev12-sale-{Guid.NewGuid():N}"[..24]);
        var marker = $"N{Guid.NewGuid():N}"[..9];
        // Days overdue count from Oslo's today, as the notice job does: a UTC date is a day behind it between midnight and two at night.
        var dueDate = DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, TimeZoneInfo.FindSystemTimeZoneById("Europe/Oslo")).DateTime).AddDays(-20);
        var notices = new List<(HttpClient Reader, string Number)>();
        foreach (var (reader, role) in new[] { (technician, "tech"), (sales, "sale") })
        {
            var organizationId = await admin.CreateOrganizationAsync(new { name = $"{marker} {role} AS", status = "Customer", accountManagerId = await reader.UserIdAsync() });
            var number = $"{marker}-{role}";
            await UpsertAsync([Invoice("poweroffice", number, organizationId, dueDate.AddDays(-14), 12_500m, 12_500m, dueDate)]);
            notices.Add((reader, number));
        }

        await factory.RunJobAsync<Crm.Notifications.Features.NotificationScanJob>(job => job.RunAsync(CancellationToken.None));

        async Task<JsonElement> NoticeAsync(HttpClient reader, string number) =>
            (await reader.GetFromJsonAsync<JsonElement>("/api/v1/notifications?limit=200", Ct)).GetProperty("items").EnumerateArray()
            .Single(n => n.GetProperty("kind").GetString() == "InvoiceOverdue" && n.GetProperty("parameters").GetProperty("number").GetString() == number);
        var forTechnician = await NoticeAsync(notices[0].Reader, notices[0].Number);
        forTechnician.GetProperty("parameters").TryGetProperty("amount", out _).ShouldBeFalse("a technician may not see money");
        forTechnician.GetProperty("parameters").GetProperty("days").GetString().ShouldBe("20");
        // nb-NO groups thousands with a no-break space.
        (await NoticeAsync(notices[1].Reader, notices[1].Number)).GetProperty("parameters").GetProperty("amount").GetString()!
            .Replace('\u00A0', ' ').Replace('\u202F', ' ').ShouldBe("12 500 NOK");
    }

    [Fact]
    public async Task AC05_an_organizations_tickets_devices_and_alerts_past_the_old_caps_are_each_listed_exactly_once()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "dev12-service");
        var marker = $"V{Guid.NewGuid():N}"[..9];
        // A system of its own: a complete alert read resolves every other open alert of the system, and other tests mirror "atera".
        var system = $"dev12-{marker}";
        var organizationId = await admin.CreateOrganizationAsync(new { name = $"{marker} Drift AS", status = "Customer" });
        var at = new DateTimeOffset(2026, 9, 1, 9, 0, 0, TimeSpan.Zero);

        // 520 tickets (the old cap was 500), open and closed in turn, ten to an instant.
        var tickets = Enumerable.Range(0, 520).Select(i => new Crm.Service.Contracts.ExternalTicket(
            system, 1_000_000 + i, organizationId, null, $"{marker} sak {i}", i % 2 == 0 ? "Open" : "Closed", "High",
            null, null, null, null, null, null, null, at.AddMinutes(i / 10), null, null, null, null)).ToList();
        await factory.RunJobAsync<Crm.Service.Contracts.IServiceApi>(api => api.UpsertTicketsAsync(tickets, CancellationToken.None));
        // 1100 devices (the old cap was 1000), forty of them with the same name.
        var devices = Enumerable.Range(0, 1100).Select(i => new Crm.Service.Contracts.ExternalDevice(
            $"{marker}-{i}", i < 40 ? "PC-SAME" : $"PC-{i:0000}", i % 3 == 0 ? Crm.Service.Contracts.DeviceType.Server : Crm.Service.Contracts.DeviceType.Workstation,
            null, true, at, null)).ToList();
        await factory.RunJobAsync<Crm.Service.Contracts.IServiceApi>(api => api.ReplaceDevicesAsync(organizationId, system, devices, CancellationToken.None));
        // 230 alerts (the old cap was 200), critical and warning in turn, ten to an instant.
        var alerts = Enumerable.Range(0, 230).Select(i => new Crm.Service.Contracts.ExternalAlert(
            $"{marker}-a{i}", organizationId, i % 2 == 0 ? Crm.Service.Contracts.AlertSeverity.Critical : Crm.Service.Contracts.AlertSeverity.Warning,
            $"{marker} varsel {i}", null, at.AddMinutes(i / 10))).ToList();
        await factory.RunJobAsync<Crm.Service.Contracts.IServiceApi>(api => api.ApplyAlertSnapshotAsync(new Crm.Service.Contracts.AlertSnapshot(
            system, Crm.Service.Contracts.AlertKind.Monitoring, alerts, alerts.Select(a => a.ExternalId).ToList(), IsComplete: true), CancellationToken.None));

        var listedTickets = await ItemsAsync(admin, $"/api/v1/service/tickets?organizationId={organizationId}", 37);
        listedTickets.Select(t => t.Item.GetProperty("id").GetGuid()).Distinct().Count().ShouldBe(520);
        listedTickets.Count.ShouldBe(520);
        listedTickets.ShouldAllBe(t => t.Total == 520);
        listedTickets.Take(260).ShouldAllBe(t => t.Item.GetProperty("isOpen").GetBoolean(), "open tickets come first, across pages");
        (await ItemsAsync(admin, $"/api/v1/service/tickets?organizationId={organizationId}&openOnly=true", 50)).Count.ShouldBe(260);

        var listedDevices = await ItemsAsync(admin, $"/api/v1/service/devices?organizationId={organizationId}", 33);
        listedDevices.Select(d => d.Item.GetProperty("id").GetGuid()).Distinct().Count().ShouldBe(1100);
        listedDevices.Count.ShouldBe(1100);
        listedDevices[0].Total.ShouldBe(1100);
        listedDevices.Count(d => d.Item.GetProperty("machineName").GetString() == "PC-SAME").ShouldBe(40);

        var listedAlerts = await ItemsAsync(admin, $"/api/v1/service/alerts?organizationId={organizationId}", 19);
        listedAlerts.Select(a => a.Item.GetProperty("id").GetGuid()).Distinct().Count().ShouldBe(230);
        listedAlerts.Count.ShouldBe(230);
        listedAlerts[0].Total.ShouldBe(230);
        // M38: critical first, then the oldest, across pages (ten alerts share each instant, the id breaks the tie).
        static int Rank(JsonElement alert) => alert.GetProperty("severity").GetString() == "Critical" ? 0 : 1;
        listedAlerts.Zip(listedAlerts.Skip(1)).Select(pair => Rank(pair.First.Item) < Rank(pair.Second.Item) ||
                (Rank(pair.First.Item) == Rank(pair.Second.Item) &&
                 pair.First.Item.GetProperty("createdAt").GetDateTimeOffset() <= pair.Second.Item.GetProperty("createdAt").GetDateTimeOffset()))
            .ShouldAllBe(inOrder => inOrder, "critical alerts come first and the oldest first within a severity, across pages");
        (await ItemsAsync(admin, $"/api/v1/service/alerts?organizationId={organizationId}&severity=Critical", 50)).Count.ShouldBe(115);
        (await admin.GetFromJsonAsync<JsonElement>($"/api/v1/service/alerts?organizationId={organizationId}&limit=500", Ct))
            .GetProperty("items").GetArrayLength().ShouldBe(100, "a page holds at most 100 alerts");
    }

    [Fact]
    public async Task AC05_a_migration_preview_counts_the_whole_file_and_lists_what_needs_a_person_first()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "dev12-migration");
        var marker = $"M{Guid.NewGuid():N}"[..9];
        // 250 new customers, then a row without a name at the very end of the file.
        var csv = new StringBuilder("name;city\n");
        for (var i = 0; i < 250; i++)
        {
            csv.Append(System.Globalization.CultureInfo.InvariantCulture, $"{marker} Kunde {i:000} AS;Bergen\n");
        }

        csv.Append(";Bergen\n");
        var response = await admin.PostAsync("/api/v1/customers/organizations/import?dryRun=true", new StringContent(csv.ToString(), Encoding.UTF8, "text/csv"), Ct);
        response.EnsureSuccessStatusCode();
        var preview = await response.ReadJsonAsync();
        (preview.GetProperty("created").GetInt32(), preview.GetProperty("failed").GetInt32()).ShouldBe((250, 1));
        var rows = preview.GetProperty("rows").EnumerateArray().ToList();
        rows.Count.ShouldBe(200, "the answer lists a sample; the counts above cover all 251 rows");
        rows[0].GetProperty("action").GetString().ShouldBe("Rejected", "what needs a person comes first, wherever it is in the file");
        rows[0].GetProperty("reasonCode").GetString().ShouldBe("MISSING_NAME");
        rows[0].GetProperty("line").GetInt32().ShouldBe(252);
    }

    [Fact]
    public async Task The_digest_reaches_a_reader_due_now_however_many_older_notices_wait_for_other_hours()
    {
        var oslo = TimeZoneInfo.FindSystemTimeZoneById("Europe/Oslo");
        if (TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, oslo) is { Minute: 59, Second: > 45 })
        {
            // The job reads the hour itself; do not straddle a full hour.
            await Task.Delay(TimeSpan.FromSeconds(20), Ct);
        }

        var hour = TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, oslo).Hour;
        var reader = factory.ClientAs(CrmRoles.Sales, userKey: $"dev12-digest-{Guid.NewGuid():N}"[..24]);
        var readerId = await reader.UserIdAsync();
        (await reader.PutAsJsonAsync("/api/v1/notifications/preferences", new { emailEnabled = true, digestHour = hour, mutedKinds = Array.Empty<string>() }, Ct))
            .StatusCode.ShouldBe(System.Net.HttpStatusCode.OK);
        factory.Graph.Given(WireMock.RequestBuilders.Request.Create().WithPath("/graph/v1.0/users/crm@vardahei.no/sendMail").UsingPost())
            .RespondWith(WireMock.ResponseBuilders.Response.Create().WithStatusCode(202));

        // 2100 older notices of someone whose digest goes out twelve hours from now — more than the old batch of 2000 oldest.
        var elsewhere = Guid.NewGuid();
        var marker = $"G{Guid.NewGuid():N}"[..9];
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<Crm.Notifications.Persistence.NotificationsDbContext>();
            var preference = Crm.Notifications.Domain.NotificationPreference.Default(elsewhere);
            preference.Update(true, (hour + 12) % 24, []);
            db.Preferences.Add(preference);
            db.Notifications.AddRange(Enumerable.Range(0, 2100).Select(i => Crm.Notifications.Domain.Notification.Create(new Crm.Notifications.Contracts.NotificationRequest(
                Crm.Notifications.Contracts.NotificationKind.ContractEnding, elsewhere, $"{marker}-{i}",
                new Dictionary<string, string> { ["organization"] = $"{marker} {i}", ["number"] = "K-1", ["days"] = "30" }))));
            await db.SaveChangesAsync(Ct);
        }

        await factory.RunJobAsync<Crm.Notifications.Contracts.INotificationsApi>(api => api.EnqueueAsync(new Crm.Notifications.Contracts.NotificationRequest(
            Crm.Notifications.Contracts.NotificationKind.ContractEnding, readerId, $"{marker}-due",
            new Dictionary<string, string> { ["organization"] = $"{marker} Nå AS", ["number"] = "K-2", ["days"] = "30" }), CancellationToken.None));

        await factory.RunJobAsync<Crm.Notifications.Features.NotificationDigestJob>(job => job.RunAsync(CancellationToken.None));

        var mine = await reader.GetFromJsonAsync<JsonElement>("/api/v1/notifications?limit=200", Ct);
        mine.GetProperty("items").EnumerateArray()
            .Single(n => n.GetProperty("parameters").GetProperty("organization").GetString() == $"{marker} Nå AS")
            .GetProperty("emailStatus").GetString().ShouldBe("Sent", "the reader due now gets the digest");
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<Crm.Notifications.Persistence.NotificationsDbContext>();
            (await db.Notifications.CountAsync(n => n.RecipientId == elsewhere && n.EmailStatus == Crm.Notifications.Domain.EmailStatus.Pending, Ct))
                .ShouldBe(2100, "notices due at another hour wait for it");
        }
    }

    [Fact]
    public async Task AC05_the_dashboard_counts_every_renewal_it_does_not_list_and_the_mart_exports_them_all()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "dev12-renewals");
        var marker = $"R{Guid.NewGuid():N}"[..9];
        var organizationId = await admin.CreateOrganizationAsync(new { name = $"{marker} Fornyelse AS", status = "Customer" });
        var today = DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, TimeZoneInfo.FindSystemTimeZoneById("Europe/Oslo")).DateTime);
        // 205 contracts ending within the next 90 days — more than the old cap of 200 renewals.
        var ids = await CreateManyAsync(205, i => admin.PostAsJsonAsync("/api/v1/contracts", new
        {
            organizationId, title = $"{marker} Avtale {i:000}", type = "Msp", startDate = today.AddYears(-1).ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture),
            endDate = today.AddDays(10 + i % 70).ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture), autoRenew = false, renewalTermMonths = 0,
            noticePeriodDays = 30, invoiceFrequency = "Monthly", invoiceTiming = "InAdvance", indexation = false,
        }, Ct));
        foreach (var batch in ids.Chunk(15))
        {
            foreach (var activated in await Task.WhenAll(batch.Select(id => admin.PostAsync($"/api/v1/contracts/{id}/activate", null, Ct))))
            {
                activated.StatusCode.ShouldBe(System.Net.HttpStatusCode.OK);
            }
        }

        var dashboard = await admin.GetFromJsonAsync<JsonElement>("/api/v1/reports/dashboard", Ct);
        dashboard.GetProperty("renewals").GetArrayLength().ShouldBe(20, "the widget lists the soonest twenty");
        dashboard.GetProperty("renewalsTotal").GetInt32().ShouldBeGreaterThanOrEqualTo(205, "and counts every renewal of the window");

        var mart = await admin.GetFromJsonAsync<JsonElement>(
            $"/api/v1/reports/mart/renewals?from={today:yyyy-MM-dd}&to={today.AddDays(90):yyyy-MM-dd}", Ct);
        var column = mart.GetProperty("columns").EnumerateArray().Select(c => c.GetString()).ToList().IndexOf("organizationId");
        mart.GetProperty("rows").EnumerateArray().Count(r => r[column].GetGuid() == organizationId).ShouldBe(205, "the export has every row of the period");
    }

    [Fact]
    public async Task AC05_licences_past_the_old_caps_of_1000_listed_and_2000_counted_are_all_listed_and_counted()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "dev12-licences");
        var marker = $"Q{Guid.NewGuid():N}"[..9];
        var orgNumber = TestData.OrgNumber();
        var organizationId = await admin.CreateOrganizationAsync(new { name = $"{marker} Lisenser AS", orgNumber, status = "Customer" });
        var today = DateOnly.FromDateTime(DateTime.UtcNow);
        // 2100 subscriptions of one customer from one distributor file; none is on a contract, so every one is "not billed".
        var csv = new StringBuilder("Kundenavn;Organisasjonsnummer;KundeID;AbonnementsID;OfferId;Produktnavn;Antall;Status;Bindingstid;Faktureringsperiode;Startdato;Sluttdato;Autofornyelse;Partnerpris\n");
        for (var i = 0; i < 2100; i++)
        {
            csv.Append(System.Globalization.CultureInfo.InvariantCulture,
                $"{marker} Lisenser AS;{orgNumber};csp-{marker};sub-{marker}-{i:0000};OFFER-{marker}-{i % 7};Lisens {i % 7};{1 + i % 9};Active;P1Y;Annual;{today.AddMonths(-1):yyyy-MM-dd};{today.AddDays(200 + i % 100):yyyy-MM-dd};ja;100,00\n");
        }

        var imported = await admin.PostAsync("/api/v1/licensing/import", new StringContent(csv.ToString(), Encoding.UTF8, "text/csv"), Ct);
        imported.StatusCode.ShouldBe(System.Net.HttpStatusCode.OK, await imported.Content.ReadAsStringAsync(Ct));
        (await imported.ReadJsonAsync()).GetProperty("created").GetInt32().ShouldBe(2100);

        var listed = await ItemsAsync(admin, $"/api/v1/licensing/subscriptions?organizationId={organizationId}", 200);
        listed.Count.ShouldBe(2100);
        listed.Select(s => s.Item.GetProperty("id").GetGuid()).Distinct().Count().ShouldBe(2100);
        listed[0].Total.ShouldBe(2100);
        var notBilled = await ItemsAsync(admin, $"/api/v1/licensing/subscriptions?organizationId={organizationId}&notBilled=true", 150);
        notBilled.Select(s => s.Item.GetProperty("id").GetGuid()).Distinct().Count().ShouldBe(2100, "the not-billed filter pages through every one");

        var attention = await admin.GetFromJsonAsync<JsonElement>("/api/v1/licensing/attention", Ct);
        attention.GetProperty("summary").GetProperty("subscriptions").GetInt32().ShouldBeGreaterThanOrEqualTo(2100, "the summary counts every subscription");
        attention.GetProperty("summary").GetProperty("notBilled").GetInt32().ShouldBeGreaterThanOrEqualTo(2100);
        attention.GetProperty("notBilled").GetArrayLength().ShouldBeLessThanOrEqualTo(20, "the attention list is a top-N; the summary says how many");
    }

    private static async Task<HashSet<Guid>> CreateManyAsync(int count, Func<int, Task<HttpResponseMessage>> create)
    {
        var ids = new HashSet<Guid>();
        foreach (var batch in Enumerable.Range(0, count).Chunk(15))
        {
            foreach (var response in await Task.WhenAll(batch.Select(create)))
            {
                response.IsSuccessStatusCode.ShouldBeTrue(await response.Content.ReadAsStringAsync(Ct));
                ids.Add((await response.ReadJsonAsync()).GetProperty("id").GetGuid());
            }
        }

        return ids;
    }

    private static async Task<List<Guid>> ItemIdsAsync(HttpClient client, string url, int limit)
    {
        var ids = new List<Guid>();
        string? cursor = null;
        for (var guard = 0; guard < 1000; guard++)
        {
            var page = await client.GetFromJsonAsync<JsonElement>($"{url}&limit={limit}{(cursor is null ? "" : $"&cursor={Uri.EscapeDataString(cursor)}")}", Ct);
            ids.AddRange(page.GetProperty("items").EnumerateArray().Select(i => i.GetProperty("id").GetGuid()));
            if (page.GetProperty("nextCursor").ValueKind == JsonValueKind.Null)
            {
                return ids;
            }

            cursor = page.GetProperty("nextCursor").GetString();
        }

        throw new InvalidOperationException("The pages never ended.");
    }

    /// <summary>Every row of a paged list, each with the total the page it came on reported.</summary>
    private static async Task<List<(JsonElement Item, int Total)>> ItemsAsync(HttpClient client, string url, int limit)
    {
        var items = new List<(JsonElement, int)>();
        string? cursor = null;
        for (var guard = 0; guard < 1000; guard++)
        {
            var page = await client.GetFromJsonAsync<JsonElement>($"{url}&limit={limit}{(cursor is null ? "" : $"&cursor={Uri.EscapeDataString(cursor)}")}", Ct);
            var total = page.GetProperty("totalCount").GetInt32();
            items.AddRange(page.GetProperty("items").EnumerateArray().Select(i => (i, total)));
            if (page.GetProperty("nextCursor").ValueKind == JsonValueKind.Null)
            {
                return items;
            }

            cursor = page.GetProperty("nextCursor").GetString();
        }

        throw new InvalidOperationException("The pages never ended.");
    }

    private sealed record InvoiceSet(string Marker, Guid OrganizationId, IReadOnlySet<Guid> Ids, decimal Outstanding, decimal Overdue, int Open, int OverdueCount);

    /// <summary>
    /// A customer with <paramref name="count"/> invoices in two systems that number alike, ten to a date: every date and every
    /// number occurs more than once. A third is paid, a third overdue, a third open and not yet due.
    /// </summary>
    private async Task<InvoiceSet> InvoicesAsync(int count)
    {
        var marker = $"L{Guid.NewGuid():N}"[..9];
        var organizationId = await factory.ClientAs(CrmRoles.Admin).CreateOrganizationAsync(new { name = $"{marker} Fakturaer AS", status = "Customer" });
        var today = DateOnly.FromDateTime(DateTime.UtcNow);
        var invoices = new List<ExternalInvoice>();
        decimal outstanding = 0, overdue = 0;
        int open = 0, overdueCount = 0;
        for (var i = 0; i < count; i++)
        {
            var system = i % 2 == 0 ? "poweroffice" : "legacy";
            var number = $"{marker}-{i / 2:0000}";
            var date = today.AddDays(-30 - i / 10);
            var (left, due) = (i % 3) switch
            {
                0 => (0m, (DateOnly?)date.AddDays(14)),
                1 => (100m, date.AddDays(14)),
                _ => (100m, today.AddDays(10)),
            };
            outstanding += left;
            open += left > 0 ? 1 : 0;
            if (left > 0 && due < today)
            {
                overdue += left;
                overdueCount++;
            }

            invoices.Add(Invoice(system, number, organizationId, date, 100m, left, due));
        }

        await UpsertAsync(invoices);
        await using var scope = factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<Crm.Billing.Persistence.BillingDbContext>();
        var ids = (await db.Invoices.Where(i => i.OrganizationId == organizationId).Select(i => i.Id).ToListAsync(Ct)).ToHashSet();
        return new InvoiceSet(marker, organizationId, ids, outstanding, overdue, open, overdueCount);
    }

    private static ExternalInvoice Invoice(string system, string number, Guid organizationId, DateOnly date, decimal total, decimal outstanding, DateOnly? due) =>
        new(system, number, null, null, organizationId, date, due, total, outstanding, outstanding == 0 ? InvoiceStatus.Paid : InvoiceStatus.Sent, null);

    private async Task UpsertAsync(IReadOnlyCollection<ExternalInvoice> invoices)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        await scope.ServiceProvider.GetRequiredService<IBillingApi>().UpsertInvoicesAsync(invoices, Ct);
    }

    private static IEnumerable<Guid> Ids(JsonElement page) => page.GetProperty("invoices").EnumerateArray().Select(i => i.GetProperty("id").GetGuid());

    private static async Task<(List<Guid> Ids, List<(string Date, string Number)> Rows)> AllPagesAsync(HttpClient client, string url, int limit)
    {
        var ids = new List<Guid>();
        var rows = new List<(string, string)>();
        string? cursor = null;
        for (var guard = 0; guard < 1000; guard++)
        {
            var page = await client.GetFromJsonAsync<JsonElement>($"{url}&limit={limit}{(cursor is null ? "" : $"&cursor={Uri.EscapeDataString(cursor)}")}", Ct);
            foreach (var invoice in page.GetProperty("invoices").EnumerateArray())
            {
                ids.Add(invoice.GetProperty("id").GetGuid());
                rows.Add((invoice.GetProperty("invoiceDate").GetString()!, invoice.GetProperty("invoiceNo").GetString()!));
            }

            if (page.GetProperty("nextCursor").ValueKind == JsonValueKind.Null)
            {
                return (ids, rows);
            }

            cursor = page.GetProperty("nextCursor").GetString();
        }

        throw new InvalidOperationException("The pages never ended.");
    }
}
