using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Crm.Authorization;
using Crm.Sales.Domain;
using Crm.Sales.Features;
using Crm.Sales.Persistence;
using Crm.SharedKernel.Documents;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using WireMock.RequestBuilders;
using WireMock.ResponseBuilders;
using static Crm.IntegrationTests.IntegrationTestHelpers;

namespace Crm.IntegrationTests;

/// <summary>
/// DEV-08: the document of a released quote version is frozen and stored once; downloads and e-mail attachments are that
/// stored object, a storage failure keeps the quote from leaving until it is stored, and nothing overwrites or deletes it.
/// </summary>
public class QuoteDocumentsTests(CrmWebFactory factory)
{
    private const string Sales = "/api/v1/sales";
    private const string Customers = "/api/v1/customers";
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task AC01_changes_to_the_customer_contact_company_settings_and_template_after_release_leave_the_document_as_it_was()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "doc-admin");
        var marker = $"D{Guid.NewGuid():N}"[..10];
        var templateId = await DefaultTemplateAsync(admin, "en", $"{marker} footer as released");
        var (organizationId, contactId) = await CustomerAsync(admin, marker);
        var quoteId = await QuoteAsync(admin, organizationId, contactId, marker, "en");

        var released = await (await admin.PostAsync($"{Sales}/quotes/{quoteId}/submit", null, Ct)).ReadJsonAsync();
        released.GetProperty("status").GetString().ShouldBe("Ready");
        var document = released.GetProperty("documents").EnumerateArray().Single();
        document.GetProperty("status").GetString().ShouldBe("Ready");
        document.GetProperty("origin").GetString().ShouldBe("Issued");
        document.GetProperty("revision").GetInt32().ShouldBe(1);
        var (original, headers, _) = await DownloadAsync(admin, quoteId);
        var sha256 = DocumentHashes.Sha256(original);
        document.GetProperty("sha256").GetString().ShouldBe(sha256);
        headers.ETag!.Tag.ShouldBe($"\"{sha256}\"");
        var text = Encoding.Latin1.GetString(original);
        text.ShouldContain($"{marker} Kunde AS");
        text.ShouldContain("Kari Hansen");
        text.ShouldContain($"{marker} footer as released");

        // Afterwards: the customer moves and is renamed, the contact changes name, the template its footer.
        var organizationUrl = $"{Customers}/organizations/{organizationId}";
        var organization = await admin.GetAsync(organizationUrl, Ct);
        (await admin.PutWithETagAsync(organizationUrl, new
        {
            name = $"{marker} Nytt Navn AS", orgNumber = (string?)null, legalForm = "AS", status = "Customer", ehfEnabled = false,
            postalAddress = new { street = "Ny gate 9", postalCode = "9999", city = "Andeby", countryCode = "NO" },
        }, organization.Headers.ETag!.Tag)).StatusCode.ShouldBe(HttpStatusCode.OK);
        var contactUrl = $"{Customers}/contacts/{contactId}";
        var contact = await admin.GetAsync(contactUrl, Ct);
        (await admin.PutWithETagAsync(contactUrl, new { firstName = "Kari", lastName = "Endret", email = $"kari.endret.{marker}@example.no" }, contact.Headers.ETag!.Tag))
            .StatusCode.ShouldBe(HttpStatusCode.OK);
        var template = (await admin.GetFromJsonAsync<JsonElement>($"{Sales}/quote-templates?includeInactive=true", Ct)).EnumerateArray()
            .Single(t => t.GetProperty("id").GetGuid() == templateId);
        (await admin.PutWithETagAsync($"{Sales}/quote-templates/{templateId}", new
        {
            name = template.GetProperty("name").GetString(), language = "en", footerText = $"{marker} footer changed later", validityDays = 30, isActive = true, isDefault = true,
        }, template.GetProperty("etag").GetString()!)).StatusCode.ShouldBe(HttpStatusCode.OK);

        var afterChanges = (await DownloadAsync(admin, quoteId)).Content;
        afterChanges.ShouldBe(original);

        // ... and the company settings differ in another instance of the application (a later deployment, say).
        await using var renamed = factory.WithWebHostBuilder(builder => builder.UseSetting("Sales:Company:Name", "Et Helt Annet Selskap AS"));
        using var elsewhere = Client(renamed, CrmRoles.Admin, "doc-admin");
        var fromElsewhere = (await DownloadAsync(elsewhere, quoteId)).Content;
        fromElsewhere.ShouldBe(original);

        // A new version is released with today's data: its own document, the first one untouched.
        var second = await (await admin.PostAsync($"{Sales}/quotes/{quoteId}/revise", null, Ct)).ReadJsonAsync();
        var secondId = second.GetProperty("id").GetGuid();
        (await elsewhere.PostAsync($"{Sales}/quotes/{secondId}/submit", null, Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
        var newer = (await DownloadAsync(admin, secondId)).Content;
        var newerText = Encoding.Latin1.GetString(newer);
        newerText.ShouldContain($"{marker} Nytt Navn AS");
        newerText.ShouldContain("Kari Endret");
        newerText.ShouldContain($"{marker} footer changed later");
        newerText.ShouldContain("Et Helt Annet Selskap AS");
        (await DownloadAsync(admin, quoteId)).Content.ShouldBe(original);
    }

    [Fact]
    public async Task AC02_the_e_mail_attachment_is_exactly_the_document_a_download_returns()
    {
        var sales = factory.ClientAs(CrmRoles.Sales, userKey: "doc-sales");
        var marker = $"D{Guid.NewGuid():N}"[..10];
        var (organizationId, contactId) = await CustomerAsync(sales, marker);
        var quoteId = await QuoteAsync(sales, organizationId, contactId, marker, "nb");
        (await sales.PostAsync($"{Sales}/quotes/{quoteId}/submit", null, Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
        factory.Graph.Given(Request.Create().WithPath("/graph/v1.0/users/doc-sales@test.local/sendMail").UsingPost())
            .RespondWith(Response.Create().WithStatusCode(202));

        (await sales.PostAsJsonAsync($"{Sales}/quotes/{quoteId}/send", new { toAddress = $"kari.{marker}@example.no", subject = $"{marker} Tilbud" }, Ct))
            .StatusCode.ShouldBe(HttpStatusCode.OK);

        var attachment = Attachments(marker).Single();
        var (downloaded, headers, fileName) = await DownloadAsync(sales, quoteId);
        attachment.Content.ShouldBe(downloaded);
        DocumentHashes.Sha256(attachment.Content).ShouldBe(headers.GetValues("X-Document-Sha256").Single());
        attachment.Name.ShouldBe(fileName);
        var quote = await sales.GetFromJsonAsync<JsonElement>($"{Sales}/quotes/{quoteId}", Ct);
        quote.GetProperty("status").GetString().ShouldBe("Sent");
        quote.GetProperty("documents").EnumerateArray().Single().GetProperty("sha256").GetString().ShouldBe(DocumentHashes.Sha256(downloaded));
    }

    [Fact]
    public async Task AC03_storage_that_fails_at_release_holds_the_quote_back_until_the_document_is_stored()
    {
        var sales = factory.ClientAs(CrmRoles.Sales, userKey: "doc-sales");
        var marker = $"D{Guid.NewGuid():N}"[..10];
        var (organizationId, contactId) = await CustomerAsync(sales, marker);
        var quoteId = await QuoteAsync(sales, organizationId, contactId, marker, "nb");
        factory.Graph.Given(Request.Create().WithPath("/graph/v1.0/users/doc-sales@test.local/sendMail").UsingPost())
            .RespondWith(Response.Create().WithStatusCode(202));
        factory.Documents.Fail(quoteId.ToString("N"), StoreFailure.BeforeWrite);
        try
        {
            // Released: the fields are frozen, but there is no stored PDF yet.
            var released = await (await sales.PostAsync($"{Sales}/quotes/{quoteId}/submit", null, Ct)).ReadJsonAsync();
            released.GetProperty("status").GetString().ShouldBe("Ready");
            released.GetProperty("documents").EnumerateArray().Single().GetProperty("status").GetString().ShouldBe("Preparing");

            // Nothing leaves before it is: no download, no e-mail.
            var download = await sales.GetAsync($"{Sales}/quotes/{quoteId}/pdf", Ct);
            download.StatusCode.ShouldBe(HttpStatusCode.Conflict);
            (await download.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe("SAL_DOCUMENT_PREPARING");
            var send = await sales.PostAsJsonAsync($"{Sales}/quotes/{quoteId}/send", new { toAddress = $"kari.{marker}@example.no", subject = $"{marker} Tilbud" }, Ct);
            send.StatusCode.ShouldBe(HttpStatusCode.Conflict);
            (await send.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe("SAL_DOCUMENT_PREPARING");
            Attachments(marker).ShouldBeEmpty();
            // The worker tries again and fails again: still Preparing (other classes' documents may complete meanwhile).
            await RunDocumentJobAsync();
            (await DocumentsOfAsync(quoteId)).Single().Status.ShouldBe(QuoteDocumentStatus.Preparing);
        }
        finally
        {
            factory.Documents.Heal(quoteId.ToString("N"));
        }

        // Storage is back: the worker stores it from the frozen fields, and from then on it downloads and sends.
        await RunDocumentJobAsync();
        var ready = (await DocumentsOfAsync(quoteId)).Single();
        ready.Status.ShouldBe(QuoteDocumentStatus.Ready);
        var content = (await DownloadAsync(sales, quoteId)).Content;
        DocumentHashes.Sha256(content).ShouldBe(ready.ContentSha256);
        (await sales.PostAsJsonAsync($"{Sales}/quotes/{quoteId}/send", new { toAddress = $"kari.{marker}@example.no", subject = $"{marker} Tilbud" }, Ct))
            .StatusCode.ShouldBe(HttpStatusCode.OK);
        Attachments(marker).Single().Content.ShouldBe(content);
    }

    [Fact]
    public async Task AC03_a_pdf_stored_without_an_answer_is_adopted_and_never_stored_twice()
    {
        var sales = factory.ClientAs(CrmRoles.Sales, userKey: "doc-sales");
        var marker = $"D{Guid.NewGuid():N}"[..10];
        var (organizationId, contactId) = await CustomerAsync(sales, marker);
        var quoteId = await QuoteAsync(sales, organizationId, contactId, marker, "nb");
        factory.Documents.Fail(quoteId.ToString("N"), StoreFailure.AfterWrite);
        try
        {
            (await sales.PostAsync($"{Sales}/quotes/{quoteId}/submit", null, Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
        }
        finally
        {
            factory.Documents.Heal(quoteId.ToString("N"));
        }

        // The PDF is in storage, the record still says Preparing: what a crash between the two leaves behind.
        var preparing = (await DocumentsOfAsync(quoteId)).Single();
        preparing.Status.ShouldBe(QuoteDocumentStatus.Preparing);
        var stored = await File.ReadAllBytesAsync(factory.Documents.PathOf(preparing.ObjectKey), Ct);

        var content = (await DownloadAsync(sales, quoteId)).Content;
        content.ShouldBe(stored);
        var ready = (await DocumentsOfAsync(quoteId)).Single();
        ready.Status.ShouldBe(QuoteDocumentStatus.Ready);
        ready.ContentSha256.ShouldBe(DocumentHashes.Sha256(stored));
        ready.ObjectKey.ShouldBe(preparing.ObjectKey);
        Directory.GetFiles(Path.GetDirectoryName(factory.Documents.PathOf(ready.ObjectKey))!).ShouldHaveSingleItem();
    }

    [Fact]
    public async Task AC03_a_stored_document_that_is_altered_or_missing_is_neither_shown_nor_sent()
    {
        var sales = factory.ClientAs(CrmRoles.Sales, userKey: "doc-sales");
        var marker = $"D{Guid.NewGuid():N}"[..10];
        var (organizationId, contactId) = await CustomerAsync(sales, marker);
        var quoteId = await QuoteAsync(sales, organizationId, contactId, marker, "nb");
        (await sales.PostAsync($"{Sales}/quotes/{quoteId}/submit", null, Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
        factory.Graph.Given(Request.Create().WithPath("/graph/v1.0/users/doc-sales@test.local/sendMail").UsingPost())
            .RespondWith(Response.Create().WithStatusCode(202));
        var document = (await DocumentsOfAsync(quoteId)).Single();
        var path = factory.Documents.PathOf(document.ObjectKey);
        var original = await File.ReadAllBytesAsync(path, Ct);
        var altered = original.ToArray();
        altered[^10] ^= 0x01;

        // Someone with access to the storage changes one byte of the object, later removes it.
        foreach (var damage in new Action[] { () => File.WriteAllBytes(path, altered), () => File.Delete(path) })
        {
            damage();
            var download = await sales.GetAsync($"{Sales}/quotes/{quoteId}/pdf", Ct);
            download.StatusCode.ShouldBe(HttpStatusCode.InternalServerError);
            (await download.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe("SAL_DOCUMENT_UNAVAILABLE");
            var send = await sales.PostAsJsonAsync($"{Sales}/quotes/{quoteId}/send", new { toAddress = $"kari.{marker}@example.no", subject = $"{marker} Tilbud" }, Ct);
            send.StatusCode.ShouldBe(HttpStatusCode.InternalServerError);
            (await send.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe("SAL_DOCUMENT_UNAVAILABLE");
        }

        Attachments(marker).ShouldBeEmpty();
        (await sales.GetFromJsonAsync<JsonElement>($"{Sales}/quotes/{quoteId}", Ct)).GetProperty("status").GetString().ShouldBe("Ready");
        // No new document is slipped in for the damaged one: the record stays what was issued.
        (await DocumentsOfAsync(quoteId)).ShouldHaveSingleItem().ContentSha256.ShouldBe(document.ContentSha256);

        // Restored from a blob version (runbook 10 §2), the same bytes are the document again; an unknown revision is not.
        await File.WriteAllBytesAsync(path, original, Ct);
        (await DownloadAsync(sales, quoteId)).Content.ShouldBe(original);
        var unknown = await sales.GetAsync($"{Sales}/quotes/{quoteId}/pdf?revision=2", Ct);
        unknown.StatusCode.ShouldBe(HttpStatusCode.NotFound);
        (await unknown.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe("SAL_DOCUMENT_NOT_FOUND");
    }

    [Fact]
    public async Task AC04_finance_read_and_read_access_decide_who_gets_the_document_no_write_right_needed()
    {
        var sales = factory.ClientAs(CrmRoles.Sales, userKey: "doc-sales");
        var marker = $"D{Guid.NewGuid():N}"[..10];
        var (organizationId, contactId) = await CustomerAsync(sales, marker);
        var quoteId = await QuoteAsync(sales, organizationId, contactId, marker, "nb");
        (await sales.PostAsync($"{Sales}/quotes/{quoteId}/submit", null, Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
        var url = $"{Sales}/quotes/{quoteId}/pdf";

        // Finance reads quotes and sees money, and writes no quotes: it downloads the document.
        var finance = await factory.ClientAs(CrmRoles.Finance, userKey: "doc-finance").GetAsync(url, Ct);
        finance.StatusCode.ShouldBe(HttpStatusCode.OK);
        finance.Headers.CacheControl!.NoStore.ShouldBeTrue();
        finance.Headers.GetValues("X-Content-Type-Options").Single().ShouldBe("nosniff");
        finance.Content.Headers.ContentDisposition!.DispositionType.ShouldBe("attachment");

        // Read access without finance.read: no financial document.
        foreach (var role in new[] { CrmRoles.ReadOnly, CrmRoles.Technician })
        {
            var refused = await factory.ClientAs(role, userKey: $"doc-{role.ToLowerInvariant()}").GetAsync(url, Ct);
            refused.StatusCode.ShouldBe(HttpStatusCode.Forbidden, role);
            (await refused.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe("SAL_QUOTE_PRICES_HIDDEN");
        }

        // No read access at all, or no session: nothing.
        (await factory.ClientAs("Crm.Unknown", userKey: "doc-nobody").GetAsync(url, Ct)).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        (await factory.AnonymousClient().GetAsync(url, Ct)).StatusCode.ShouldBe(HttpStatusCode.Unauthorized);

        // The record names no storage address: the document is only reachable through this authorized path.
        var quote = await sales.GetStringAsync($"{Sales}/quotes/{quoteId}", Ct);
        quote.ShouldNotContain("quotes/");
        quote.ShouldNotContain("blob.core");
        quote.ShouldNotContain(factory.Documents.Root);
    }

    [Fact]
    public async Task AC05_a_new_version_gets_its_own_object_and_orphan_cleanup_keeps_every_referenced_document()
    {
        var sales = factory.ClientAs(CrmRoles.Sales, userKey: "doc-sales");
        var marker = $"D{Guid.NewGuid():N}"[..10];
        var (organizationId, contactId) = await CustomerAsync(sales, marker);
        var firstId = await QuoteAsync(sales, organizationId, contactId, marker, "nb");
        (await sales.PostAsync($"{Sales}/quotes/{firstId}/submit", null, Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
        var first = (await DocumentsOfAsync(firstId)).Single();
        var firstBytes = await File.ReadAllBytesAsync(factory.Documents.PathOf(first.ObjectKey), Ct);

        var secondId = (await (await sales.PostAsync($"{Sales}/quotes/{firstId}/revise", null, Ct)).ReadJsonAsync()).GetProperty("id").GetGuid();
        (await sales.PostAsync($"{Sales}/quotes/{secondId}/submit", null, Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
        var second = (await DocumentsOfAsync(secondId)).Single();
        second.ObjectKey.ShouldNotBe(first.ObjectKey);
        (await File.ReadAllBytesAsync(factory.Documents.PathOf(first.ObjectKey), Ct)).ShouldBe(firstBytes);
        (await DownloadAsync(sales, firstId)).Content.ShouldBe(firstBytes);

        // Writing the key of an existing document again keeps the first object (create-only).
        var again = await factory.Documents.PutAsync(first.ObjectKey, Encoding.UTF8.GetBytes("not the document"), "application/pdf", Ct);
        again.Created.ShouldBeFalse();
        again.Sha256.ShouldBe(first.ContentSha256);
        (await File.ReadAllBytesAsync(factory.Documents.PathOf(first.ObjectKey), Ct)).ShouldBe(firstBytes);

        // Old enough to be cleaned: the first document's own object and an object nothing references; a fresh orphan stays.
        var old = DateTime.UtcNow - QuoteDocumentJob.OrphanGrace - TimeSpan.FromDays(1);
        File.SetLastWriteTimeUtc(factory.Documents.PathOf(first.ObjectKey), old);
        var orphan = $"quotes/{Guid.NewGuid():N}/{Guid.NewGuid():N}/{Guid.NewGuid():N}.pdf";
        var freshOrphan = $"quotes/{Guid.NewGuid():N}/{Guid.NewGuid():N}/{Guid.NewGuid():N}.pdf";
        await factory.Documents.PutAsync(orphan, Encoding.UTF8.GetBytes("orphan"), "application/pdf", Ct);
        await factory.Documents.PutAsync(freshOrphan, Encoding.UTF8.GetBytes("fresh orphan"), "application/pdf", Ct);
        File.SetLastWriteTimeUtc(factory.Documents.PathOf(orphan), old);

        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var result = await scope.ServiceProvider.GetRequiredService<QuoteDocumentJob>().CleanOrphansAsync(Ct);
            result.Removed.ShouldBeGreaterThanOrEqualTo(1);
        }

        File.Exists(factory.Documents.PathOf(orphan)).ShouldBeFalse();
        File.Exists(factory.Documents.PathOf(freshOrphan)).ShouldBeTrue();
        (await File.ReadAllBytesAsync(factory.Documents.PathOf(first.ObjectKey), Ct)).ShouldBe(firstBytes);
        File.Exists(factory.Documents.PathOf(second.ObjectKey)).ShouldBeTrue();
        (await DownloadAsync(sales, secondId)).Headers.GetValues("X-Document-Sha256").Single().ShouldBe(second.ContentSha256);
    }

    [Fact]
    public async Task Versions_released_before_documents_were_stored_get_an_issued_document_or_a_labelled_reconstruction()
    {
        var sales = factory.ClientAs(CrmRoles.Sales, userKey: "doc-sales");
        var marker = $"D{Guid.NewGuid():N}"[..10];
        var (organizationId, contactId) = await CustomerAsync(sales, marker);
        var sentBefore = await QuoteAsync(sales, organizationId, contactId, marker, "nb");
        var readyBefore = await QuoteAsync(sales, organizationId, contactId, marker, "nb");
        // As an older release left them: released (one of them also sent), no document stored.
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<SalesDbContext>();
            await db.Quotes.Where(q => q.Id == sentBefore).ExecuteUpdateAsync(s => s
                .SetProperty(q => q.Status, QuoteStatus.Sent).SetProperty(q => q.SentAt, DateTimeOffset.UtcNow.AddDays(-20)).SetProperty(q => q.SentTo, "kunde@example.no"), Ct);
            await db.Quotes.Where(q => q.Id == readyBefore).ExecuteUpdateAsync(s => s.SetProperty(q => q.Status, QuoteStatus.Ready), Ct);
        }

        // Two downloads at once make one document.
        var downloads = await Task.WhenAll(DownloadAsync(sales, sentBefore), DownloadAsync(sales, sentBefore));
        downloads[0].Content.ShouldBe(downloads[1].Content);
        var (reconstructed, headers, fileName) = downloads[0];
        headers.GetValues("X-Document-Origin").Single().ShouldBe("Reconstructed");
        fileName.ShouldEndWith("-gjenskapt.pdf");
        Encoding.Latin1.GetString(reconstructed).ShouldContain("Gjenskapt kopi");
        (await DocumentsOfAsync(sentBefore)).ShouldHaveSingleItem().Origin.ShouldBe(QuoteDocumentOrigin.Reconstructed);

        var (issued, issuedHeaders, _) = await DownloadAsync(sales, readyBefore);
        issuedHeaders.GetValues("X-Document-Origin").Single().ShouldBe("Issued");
        Encoding.Latin1.GetString(issued).ShouldNotContain("Gjenskapt");
    }

    [Fact]
    public async Task A_version_from_before_that_is_sent_while_it_is_downloaded_is_marked_sent_with_its_one_document()
    {
        var sales = factory.ClientAs(CrmRoles.Sales, userKey: "doc-sales");
        factory.Graph.Given(Request.Create().WithPath("/graph/v1.0/users/doc-sales@test.local/sendMail").UsingPost())
            .RespondWith(Response.Create().WithStatusCode(202));
        // Both requests find no document and create one; whichever loses adopts the other's — and a send that loses still
        // records that the quote was sent. Several rounds, because the loser is whoever the scheduler makes it.
        for (var round = 0; round < 6; round++)
        {
            var marker = $"D{Guid.NewGuid():N}"[..10];
            var (organizationId, contactId) = await CustomerAsync(sales, marker);
            var quoteId = await QuoteAsync(sales, organizationId, contactId, marker, "nb");
            await using (var scope = factory.Services.CreateAsyncScope())
            {
                await scope.ServiceProvider.GetRequiredService<SalesDbContext>().Quotes.Where(q => q.Id == quoteId)
                    .ExecuteUpdateAsync(s => s.SetProperty(q => q.Status, QuoteStatus.Ready), Ct);
            }

            var send = sales.PostAsJsonAsync($"{Sales}/quotes/{quoteId}/send", new { toAddress = $"kari.{marker}@example.no", subject = $"{marker} Tilbud" }, Ct);
            var download = sales.GetAsync($"{Sales}/quotes/{quoteId}/pdf", Ct);
            await Task.WhenAll(send, download);

            (await send).StatusCode.ShouldBe(HttpStatusCode.OK, await (await send).Content.ReadAsStringAsync(Ct));
            (await download).StatusCode.ShouldBe(HttpStatusCode.OK, await (await download).Content.ReadAsStringAsync(Ct));
            (await sales.GetFromJsonAsync<JsonElement>($"{Sales}/quotes/{quoteId}", Ct)).GetProperty("status").GetString().ShouldBe("Sent", $"round {round}");
            var document = (await DocumentsOfAsync(quoteId)).ShouldHaveSingleItem();
            document.Origin.ShouldBe(QuoteDocumentOrigin.Issued);
            Attachments(marker).Single().Content.ShouldBe(await (await download).Content.ReadAsByteArrayAsync(Ct));
        }
    }

    [Fact]
    public async Task The_database_refuses_to_change_or_delete_a_ready_document_for_every_identity()
    {
        var sales = factory.ClientAs(CrmRoles.Sales, userKey: "doc-sales");
        var marker = $"D{Guid.NewGuid():N}"[..10];
        var (organizationId, contactId) = await CustomerAsync(sales, marker);
        var quoteId = await QuoteAsync(sales, organizationId, contactId, marker, "nb");
        (await sales.PostAsync($"{Sales}/quotes/{quoteId}/submit", null, Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
        var document = (await DocumentsOfAsync(quoteId)).Single();

        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<SalesDbContext>();
            var update = await Should.ThrowAsync<SqlException>(() => db.QuoteDocuments.Where(d => d.Id == document.Id)
                .ExecuteUpdateAsync(s => s.SetProperty(d => d.ContentSha256, new string('0', 64)), Ct));
            update.Number.ShouldBe(51011);
            (await Should.ThrowAsync<SqlException>(() => db.QuoteDocuments.Where(d => d.Id == document.Id).ExecuteDeleteAsync(Ct))).Number.ShouldBe(229);
        }

        var asAdministrator = await Should.ThrowAsync<SqlException>(() => factory.AdminSqlAsync(
            $"UPDATE sales.QuoteDocuments SET FileName = N'forged.pdf' WHERE Id = '{document.Id}';"));
        asAdministrator.Number.ShouldBe(51011);
        (await Should.ThrowAsync<SqlException>(() => factory.AdminSqlAsync($"DELETE FROM sales.QuoteDocuments WHERE Id = '{document.Id}';"))).Number.ShouldBe(51011);
        (await DocumentsOfAsync(quoteId)).Single().ContentSha256.ShouldBe(document.ContentSha256);
    }

    private async Task<Guid> DefaultTemplateAsync(HttpClient admin, string language, string footer)
    {
        var created = await admin.PostAsJsonAsync($"{Sales}/quote-templates", new
        {
            name = $"Standard {language} {Guid.NewGuid():N}"[..24], language, introText = "Thank you for your time.", termsText = "Standard terms apply.",
            footerText = footer, validityDays = 30, isActive = true, isDefault = true,
        }, Ct);
        created.StatusCode.ShouldBe(HttpStatusCode.Created, await created.Content.ReadAsStringAsync(Ct));
        return (await created.ReadJsonAsync()).GetProperty("id").GetGuid();
    }

    internal static async Task<(Guid OrganizationId, Guid ContactId)> CustomerAsync(HttpClient client, string marker)
    {
        var organizationId = await client.CreateOrganizationAsync(new
        {
            name = $"{marker} Kunde AS", status = "Customer", ehfEnabled = false,
            postalAddress = new { street = "Kundeveien 1", postalCode = "5003", city = "Bergen", countryCode = "NO" },
        });
        var contactId = (await (await client.PostAsJsonAsync($"{Customers}/organizations/{organizationId}/contacts", new
        {
            firstName = "Kari", lastName = "Hansen", email = $"kari.{marker}@example.no", roles = Array.Empty<string>(), isPrimary = true,
        }, Ct)).ReadJsonAsync()).GetProperty("contactId").GetGuid();
        return (organizationId, contactId);
    }

    internal static async Task<Guid> QuoteAsync(HttpClient client, Guid organizationId, Guid contactId, string marker, string language)
    {
        var created = await client.PostAsJsonAsync($"{Sales}/quotes", new
        {
            organizationId,
            contactId,
            title = $"{marker} Drift",
            language,
            termMonths = 12,
            lines = new object[]
            {
                new { name = "Drift av arbeidsstasjoner", quantity = 10m, unitPrice = 450m, discountPct = 0m, recurrence = "Monthly" },
                new { name = "Etablering", quantity = 8m, unitPrice = 1_190m, discountPct = 0m, recurrence = "OneTime" },
            },
        }, Ct);
        created.StatusCode.ShouldBe(HttpStatusCode.Created, await created.Content.ReadAsStringAsync(Ct));
        return (await created.ReadJsonAsync()).GetProperty("id").GetGuid();
    }

    internal sealed record Download(byte[] Content, HttpResponseHeaders Headers, string FileName);

    internal static async Task<Download> DownloadAsync(HttpClient client, Guid quoteId)
    {
        var response = await client.GetAsync($"{Sales}/quotes/{quoteId}/pdf", Ct);
        response.StatusCode.ShouldBe(HttpStatusCode.OK, await response.Content.ReadAsStringAsync(Ct));
        response.Content.Headers.ContentType!.MediaType.ShouldBe("application/pdf");
        return new Download(await response.Content.ReadAsByteArrayAsync(Ct), response.Headers, response.Content.Headers.ContentDisposition!.FileName!.Trim('"'));
    }

    private List<(string Name, byte[] Content)> Attachments(string marker) => Attachments(factory, marker);

    /// <summary>The attachments of the messages sent with the subject "{marker} Tilbud".</summary>
    internal static List<(string Name, byte[] Content)> Attachments(CrmWebFactory factory, string marker) =>
        factory.Graph.LogEntries
            .Select(e => e.RequestMessage)
            .Where(r => r!.Path.EndsWith("/sendMail", StringComparison.Ordinal))
            .Select(r => JsonDocument.Parse(r!.Body ?? "{}").RootElement.GetProperty("message"))
            .Where(m => m.GetProperty("subject").GetString() == $"{marker} Tilbud")
            .Select(m => m.GetProperty("attachments").EnumerateArray().Single())
            .Select(a => (a.GetProperty("name").GetString()!, Convert.FromBase64String(a.GetProperty("contentBytes").GetString()!)))
            .ToList();

    private async Task<int> RunDocumentJobAsync()
    {
        await using var scope = factory.Services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<QuoteDocumentJob>().RunAsync(Ct);
    }

    private Task<List<QuoteDocument>> DocumentsOfAsync(Guid quoteId) => DocumentsOfAsync(factory, quoteId);

    internal static async Task<List<QuoteDocument>> DocumentsOfAsync(WebApplicationFactory<Program> host, Guid quoteId)
    {
        await using var scope = host.Services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<SalesDbContext>().QuoteDocuments.AsNoTracking()
            .Where(d => d.QuoteId == quoteId).OrderBy(d => d.Revision).ToListAsync(Ct);
    }

    internal static HttpClient Client(WebApplicationFactory<Program> host, string role, string userKey)
    {
        var client = host.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false });
        client.DefaultRequestHeaders.Add(TestAuthHandler.RolesHeader, role);
        client.DefaultRequestHeaders.Add(TestAuthHandler.UserHeader, userKey);
        client.DefaultRequestHeaders.Add("X-CSRF", "1");
        client.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        return client;
    }
}
