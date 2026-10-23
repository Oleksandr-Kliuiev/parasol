using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Crm.Authorization;
using Crm.Customers.Contracts;
using Crm.Customers.Persistence;
using Crm.SharedKernel.Documents;
using Crm.SharedKernel.Operations;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using static Crm.IntegrationTests.IntegrationTestHelpers;

namespace Crm.IntegrationTests;

/// <summary>
/// M43 on SQL Server: the monthly reports the CRM files for a customer are stored create-only and checked before their row is saved,
/// filed once per source and content, listed newest month first with the reports of organizations merged into the customer, never
/// changed or removed by the application, and never served when the stored bytes no longer match.
/// </summary>
public sealed class StoredDocumentTests(CrmWebFactory factory)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    internal static byte[] Pdf(string text) =>
        Encoding.Latin1.GetBytes($"%PDF-1.4\n1 0 obj\n<< /Title ({text}) >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n");

    private async Task<StoredDocumentFiled> FileAsync(Guid organizationId, string kind, string source, DateOnly month, byte[] content)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<ICustomerDocuments>().FileAsync(new StoredDocumentFiling(
            organizationId, kind, source, month, month.AddMonths(1).AddDays(-1), $"{kind}-{month:yyyy-MM}.pdf", content,
            kind == StoredDocumentKinds.HuntressMonthly ? StoredDocumentProvenance.Source : StoredDocumentProvenance.Captured), Ct);
    }

    private async Task<Guid> CustomerAsync(string name) =>
        await factory.ClientAs(CrmRoles.Admin).CreateOrganizationAsync(new { name = $"{name} {Guid.NewGuid():N}"[..30], status = "Customer" });

    private static string List(Guid organizationId) => $"/api/v1/customers/organizations/{organizationId}/stored-documents";

    private static string Download(Guid organizationId, Guid documentId) => $"{List(organizationId)}/{documentId}/download";

    [Fact]
    public async Task A_report_is_filed_once_listed_newest_month_first_and_downloaded_byte_for_byte()
    {
        var customer = await CustomerAsync("Arkiv AS");
        var september = Pdf("Synthetic Huntress report 9001");
        var filed = await FileAsync(customer, StoredDocumentKinds.HuntressMonthly, StoredDocumentKinds.HuntressReport(9001), new DateOnly(2026, 9, 1), september);
        filed.Created.ShouldBeTrue();
        var again = await FileAsync(customer, StoredDocumentKinds.HuntressMonthly, StoredDocumentKinds.HuntressReport(9001), new DateOnly(2026, 9, 1), september);
        (again.DocumentId, again.Created).ShouldBe((filed.DocumentId, false));
        var august = await FileAsync(customer, StoredDocumentKinds.ParasollMonthly, StoredDocumentKinds.ParasollSummary(new DateOnly(2026, 8, 1)), new DateOnly(2026, 8, 1),
            Pdf("Synthetic summary of August"));

        var client = factory.ClientAs(CrmRoles.Technician);
        var page = await (await client.GetAsync(List(customer), Ct)).ReadJsonAsync();
        page.GetProperty("totalCount").GetInt32().ShouldBe(2);
        var items = page.GetProperty("items").EnumerateArray().ToList();
        items.Select(i => (i.GetProperty("id").GetGuid(), i.GetProperty("kind").GetString(), i.GetProperty("periodStart").GetString()))
            .ShouldBe([(filed.DocumentId, "huntress-monthly", "2026-09-01"), (august.DocumentId, "parasoll-monthly", "2026-08-01")]);
        items[0].GetProperty("length").GetInt64().ShouldBe(september.Length);
        items[0].GetProperty("provenance").GetString().ShouldBe("Source");

        using var response = await client.GetAsync(Download(customer, filed.DocumentId), Ct);
        response.StatusCode.ShouldBe(HttpStatusCode.OK);
        (await response.Content.ReadAsByteArrayAsync(Ct)).ShouldBe(september);
        response.Content.Headers.ContentType!.MediaType.ShouldBe("application/pdf");
        response.Content.Headers.ContentDisposition!.FileName.ShouldBe("huntress-monthly-2026-09.pdf");
        response.Headers.CacheControl!.NoStore.ShouldBeTrue();
        response.Headers.GetValues("X-Document-Sha256").Single().ShouldBe(DocumentHashes.Sha256(september));

        // A document of another customer is not this customer's, by its id or otherwise.
        var other = await CustomerAsync("Annen AS");
        (await client.GetAsync(Download(other, filed.DocumentId), Ct)).StatusCode.ShouldBe(HttpStatusCode.NotFound);
        (await (await client.GetAsync(List(other), Ct)).ReadJsonAsync()).GetProperty("totalCount").GetInt32().ShouldBe(0);
    }

    [Fact]
    public async Task A_page_of_reports_continues_where_the_last_one_ended()
    {
        var customer = await CustomerAsync("Sider AS");
        var months = Enumerable.Range(0, 5).Select(i => new DateOnly(2026, 9, 1).AddMonths(-i)).ToList();
        foreach (var month in months)
        {
            await FileAsync(customer, StoredDocumentKinds.ParasollMonthly, StoredDocumentKinds.ParasollSummary(month), month, Pdf($"Summary {month:yyyy-MM}"));
        }

        var client = factory.ClientAs(CrmRoles.Admin);
        var first = await (await client.GetAsync($"{List(customer)}?limit=2", Ct)).ReadJsonAsync();
        var seen = first.GetProperty("items").EnumerateArray().Select(i => i.GetProperty("periodStart").GetString()).ToList();
        var cursor = first.GetProperty("nextCursor").GetString();
        while (cursor is not null)
        {
            var next = await (await client.GetAsync($"{List(customer)}?limit=2&cursor={Uri.EscapeDataString(cursor)}", Ct)).ReadJsonAsync();
            seen.AddRange(next.GetProperty("items").EnumerateArray().Select(i => i.GetProperty("periodStart").GetString()));
            cursor = next.GetProperty("nextCursor").ValueKind == JsonValueKind.Null ? null : next.GetProperty("nextCursor").GetString();
        }

        seen.ShouldBe(months.Select(m => m.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture)));
        (await client.GetAsync($"{List(customer)}?cursor=not-a-cursor", Ct)).StatusCode.ShouldBe(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task The_reports_of_a_merged_customer_are_listed_with_the_customer_it_was_merged_into()
    {
        var admin = factory.ClientAs(CrmRoles.Admin);
        var target = await CustomerAsync("Samlet AS");
        var source = await CustomerAsync("Samlet AS gammel");
        var filed = await FileAsync(source, StoredDocumentKinds.HuntressMonthly, StoredDocumentKinds.HuntressReport(Random.Shared.NextInt64(1, long.MaxValue)),
            new DateOnly(2026, 7, 1), Pdf("Report of the merged customer"));

        (await admin.PostAsJsonAsync($"/api/v1/customers/organizations/{target}/merge", new { sourceOrganizationId = source }, Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);

        var page = await (await admin.GetAsync(List(target), Ct)).ReadJsonAsync();
        page.GetProperty("items").EnumerateArray().Select(i => i.GetProperty("id").GetGuid()).ShouldBe([filed.DocumentId]);
        (await admin.GetAsync(Download(target, filed.DocumentId), Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
    }

    [Fact]
    public async Task The_runtime_role_cannot_change_or_remove_a_stored_document()
    {
        var customer = await CustomerAsync("Fast AS");
        var filed = await FileAsync(customer, StoredDocumentKinds.ParasollMonthly, StoredDocumentKinds.ParasollSummary(new DateOnly(2026, 6, 1)), new DateOnly(2026, 6, 1),
            Pdf("Immutable summary"));
        await using var scope = factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<CustomersDbContext>();
        var id = filed.DocumentId;
        (await Should.ThrowAsync<SqlException>(() => db.Database.ExecuteSqlInterpolatedAsync($"UPDATE customers.StoredDocuments SET ContentSha256 = 'bad' WHERE Id = {id}", Ct)))
            .Number.ShouldBe(229);
        (await Should.ThrowAsync<SqlException>(() => db.Database.ExecuteSqlInterpolatedAsync($"DELETE FROM customers.StoredDocuments WHERE Id = {id}", Ct)))
            .Number.ShouldBe(229);
    }

    [Fact]
    public async Task A_changed_or_missing_file_is_never_served_and_the_restore_check_names_it()
    {
        var customer = await CustomerAsync("Skadet AS");
        var content = Pdf("Report whose file is damaged");
        var filed = await FileAsync(customer, StoredDocumentKinds.HuntressMonthly, StoredDocumentKinds.HuntressReport(Random.Shared.NextInt64(1, long.MaxValue)),
            new DateOnly(2026, 5, 1), content);
        var path = factory.Documents.PathOf($"customers/documents/{customer:N}/{DocumentHashes.Sha256(content)}.pdf");
        var client = factory.ClientAs(CrmRoles.Admin);
        try
        {
            File.SetAttributes(path, FileAttributes.Normal);
            await File.WriteAllBytesAsync(path, Pdf("Something else entirely"), Ct);
            using (var response = await client.GetAsync(Download(customer, filed.DocumentId), Ct))
            {
                response.StatusCode.ShouldBe(HttpStatusCode.InternalServerError);
                (await response.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe("CUS_DOCUMENT_INTEGRITY");
            }

            await using var scope = factory.Services.CreateAsyncScope();
            var check = await scope.ServiceProvider.GetServices<IRestoreParticipant>().Single(p => p.Area == "customer-documents").CheckAsync(DateTimeOffset.UtcNow, Ct);
            check.ShouldHaveSingleItem().NeedsPerson.ShouldBeTrue();

            File.Delete(path);
            (await client.GetAsync(Download(customer, filed.DocumentId), Ct)).StatusCode.ShouldBe(HttpStatusCode.InternalServerError);
        }
        finally
        {
            await File.WriteAllBytesAsync(path, content, Ct);
        }

        (await client.GetByteArrayAsync(Download(customer, filed.DocumentId), Ct)).ShouldBe(content);
    }

    [Fact]
    public async Task Bytes_that_are_not_a_whole_pdf_or_a_customer_the_crm_does_not_have_are_refused()
    {
        var customer = await CustomerAsync("Avvist AS");
        await Should.ThrowAsync<InvalidDataException>(() =>
            FileAsync(customer, StoredDocumentKinds.HuntressMonthly, StoredDocumentKinds.HuntressReport(1), new DateOnly(2026, 4, 1), Encoding.UTF8.GetBytes("<html>Sign in</html>")));
        await Should.ThrowAsync<InvalidOperationException>(() =>
            FileAsync(Guid.NewGuid(), StoredDocumentKinds.HuntressMonthly, StoredDocumentKinds.HuntressReport(2), new DateOnly(2026, 4, 1), Pdf("No such customer")));
        (await (await factory.ClientAs(CrmRoles.Admin).GetAsync(List(customer), Ct)).ReadJsonAsync()).GetProperty("totalCount").GetInt32().ShouldBe(0);
    }
}
