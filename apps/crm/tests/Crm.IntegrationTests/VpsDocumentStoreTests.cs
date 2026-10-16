using System.Net;
using System.Net.Http.Json;
using System.Text;
using Crm.Authorization;
using Crm.Infrastructure.Documents;
using Crm.Sales.Domain;
using Crm.SharedKernel.Documents;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using WireMock.RequestBuilders;
using WireMock.ResponseBuilders;
using static Crm.IntegrationTests.IntegrationTestHelpers;

namespace Crm.IntegrationTests;

/// <summary>Real VPS store through release, download and mail, with SQL immutability and hash checks intact.</summary>
public sealed class VpsDocumentStoreTests(CrmWebFactory factory) : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), $"crm-vps-{Guid.NewGuid():N}");
    private const string Sales = "/api/v1/sales";
    private const string PdfMediaType = "application/pdf";
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task A_key_is_written_once_and_a_new_store_instance_adopts_the_actual_bytes()
    {
        var store = new FileSystemDocumentStore(_root);
        var key = NewKey();
        var first = Encoding.ASCII.GetBytes("%PDF-1.4 the issued document");

        var written = await store.PutAsync(key, first, PdfMediaType, Ct);
        written.ShouldBe(new StoredObject(key, DocumentHashes.Sha256(first), first.Length, Created: true));
        (await store.PutAsync(key, Encoding.ASCII.GetBytes("%PDF-1.4 another rendering"), PdfMediaType, Ct)).ShouldBe(written with { Created = false });
        (await store.ReadAsync(key, Ct)).ShouldBe(first);

        var restarted = new FileSystemDocumentStore(_root, createRoot: false);
        (await restarted.PutAsync(key, Encoding.ASCII.GetBytes("%PDF-1.4 a third try"), PdfMediaType, Ct)).Sha256.ShouldBe(written.Sha256);
        (await restarted.ReadAsync(key, Ct)).ShouldBe(first);
    }

    [Fact]
    public async Task Writers_racing_for_one_key_all_end_with_the_bytes_that_were_stored()
    {
        var store = new FileSystemDocumentStore(_root);
        var key = NewKey();

        var attempts = await Task.WhenAll(Enumerable.Range(0, 8)
            .Select(i => store.PutAsync(key, Encoding.ASCII.GetBytes($"%PDF-1.4 writer {i}"), PdfMediaType, Ct)));

        var stored = (await store.ReadAsync(key, Ct))!;
        attempts.Count(a => a.Created).ShouldBe(1);
        attempts.ShouldAllBe(a => a.Sha256 == DocumentHashes.Sha256(stored) && a.Length == stored.Length);
    }

    [Fact]
    public async Task Listing_reading_and_deleting_work_by_prefix_and_key()
    {
        var store = new FileSystemDocumentStore(_root);
        var prefix = $"quotes/{Guid.NewGuid():N}/";
        string[] keys = [$"{prefix}a/1.pdf", $"{prefix}b/2.pdf"];
        foreach (var key in keys)
        {
            await store.PutAsync(key, Encoding.ASCII.GetBytes(key), PdfMediaType, Ct);
        }

        await store.PutAsync($"elsewhere/{Guid.NewGuid():N}.pdf", "%PDF-1.4"u8.ToArray(), PdfMediaType, Ct);

        var listed = await store.ListAsync(prefix, Ct).ToListAsync(Ct);
        listed.Select(o => o.Key).Order(StringComparer.Ordinal).ShouldBe(keys);
        // The orphan cleanup decides by length and age; the age is the service's clock.
        listed.ShouldAllBe(o => o.Length == o.Key.Length && o.LastModified > DateTimeOffset.UtcNow.AddHours(-1) && o.LastModified < DateTimeOffset.UtcNow.AddHours(1));

        await store.DeleteAsync(keys[0], Ct);
        (await store.ReadAsync(keys[0], Ct)).ShouldBeNull();
        // The cleanup may meet an object that is already gone.
        await store.DeleteAsync(keys[0], Ct);
        (await store.ListAsync(prefix, Ct).ToListAsync(Ct)).ShouldHaveSingleItem().Key.ShouldBe(keys[1]);
        await Should.ThrowAsync<ArgumentException>(() => store.ReadAsync("quotes/../outside.pdf", Ct));
    }

    [Fact]
    public async Task A_document_has_no_public_static_file_address()
    {
        var key = NewKey();
        await factory.Documents.PutAsync(key, "%PDF-1.4 private"u8.ToArray(), PdfMediaType, Ct);
        using var anonymous = factory.AnonymousClient();
        foreach (var url in new[] { "/" + key, "/documents/" + key, "/data/documents/" + key })
        {
            var response = await anonymous.GetAsync(url, Ct);
            (await response.Content.ReadAsStringAsync(Ct)).ShouldNotContain("%PDF-1.4 private");
        }
    }

    [Fact]
    public async Task Release_download_and_e_mail_use_one_file_and_a_new_version_gets_its_own()
    {
        var store = new FileSystemDocumentStore(_root);
        await using var host = factory.WithWebHostBuilder(builder => builder.ConfigureTestServices(services =>
            services.AddSingleton<IDocumentStore>(store)));
        var sales = QuoteDocumentsTests.Client(host, CrmRoles.Sales, "doc-sales");
        var marker = $"B{Guid.NewGuid():N}"[..10];
        var (organizationId, contactId) = await QuoteDocumentsTests.CustomerAsync(sales, marker);
        var quoteId = await QuoteDocumentsTests.QuoteAsync(sales, organizationId, contactId, marker, "en");
        (await sales.PostAsync($"{Sales}/quotes/{quoteId}/submit", null, Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);

        var document = (await QuoteDocumentsTests.DocumentsOfAsync(host, quoteId)).Single();
        document.Status.ShouldBe(QuoteDocumentStatus.Ready);
        var bytes = (await store.ReadAsync(document.ObjectKey, Ct))!;
        DocumentHashes.Sha256(bytes).ShouldBe(document.ContentSha256);
        bytes.LongLength.ShouldBe(document.Length!.Value);

        var (downloaded, headers, fileName) = await QuoteDocumentsTests.DownloadAsync(sales, quoteId);
        downloaded.ShouldBe(bytes);
        headers.GetValues("X-Document-Sha256").Single().ShouldBe(document.ContentSha256);

        factory.Graph.Given(Request.Create().WithPath("/graph/v1.0/users/doc-sales@test.local/sendMail").UsingPost())
            .RespondWith(Response.Create().WithStatusCode(202));
        (await sales.PostAsJsonAsync($"{Sales}/quotes/{quoteId}/send", new { toAddress = $"kari.{marker}@example.no", subject = $"{marker} Tilbud" }, Ct))
            .StatusCode.ShouldBe(HttpStatusCode.OK);
        var attachment = QuoteDocumentsTests.Attachments(factory, marker).Single();
        attachment.Content.ShouldBe(bytes);
        attachment.Name.ShouldBe(fileName);

        var second = await (await sales.PostAsync($"{Sales}/quotes/{quoteId}/revise", null, Ct)).ReadJsonAsync();
        var secondId = second.GetProperty("id").GetGuid();
        (await sales.PostAsync($"{Sales}/quotes/{secondId}/submit", null, Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
        var secondDocument = (await QuoteDocumentsTests.DocumentsOfAsync(host, secondId)).Single();
        secondDocument.ObjectKey.ShouldNotBe(document.ObjectKey);
        (await new FileSystemDocumentStore(_root, createRoot: false).ReadAsync(document.ObjectKey, Ct)).ShouldBe(bytes);
        var objects = await store.ListAsync("quotes/", Ct).ToListAsync(Ct);
        objects.Select(o => o.Key).Order(StringComparer.Ordinal).ShouldBe(new[] { document.ObjectKey, secondDocument.ObjectKey }.Order(StringComparer.Ordinal));

        // Offline copy/restore to another physical root: SQL keys and hashes still resolve without re-rendering.
        var restoredRoot = _root + "-restored";
        try
        {
            foreach (var path in Directory.EnumerateFiles(_root, "*", SearchOption.AllDirectories))
            {
                var destination = Path.Combine(restoredRoot, Path.GetRelativePath(_root, path));
                Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
                File.Copy(path, destination);
                File.SetLastWriteTimeUtc(destination, File.GetLastWriteTimeUtc(path));
            }

            var restoredStore = new FileSystemDocumentStore(restoredRoot, createRoot: false);
            await using var restoredHost = factory.WithWebHostBuilder(builder => builder.ConfigureTestServices(services =>
                services.AddSingleton<IDocumentStore>(restoredStore)));
            var restoredSales = QuoteDocumentsTests.Client(restoredHost, CrmRoles.Sales, "doc-sales");
            var (restoredBytes, restoredHeaders, _) = await QuoteDocumentsTests.DownloadAsync(restoredSales, quoteId);
            restoredBytes.ShouldBe(bytes);
            restoredHeaders.GetValues("X-Document-Sha256").Single().ShouldBe(document.ContentSha256);
            (await restoredStore.PutAsync(document.ObjectKey, "replacement"u8.ToArray(), PdfMediaType, Ct)).Created.ShouldBeFalse();
            (await restoredStore.ReadAsync(document.ObjectKey, Ct)).ShouldBe(bytes);

            using var anonymous = restoredHost.CreateClient(new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions { AllowAutoRedirect = false });
            (await anonymous.GetAsync($"{Sales}/quotes/{quoteId}/pdf", Ct)).StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
        }
        finally
        {
            if (Directory.Exists(restoredRoot))
            {
                Directory.Delete(restoredRoot, recursive: true);
            }
        }
    }

    public void Dispose()
    {
        if (Directory.Exists(_root))
        {
            Directory.Delete(_root, recursive: true);
        }
    }

    private static string NewKey() => $"quotes/{Guid.NewGuid():N}/{Guid.NewGuid():N}/{Guid.NewGuid():N}.pdf";
}
