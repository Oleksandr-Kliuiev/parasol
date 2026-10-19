using System.Globalization;
using System.IO.Compression;
using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Crm.Authorization;
using Crm.Billing.Contracts;
using Crm.Billing.Domain;
using Crm.Billing.Persistence;
using Crm.Integrations.Core;
using Crm.Integrations.PowerOffice;
using Crm.SharedKernel.Documents;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using WireMock.RequestBuilders;
using WireMock.ResponseBuilders;
using WireMock.Server;
using static Crm.IntegrationTests.IntegrationTestHelpers;

namespace Crm.IntegrationTests;

[Collection(nameof(PowerOfficeResumeCollection))]
public sealed partial class PowerOfficePdfTests(CrmWebFactory factory)
{
    [Fact]
    public async Task Invoice_and_credit_pdfs_link_by_uuid_keep_versions_and_download_exact_source_bytes()
    {
        using var po = Provider();
        await using var host = Host(po);
        var invoice = await Seed(host);
        var credit = await Seed(host, InvoiceDocumentKind.CreditNote);
        var first = Pdf("Synthetic invoice 1250 NOK");
        var note = Pdf("Synthetic credit -1250 NOK");
        Metadata(po, invoice); Metadata(po, credit);
        Archive(po, invoice.VoucherId, Zip(("invoice.pdf", first)), type: "Application/ZIP");
        Archive(po, credit.VoucherId, Zip(("credit.pdf", note)));
        await Run(host.Services); await Run(host.Services);
        var one = (await Documents(host, invoice.InvoiceId)).ShouldHaveSingleItem();
        (await Documents(host, credit.InvoiceId)).ShouldHaveSingleItem().ContentSha256.ShouldBe(DocumentHashes.Sha256(note));
        one.Length.ShouldBe(first.Length);
        one.ContentSha256.ShouldBe(DocumentHashes.Sha256(first));
        using var response = await Client(host, CrmRoles.Finance).GetAsync(Download(invoice.InvoiceId, one.Id));
        response.StatusCode.ShouldBe(HttpStatusCode.OK);
        (await response.Content.ReadAsByteArrayAsync()).ShouldBe(first);
        response.Content.Headers.ContentType!.MediaType.ShouldBe("application/pdf");
        response.Content.Headers.ContentDisposition!.DispositionType.ShouldBe("attachment");
        response.Headers.CacheControl!.NoStore.ShouldBeTrue();
        var replacement = Pdf("Synthetic corrected invoice");
        Archive(po, invoice.VoucherId, Zip(("invoice.pdf", replacement)));
        await Run(host.Services); await Run(host.Services);
        var versions = await Documents(host, invoice.InvoiceId);
        versions.Count.ShouldBe(2);
        versions.ShouldContain(d => d.Id == one.Id && d.ContentSha256 == one.ContentSha256);
        (await Client(host, CrmRoles.Finance).GetByteArrayAsync(Download(invoice.InvoiceId, one.Id))).ShouldBe(first);
        var wrongInvoice = await Client(host, CrmRoles.Finance).GetAsync(Download(credit.InvoiceId, one.Id));
        wrongInvoice.StatusCode.ShouldBe(HttpStatusCode.NotFound);
        AssertReadOnly(po);
    }

    [Theory]
    [InlineData(CrmRoles.ReadOnly, HttpStatusCode.Forbidden)]
    [InlineData(CrmRoles.ServiceLead, HttpStatusCode.Forbidden)]
    [InlineData(CrmRoles.Finance, HttpStatusCode.OK)]
    public async Task Both_document_endpoints_require_finance_and_billing_permissions(string role, HttpStatusCode expected)
    {
        using var po = Provider(); await using var host = Host(po);
        var source = await Seed(host);
        await Import(host, source, [new("invoice.pdf", Pdf("Synthetic protected PDF"))]);
        var document = (await Documents(host, source.InvoiceId)).Single();
        var client = Client(host, role);
        (await client.GetAsync($"/api/v1/billing/invoices/{source.InvoiceId}/documents")).StatusCode.ShouldBe(expected);
        (await client.GetAsync(Download(source.InvoiceId, document.Id))).StatusCode.ShouldBe(expected);
    }

    [Fact]
    public async Task Missing_documentation_is_distinct_from_no_pdf_and_rechecked_without_invoice_changes()
    {
        using var po = Provider(); await using var host = Host(po);
        var source = await Seed(host);
        await Run(host.Services);
        var page = await Client(host, CrmRoles.Finance).GetFromJsonAsync<JsonElement>($"/api/v1/billing/invoices/{source.InvoiceId}/documents");
        page.GetProperty("sourceHasPdf").ValueKind.ShouldBe(JsonValueKind.Null);
        Metadata(po, source, false);
        await Run(host.Services);
        page = await Client(host, CrmRoles.Finance).GetFromJsonAsync<JsonElement>($"/api/v1/billing/invoices/{source.InvoiceId}/documents");
        page.GetProperty("sourceHasPdf").GetBoolean().ShouldBeFalse();
        Metadata(po, source); Archive(po, source.VoucherId, Zip(("later.pdf", Pdf("Synthetic delayed document"))));
        await Run(host.Services);
        (await Documents(host, source.InvoiceId)).Count.ShouldBe(1);
        Metadata(po, source, false); await Run(host.Services);
        (await Documents(host, source.InvoiceId)).Count.ShouldBe(1); // Provider removal cannot erase captured history.
    }

    [Fact]
    public async Task Opt_in_disabled_makes_no_provider_request()
    {
        using var po = Provider(); await using var host = Host(po, enabled: false);
        await Run(host.Services);
        po.LogEntries.ShouldBeEmpty();
    }

    private WebApplicationFactory<Program> Host(WireMockServer po, bool enabled = true) => factory.WithWebHostBuilder(builder =>
    {
        builder.UseSetting("Integrations:PowerOffice:BaseUrl", po.Url + "/v2/");
        builder.UseSetting("Integrations:PowerOffice:TokenUrl", po.Url + "/OAuth/Token");
        builder.UseSetting("Integrations:PowerOffice:WriteEnabled", "false");
        builder.UseSetting("Integrations:PowerOffice:InvoicePdfSyncEnabled", enabled.ToString());
        builder.UseSetting("Integrations:PowerOffice:PageSize", "2");
        builder.UseSetting("Integrations:RetryDelays:0", "00:00:00.020");
    });

    private static WireMockServer Provider()
    {
        var po = WireMockServer.Start();
        po.Given(Request.Create().WithPath("/OAuth/Token").UsingPost())
            .RespondWith(JsonReply(new { access_token = "synthetic-pdf-token", token_type = "bearer", expires_in = 1200 }));
        po.Given(Request.Create().WithPath("/v2/VoucherDocumentation").UsingGet()).AtPriority(10)
            .RespondWith(Response.Create().WithStatusCode(204));
        return po;
    }

    private static void Metadata(WireMockServer po, InvoiceDocumentSource source, bool? hasPdf = true, Guid? id = null, string? type = null) =>
        po.Given(Request.Create().WithPath("/v2/VoucherDocumentation").UsingGet().WithParam("id", source.VoucherId.ToString("D"))
                .WithParam("PageNumber", "1")).AtPriority(1)
            .RespondWith(JsonReply(new[] { new { VoucherId = id ?? source.VoucherId, VoucherType = type ?? (source.Kind == InvoiceDocumentKind.CreditNote ? "OutgoingCreditNote" : "OutgoingInvoice"), HasPdf = hasPdf } }));

    private static void Archive(WireMockServer po, Guid id, byte[] bytes, string type = "application/zip", int status = 200) =>
        po.Given(Request.Create().WithPath("/v2/VoucherDocumentation/Download").UsingGet().WithParam("id", id.ToString("D")).WithParam("documentationType", "Pdf"))
            .RespondWith(Response.Create().WithStatusCode(status).WithHeader("Content-Type", type).WithBody(bytes));

    private static async Task<InvoiceDocumentSource> Seed(WebApplicationFactory<Program> host, InvoiceDocumentKind kind = InvoiceDocumentKind.Invoice, Guid? organization = null)
    {
        var source = new PoOutgoingInvoice { Id = Guid.NewGuid(), CustomerId = Random.Shared.NextInt64(900000000, 999999999),
            InvoiceNo = 12345, VoucherType = kind == InvoiceDocumentKind.CreditNote ? "OutgoingCreditNote" : "OutgoingInvoice",
            IsReversed = false, VoucherDate = new(2026, 1, 1), CurrencyCode = "NOK", NetAmount = 1250m, TotalAmount = 1250m,
            NetPostedAmount = 1250m, TotalPostedAmount = 1250m, Balance = 1250m,
            LastChangedDateTimeOffset = DateTimeOffset.UtcNow, BalanceLastChangedDateTimeOffset = DateTimeOffset.UtcNow };
        await using var scope = host.Services.CreateAsyncScope();
        await scope.ServiceProvider.GetRequiredService<IBillingApi>().UpsertInvoicesAsync([PowerOfficeInvoiceMapping.Map(source, []) with { OrganizationId = organization }], CancellationToken.None);
        var invoice = await scope.ServiceProvider.GetRequiredService<BillingDbContext>().Invoices.SingleAsync(i => i.ExternalId == source.Id);
        return new(invoice.Id, source.Id, kind);
    }

    private static async Task<InvoiceDocumentImportResult> Import(WebApplicationFactory<Program> host, InvoiceDocumentSource source, IReadOnlyList<ExternalInvoicePdf> files)
    {
        await using var scope = host.Services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<IBillingApi>().ImportInvoiceDocumentsAsync("poweroffice", source, true, files, CancellationToken.None);
    }

    private static async Task<List<InvoiceDocument>> Documents(WebApplicationFactory<Program> host, Guid id)
    {
        await using var scope = host.Services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<BillingDbContext>().InvoiceDocuments.AsNoTracking().Where(d => d.InvoiceId == id).OrderBy(d => d.ImportedAt).ToListAsync();
    }

    private static async Task Run(IServiceProvider services)
    {
        await using var scope = services.CreateAsyncScope();
        await scope.ServiceProvider.GetRequiredService<PowerOfficePdfSyncJob>().RunAsync(CancellationToken.None);
    }

    private static HttpClient Client(WebApplicationFactory<Program> host, string role)
    {
        var client = host.CreateClient();
        client.DefaultRequestHeaders.Add(TestAuthHandler.RolesHeader, role);
        client.DefaultRequestHeaders.Add(TestAuthHandler.UserHeader, "admin");
        client.DefaultRequestHeaders.Add("X-CSRF", "1");
        return client;
    }
    private static string Download(Guid invoice, Guid document) => $"/api/v1/billing/invoices/{invoice}/documents/{document}/download";
    private static void AssertReadOnly(WireMockServer po) => po.LogEntries.Where(e => e.RequestMessage!.Path!.StartsWith("/v2/", StringComparison.Ordinal))
        .ShouldAllBe(e => e.RequestMessage!.Method == "GET");

    private static byte[] Zip(params (string Name, byte[] Bytes)[] files)
    {
        using var output = new MemoryStream();
        using (var zip = new ZipArchive(output, ZipArchiveMode.Create, leaveOpen: true))
            foreach (var (name, bytes) in files)
            {
                using var entry = zip.CreateEntry(name).Open(); entry.Write(bytes);
            }
        return output.ToArray();
    }

    // A real one-page ASCII PDF with correct object offsets, not an envelope-only success fixture.
    private static byte[] Pdf(string label)
    {
        var text = $"BT /F1 12 Tf 40 740 Td ({label}) Tj ET";
        string[] objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", $"<< /Length {text.Length} >>\nstream\n{text}\nendstream"];
        var output = new StringBuilder("%PDF-1.4\n");
        var offsets = new List<int>();
        for (int i = 0; i < objects.Length; i++) { offsets.Add(output.Length); output.Append($"{i + 1} 0 obj\n{objects[i]}\nendobj\n"); }
        var xref = output.Length;
        output.Append("xref\n0 6\n0000000000 65535 f \n");
        foreach (var offset in offsets) output.Append(offset.ToString("D10", CultureInfo.InvariantCulture) + " 00000 n \n");
        output.Append($"trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n");
        return Encoding.ASCII.GetBytes(output.ToString());
    }
}
