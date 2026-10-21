using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crm.Authorization;
using Crm.Integrations.Core;
using Crm.Integrations.Core.Actions;
using Crm.Integrations.Core.Persistence;
using Crm.Service.Contracts;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using WireMock.RequestBuilders;
using WireMock.ResponseBuilders;

namespace Crm.IntegrationTests;

/// <summary>
/// A synthetic contact person with data in every module that can hold it (DEV-11): the contact and an affiliation, a deal, a
/// quote sent to them (not accepted) and an accepted one, a call and an e-mail saved from them, a mirrored Atera ticket where
/// they are the end user (with a reply sent to them from the CRM and an internal note still waiting to be sent, M39), a ticket
/// request for them, a linked Atera person record and a queued change for PowerOffice —
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
    Guid OutboundId,
    Guid ReplyActionId,
    Guid WaitingActionId)
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
            // M39.2: the ticket's conversation is about the person too.
            await scope.ServiceProvider.GetRequiredService<IServiceApi>().ApplyTicketConversationAsync("atera", ateraTicketId,
            [
                new ExternalTicketComment($"prv-{marker}-1", $"{firstName} sin skriver svarer ikke", false, TicketCommentAuthor.EndUser, $"{firstName} {lastName}", null,
                    DateTimeOffset.UtcNow.AddDays(-2)),
                new ExternalTicketComment($"prv-{marker}-2", $"Hei {firstName}, vi ser på det", false, TicketCommentAuthor.Technician, "Tekniker", null, DateTimeOffset.UtcNow.AddDays(-1)),
            ], withheld: false, Ct);
        }

        var ticketRequest = await sales.PostAsJsonAsync("/api/v1/service/ticket-requests", new
        {
            organizationId, contactId, title = $"Hjelp til {firstName}", description = $"{firstName} trenger ny PC", priority = "Medium", type = "Request",
        }, Ct);
        ticketRequest.IsSuccessStatusCode.ShouldBeTrue(await ticketRequest.Content.ReadAsStringAsync(Ct));
        var ticketRequestId = (await ticketRequest.ReadJsonAsync()).GetProperty("id").GetGuid();

        var ateraContactId = Random.Shared.Next(100_000_000, 999_999_999).ToString(CultureInfo.InvariantCulture);
        Guid recordId, outboundId, ticketId, replyActionId, waitingActionId;
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
            replyActionId = AddTicketAction(db, ateraTicketId, organizationId, marker, "ticket.reply", $"Hei {firstName}, ny PC kommer i morgen", VendorActionStatus.Succeeded);
            waitingActionId = AddTicketAction(db, ateraTicketId, organizationId, marker, "ticket.note", $"{firstName} ringer tilbake etter lunsj", VendorActionStatus.Queued);
            await db.SaveChangesAsync(Ct);
            outboundId = operation.Id;
            ticketId = await scope.ServiceProvider.GetRequiredService<Crm.Service.Persistence.ServiceDbContext>().Tickets
                .Where(t => t.ExternalId == ateraTicketId).Select(t => t.Id).SingleAsyncEf(Ct);
        }

        // A host with a database of its own (the restore test) shares it with no parallel class, so there is nothing to race with.
        var database = new SqlConnectionStringBuilder(host.Services.GetRequiredService<IConfiguration>().GetConnectionString("crm")).InitialCatalog;
        if (database == CrmWebFactory.Database)
        {
            await SettleAsync(factory, contactId);
        }

        return new PrivacyPerson(
            marker, organizationId, contactId, colleagueId, firstName, lastName, email, phone, colleagueEmail, dealId, sentQuoteId, acceptedQuoteId,
            callId, mailId, ticketId, ateraTicketId, ticketRequestId, ateraContactId, recordId, outboundId, replyActionId, waitingActionId);
    }

    /// <summary>An action asked for the person's ticket, saved with its operation as a command saves it (M39.1).</summary>
    private static Guid AddTicketAction(IntegrationDbContext db, long ticket, Guid organizationId, string marker, string kind, string text, VendorActionStatus status)
    {
        var now = DateTimeOffset.UtcNow;
        var done = status == VendorActionStatus.Succeeded;
        var operation = new OutboundOperation
        {
            Id = Crm.SharedKernel.Domain.SequentialId.New(),
            System = "atera",
            Operation = $"action:{kind}",
            EntityType = "VendorAction",
            EntityId = Guid.NewGuid(),
            IdempotencyKey = $"prv-{marker}-{kind}",
            Status = done ? OutboundStatus.Succeeded : OutboundStatus.Pending,
            Attempts = done ? 1 : 0,
            CreatedAt = now,
            NextAttemptAt = done ? now : now.AddHours(1),
            CompletedAt = done ? now : null,
        };
        db.OutboundOperations.Add(operation);
        var action = new VendorAction
        {
            Id = operation.EntityId,
            System = "atera",
            Kind = kind,
            Level = VendorActionLevel.Standard,
            TargetType = VendorActionTargets.Ticket,
            TargetId = ticket.ToString(CultureInfo.InvariantCulture),
            TargetName = $"#{ticket} {marker} Skriver virker ikke",
            OrganizationId = organizationId,
            Parameters = JsonSerializer.Serialize(new { text }),
            Fingerprint = new string('0', 64),
            RequestedBy = Guid.NewGuid(),
            RequestedAt = now,
            NotBefore = now,
            CommandKey = Guid.NewGuid(),
            OutboundOperationId = operation.Id,
            Status = status,
            OutcomeCode = done ? "VND_SENT" : null,
            Outcome = done ? "Sent." : null,
            Attempts = done ? 1 : 0,
            CompletedAt = done ? now : null,
        };
        db.VendorActions.Add(action);
        return action.Id;
    }

    /// <summary>
    /// Settles the person before a plan is previewed. The test factory writes to PowerOffice, so every change of a contact queues a
    /// contact person sync when its event is delivered — possibly by a parallel class, possibly after the preview — and that sync,
    /// once sent, links the contact. Either would change the plan between preview and execution, and the case would rightly answer
    /// PRV_PLAN_CHANGED. So every event that names the person is delivered first, and their queued operations are then held back as
    /// if leased for an hour; the erasure cancels them all the same, as it does every operation not yet sent.
    /// </summary>
    public static async Task SettleAsync(CrmWebFactory factory, Guid contactId)
    {
        var holder = Guid.NewGuid();
        for (var attempt = 0; attempt < 100; attempt++)
        {
            await factory.ProcessEventsAsync();
            if (await ScalarAsync(factory, UndeliveredSql, contactId, holder) == 0 && await ScalarAsync(factory, HoldBackSql, contactId, holder) == 0)
            {
                return;
            }

            await Task.Delay(100, Ct);
        }

        throw new Shouldly.ShouldAssertException($"The events and operations of contact {contactId} did not settle.");
    }

    /// <summary>Events in any module's outbox that name the contact and are not delivered yet.</summary>
    private const string UndeliveredSql = """
        DECLARE @pattern nvarchar(64) = N'%' + LOWER(CONVERT(nvarchar(36), @id)) + N'%';
        DECLARE @sql nvarchar(max) = N'';
        SELECT @sql = @sql + CASE WHEN @sql = N'' THEN N'' ELSE N' UNION ALL ' END
            + N'SELECT COUNT(*) AS n FROM ' + QUOTENAME(s.name) + N'.OutboxMessages WHERE ProcessedAt IS NULL AND Status IN (N''Pending'', N''Processing'') AND Payload LIKE @pattern'
        FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id WHERE t.name = N'OutboxMessages';
        SET @sql = N'SELECT COALESCE(SUM(n), 0) FROM (' + @sql + N') AS x';
        EXEC sp_executesql @sql, N'@pattern nvarchar(64)', @pattern = @pattern;
        """;

    /// <summary>
    /// Holds back the contact's queued operations that nobody is sending, then counts those a parallel class is sending right now
    /// (leased by someone else): the caller waits for them to finish.
    /// </summary>
    private const string HoldBackSql = """
        UPDATE integration.OutboundOperations
        SET NextAttemptAt = DATEADD(hour, 1, SYSDATETIMEOFFSET()), LockedUntil = DATEADD(hour, 1, SYSDATETIMEOFFSET()), LeaseOwner = @holder
        WHERE EntityType = N'Contact' AND EntityId = @id AND Status = N'Pending' AND (LockedUntil IS NULL OR LockedUntil < SYSDATETIMEOFFSET());
        SELECT COUNT(*) FROM integration.OutboundOperations
        WHERE EntityType = N'Contact' AND EntityId = @id AND Status = N'Pending' AND LockedUntil >= SYSDATETIMEOFFSET() AND (LeaseOwner IS NULL OR LeaseOwner <> @holder);
        """;

    private static async Task<int> ScalarAsync(CrmWebFactory factory, string sql, Guid contactId, Guid holder)
    {
        await using var connection = new SqlConnection(factory.AdminConnectionString);
        await connection.OpenAsync(Ct);
        await using var command = new SqlCommand(sql, connection);
        command.Parameters.AddWithValue("@id", contactId);
        command.Parameters.AddWithValue("@holder", holder);
        return Convert.ToInt32(await command.ExecuteScalarAsync(Ct), CultureInfo.InvariantCulture);
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
