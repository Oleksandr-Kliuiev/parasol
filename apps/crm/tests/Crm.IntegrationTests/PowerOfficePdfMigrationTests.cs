using Crm.Billing.Domain;
using Crm.Billing.Persistence;
using Crm.Integrations.PowerOffice;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace Crm.IntegrationTests;

public sealed partial class PowerOfficePdfTests
{
    [Fact]
    public async Task Additive_pdf_migration_preserves_invoice_and_ledger_and_blocks_lossy_downgrade()
    {
        var name = "pdf_history_" + Guid.NewGuid().ToString("N");
        var connectionString = new SqlConnectionStringBuilder(factory.AdminConnectionString) { InitialCatalog = name, Pooling = false }.ConnectionString;
        await factory.AdminSqlAsync($"CREATE DATABASE [{name}];");
        try
        {
            await using var db = new BillingDbContext(new DbContextOptionsBuilder<BillingDbContext>().UseSqlServer(connectionString,
                sql => sql.MigrationsHistoryTable("__EFMigrationsHistory", "billing")).Options);
            var migrator = db.GetService<IMigrator>();
            await migrator.MigrateAsync("20261018072202_PowerOfficeCustomerLedger");
            var changed = DateTimeOffset.Parse("2026-10-18T01:00:00Z");
            var header = new PoOutgoingInvoice { Id = Guid.NewGuid(), InvoiceNo = 10001, CustomerId = 17,
                VoucherDate = new(2026, 1, 1), CurrencyCode = "NOK", NetAmount = 1250m, TotalAmount = 1250m,
                NetPostedAmount = 1250m, TotalPostedAmount = 1250m, Balance = 1250m, VoucherType = "OutgoingInvoice",
                IsReversed = false, LastChangedDateTimeOffset = changed, BalanceLastChangedDateTimeOffset = changed };
            var invoice = Invoice.From(PowerOfficeInvoiceMapping.Map(header, []), null, null, changed);
            db.Invoices.Add(invoice);
            var scan = Guid.NewGuid();
            db.CustomerLedgerSnapshots.Add(new() { System = "poweroffice", CustomerKey = "17", ScanId = scan, ReadStartedAt = changed, SavedAt = changed });
            var ledgerSource = PowerOfficeLedgerMapping.Map(new() { Id = 701, CustomerId = 17, VoucherId = header.Id, VoucherNo = 1,
                VoucherType = "OutgoingInvoice", PostingDate = new(2026, 1, 1), VoucherDate = new(2026, 1, 1),
                Amount = 1250m, Balance = 1250m, CurrencyAmount = 1250m, CurrencyCode = "NOK",
                CreatedDateTimeOffset = changed, LastChangedDateTimeOffset = changed });
            var ledger = CustomerLedgerEntry.From("poweroffice", ledgerSource, scan, changed);
            db.CustomerLedgerEntries.Add(ledger);
            await db.SaveChangesAsync();
            var rowVersion = await db.Database.SqlQuery<byte[]>($"SELECT [RowVersion] AS [Value] FROM billing.Invoices WHERE Id={invoice.Id}").SingleAsync();
            var history = invoice.HistoryJson;
            await migrator.MigrateAsync();
            db.ChangeTracker.Clear();
            (await db.Invoices.SingleAsync()).HistoryJson.ShouldBe(history);
            (await db.Database.SqlQuery<byte[]>($"SELECT [RowVersion] AS [Value] FROM billing.Invoices WHERE Id={invoice.Id}").SingleAsync()).ShouldBe(rowVersion);
            (await db.CustomerLedgerEntries.SingleAsync()).SnapshotJson.ShouldBe(ledger.SnapshotJson);
            (await db.CustomerLedgerVersions.CountAsync()).ShouldBe(1);
            db.Database.HasPendingModelChanges().ShouldBeFalse();
            // Empty new tables can be downgraded and re-created. Persisted checks alone also forbid loss.
            await migrator.MigrateAsync("20261018072202_PowerOfficeCustomerLedger");
            await migrator.MigrateAsync();
            db.InvoiceDocumentChecks.Add(InvoiceDocumentCheck.Create(invoice.Id));
            await db.SaveChangesAsync();
            (await Should.ThrowAsync<SqlException>(() => migrator.MigrateAsync("20261018072202_PowerOfficeCustomerLedger"))).Number.ShouldBe(51000);
            db.ChangeTracker.Clear();
            var document = InvoiceDocument.Create(invoice.Id, "invoice.pdf", Pdf("Synthetic preserved migration"), changed);
            db.InvoiceDocuments.Add(document);
            await db.SaveChangesAsync();
            (await Should.ThrowAsync<SqlException>(() => migrator.MigrateAsync("20261018072202_PowerOfficeCustomerLedger"))).Number.ShouldBe(51000);
            db.ChangeTracker.Clear();
            (await db.InvoiceDocuments.SingleAsync()).ContentSha256.ShouldBe(document.ContentSha256);
            (await db.Invoices.SingleAsync()).HistoryJson.ShouldBe(history);
            (await db.CustomerLedgerEntries.CountAsync()).ShouldBe(1);
        }
        finally
        {
            await factory.AdminSqlAsync($"ALTER DATABASE [{name}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [{name}];");
        }
    }
}
