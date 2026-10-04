using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Crm.Authorization;
using Crm.Integrations.Core.Persistence;
using Crm.Privacy.Contracts;
using Crm.Privacy.Features;
using Crm.Privacy.Persistence;
using Crm.Sales.Persistence;
using Crm.Service.Persistence;
using Crm.SharedKernel.Documents;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crm.IntegrationTests;

/// <summary>
/// DEV-11: data subject requests end to end — the export of everything the modules hold about a person, an erasure that
/// leaves nothing readable behind in the APIs, the history, search and the frozen documents, carried out idempotently and
/// resumably, keeping what bookkeeping and a legal hold require and nothing more — and retention that removes nothing until
/// its periods are approved (EXT-07).
/// </summary>
public sealed class PrivacyTests(CrmWebFactory factory)
{
    private const string Privacy = "/api/v1/privacy";

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task AC01_the_export_of_a_contact_holds_their_data_from_every_module_and_nobody_else_s()
    {
        var person = await PrivacyTestData.PersonAsync(factory);
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: $"prv-admin-{person.Marker.ToLowerInvariant()}");
        var (caseId, etag) = await OpenAsync(admin, "Access", "Contact", person.ContactId);
        etag = await VerifyAsync(admin, caseId, etag);

        var response = await admin.GetAsync($"{Privacy}/cases/{caseId}/export", Ct);
        response.StatusCode.ShouldBe(HttpStatusCode.OK, await response.Content.ReadAsStringAsync(Ct));
        var bytes = await response.Content.ReadAsByteArrayAsync(Ct);
        var text = Encoding.UTF8.GetString(bytes);
        using var export = JsonDocument.Parse(bytes);
        var sections = export.RootElement.GetProperty("sections").EnumerateArray().ToDictionary(s => s.GetProperty("module").GetString()!, s => s);
        Items(sections["customers"], "contact").ShouldHaveSingleItem().GetProperty("fields").GetProperty("email").GetString().ShouldBe(person.Email);
        Items(sections["customers"], "affiliation").ShouldHaveSingleItem().GetProperty("fields").GetProperty("title").GetString().ShouldBe("Daglig leder");
        Items(sections["sales"], "deal").ShouldHaveSingleItem().GetProperty("recordId").GetGuid().ShouldBe(person.DealId);
        Items(sections["sales"], "quote").Select(q => q.GetProperty("recordId").GetGuid()).ShouldBe([person.SentQuoteId, person.AcceptedQuoteId], ignoreOrder: true);
        Items(sections["sales"], "quote").ShouldAllBe(q => q.GetProperty("fields").GetProperty("sentTo").GetString() == person.Email);
        Items(sections["activities"], "activity").Select(a => a.GetProperty("recordId").GetGuid()).ShouldBe([person.CallId, person.MailId], ignoreOrder: true);
        Items(sections["service"], "ticket").ShouldHaveSingleItem().GetProperty("fields").GetProperty("endUserEmail").GetString().ShouldBe(person.Email);
        Items(sections["service"], "ticketRequest").ShouldHaveSingleItem().GetProperty("recordId").GetGuid().ShouldBe(person.TicketRequestId);
        Items(sections["integration"], "externalLink").Select(l => l.GetProperty("fields").GetProperty("externalId").GetString()).ShouldContain(person.AteraContactId);
        Items(sections["integration"], "externalRecord").Select(r => r.GetProperty("recordId").GetGuid()).ShouldContain(person.ExternalRecordId);
        // The outbox may have queued a real PowerOffice update for the person by now, next to the seeded one.
        Items(sections["integration"], "outboundOperation").Select(o => o.GetProperty("recordId").GetGuid()).ShouldContain(person.OutboundId);
        var history = Items(sections["audit"], "history");
        history.Count.ShouldBeGreaterThanOrEqualTo(3, "the contact's creation and change, the affiliation's creation");
        // The serializer writes '+' as \u002B, so the number is matched without it.
        history.ShouldContain(h => (h.GetProperty("fields").GetProperty("changes").GetString() ?? "").Contains("41 00 00 00", StringComparison.Ordinal),
            "the old mobile number from before the change");

        // Nobody else's data: not the colleague at the same customer, not the employees who made the changes.
        text.ShouldNotContain(person.ColleagueEmail);
        text.ShouldNotContain($"Kollega{person.Marker}");
        text.ShouldNotContain($"prv-admin-{person.Marker.ToLowerInvariant()}");
        text.ShouldNotContain($"prv-sales-{person.Marker.ToLowerInvariant()}");
        export.RootElement.GetProperty("excluded").GetArrayLength().ShouldBeGreaterThanOrEqualTo(4);
        var manifest = export.RootElement.GetProperty("manifest");
        manifest.GetProperty("items").GetInt32().ShouldBe(sections.Values.Sum(s => s.GetProperty("items").GetArrayLength()));

        var closed = await admin.GetFromJsonAsync<JsonElement>($"{Privacy}/cases/{caseId}", Ct);
        closed.GetProperty("status").GetString().ShouldBe("Completed");
        closed.GetProperty("exportSha256").GetString().ShouldBe(DocumentHashes.Sha256(bytes));
        (await factory.ClientAs(CrmRoles.Management).GetAsync($"{Privacy}/cases/{caseId}/export", Ct)).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task AC02_after_an_erasure_no_api_search_history_or_frozen_document_shows_the_person()
    {
        var person = await PrivacyTestData.PersonAsync(factory);
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: $"prv-admin-{person.Marker.ToLowerInvariant()}");
        var (caseId, etag) = await OpenAsync(admin, "Erasure", "Contact", person.ContactId);
        etag = await VerifyAsync(admin, caseId, etag);
        var plan = await PreviewAsync(admin, caseId, etag);
        etag = plan.Etag;
        var number = (await admin.GetFromJsonAsync<JsonElement>($"{Privacy}/cases/{caseId}", Ct)).GetProperty("number").GetString()!;

        Action(plan, "customers", "Contact", person.ContactId).ShouldBe("Pseudonymize");
        Action(plan, "sales", "Quote", person.SentQuoteId).ShouldBe("Pseudonymize");
        Action(plan, "sales", "Quote", person.AcceptedQuoteId).ShouldBe("Retain");
        Plan(plan).Where(p => p.GetProperty("record").GetProperty("entityType").GetString() == "QuoteDocument").ShouldNotBeEmpty();
        Action(plan, "activities", "Activity", person.CallId).ShouldBe("Delete");
        Action(plan, "service", "Ticket", person.TicketId).ShouldBe("Pseudonymize");
        Action(plan, "integration", "ExternalRecord", person.ExternalRecordId).ShouldBe("Pseudonymize");
        Action(plan, "integration", "OutboundOperation", person.OutboundId).ShouldBe("Pseudonymize");

        (await ExecuteRawAsync(admin, caseId, etag, plan.Digest, "PRV-0000-0000")).StatusCode.ShouldBe(HttpStatusCode.BadRequest);
        var stale = await ExecuteRawAsync(admin, caseId, etag, new string('0', 64), number);
        stale.StatusCode.ShouldBe(HttpStatusCode.Conflict);
        (await stale.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe("PRV_PLAN_CHANGED");
        var executed = await ExecuteRawAsync(admin, caseId, etag, plan.Digest, number);
        executed.StatusCode.ShouldBe(HttpStatusCode.OK, await executed.Content.ReadAsStringAsync(Ct));
        var receipt = (await executed.ReadJsonAsync()).GetProperty("receipt");

        // The APIs, lists and search.
        (await admin.GetAsync($"/api/v1/customers/contacts/{person.ContactId}", Ct)).StatusCode.ShouldBe(HttpStatusCode.NotFound);
        var contacts = await admin.GetStringAsync($"/api/v1/customers/organizations/{person.OrganizationId}/contacts", Ct);
        contacts.ShouldNotContain(person.Email);
        contacts.ShouldContain(person.ColleagueEmail);
        foreach (var term in new[] { person.FirstName, person.Email })
        {
            (await admin.GetStringAsync($"/api/v1/search?q={Uri.EscapeDataString(term)}", Ct)).ShouldNotContain(person.ContactId.ToString());
        }

        (await ActivityIdsAsync(admin, person.OrganizationId)).ShouldNotContain(person.CallId);
        var sent = await admin.GetFromJsonAsync<JsonElement>($"/api/v1/sales/quotes/{person.SentQuoteId}", Ct);
        sent.GetProperty("sentTo").ValueKind.ShouldBe(JsonValueKind.Null);
        var pdf = await admin.GetAsync($"/api/v1/sales/quotes/{person.SentQuoteId}/pdf", Ct);
        pdf.StatusCode.ShouldBe(HttpStatusCode.NotFound);
        (await pdf.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe("SAL_DOCUMENT_ERASED");
        (await admin.GetAsync($"/api/v1/sales/quotes/{person.AcceptedQuoteId}/pdf", Ct)).StatusCode.ShouldBe(HttpStatusCode.OK, "bookkeeping keeps the accepted quote");

        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var ticket = await scope.ServiceProvider.GetRequiredService<ServiceDbContext>().Tickets.AsNoTracking().SingleAsync(t => t.Id == person.TicketId, Ct);
            ticket.EndUserName.ShouldBeNull();
            ticket.EndUserEmail.ShouldBeNull();
            ticket.ContactId.ShouldBeNull();
            var integration = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
            var record = await integration.ExternalRecords.AsNoTracking().SingleAsync(r => r.Id == person.ExternalRecordId, Ct);
            record.DisplayName.ShouldBe("—");
            record.Email.ShouldBeNull();
            record.Phone.ShouldBeNull();
            record.Payload.ShouldBe("{}");
            (await integration.ExternalLinks.AnyAsync(l => l.EntityType == "Contact" && l.EntityId == person.ContactId, Ct)).ShouldBeFalse();
            var outbound = await integration.OutboundOperations.AsNoTracking().SingleAsync(o => o.Id == person.OutboundId, Ct);
            outbound.Status.ShouldBe(OutboundStatus.Cancelled);
            outbound.LastError.ShouldBeNull();
        }

        // The history: the fact of each action stays, what changed is not shown; the erasure names the case and the fields only.
        var history = await admin.GetFromJsonAsync<JsonElement>($"/api/v1/audit/entities/customers/Contact/{person.ContactId}", Ct);
        var entries = history.GetProperty("items").EnumerateArray().ToList();
        entries.ShouldContain(e => e.GetProperty("action").GetString() == "Erase");
        entries.Where(e => e.GetProperty("action").GetString() != "Erase").ShouldAllBe(e => e.GetProperty("erased").GetBoolean() && e.GetProperty("changes").ValueKind == JsonValueKind.Null);
        var erase = entries.Single(e => e.GetProperty("action").GetString() == "Erase").GetProperty("changes");
        erase.GetProperty("case").GetString().ShouldBe(number);
        erase.GetProperty("fields").EnumerateArray().Select(f => f.GetString()).ShouldContain("Email");
        history.GetRawText().ShouldNotContain(person.Email);
        history.GetRawText().ShouldNotContain(person.FirstName);
        (await admin.GetFromJsonAsync<JsonElement>($"/api/v1/audit/entities/sales/Quote/{person.SentQuoteId}", Ct)).GetRawText()
            .ShouldNotContain(person.Email, Case.Insensitive, "the quote's own history hides the address it went to");

        // The case and the manifest carry ids and counts, nothing about the person.
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<PrivacyDbContext>();
            var stored = await db.Cases.AsNoTracking().SingleAsync(c => c.Id == caseId, Ct);
            var manifest = await db.ErasureManifests.AsNoTracking().SingleAsync(m => m.CaseId == caseId, Ct);
            var file = Encoding.UTF8.GetString(await factory.Documents.ReadAsync(manifest.StoreKey!, Ct) ?? []);
            file.ShouldNotBeEmpty();
            foreach (var value in person.PersonalValues)
            {
                stored.PlanJson!.ShouldNotContain(value);
                stored.ReceiptJson!.ShouldNotContain(value);
                file.ShouldNotContain(value);
            }
        }

        // Domain events carry ids: no module's outbox keeps a copy of the person for the 30 days a delivered row is kept.
        // (JSON writes '+' as \u002B, so the number is looked for without it.)
        foreach (var value in new[] { person.Email, person.Phone[1..], person.FirstName })
        {
            (await AdminScalarAsync<int>("""
                DECLARE @sql nvarchar(max) = N'SELECT @n = 0';
                SELECT @sql += N' + (SELECT COUNT(*) FROM ' + QUOTENAME(SCHEMA_NAME(schema_id)) + N'.[OutboxMessages] WHERE [Payload] LIKE N''%'' + @value + N''%'')'
                FROM sys.tables WHERE name = N'OutboxMessages';
                DECLARE @n int;
                EXEC sp_executesql @sql, N'@value nvarchar(256), @n int OUTPUT', @value = @value, @n = @n OUTPUT;
                SELECT @n;
                """, ("@value", value))).ShouldBe(0, $"an outbox payload carries {value}");
        }

        receipt.GetProperty("retained").EnumerateArray().ShouldContain(r =>
            r.GetProperty("entityId").GetGuid() == person.AcceptedQuoteId && r.GetProperty("basis").GetString() == "Bookkeeping");
        receipt.GetProperty("externalSystems").EnumerateArray().Select(s => s.GetString()).ShouldContain("atera");
        (await admin.GetFromJsonAsync<JsonElement>($"/api/v1/customers/contacts/{person.ColleagueId}", Ct)).GetProperty("email").GetString().ShouldBe(person.ColleagueEmail);

        // The protected stores: still holding the payload, which only the privacy operator's procedures clear.
        (await AdminScalarAsync<int>("SELECT COUNT(*) FROM audit.AuditEntries WHERE Module = N'customers' AND EntityType = N'Contact' AND EntityId = @id AND Changes LIKE N'%' + @email + N'%';",
            ("@id", person.ContactId), ("@email", person.Email))).ShouldBeGreaterThan(0);
        var privacyLogin = $"crm_privacy_dev11_{person.Marker.ToLowerInvariant()}";
        var password = $"Pv-{Guid.NewGuid():N}aA1!";
        await factory.CreateLoginAsync(privacyLogin, password, Crm.Infrastructure.Persistence.DatabaseRoles.Privacy);
        await using (var operatorConnection = new SqlConnection(factory.LoginConnectionString(privacyLogin, password)))
        {
            await operatorConnection.OpenAsync(Ct);
            (await ScalarAsync<int>(operatorConnection, "EXEC audit.ClearErasedPayloads;")).ShouldBeGreaterThan(0, "the dry run counts");
            await ScalarAsync<int>(operatorConnection, "EXEC audit.ClearErasedPayloads @DryRun = 0;");
            await ScalarAsync<int>(operatorConnection, "EXEC sales.ClearErasedDocuments @DryRun = 0;");
        }

        (await AdminScalarAsync<int>("SELECT COUNT(*) FROM audit.AuditEntries WHERE Module = N'customers' AND EntityId = @id AND Changes LIKE N'%' + @email + N'%';",
            ("@id", person.ContactId), ("@email", person.Email))).ShouldBe(0);
        (await AdminScalarAsync<int>("SELECT COUNT(*) FROM audit.AuditEntries WHERE Module = N'sales' AND EntityId = @id AND Changes LIKE N'%' + @email + N'%';",
            ("@id", person.SentQuoteId), ("@email", person.Email))).ShouldBeGreaterThan(0, "the audit of financial records is evidence and stays (DEC-03); views hide it");
        var documents = await QuoteDocumentsTests.DocumentsOfAsync(factory, person.SentQuoteId);
        documents.ShouldAllBe(d => d.ErasedAt != null && d.SnapshotJson == "{}" && d.ObjectKey == $"erased/{d.Id}" && d.ErasureReference == number);
        (await QuoteDocumentsTests.DocumentsOfAsync(factory, person.AcceptedQuoteId)).ShouldAllBe(d => d.ErasedAt == null && d.SnapshotJson.Contains(person.FirstName));

        // The application itself cannot take the operator's path, not even by setting the session flag.
        await using var runtime = new SqlConnection(factory.RuntimeConnectionString);
        await runtime.OpenAsync(Ct);
        (await ErrorOfAsync(runtime, """
            EXEC sp_set_session_context @key = N'crm.privacy-erasure', @value = 1;
            UPDATE sales.QuoteDocuments SET SnapshotJson = N'{}', ObjectKey = CONCAT(N'erased/', LOWER(CONVERT(nvarchar(36), Id))),
                   ErasedAt = SYSDATETIMEOFFSET(), ErasureReference = N'forged' WHERE QuoteId = @quote;
            """, ("@quote", person.AcceptedQuoteId))).ShouldBe(51011);
        (await ErrorOfAsync(runtime, "EXEC audit.ClearErasedPayloads @DryRun = 0;")).ShouldBe(229);
        (await ErrorOfAsync(runtime, "EXEC sales.ClearErasedDocuments @DryRun = 0;")).ShouldBe(229);
    }

    [Fact]
    public async Task AC03_a_failing_module_leaves_the_case_resumable_and_repeating_it_or_the_jobs_changes_nothing_more()
    {
        var probe = new FlakyContributor();
        await using var host = factory.WithWebHostBuilder(builder =>
            builder.ConfigureTestServices(services => services.AddSingleton<IPersonalDataContributor>(probe)));
        var person = await PrivacyTestData.PersonAsync(factory, host);
        var admin = PrivacyTestData.Client(host, CrmRoles.Admin, $"prv-admin-{person.Marker.ToLowerInvariant()}");
        var (caseId, etag) = await OpenAsync(admin, "Erasure", "Contact", person.ContactId);
        etag = await VerifyAsync(admin, caseId, etag);
        var plan = await PreviewAsync(admin, caseId, etag);
        var number = (await admin.GetFromJsonAsync<JsonElement>($"{Privacy}/cases/{caseId}", Ct)).GetProperty("number").GetString()!;

        probe.Failing = true;
        var first = await ExecuteRawAsync(admin, caseId, plan.Etag, plan.Digest, number);
        first.StatusCode.ShouldBe(HttpStatusCode.Conflict);
        var problem = await first.ReadJsonAsync();
        problem.GetProperty("code").GetString().ShouldBe("PRV_EXECUTION_INCOMPLETE");
        problem.GetProperty("modules").EnumerateArray().Select(m => m.GetString()).ShouldBe([FlakyContributor.Name]);
        var resumed = await admin.GetAsync($"{Privacy}/cases/{caseId}", Ct);
        (await resumed.ReadJsonAsync()).GetProperty("status").GetString().ShouldBe("Executing");
        (await admin.GetAsync($"/api/v1/customers/contacts/{person.ContactId}", Ct)).StatusCode.ShouldBe(HttpStatusCode.NotFound, "the modules that could, did");
        await using (var scope = host.Services.CreateAsyncScope())
        {
            (await scope.ServiceProvider.GetRequiredService<PrivacyDbContext>().ErasureManifests.AnyAsync(m => m.CaseId == caseId, Ct)).ShouldBeFalse();
            // Financial references survive: the accepted quote still points at the (pseudonymized) person's row.
            var accepted = await scope.ServiceProvider.GetRequiredService<SalesDbContext>().Quotes.AsNoTracking().SingleAsync(q => q.Id == person.AcceptedQuoteId, Ct);
            (accepted.ContactId, accepted.Status.ToString()).ShouldBe((person.ContactId, "Accepted"));
        }

        probe.Failing = false;
        var second = await ExecuteRawAsync(admin, caseId, resumed.Headers.ETag!.Tag, plan.Digest, number);
        second.StatusCode.ShouldBe(HttpStatusCode.OK, await second.Content.ReadAsStringAsync(Ct));
        probe.Erased.ShouldBe(1);
        var again = await ExecuteRawAsync(admin, caseId, second.Headers.ETag!.Tag, plan.Digest, number);
        again.StatusCode.ShouldBe(HttpStatusCode.Conflict);
        (await again.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe("PRV_CASE_CLOSED");
        (await AdminScalarAsync<int>("SELECT COUNT(*) FROM audit.AuditEntries WHERE Module = N'customers' AND EntityType = N'Contact' AND EntityId = @id AND [Action] = N'Erase';",
            ("@id", person.ContactId))).ShouldBe(1, "resuming erased nothing twice");
        (await AdminScalarAsync<int>("SELECT COUNT(*) FROM privacy.ErasureManifests WHERE CaseId = @id;", ("@id", caseId))).ShouldBe(1);

        // The jobs, twice: nothing to apply again after the first, nothing new the second time.
        await using (var scope = host.Services.CreateAsyncScope())
        {
            var replay = scope.ServiceProvider.GetRequiredService<PrivacyReplayJob>();
            (await replay.RunAsync(Ct)).Replayed.ShouldBe(0);
            (await replay.RunAsync(Ct)).Replayed.ShouldBe(0);
        }

        // A manifest the document store refused is written by the replay job later; the erasure itself is done.
        var other = await PrivacyTestData.PersonAsync(factory, host);
        var (otherCase, otherEtag) = await OpenAsync(admin, "Erasure", "Contact", other.ContactId);
        otherEtag = await VerifyAsync(admin, otherCase, otherEtag);
        var otherPlan = await PreviewAsync(admin, otherCase, otherEtag);
        var otherNumber = (await admin.GetFromJsonAsync<JsonElement>($"{Privacy}/cases/{otherCase}", Ct)).GetProperty("number").GetString()!;
        factory.Documents.Fail(PrivacyCaseService.ManifestPrefix, StoreFailure.BeforeWrite);
        try
        {
            (await ExecuteRawAsync(admin, otherCase, otherPlan.Etag, otherPlan.Digest, otherNumber)).StatusCode.ShouldBe(HttpStatusCode.OK);
        }
        finally
        {
            factory.Documents.Heal(PrivacyCaseService.ManifestPrefix);
        }

        await using (var scope = host.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<PrivacyDbContext>();
            (await db.ErasureManifests.AsNoTracking().SingleAsync(m => m.CaseId == otherCase, Ct)).StoredAt.ShouldBeNull();
            (await scope.ServiceProvider.GetRequiredService<PrivacyReplayJob>().RunAsync(Ct)).Stored.ShouldBeGreaterThanOrEqualTo(1);
        }

        await using (var scope = host.Services.CreateAsyncScope())
        {
            var manifest = await scope.ServiceProvider.GetRequiredService<PrivacyDbContext>().ErasureManifests.AsNoTracking().SingleAsync(m => m.CaseId == otherCase, Ct);
            manifest.StoredAt.ShouldNotBeNull();
            (await factory.Documents.ReadAsync(manifest.StoreKey!, Ct)).ShouldNotBeNull();
        }
    }

    [Fact]
    public async Task AC04_a_legal_hold_keeps_one_record_with_its_explanation_and_never_the_whole_person()
    {
        var person = await PrivacyTestData.PersonAsync(factory);
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: $"prv-admin-{person.Marker.ToLowerInvariant()}");
        var today = DateOnly.FromDateTime(DateTime.UtcNow);
        var until = today.AddDays(400);
        const string explanation = "Evidence in a dispute about the support agreement (test).";
        (await admin.PostAsJsonAsync($"{Privacy}/holds", new
        {
            module = "activities", entityType = "Activity", entityId = person.CallId, reason = "LegalClaim", explanation, until = today.AddDays(-1),
        }, Ct)).StatusCode.ShouldBe(HttpStatusCode.BadRequest, "a hold always has an end, and not in the past");
        (await admin.PostAsJsonAsync($"{Privacy}/holds", new
        {
            module = "activities", entityType = "Activity", entityId = person.CallId, reason = "LegalClaim", explanation = "", until,
        }, Ct)).StatusCode.ShouldBe(HttpStatusCode.BadRequest, "and an explanation");
        var placed = await admin.PostAsJsonAsync($"{Privacy}/holds", new
        {
            module = "activities", entityType = "Activity", entityId = person.CallId, reason = "LegalClaim", explanation, until,
        }, Ct);
        placed.StatusCode.ShouldBe(HttpStatusCode.Created, await placed.Content.ReadAsStringAsync(Ct));
        var hold = await placed.ReadJsonAsync();

        var (caseId, etag) = await OpenAsync(admin, "Erasure", "Contact", person.ContactId);
        etag = await VerifyAsync(admin, caseId, etag);
        var plan = await PreviewAsync(admin, caseId, etag);
        var held = Plan(plan).Single(p => p.GetProperty("record").GetProperty("entityId").GetGuid() == person.CallId);
        (held.GetProperty("action").GetString(), held.GetProperty("basis").GetString(), held.GetProperty("note").GetString())
            .ShouldBe(("Retain", "LegalHold", explanation));
        var number = (await admin.GetFromJsonAsync<JsonElement>($"{Privacy}/cases/{caseId}", Ct)).GetProperty("number").GetString()!;
        var executed = await ExecuteRawAsync(admin, caseId, plan.Etag, plan.Digest, number);
        executed.StatusCode.ShouldBe(HttpStatusCode.OK, await executed.Content.ReadAsStringAsync(Ct));
        var retained = (await executed.ReadJsonAsync()).GetProperty("receipt").GetProperty("retained").EnumerateArray().ToList();
        var keptCall = retained.Single(r => r.GetProperty("entityId").GetGuid() == person.CallId);
        (keptCall.GetProperty("basis").GetString(), keptCall.GetProperty("until").GetString(), keptCall.GetProperty("note").GetString())
            .ShouldBe(("LegalHold", until.ToString("yyyy-MM-dd"), explanation));
        var bookkeeping = retained.Single(r => r.GetProperty("entityId").GetGuid() == person.AcceptedQuoteId);
        bookkeeping.GetProperty("basis").GetString().ShouldBe("Bookkeeping");
        bookkeeping.GetProperty("until").GetString().ShouldBe($"{today.Year + 5}-12-31");

        // The held call is there, untouched; everything else about the person is gone.
        var activities = await admin.GetFromJsonAsync<JsonElement>($"/api/v1/activities/?organizationId={person.OrganizationId}", Ct);
        Rows(activities).Single(a => a.GetProperty("id").GetGuid() == person.CallId).GetProperty("subject").GetString().ShouldBe($"Samtale med {person.FirstName}");
        Rows(activities).ShouldNotContain(a => a.GetProperty("id").GetGuid() == person.MailId);
        (await admin.GetAsync($"/api/v1/customers/contacts/{person.ContactId}", Ct)).StatusCode.ShouldBe(HttpStatusCode.NotFound);

        // Released, the hold protects nothing: the next erasure takes the record too.
        var holdEtag = (await admin.GetFromJsonAsync<JsonElement>($"{Privacy}/holds?includeEnded=true&limit=200", Ct)).GetProperty("items").EnumerateArray()
            .Single(h => h.GetProperty("id").GetGuid() == hold.GetProperty("id").GetGuid()).GetProperty("etag").GetString()!;
        (await admin.PostWithETagAsync($"{Privacy}/holds/{hold.GetProperty("id").GetGuid()}/release", new { reason = "Dispute settled (test)." }, holdEtag))
            .StatusCode.ShouldBe(HttpStatusCode.OK);
        var (nextCase, nextEtag) = await OpenAsync(admin, "Erasure", "Contact", person.ContactId);
        nextEtag = await VerifyAsync(admin, nextCase, nextEtag);
        var nextPlan = await PreviewAsync(admin, nextCase, nextEtag);
        Action(nextPlan, "activities", "Activity", person.CallId).ShouldBe("Delete");
        var nextNumber = (await admin.GetFromJsonAsync<JsonElement>($"{Privacy}/cases/{nextCase}", Ct)).GetProperty("number").GetString()!;
        var nextExecuted = await ExecuteRawAsync(admin, nextCase, nextPlan.Etag, nextPlan.Digest, nextNumber);
        nextExecuted.StatusCode.ShouldBe(HttpStatusCode.OK, await nextExecuted.Content.ReadAsStringAsync(Ct));
        (await ActivityIdsAsync(admin, person.OrganizationId)).ShouldNotContain(person.CallId);
    }

    [Fact]
    public async Task AC07_retention_counts_until_its_periods_are_approved_and_removes_only_with_an_approved_policy_in_apply_mode()
    {
        var sales = factory.ClientAs(CrmRoles.Sales, userKey: "prv-retention-sales");
        var marker = $"R{Guid.NewGuid():N}"[..10];
        var created = await sales.PostAsJsonAsync("/api/v1/sales/leads", new
        {
            companyName = $"{marker} Lead AS", contactName = $"Gammel {marker}", email = $"gammel.{marker.ToLowerInvariant()}@example.no", phone = "+47 22 00 00 00",
        }, Ct);
        created.StatusCode.ShouldBe(HttpStatusCode.Created, await created.Content.ReadAsStringAsync(Ct));
        var leadId = (await created.ReadJsonAsync()).GetProperty("id").GetGuid();
        await factory.AdminSqlAsync($"UPDATE sales.Leads SET CreatedAt = DATEADD(year, -3, SYSDATETIMEOFFSET()), ModifiedAt = NULL WHERE Id = '{leadId}';");

        // The default: a dry run with the periods docs/04 proposes, labelled as proposals.
        var dryRun = await RunRetentionAsync(factory);
        dryRun.Mode.ToString().ShouldBe("DryRun");
        var leads = dryRun.Classes.Single(c => c.DataClass == "sales.unconverted-leads");
        (leads.Approved, leads.Proposal, leads.Days, leads.Removed).ShouldBe((false, true, 730, 0));
        leads.Due.ShouldBeGreaterThanOrEqualTo(1);
        dryRun.Classes.Select(c => c.DataClass).ShouldBe(
            ["customers.former-contacts", "identity.sessions", "integration.external-payloads", "integration.sync-runs", "sales.unconverted-leads", "service.tickets"]);
        (await LeadContactAsync(leadId)).ShouldNotBeNull();

        // Apply mode without an approved policy still removes nothing.
        await using var apply = factory.WithWebHostBuilder(builder => builder.UseSetting("Privacy:Retention:Mode", "Apply"));
        var unapproved = await RunRetentionAsync(apply);
        unapproved.Classes.Single(c => c.DataClass == "sales.unconverted-leads").Removed.ShouldBe(0);
        (await LeadContactAsync(leadId)).ShouldNotBeNull();

        // The application cannot approve a period; the database administrator writes it with the EXT-07 reference.
        await using (var runtime = new SqlConnection(factory.RuntimeConnectionString))
        {
            await runtime.OpenAsync(Ct);
            (await ErrorOfAsync(runtime, "INSERT INTO privacy.RetentionPolicies (DataClass, RetainDays, ApprovedBy, ApprovedAt, Reference) VALUES (N'sales.unconverted-leads', 365, N'app', SYSDATETIMEOFFSET(), N'none');"))
                .ShouldBe(229);
        }

        await using (var dba = new SqlConnection(factory.AdminConnectionString))
        {
            await dba.OpenAsync(Ct);
            (await ErrorOfAsync(dba, "INSERT INTO privacy.RetentionPolicies (DataClass, RetainDays, ApprovedBy, ApprovedAt, Reference) VALUES (N'sales.unconverted-leads', 10, N'Data owner (test)', SYSDATETIMEOFFSET(), N'too short');"))
                .ShouldBe(547, "no period shorter than 30 days");
        }

        await factory.AdminSqlAsync($"INSERT INTO privacy.RetentionPolicies (DataClass, RetainDays, ApprovedBy, ApprovedAt, Reference) VALUES (N'sales.unconverted-leads', 365, N'Data owner (test)', SYSDATETIMEOFFSET(), N'EXT-07 test {marker}');");
        try
        {
            var approved = await RunRetentionAsync(apply);
            var applied = approved.Classes.Single(c => c.DataClass == "sales.unconverted-leads");
            (applied.Approved, applied.Days, applied.Reference).ShouldBe((true, 365, $"EXT-07 test {marker}"));
            applied.Removed.ShouldBeGreaterThanOrEqualTo(1);
            (await LeadContactAsync(leadId)).ShouldBeNull();
            approved.Classes.Where(c => c.DataClass != "sales.unconverted-leads").ShouldAllBe(c => c.Removed == 0, "only the approved class");
        }
        finally
        {
            await factory.AdminSqlAsync("DELETE FROM privacy.RetentionPolicies WHERE DataClass = N'sales.unconverted-leads';");
        }

        var report = await factory.ClientAs(CrmRoles.Admin).GetFromJsonAsync<JsonElement>($"{Privacy}/retention", Ct);
        report.GetProperty("mode").GetString().ShouldBe("DryRun");
        report.GetProperty("lastRun").GetProperty("classes").GetArrayLength().ShouldBe(6);
    }

    private static async Task<List<Guid>> ActivityIdsAsync(HttpClient client, Guid organizationId) =>
        Rows(await client.GetFromJsonAsync<JsonElement>($"/api/v1/activities/?organizationId={organizationId}", Ct)).Select(a => a.GetProperty("id").GetGuid()).ToList();

    /// <summary>A list answer is either an array or a page with items.</summary>
    private static JsonElement.ArrayEnumerator Rows(JsonElement list) =>
        list.ValueKind == JsonValueKind.Array ? list.EnumerateArray() : list.GetProperty("items").EnumerateArray();

    private async Task<string?> LeadContactAsync(Guid leadId)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<SalesDbContext>().Leads.IgnoreQueryFilters().AsNoTracking()
            .Where(l => l.Id == leadId).Select(l => l.ContactName).SingleAsync(Ct);
    }

    private static async Task<RetentionReport> RunRetentionAsync(WebApplicationFactory<Program> host)
    {
        await using var scope = host.Services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<PrivacyRetentionJob>().RunAsync(Ct);
    }

    [Fact]
    public async Task Requests_opened_at_the_same_moment_each_get_a_number_of_their_own()
    {
        var person = await PrivacyTestData.PersonAsync(factory);
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: $"prv-admin-{person.Marker.ToLowerInvariant()}");
        var opened = await Task.WhenAll(Enumerable.Range(0, 12).Select(_ =>
            admin.PostAsJsonAsync($"{Privacy}/cases", new { kind = "Access", subjectKind = "Contact", subjectId = person.ContactId, channel = "Email" }, Ct)));
        foreach (var response in opened)
        {
            response.StatusCode.ShouldBe(HttpStatusCode.Created, await response.Content.ReadAsStringAsync(Ct));
        }

        var numbers = await Task.WhenAll(opened.Select(async r => (await r.ReadJsonAsync()).GetProperty("number").GetString()));
        numbers.Distinct().Count().ShouldBe(12);
    }

    internal static async Task<(Guid Id, string Etag)> OpenAsync(HttpClient admin, string kind, string subjectKind, Guid subjectId)
    {
        var opened = await admin.PostAsJsonAsync($"{Privacy}/cases", new { kind, subjectKind, subjectId, channel = "Email", note = "Request by e-mail (test)." }, Ct);
        opened.StatusCode.ShouldBe(HttpStatusCode.Created, await opened.Content.ReadAsStringAsync(Ct));
        return ((await opened.ReadJsonAsync()).GetProperty("id").GetGuid(), opened.Headers.ETag!.Tag);
    }

    internal static async Task<string> VerifyAsync(HttpClient admin, Guid caseId, string etag)
    {
        var verified = await admin.PostWithETagAsync($"{Privacy}/cases/{caseId}/verify", new { method = "KnownEmail", note = "From the address on file." }, etag);
        verified.StatusCode.ShouldBe(HttpStatusCode.OK, await verified.Content.ReadAsStringAsync(Ct));
        return verified.Headers.ETag!.Tag;
    }

    internal sealed record PlanResult(string Digest, JsonElement Body, string Etag);

    internal static async Task<PlanResult> PreviewAsync(HttpClient admin, Guid caseId, string etag)
    {
        var previewed = await admin.PostWithETagAsync($"{Privacy}/cases/{caseId}/preview", new { }, etag);
        previewed.StatusCode.ShouldBe(HttpStatusCode.OK, await previewed.Content.ReadAsStringAsync(Ct));
        var body = await previewed.ReadJsonAsync();
        return new PlanResult(body.GetProperty("digest").GetString()!, body, previewed.Headers.ETag!.Tag);
    }

    internal static Task<HttpResponseMessage> ExecuteRawAsync(HttpClient admin, Guid caseId, string etag, string digest, string confirmation) =>
        admin.PostWithETagAsync($"{Privacy}/cases/{caseId}/execute", new { planDigest = digest, confirmation }, etag);

    private static List<JsonElement> Items(JsonElement section, string category) =>
        section.GetProperty("items").EnumerateArray().Where(i => i.GetProperty("category").GetString() == category).ToList();

    private static JsonElement.ArrayEnumerator Plan(PlanResult plan) => plan.Body.GetProperty("records").EnumerateArray();

    private static string? Action(PlanResult plan, string module, string entityType, Guid id) =>
        Plan(plan).SingleOrDefault(p =>
            p.GetProperty("record").GetProperty("module").GetString() == module &&
            p.GetProperty("record").GetProperty("entityType").GetString() == entityType &&
            p.GetProperty("record").GetProperty("entityId").GetGuid() == id) is { ValueKind: JsonValueKind.Object } found
            ? found.GetProperty("action").GetString()
            : null;

    private async Task<T> AdminScalarAsync<T>(string sql, params (string Name, object Value)[] parameters)
    {
        await using var connection = new SqlConnection(factory.AdminConnectionString);
        await connection.OpenAsync(Ct);
        return await ScalarAsync<T>(connection, sql, parameters);
    }

    private static async Task<T> ScalarAsync<T>(SqlConnection connection, string sql, params (string Name, object Value)[] parameters)
    {
        await using var command = new SqlCommand(sql, connection);
        foreach (var (name, value) in parameters)
        {
            command.Parameters.AddWithValue(name, value);
        }

        return (T)Convert.ChangeType((await command.ExecuteScalarAsync(Ct))!, typeof(T), System.Globalization.CultureInfo.InvariantCulture);
    }

    private static async Task<int> ErrorOfAsync(SqlConnection connection, string sql, params (string Name, object Value)[] parameters)
    {
        try
        {
            await using var command = new SqlCommand(sql, connection);
            foreach (var (name, value) in parameters)
            {
                command.Parameters.AddWithValue(name, value);
            }

            await command.ExecuteNonQueryAsync(Ct);
            return 0;
        }
        catch (SqlException ex)
        {
            return ex.Number;
        }
    }

    /// <summary>A module that plans one record and fails to erase it until told otherwise (AC03).</summary>
    private sealed class FlakyContributor : IPersonalDataContributor
    {
        public const string Name = "zz-probe";

        public bool Failing { get; set; }

        public int Erased { get; private set; }

        public string Module => Name;

        public Task<PersonalDataSection> ExportAsync(DataSubject subject, CancellationToken cancellationToken) =>
            Task.FromResult(new PersonalDataSection(Name, [], []));

        public Task<IReadOnlyList<PlannedErasure>> PlanAsync(DataSubject subject, CancellationToken cancellationToken) =>
            Task.FromResult<IReadOnlyList<PlannedErasure>>(
                subject.Kind == DataSubjectKind.Contact ? [new PlannedErasure(new RecordRef(Name, "Probe", subject.Id), ErasureAction.Delete, "zz.probe")] : []);

        public Task<IReadOnlyList<ErasedRecord>> EraseAsync(DataSubject subject, IReadOnlyList<PlannedErasure> plan, string reference, CancellationToken cancellationToken)
        {
            if (Failing)
            {
                throw new InvalidOperationException("The probe module is down (test).");
            }

            Erased++;
            return Task.FromResult<IReadOnlyList<ErasedRecord>>(plan.Select(p => new ErasedRecord(p.Record, p.Action, p.DataClass)).ToList());
        }

        public Task<int> ReapplyAsync(IReadOnlyList<ErasedRecord> records, string reference, CancellationToken cancellationToken) => Task.FromResult(0);
    }
}
