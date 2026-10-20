using Crm.Billing.Domain;
using Crm.Billing.Persistence;
using Crm.Integrations.PowerOffice;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace Crm.IntegrationTests;

public sealed partial class PowerOfficeInvoiceHistoryTests
{
    [Fact]
    public async Task Additive_migration_preserves_legacy_invoice_and_movements_and_refuses_lossy_rollback()
    {
        var name = "invoice_history_" + Guid.NewGuid().ToString("N");
        var connectionString = new SqlConnectionStringBuilder(factory.AdminConnectionString) { InitialCatalog = name, Pooling = false }.ConnectionString;
        await factory.AdminSqlAsync($"CREATE DATABASE [{name}];");
        try
        {
            await using var db = new BillingDbContext(new DbContextOptionsBuilder<BillingDbContext>()
                .UseSqlServer(connectionString, sql => sql.MigrationsHistoryTable("__EFMigrationsHistory", "billing")).Options);
            var migrator = db.GetService<IMigrator>();
            await migrator.MigrateAsync("20261005095917_InvoiceBalanceMovements");
            var id = Guid.NewGuid();
            var movementId = Guid.NewGuid();
            await db.Database.ExecuteSqlInterpolatedAsync($"""
                INSERT INTO [billing].[Invoices] ([Id],[System],[InvoiceNo],[InvoiceDate],[TotalIncVat],[Outstanding],[Status],[Url],[SyncedAt],[CreatedAt],[IsDeleted])
                VALUES ({id},N'poweroffice',N'10001','2026-01-01',1250,1000,N'PartiallyPaid',N'https://example.invalid/legacy',SYSUTCDATETIME(),SYSUTCDATETIME(),0);
                INSERT INTO [billing].[InvoicePayments] ([Id],[InvoiceId],[PaidAt],[Amount],[Kind],[Source],[CreatedAt],[IsDeleted])
                VALUES ({movementId},{id},'2026-01-02',250,N'BalanceDecrease',N'Synthetic legacy observation',SYSUTCDATETIME(),0);
                """);
            var version = await db.Database.SqlQuery<byte[]>($"SELECT [RowVersion] AS [Value] FROM [billing].[Invoices] WHERE [Id]={id}").SingleAsync();
            await migrator.MigrateAsync();
            var legacy = await db.Invoices.Include(i => i.Payments).SingleAsync(i => i.Id == id);
            (await db.Database.SqlQuery<byte[]>($"SELECT [RowVersion] AS [Value] FROM [billing].[Invoices] WHERE [Id]={id}").SingleAsync()).ShouldBe(version);
            legacy.Url.ShouldBe("https://example.invalid/legacy");
            legacy.History.ShouldBeNull();
            legacy.Outstanding.ShouldBe(1000m);
            legacy.Payments.ShouldHaveSingleItem().Id.ShouldBe(movementId);
            legacy.Payments.Single().Source.ShouldBe("Synthetic legacy observation");
            db.Database.HasPendingModelChanges().ShouldBeFalse();
            var incoming = PowerOfficeInvoiceMapping.Map(Header(null) with { InvoiceNo = 10001 }, [Line()]);
            db.Invoices.Add(Invoice.From(incoming, null, null, Changed));
            await db.SaveChangesAsync();
            var failure = await Should.ThrowAsync<SqlException>(() => migrator.MigrateAsync("20261005095917_InvoiceBalanceMovements"));
            failure.Number.ShouldBe(51000);
            db.ChangeTracker.Clear();
            (await db.Invoices.CountAsync()).ShouldBe(2);
            (await db.Invoices.SingleAsync(i => i.ExternalId == incoming.History!.ExternalId)).History!.Lines.Count.ShouldBe(1);
        }
        finally
        {
            // This database was created above exclusively for this migration test.
            await factory.AdminSqlAsync($"ALTER DATABASE [{name}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [{name}];");
        }
    }
}
