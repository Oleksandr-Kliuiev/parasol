using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crm.Authorization;
using WireMock.RequestBuilders;
using WireMock.ResponseBuilders;
using static Crm.IntegrationTests.IntegrationTestHelpers;

namespace Crm.IntegrationTests;

/// <summary>
/// Quotes end to end (FR-SAL-03..05): the editor freezes prices, a discount above the limit waits for management, the PDF
/// leaves from the salesperson's own mailbox and an accepted quote drafts a contract and queues its one-time items.
/// </summary>
public class QuotesApiTests(CrmWebFactory factory)
{
    private const string Sales = "/api/v1/sales";

    private static async Task<Guid> StageAsync(HttpClient client, string name)
    {
        var stages = await client.GetFromJsonAsync<JsonElement>($"{Sales}/stages");
        return stages.EnumerateArray().Single(s => s.GetProperty("name").GetString() == name).GetProperty("id").GetGuid();
    }

    private static readonly DateOnly Today =
        DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, TimeZoneInfo.FindSystemTimeZoneById("Europe/Oslo")).DateTime);

    [Fact]
    public async Task A_quote_with_an_extra_discount_waits_for_management_and_then_becomes_a_contract()
    {
        var sales = factory.ClientAs(CrmRoles.Sales, userKey: "quote-sales");
        var management = factory.ClientAs(CrmRoles.Management, userKey: "quote-management");
        var finance = factory.ClientAs(CrmRoles.Finance, userKey: "quote-finance");
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "quote-admin");
        var marker = $"Q{Guid.NewGuid():N}"[..10];
        var organizationId = await sales.CreateOrganizationAsync(new { name = $"{marker} Tilbud AS", status = "Prospect", orgNumber = TestData.OrgNumber() });
        var contactId = (await (await sales.PostAsJsonAsync($"/api/v1/customers/organizations/{organizationId}/contacts", new
        {
            firstName = "Kari", lastName = "Hansen", email = $"kari.{marker}@example.no", roles = Array.Empty<string>(), isPrimary = true,
        })).ReadJsonAsync()).GetProperty("contactId").GetGuid();

        // Catalog: the monthly licence keeps its list price, the implementation is quoted by hand.
        var licence = await CatalogApiTests.CreateProductAsync(finance, CatalogApiTests.Product(CatalogApiTests.Sku("M365"), "Microsoft 365 Business Premium", 250m, 200m));
        var implementation = await CatalogApiTests.CreateProductAsync(
            finance, CatalogApiTests.Product(CatalogApiTests.Sku("IMPL"), "Etablering", 1_190m, 700m, "HourlyService", "OneTime"));

        var opportunityId = (await (await sales.PostAsJsonAsync($"{Sales}/opportunities", new
        {
            organizationId, name = $"{marker} Drift", businessLine = "Microsoft", stageId = await StageAsync(sales, "Qualification"),
            expectedCloseDate = Today.AddDays(30), oneOffAmount = 0m, mrr = 0m, termMonths = 24,
        })).ReadJsonAsync()).GetProperty("id").GetGuid();

        var created = await sales.PostAsJsonAsync($"{Sales}/quotes", new
        {
            organizationId,
            contactId,
            opportunityId,
            title = $"{marker} Drift av Microsoft 365",
            language = "nb",
            termMonths = 24,
            customerReference = "Bestilling 2026-14",
            lines = new object[]
            {
                new { productId = licence, name = "Microsoft 365 Business Premium", quantity = 25m, discountPct = 0m, recurrence = "Monthly" },
                new { productId = implementation, name = "Etablering og migrering", quantity = 20m, unitPrice = 1_190m, discountPct = 20m, recurrence = "OneTime" },
            },
        });
        created.StatusCode.ShouldBe(HttpStatusCode.Created);
        var quote = await created.ReadJsonAsync();
        var quoteId = quote.GetProperty("id").GetGuid();
        quote.GetProperty("number").GetString().ShouldStartWith($"T-{Today.Year}-");
        quote.GetProperty("status").GetString().ShouldBe("Draft");
        quote.GetProperty("versionNo").GetInt32().ShouldBe(1);
        // The line without a price took today's catalog price and froze it (BR-SAL-06).
        quote.GetProperty("lines").EnumerateArray().First().GetProperty("unitPrice").GetDecimal().ShouldBe(250m);
        quote.GetProperty("monthlyExVat").GetDecimal().ShouldBe(6_250m);
        quote.GetProperty("oneTimeExVat").GetDecimal().ShouldBe(19_040m);
        quote.GetProperty("contractValue").GetDecimal().ShouldBe(19_040m + (6_250m * 24));
        quote.GetProperty("maxDiscountPct").GetDecimal().ShouldBe(20m);
        (await sales.GetFromJsonAsync<JsonElement>($"{Sales}/quotes/{quoteId}")).GetProperty("etag").GetString()
            .ShouldBe(quote.GetProperty("etag").GetString());

        // BR-SAL-05: 20 % is above the 15 % a salesperson may give, so releasing it asks management first.
        var submitted = await (await sales.PostAsync($"{Sales}/quotes/{quoteId}/submit", null)).ReadJsonAsync();
        submitted.GetProperty("status").GetString().ShouldBe("PendingApproval");
        submitted.GetProperty("hasDocument").GetBoolean().ShouldBeFalse();

        var tooEarly = await sales.GetAsync($"{Sales}/quotes/{quoteId}/pdf");
        tooEarly.StatusCode.ShouldBe(HttpStatusCode.Conflict);
        (await tooEarly.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe("SAL_QUOTE_NOT_RELEASED");
        (await sales.PostAsync($"{Sales}/quotes/{quoteId}/approve", null)).StatusCode.ShouldBe(HttpStatusCode.Forbidden);

        var approved = await (await management.PostAsync($"{Sales}/quotes/{quoteId}/approve", null)).ReadJsonAsync();
        approved.GetProperty("status").GetString().ShouldBe("Ready");
        approved.GetProperty("approvedBy").GetProperty("name").GetString().ShouldBe("Test quote-management");

        // FR-SAL-03: the document is rendered from the frozen version.
        var pdf = await sales.GetAsync($"{Sales}/quotes/{quoteId}/pdf");
        pdf.StatusCode.ShouldBe(HttpStatusCode.OK);
        pdf.Content.Headers.ContentType!.MediaType.ShouldBe("application/pdf");
        var bytes = await pdf.Content.ReadAsByteArrayAsync();
        System.Text.Encoding.Latin1.GetString(bytes[..8]).ShouldStartWith("%PDF-1.7");
        System.Text.Encoding.Latin1.GetString(bytes).ShouldContain("Kari Hansen");

        // FR-SAL-04: sent from the salesperson's own mailbox, with the PDF attached.
        factory.Graph.Given(Request.Create().WithPath("/graph/v1.0/users/quote-sales@test.local/sendMail").UsingPost())
            .RespondWith(Response.Create().WithStatusCode(202));
        var sent = await sales.PostAsJsonAsync($"{Sales}/quotes/{quoteId}/send", new
        {
            toAddress = $"kari.{marker}@example.no", toName = "Kari Hansen", subject = $"{marker} Tilbud", message = "Hei Kari, her er tilbudet.",
        });
        sent.StatusCode.ShouldBe(HttpStatusCode.OK);
        (await sent.ReadJsonAsync()).GetProperty("status").GetString().ShouldBe("Sent");

        var mail = factory.Graph.LogEntries
            .Select(e => e.RequestMessage)
            .Where(r => r!.Path == "/graph/v1.0/users/quote-sales@test.local/sendMail")
            .Select(r => JsonDocument.Parse(r!.Body ?? "{}").RootElement)
            .Single(e => e.GetProperty("message").GetProperty("subject").GetString() == $"{marker} Tilbud");
        mail.GetProperty("saveToSentItems").GetBoolean().ShouldBeTrue();
        var attachment = mail.GetProperty("message").GetProperty("attachments").EnumerateArray().Single();
        attachment.GetProperty("@odata.type").GetString().ShouldBe("#microsoft.graph.fileAttachment");
        attachment.GetProperty("contentType").GetString().ShouldBe("application/pdf");
        Convert.FromBase64String(attachment.GetProperty("contentBytes").GetString()!).Length.ShouldBe(bytes.Length);

        // A sent version never changes again (BR-SAL-04).
        var edit = await sales.PutWithETagAsync($"{Sales}/quotes/{quoteId}", new
        {
            organizationId, title = "Endret", termMonths = 24, lines = Array.Empty<object>(),
        }, (await sales.GetFromJsonAsync<JsonElement>($"{Sales}/quotes/{quoteId}")).GetProperty("etag").GetString()!);
        edit.StatusCode.ShouldBe(HttpStatusCode.Conflict);
        (await edit.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe("SAL_QUOTE_NOT_EDITABLE");

        // BR-SAL-07: accepting wins the deal, drafts a contract and queues the one-time line for billing.
        (await sales.PostAsync($"{Sales}/quotes/{quoteId}/accept", null)).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await sales.GetFromJsonAsync<JsonElement>($"{Sales}/opportunities/{opportunityId}")).GetProperty("status").GetString().ShouldBe("Won");

        await factory.EventuallyAsync(async () =>
            (await admin.GetFromJsonAsync<JsonElement>($"/api/v1/contracts?search={marker}")).GetProperty("items").GetArrayLength() > 0);
        var contracts = (await admin.GetFromJsonAsync<JsonElement>($"/api/v1/contracts?search={marker}")).GetProperty("items");
        contracts.GetArrayLength().ShouldBe(1);
        var contract = await admin.GetFromJsonAsync<JsonElement>($"/api/v1/contracts/{contracts[0].GetProperty("id").GetGuid()}");
        contract.GetProperty("status").GetString().ShouldBe("Draft");
        contract.GetProperty("title").GetString().ShouldBe($"{marker} Drift av Microsoft 365");
        var line = contract.GetProperty("lines").EnumerateArray().Single();
        line.GetProperty("quantity").GetDecimal().ShouldBe(25m);
        line.GetProperty("unitPrice").GetDecimal().ShouldBe(250m);

        // A repeated delivery of the event drafts nothing twice.
        await factory.ProcessEventsAsync();
        (await admin.GetFromJsonAsync<JsonElement>($"/api/v1/contracts?search={marker}")).GetProperty("items").GetArrayLength().ShouldBe(1);

        // The one-time line is collected by the next billing run, once.
        var period = new DateOnly(2027, 11, 1);
        var runId = (await (await finance.PostAsJsonAsync("/api/v1/billing/runs", new { year = period.Year, month = period.Month, notes = marker })).ReadJsonAsync())
            .GetProperty("id").GetGuid();
        (await finance.RunCommandAsync(runId, "collect")).StatusCode.ShouldBe(HttpStatusCode.OK);
        // The first open run that collects the line holds it; in the shared database that may be another test's run (ADR-013).
        var detail = await factory.QueuedChargeBasisAsync(finance, runId, c => c.SourceType == "quote" && c.SourceId == quoteId);
        detail.GetProperty("organization").GetProperty("id").GetGuid().ShouldBe(organizationId);
        var oneOff = detail.GetProperty("lines").EnumerateArray().Single(l => l.GetProperty("group").GetString() == "OneOff");
        oneOff.GetProperty("description").GetString()!.ShouldContain("Etablering og migrering");
        oneOff.GetProperty("lineTotal").GetDecimal().ShouldBe(19_040m);
        oneOff.GetProperty("quantity").GetDecimal().ShouldBe(20m);
    }

    [Fact]
    public async Task A_rejected_discount_comes_back_to_the_salesperson_and_a_new_version_starts_from_the_old_one()
    {
        var sales = factory.ClientAs(CrmRoles.Sales, userKey: "quote-sales2");
        var management = factory.ClientAs(CrmRoles.Management, userKey: "quote-management");
        var marker = $"Q{Guid.NewGuid():N}"[..10];
        var organizationId = await sales.CreateOrganizationAsync(new { name = $"{marker} Rabatt AS", status = "Prospect" });

        var quoteId = (await (await sales.PostAsJsonAsync($"{Sales}/quotes", new
        {
            organizationId,
            title = $"{marker} Pakke",
            termMonths = 12,
            lines = new object[] { new { name = "Drift", quantity = 10m, unitPrice = 1_000m, discountPct = 30m, recurrence = "Monthly" } },
        })).ReadJsonAsync()).GetProperty("id").GetGuid();

        (await sales.PostAsync($"{Sales}/quotes/{quoteId}/submit", null)).StatusCode.ShouldBe(HttpStatusCode.OK);
        var queue = await management.GetFromJsonAsync<JsonElement>($"{Sales}/quotes?awaitingApproval=true&search={marker}");
        queue.GetProperty("items").EnumerateArray().Single().GetProperty("maxDiscountPct").GetDecimal().ShouldBe(30m);

        var rejected = await (await management.PostAsJsonAsync($"{Sales}/quotes/{quoteId}/reject", new { reason = "For lav margin på drift." })).ReadJsonAsync();
        rejected.GetProperty("status").GetString().ShouldBe("Draft");
        rejected.GetProperty("rejectedReason").GetString().ShouldBe("For lav margin på drift.");

        // Back within the limit it is released without asking anyone.
        var etag = (await sales.GetFromJsonAsync<JsonElement>($"{Sales}/quotes/{quoteId}")).GetProperty("etag").GetString()!;
        var updated = await sales.PutWithETagAsync($"{Sales}/quotes/{quoteId}", new
        {
            organizationId,
            title = $"{marker} Pakke",
            termMonths = 12,
            lines = new object[] { new { name = "Drift", quantity = 10m, unitPrice = 1_000m, discountPct = 10m, recurrence = "Monthly" } },
        }, etag);
        updated.StatusCode.ShouldBe(HttpStatusCode.OK, await updated.Content.ReadAsStringAsync());
        (await (await sales.PostAsync($"{Sales}/quotes/{quoteId}/submit", null)).ReadJsonAsync()).GetProperty("status").GetString().ShouldBe("Ready");

        // A new version copies the lines and leaves the old one as history (BR-SAL-04).
        var second = await (await sales.PostAsync($"{Sales}/quotes/{quoteId}/revise", null)).ReadJsonAsync();
        second.GetProperty("versionNo").GetInt32().ShouldBe(2);
        second.GetProperty("number").GetString().ShouldBe(rejected.GetProperty("number").GetString());
        second.GetProperty("lines").GetArrayLength().ShouldBe(1);
        second.GetProperty("versions").GetArrayLength().ShouldBe(2);
        (await sales.GetFromJsonAsync<JsonElement>($"{Sales}/quotes/{quoteId}")).GetProperty("status").GetString().ShouldBe("Superseded");

        var list = await sales.GetFromJsonAsync<JsonElement>($"{Sales}/quotes?search={marker}");
        list.GetProperty("items").EnumerateArray().Count(q => q.GetProperty("isLatestVersion").GetBoolean()).ShouldBe(1);
    }

    [Fact]
    public async Task A_role_without_finance_read_sees_no_amounts_and_gets_no_document_even_of_a_quote_it_owns()
    {
        var sales = factory.ClientAs(CrmRoles.Sales, userKey: "quote-sales3");
        var reader = factory.ClientAs(CrmRoles.ReadOnly, userKey: "quote-reader");
        var marker = $"Q{Guid.NewGuid():N}"[..10];
        var organizationId = await sales.CreateOrganizationAsync(new { name = $"{marker} Innsyn AS", status = "Prospect" });
        var quoteId = (await (await sales.PostAsJsonAsync($"{Sales}/quotes", new
        {
            organizationId,
            title = $"{marker} Innsyn",
            termMonths = 12,
            lines = new object[] { new { name = "Drift", quantity = 1m, unitPrice = 5_000m, discountPct = 0m, recurrence = "Monthly" } },
        })).ReadJsonAsync()).GetProperty("id").GetGuid();
        (await sales.PostAsync($"{Sales}/quotes/{quoteId}/submit", null)).StatusCode.ShouldBe(HttpStatusCode.OK);

        // Someone else's quote is not there at all for ReadOnly (DEV-09); one handed to the reader is, without its money.
        (await reader.GetAsync($"{Sales}/quotes/{quoteId}")).StatusCode.ShouldBe(HttpStatusCode.NotFound);
        (await sales.TransferQuoteAsync(quoteId, await reader.UserIdAsync())).StatusCode.ShouldBe(HttpStatusCode.NoContent);

        var seen = await reader.GetFromJsonAsync<JsonElement>($"{Sales}/quotes/{quoteId}");
        seen.TryGetProperty("monthlyExVat", out _).ShouldBeFalse();
        seen.GetProperty("lines").EnumerateArray().First().TryGetProperty("unitPrice", out _).ShouldBeFalse();
        seen.GetProperty("title").GetString().ShouldBe($"{marker} Innsyn");

        var document = await reader.GetAsync($"{Sales}/quotes/{quoteId}/pdf");
        document.StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        (await reader.PostAsync($"{Sales}/quotes/{quoteId}/accept", null)).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
    }
}
