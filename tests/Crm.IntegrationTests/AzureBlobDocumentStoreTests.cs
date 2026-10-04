using System.Net;
using System.Net.Http.Json;
using System.Text;
using Azure.Storage.Blobs;
using Azure.Storage.Blobs.Models;
using Crm.Authorization;
using Crm.Infrastructure.Documents;
using Crm.Sales.Domain;
using Crm.SharedKernel.Documents;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Testcontainers.Azurite;
using WireMock.RequestBuilders;
using WireMock.ResponseBuilders;
using static Crm.IntegrationTests.IntegrationTestHelpers;

namespace Crm.IntegrationTests;

/// <summary>
/// Azurite, the Azure Storage emulator, for the blob document store (DEV-08). It speaks the Blob REST API, so conditional
/// uploads, metadata, listing and anonymous reads run against the protocol the store uses in Azure. What only Azure decides
/// (an account without public access or shared keys, the worker's role on the container) is checked in the Bicep tests.
/// </summary>
public sealed class AzuriteFixture : IAsyncLifetime
{
    private readonly AzuriteContainer _azurite = new AzuriteBuilder("mcr.microsoft.com/azure-storage/azurite:3.35.0")
        .WithInMemoryPersistence()
        // The SDK may speak a newer service version than the emulator announces.
        .WithCommand("--skipApiVersionCheck")
        .Build();

    public async ValueTask InitializeAsync() => await _azurite.StartAsync();

    public async ValueTask DisposeAsync() => await _azurite.DisposeAsync();

    /// <summary>A new private container (no anonymous access), so tests do not see each other's objects.</summary>
    public async Task<BlobContainerClient> NewContainerAsync(CancellationToken cancellationToken)
    {
        var container = new BlobContainerClient(_azurite.GetConnectionString(), $"documents-{Guid.NewGuid():N}");
        await container.CreateAsync(PublicAccessType.None, cancellationToken: cancellationToken);
        return container;
    }
}

/// <summary>The production document store (DEV-08-AC02/AC04/AC05): create-only keys, a private container, one object per document.</summary>
public sealed class AzureBlobDocumentStoreTests(AzuriteFixture azurite, CrmWebFactory factory) : IClassFixture<AzuriteFixture>
{
    private const string Sales = "/api/v1/sales";
    private const string PdfMediaType = "application/pdf";
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task A_key_is_written_once_and_a_later_writer_keeps_the_first_bytes_whatever_the_metadata_says()
    {
        var container = await azurite.NewContainerAsync(Ct);
        var store = new AzureBlobDocumentStore(container);
        var key = NewKey();
        var first = Encoding.ASCII.GetBytes("%PDF-1.4 the issued document");

        var written = await store.PutAsync(key, first, PdfMediaType, Ct);
        written.ShouldBe(new StoredObject(key, DocumentHashes.Sha256(first), first.Length, Created: true));
        var properties = (await container.GetBlobClient(key).GetPropertiesAsync(cancellationToken: Ct)).Value;
        properties.ContentType.ShouldBe(PdfMediaType);
        properties.Metadata[AzureBlobDocumentStore.HashMetadata].ShouldBe(written.Sha256);

        (await store.PutAsync(key, Encoding.ASCII.GetBytes("%PDF-1.4 another rendering"), PdfMediaType, Ct)).ShouldBe(written with { Created = false });
        (await store.ReadAsync(key, Ct)).ShouldBe(first);

        // Metadata is for operators and anyone with write access can change it: the store reports the hash of the bytes.
        await container.GetBlobClient(key).SetMetadataAsync(
            new Dictionary<string, string> { [AzureBlobDocumentStore.HashMetadata] = new string('0', 64) }, cancellationToken: Ct);
        (await store.PutAsync(key, Encoding.ASCII.GetBytes("%PDF-1.4 a third try"), PdfMediaType, Ct)).Sha256.ShouldBe(written.Sha256);
        (await store.ReadAsync(key, Ct)).ShouldBe(first);
    }

    [Fact]
    public async Task Writers_racing_for_one_key_all_end_with_the_bytes_that_were_stored()
    {
        var store = new AzureBlobDocumentStore(await azurite.NewContainerAsync(Ct));
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
        var store = new AzureBlobDocumentStore(await azurite.NewContainerAsync(Ct));
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
    public async Task The_private_container_gives_an_anonymous_blob_url_nothing()
    {
        var container = await azurite.NewContainerAsync(Ct);
        var key = NewKey();
        await new AzureBlobDocumentStore(container).PutAsync(key, "%PDF-1.4 private"u8.ToArray(), PdfMediaType, Ct);

        using var anonymous = new HttpClient();
        var response = await anonymous.GetAsync(container.GetBlobClient(key).Uri, Ct);
        TestContext.Current.TestOutputHelper?.WriteLine($"Anonymous GET of the blob URL: {(int)response.StatusCode} {response.StatusCode}");

        response.IsSuccessStatusCode.ShouldBeFalse(response.StatusCode.ToString());
        (await response.Content.ReadAsStringAsync(Ct)).ShouldNotContain("%PDF");
    }

    [Fact]
    public async Task Release_download_and_e_mail_use_the_one_blob_and_a_new_version_gets_its_own()
    {
        var container = await azurite.NewContainerAsync(Ct);
        await using var host = factory.WithWebHostBuilder(builder => builder.ConfigureTestServices(services =>
            services.AddSingleton<IDocumentStore>(new AzureBlobDocumentStore(container))));
        var sales = QuoteDocumentsTests.Client(host, CrmRoles.Sales, "doc-sales");
        var marker = $"B{Guid.NewGuid():N}"[..10];
        var (organizationId, contactId) = await QuoteDocumentsTests.CustomerAsync(sales, marker);
        var quoteId = await QuoteDocumentsTests.QuoteAsync(sales, organizationId, contactId, marker, "en");
        (await sales.PostAsync($"{Sales}/quotes/{quoteId}/submit", null, Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);

        var document = (await QuoteDocumentsTests.DocumentsOfAsync(host, quoteId)).Single();
        document.Status.ShouldBe(QuoteDocumentStatus.Ready);
        var blob = container.GetBlobClient(document.ObjectKey);
        var stored = (await blob.DownloadContentAsync(Ct)).Value;
        var bytes = stored.Content.ToArray();
        stored.Details.ContentType.ShouldBe(PdfMediaType);
        stored.Details.Metadata[AzureBlobDocumentStore.HashMetadata].ShouldBe(document.ContentSha256);
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
        (await blob.DownloadContentAsync(Ct)).Value.Content.ToArray().ShouldBe(bytes);
        var objects = await new AzureBlobDocumentStore(container).ListAsync("quotes/", Ct).ToListAsync(Ct);
        objects.Select(o => o.Key).Order(StringComparer.Ordinal).ShouldBe(new[] { document.ObjectKey, secondDocument.ObjectKey }.Order(StringComparer.Ordinal));
    }

    private static string NewKey() => $"quotes/{Guid.NewGuid():N}/{Guid.NewGuid():N}/{Guid.NewGuid():N}.pdf";
}
