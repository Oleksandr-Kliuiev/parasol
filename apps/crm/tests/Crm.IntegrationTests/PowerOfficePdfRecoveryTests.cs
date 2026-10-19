using System.Net;
using System.Text;
using Crm.Authorization;
using Crm.Billing.Contracts;
using Crm.Billing.Persistence;
using Crm.Integrations.Core;
using Crm.SharedKernel.Operations;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using static Crm.IntegrationTests.IntegrationTestHelpers;

namespace Crm.IntegrationTests;

public sealed partial class PowerOfficePdfTests
{
    [Theory]
    [InlineData(StoreFailure.BeforeWrite)]
    [InlineData(StoreFailure.AfterWrite)]
    public async Task Storage_failure_and_replay_never_duplicate_or_publish_partial_documents(StoreFailure failure)
    {
        using var po = Provider(); await using var host = Host(po);
        var source = await Seed(host);
        Metadata(po, source); Archive(po, source.VoucherId, Zip(("invoice.pdf", Pdf("Synthetic recoverable document"))));
        var fragment = source.InvoiceId.ToString("N");
        factory.Documents.Fail(fragment, failure);
        try
        {
            await Should.ThrowAsync<SyncFailedException>(() => Run(host.Services));
            (await Documents(host, source.InvoiceId)).ShouldBeEmpty();
            await using var check = host.Services.CreateAsyncScope();
            (await check.ServiceProvider.GetRequiredService<BillingDbContext>().InvoiceDocumentChecks.AnyAsync(d => d.InvoiceId == source.InvoiceId)).ShouldBeFalse();
        }
        finally { factory.Documents.Heal(fragment); }
        await Run(host.Services); await Run(host.Services);
        (await Documents(host, source.InvoiceId)).Count.ShouldBe(1);
    }

    [Fact]
    public async Task Failed_sql_commit_reuses_verified_files_after_rollback()
    {
        using var po = Provider(); await using var host = Host(po);
        var source = await Seed(host);
        var files = new ExternalInvoicePdf[] { new("invoice.pdf", Pdf("Synthetic SQL recovery")), new("attachment.pdf", Pdf("Synthetic appendix")) };
        var trigger = "trg_test_pdf_" + Guid.NewGuid().ToString("N");
        await factory.AdminSqlAsync($"CREATE TRIGGER [billing].[{trigger}] ON [billing].[InvoiceDocuments] AFTER INSERT AS BEGIN IF EXISTS (SELECT 1 FROM inserted WHERE InvoiceId='{source.InvoiceId}') THROW 51000, 'Synthetic PDF commit failure.', 1; END;");
        try
        {
            await Should.ThrowAsync<DbUpdateException>(() => Import(host, source, files));
            (await Documents(host, source.InvoiceId)).ShouldBeEmpty();
        }
        finally { await factory.AdminSqlAsync($"DROP TRIGGER [billing].[{trigger}];"); }
        var result = await Import(host, source, files);
        result.Created.ShouldBe(2);
        (await Import(host, source, files)).Unchanged.ShouldBe(2);
        (await Documents(host, source.InvoiceId)).Count.ShouldBe(2);
    }

    [Theory]
    [InlineData("uuid")]
    [InlineData("kind")]
    [InlineData("null")]
    [InlineData("html")]
    [InlineData("empty204")]
    [InlineData("forbidden")]
    [InlineData("truncated")]
    [InlineData("mixed")]
    public async Task Invalid_provider_response_never_publishes_a_document_or_successful_check(string error)
    {
        using var po = Provider(); await using var host = Host(po);
        var source = await Seed(host);
        Metadata(po, source, error == "null" ? null : true, error == "uuid" ? Guid.NewGuid() : null, error == "kind" ? "OutgoingCreditNote" : null);
        var pdf = Pdf("Synthetic invalid transport");
        var zip = error == "mixed" ? Zip(("good.pdf", pdf), ("bad.pdf", Encoding.ASCII.GetBytes("<html>not PDF</html>"))) : Zip(("invoice.pdf", pdf));
        Archive(po, source.VoucherId, error == "truncated" ? zip[..^10] : zip, error == "html" ? "text/html" : "application/zip",
            error == "empty204" ? 204 : error == "forbidden" ? 403 : 200);
        await Should.ThrowAsync<SyncFailedException>(() => Run(host.Services));
        (await Documents(host, source.InvoiceId)).ShouldBeEmpty();
        await using var check = host.Services.CreateAsyncScope();
        (await check.ServiceProvider.GetRequiredService<BillingDbContext>().InvoiceDocumentChecks.AnyAsync(d => d.InvoiceId == source.InvoiceId)).ShouldBeFalse();
        AssertReadOnly(po);
    }

    [Fact]
    public async Task Concurrent_import_and_binding_validation_leave_one_copy()
    {
        using var po = Provider(); await using var host = Host(po);
        var source = await Seed(host);
        var files = new ExternalInvoicePdf[] { new("invoice.pdf", Pdf("Synthetic concurrent document")) };
        var results = await Task.WhenAll(Import(host, source, files), Import(host, source, files));
        results.Sum(r => r.Created).ShouldBe(1);
        (await Documents(host, source.InvoiceId)).Count.ShouldBe(1);
        await Should.ThrowAsync<InvalidOperationException>(() => Import(host, source with { VoucherId = Guid.NewGuid() }, files));
        await Should.ThrowAsync<InvalidOperationException>(() => Import(host, source with { Kind = InvoiceDocumentKind.CreditNote }, files));
        await Should.ThrowAsync<InvalidOperationException>(() => Import(host, source with { InvoiceId = Guid.NewGuid() }, files));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Missing_or_corrupt_file_blocks_download_reimport_and_restore_check(bool missing)
    {
        using var po = Provider(); await using var host = Host(po);
        var source = await Seed(host);
        var files = new ExternalInvoicePdf[] { new("invoice.pdf", Pdf("Synthetic verified document")) };
        await Import(host, source, files);
        var document = (await Documents(host, source.InvoiceId)).Single();
        var path = factory.Documents.PathOf(document.ObjectKey);
        var original = await File.ReadAllBytesAsync(path);
        try
        {
            if (missing) File.Delete(path);
            else await File.WriteAllBytesAsync(path, Pdf("Synthetic tampered bytes"));
            var response = await Client(host, CrmRoles.Finance).GetAsync(Download(source.InvoiceId, document.Id));
            response.StatusCode.ShouldBe(HttpStatusCode.InternalServerError);
            await using var scope = host.Services.CreateAsyncScope();
            var restore = scope.ServiceProvider.GetServices<IRestoreParticipant>().Single(p => p.Area == "billing-documents");
            (await restore.CheckAsync(DateTimeOffset.UtcNow, CancellationToken.None)).ShouldContain(l => l.NeedsPerson);
            if (!missing) await Should.ThrowAsync<InvalidDataException>(() => Import(host, source, files));
            else
            {
                // Recover a missing content-addressed object from identical verified source bytes, with no metadata mutation.
                (await Import(host, source, files)).Unchanged.ShouldBe(1);
                (await Client(host, CrmRoles.Finance).GetAsync(Download(source.InvoiceId, document.Id))).StatusCode.ShouldBe(HttpStatusCode.OK);
            }
        }
        finally { await File.WriteAllBytesAsync(path, original); }
        await using var healed = host.Services.CreateAsyncScope();
        (await healed.ServiceProvider.GetServices<IRestoreParticipant>().Single(p => p.Area == "billing-documents")
            .CheckAsync(DateTimeOffset.UtcNow, CancellationToken.None)).ShouldAllBe(l => !l.NeedsPerson);
    }

    [Fact]
    public async Task Runtime_role_cannot_update_or_delete_captured_pdf_metadata()
    {
        using var po = Provider(); await using var host = Host(po);
        var source = await Seed(host);
        await Import(host, source, [new("invoice.pdf", Pdf("Synthetic immutable metadata"))]);
        var id = (await Documents(host, source.InvoiceId)).Single().Id;
        await using var scope = host.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<BillingDbContext>();
        (await Should.ThrowAsync<SqlException>(() => db.Database.ExecuteSqlInterpolatedAsync($"UPDATE billing.InvoiceDocuments SET ContentSha256='bad' WHERE Id={id}"))).Number.ShouldBe(229);
        (await Should.ThrowAsync<SqlException>(() => db.Database.ExecuteSqlInterpolatedAsync($"DELETE FROM billing.InvoiceDocuments WHERE Id={id}"))).Number.ShouldBe(229);
    }

    [Fact]
    public async Task Customer_relink_keeps_original_pdf_on_the_same_invoice()
    {
        using var po = Provider(); await using var host = Host(po);
        var admin = Client(host, CrmRoles.Admin);
        var oldOrg = await admin.CreateOrganizationAsync(new { name = "Synthetic PDF old customer", status = "Customer" });
        var newOrg = await admin.CreateOrganizationAsync(new { name = "Synthetic PDF new customer", status = "Customer" });
        var source = await Seed(host, organization: oldOrg);
        await Import(host, source, [new("invoice.pdf", Pdf("Synthetic relinked document"))]);
        var document = (await Documents(host, source.InvoiceId)).Single();
        await using var scope = host.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<BillingDbContext>();
        var customer = await db.Invoices.Where(i => i.Id == source.InvoiceId).Select(i => i.ExternalCustomerId).SingleAsync();
        await scope.ServiceProvider.GetRequiredService<IBillingApi>().BindHistoricalInvoiceAsync(source.InvoiceId, customer!, newOrg, CancellationToken.None);
        db.ChangeTracker.Clear();
        (await db.Invoices.SingleAsync(i => i.Id == source.InvoiceId)).OrganizationId.ShouldBe(newOrg);
        (await Documents(host, source.InvoiceId)).Single().Id.ShouldBe(document.Id);
        (await Client(host, CrmRoles.Finance).GetAsync(Download(source.InvoiceId, document.Id))).StatusCode.ShouldBe(HttpStatusCode.OK);
    }
}
