using Crm.Billing.Domain;
using Crm.Billing.Persistence;
using Crm.Integrations.PowerOffice;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace Crm.IntegrationTests;

public sealed partial class PowerOfficeLedgerTests
{
    [Fact]
    public async Task Additive_ledger_migration_preserves_existing_invoice_snapshots_and_refuses_lossy_downgrade()
    {
        var name = "ledger_history_" + Guid.NewGuid().ToString("N");
        var connectionString = new SqlConnectionStringBuilder(factory.AdminConnectionString) { InitialCatalog = name, Pooling = false }.ConnectionString;
        await factory.AdminSqlAsync($"CREATE DATABASE [{name}];");
        try
        {
            await using var db = new BillingDbContext(new DbContextOptionsBuilder<BillingDbContext>().UseSqlServer(connectionString,
                sql => sql.MigrationsHistoryTable("__EFMigrationsHistory", "billing")).Options);
            var migrator = db.GetService<IMigrator>();
            await migrator.MigrateAsync("20261018064742_PowerOfficeInvoiceHistory");
            var header = new PoOutgoingInvoice { Id = Guid.NewGuid(), InvoiceNo = 10001, CustomerId = 17,
                VoucherDate = new(2026, 1, 1), CurrencyCode = "NOK", NetAmount = 1250m, TotalAmount = 1250m,
                NetPostedAmount = 1250m, TotalPostedAmount = 1250m, Balance = 1250m, VoucherType = "OutgoingInvoice",
                IsReversed = false, LastChangedDateTimeOffset = Changed, BalanceLastChangedDateTimeOffset = Changed };
            PoOutgoingInvoiceLine[] lines = [new() { Id = 71, SortOrder = 0, LineType = "Normal", Description = "Synthetic preserved history",
                NetAmount = 1250m, VatAmount = 0m, TotalAmount = 1250m, NetPostedAmount = 1250m, TotalPostedAmount = 1250m }];
            var source = PowerOfficeInvoiceMapping.Map(header, lines) with { Url = "https://example.invalid/legacy" };
            var invoice = Invoice.From(source, null, null, Changed);
            invoice.Apply(PowerOfficeInvoiceMapping.Map(header with { Balance = 1000m, LastChangedDateTimeOffset = Changed.AddMinutes(1),
                BalanceLastChangedDateTimeOffset = Changed.AddMinutes(1) }, lines), null, null, Changed.AddMinutes(2));
            var history = invoice.HistoryJson;
            db.Invoices.Add(invoice);
            await db.SaveChangesAsync();
            var version = await db.Database.SqlQuery<byte[]>($"SELECT [RowVersion] AS [Value] FROM billing.Invoices WHERE Id={invoice.Id}").SingleAsync();
            await migrator.MigrateAsync();
            (await db.Database.SqlQuery<byte[]>($"SELECT [RowVersion] AS [Value] FROM billing.Invoices WHERE Id={invoice.Id}").SingleAsync()).ShouldBe(version);
            var preserved = await db.Invoices.AsNoTracking().Include(i => i.Payments).SingleAsync();
            preserved.HistoryJson.ShouldBe(history);
            preserved.History!.Lines.Count.ShouldBe(1);
            preserved.Outstanding.ShouldBe(1000m);
            preserved.Payments.ShouldHaveSingleItem().Amount.ShouldBe(250m);
            db.Database.HasPendingModelChanges().ShouldBeFalse();
            var scan = Guid.NewGuid();
            db.CustomerLedgerSnapshots.Add(new() { System = "poweroffice", CustomerKey = "17", ScanId = scan, ReadStartedAt = Changed, SavedAt = Changed });
            var row = CustomerLedgerEntry.From("poweroffice", PowerOfficeLedgerMapping.Map(Entry(17, "BankJournal")), scan, Changed);
            db.CustomerLedgerEntries.Add(row);
            await db.SaveChangesAsync();
            (await Should.ThrowAsync<SqlException>(() => migrator.MigrateAsync("20261018064742_PowerOfficeInvoiceHistory"))).Number.ShouldBe(51000);
            db.ChangeTracker.Clear();
            (await db.CustomerLedgerEntries.CountAsync()).ShouldBe(1);
            (await db.CustomerLedgerVersions.CountAsync()).ShouldBe(1);
            (await db.Invoices.SingleAsync()).Url.ShouldBe("https://example.invalid/legacy");
        }
        finally
        {
            // Only the database created exclusively by this test is removed.
            await factory.AdminSqlAsync($"ALTER DATABASE [{name}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [{name}];");
        }
    }
}
