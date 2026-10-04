using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crm.Authorization;
using Crm.Integrations.Core;
using Crm.Integrations.Core.Persistence;
using Crm.Service.Contracts;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using WireMock.RequestBuilders;
using WireMock.ResponseBuilders;

namespace Crm.IntegrationTests;

/// <summary>
/// A synthetic contact person with data in every module that can hold it (DEV-11): the contact and an affiliation, a deal, a
/// quote sent to them (not accepted) and an accepted one, a call and an e-mail saved from them, a mirrored Atera ticket where
/// they are the end user, a ticket request for them, a linked Atera person record and a queued change for PowerOffice —
/// plus a colleague at the same customer whose data must never show up in the person's export or be touched by its erasure.
/// </summary>
internal sealed record PrivacyPerson(
    string Marker,
    Guid OrganizationId,
    Guid ContactId,
    Guid ColleagueId,
    string FirstName,
    string LastName,
    string Email,
    string Phone,
    string ColleagueEmail,
    Guid DealId,
    Guid SentQuoteId,
    Guid AcceptedQuoteId,
    Guid CallId,
    Guid MailId,
    Guid TicketId,
    long AteraTicketId,
    Guid TicketRequestId,
    string AteraContactId,
    Guid ExternalRecordId,
    Guid OutboundId)
{
    public IEnumerable<string> PersonalValues => [FirstName, LastName, Email, Phone, "Daglig leder", $"Samtale med {FirstName}", $"Hei fra {FirstName}"];
}

internal static class PrivacyTestData
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    public static async Task<PrivacyPerson> PersonAsync(CrmWebFactory factory, WebApplicationFactory<Program>? host = null)
    {
        host ??= factory;
        var marker = $"P{Guid.NewGuid():N}"[..10];
        var salesKey = $"prv-sales-{marker.ToLowerInvariant()}";
        var admin = Client(host, CrmRoles.Admin, $"prv-admin-{marker.ToLowerInvariant()}");
        var sales = Client(host, CrmRoles.Sales, salesKey);
        var firstName = $"Solveig{marker}";
        var lastName = "Nordli";
        var email = $"solveig.{marker.ToLowerInvariant()}@example.no";
        var phone = $"+47 9{marker.GetHashCode(StringComparison.Ordinal) & 0x7FFFFFF:0000000}"[..12];

        var organizationId = await admin.CreateOrganizationAsync(new
        {
            name = $"{marker} Personvern AS", status = "Customer", ehfEnabled = false,
            postalAddress = new { street = "Gata 1", postalCode = "0150", city = "Oslo", countryCode = "NO" },
        });
        var contactId = await ContactAsync(admin, organizationId, new
        {
            firstName, lastName, email, phone, mobilePhone = "+47 41 00 00 00", preferredLanguage = "nb", title = "Daglig leder",
            roles = new[] { "DecisionMaker" }, isPrimary = true,
        });
        var colleagueEmail = $"kollega.{marker.ToLowerInvariant()}@example.no";
        var colleagueId = await ContactAsync(admin, organizationId, new
        {
            firstName = $"Kollega{marker}", lastName = "Berg", email = colleagueEmail, roles = Array.Empty<string>(), isPrimary = false,
        });

        // A change of the person, so the audit trail holds their old values too.
        var current = await admin.GetAsync($"/api/v1/customers/contacts/{contactId}", Ct);
        current.StatusCode.ShouldBe(HttpStatusCode.OK);
        (await admin.PutWithETagAsync($"/api/v1/customers/contacts/{contactId}", new
        {
            firstName, lastName, email, phone, mobilePhone = "+47 41 11 11 11", preferredLanguage = "nb",
        }, current.Headers.ETag!.Tag)).StatusCode.ShouldBe(HttpStatusCode.OK);

        var stage = (await admin.GetFromJsonAsync<JsonElement>("/api/v1/sales/stages", Ct)).EnumerateArray().First().GetProperty("id").GetGuid();
        var deal = await sales.PostAsJsonAsync("/api/v1/sales/opportunities", new
        {
            organizationId, contactId, name = $"{marker} Avtale", businessLine = "Msp", stageId = stage, probability = 50,
            expectedCloseDate = DateOnly.FromDateTime(DateTime.UtcNow.AddMonths(1)).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
            oneOffAmount = 0m, mrr = 1000m, termMonths = 12,
        }, Ct);
        deal.StatusCode.ShouldBe(HttpStatusCode.Created, await deal.Content.ReadAsStringAsync(Ct));
        var dealId = (await deal.ReadJsonAsync()).GetProperty("id").GetGuid();

        factory.Graph.Given(Request.Create().WithPath($"/graph/v1.0/users/{salesKey}@test.local/sendMail").UsingPost())
            .RespondWith(Response.Create().WithStatusCode(202));
        var sentQuoteId = await QuoteDocumentsTests.QuoteAsync(sales, organizationId, contactId, marker, "nb");
        (await sales.PostAsync($"/api/v1/sales/quotes/{sentQuoteId}/submit", null, Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await sales.PostAsJsonAsync($"/api/v1/sales/quotes/{sentQuoteId}/send", new { toAddress = email, subject = $"{marker} Tilbud" }, Ct))
            .StatusCode.ShouldBe(HttpStatusCode.OK);
        var acceptedQuoteId = await QuoteDocumentsTests.QuoteAsync(sales, organizationId, contactId, marker, "nb");
        (await sales.PostAsync($"/api/v1/sales/quotes/{acceptedQuoteId}/submit", null, Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await sales.PostAsJsonAsync($"/api/v1/sales/quotes/{acceptedQuoteId}/send", new { toAddress = email, subject = $"{marker} Tilbud 2" }, Ct))
            .StatusCode.ShouldBe(HttpStatusCode.OK);
        (await sales.PostAsync($"/api/v1/sales/quotes/{acceptedQuoteId}/accept", null, Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);

        var call = await sales.PostAsJsonAsync("/api/v1/activities/", new
        {
            type = "Call", organizationId, contactId, subject = $"Samtale med {firstName}", body = $"Ring {phone} om avtalen", priority = "Normal",
        }, Ct);
        call.StatusCode.ShouldBe(HttpStatusCode.Created, await call.Content.ReadAsStringAsync(Ct));
        var callId = (await call.ReadJsonAsync()).GetProperty("id").GetGuid();
        var mail = await sales.PostAsJsonAsync("/api/v1/activities/mail/save", new
        {
            organizationId, messageId = $"<{marker}@example.no>", subject = $"Hei fra {firstName}", preview = "Takk for sist", fromAddress = email,
            fromName = $"{firstName} {lastName}", receivedAt = DateTimeOffset.UtcNow.AddDays(-1), webLink = "https://outlook.office.com/mail/x",
        }, Ct);
        mail.StatusCode.ShouldBe(HttpStatusCode.Created, await mail.Content.ReadAsStringAsync(Ct));
        var mailId = (await mail.ReadJsonAsync()).GetProperty("id").GetGuid();

        var ateraTicketId = Random.Shared.NextInt64(10_000_000, 99_999_999);
        await using (var scope = host.Services.CreateAsyncScope())
        {
            await scope.ServiceProvider.GetRequiredService<IServiceApi>().UpsertTicketsAsync(
            [
                new ExternalTicket("atera", ateraTicketId, organizationId, contactId, $"{marker} Skriver virker ikke", "Open", "Medium", null, "Problem", "Email",
                    null, "Tekniker", $"{firstName} {lastName}", email, DateTimeOffset.UtcNow.AddDays(-2), null, null, DateTimeOffset.UtcNow, null),
            ], Ct);
        }

        var ticketRequest = await sales.PostAsJsonAsync("/api/v1/service/ticket-requests", new
        {
            organizationId, contactId, title = $"Hjelp til {firstName}", description = $"{firstName} trenger ny PC", priority = "Medium", type = "Request",
        }, Ct);
        ticketRequest.IsSuccessStatusCode.ShouldBeTrue(await ticketRequest.Content.ReadAsStringAsync(Ct));
        var ticketRequestId = (await ticketRequest.ReadJsonAsync()).GetProperty("id").GetGuid();

        var ateraContactId = Random.Shared.Next(100_000_000, 999_999_999).ToString(CultureInfo.InvariantCulture);
        Guid recordId, outboundId, ticketId;
        await using (var scope = host.Services.CreateAsyncScope())
        {
            var records = scope.ServiceProvider.GetRequiredService<ExternalRecordStore>();
            var outcome = await records.UpsertAsync(new ExternalRecordInput(
                "atera", "Contact", ateraContactId, $"{firstName} {lastName}",
                new { firstName, lastName, email, phone }, Email: email, Phone: phone, ParentExternalId: "1", IsPerson: true), Ct);
            recordId = outcome.Record.Id;
            (await scope.ServiceProvider.GetRequiredService<ExternalLinkService>()
                .LinkAsync(EntityTypes.Contact, contactId, "atera", "Contact", ateraContactId, LinkMethod.Manual, null, Ct)).IsSuccess.ShouldBeTrue();
            var db = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
            var operation = new OutboundOperation
            {
                Id = Crm.SharedKernel.Domain.SequentialId.New(),
                System = "poweroffice",
                Operation = "sync-contact-person",
                EntityType = EntityTypes.Contact,
                EntityId = contactId,
                IdempotencyKey = $"prv-{marker}",
                Status = OutboundStatus.Failed,
                Attempts = 1,
                CreatedAt = DateTimeOffset.UtcNow,
                NextAttemptAt = DateTimeOffset.UtcNow.AddHours(1),
                LastError = $"PowerOffice refused {email}",
            };
            db.OutboundOperations.Add(operation);
            await db.SaveChangesAsync(Ct);
            outboundId = operation.Id;
            ticketId = await scope.ServiceProvider.GetRequiredService<Crm.Service.Persistence.ServiceDbContext>().Tickets
                .Where(t => t.ExternalId == ateraTicketId).Select(t => t.Id).SingleAsyncEf(Ct);
        }

        return new PrivacyPerson(
            marker, organizationId, contactId, colleagueId, firstName, lastName, email, phone, colleagueEmail, dealId, sentQuoteId, acceptedQuoteId,
            callId, mailId, ticketId, ateraTicketId, ticketRequestId, ateraContactId, recordId, outboundId);
    }

    public static HttpClient Client(WebApplicationFactory<Program> host, string role, string userKey) =>
        QuoteDocumentsTests.Client(host, role, userKey);

    private static async Task<Guid> ContactAsync(HttpClient admin, Guid organizationId, object body)
    {
        var created = await admin.PostAsJsonAsync($"/api/v1/customers/organizations/{organizationId}/contacts", body, Ct);
        created.StatusCode.ShouldBe(HttpStatusCode.Created, await created.Content.ReadAsStringAsync(Ct));
        return (await created.ReadJsonAsync()).GetProperty("contactId").GetGuid();
    }

    private static Task<T> SingleAsyncEf<T>(this IQueryable<T> query, CancellationToken ct) =>
        Microsoft.EntityFrameworkCore.EntityFrameworkQueryableExtensions.SingleAsync(query, ct);
}
