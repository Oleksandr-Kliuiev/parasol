using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crm.Audit.Features;
using Crm.Authorization;
using Crm.Billing.Contracts;
using Crm.Billing.Domain;
using Crm.Billing.Persistence;
using Crm.Infrastructure.Persistence;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using WireMock.Matchers;
using WireMock.RequestBuilders;
using static Crm.IntegrationTests.IntegrationTestHelpers;

namespace Crm.IntegrationTests;

/// <summary>
/// What the application identities may do in SQL Server (DEV-04, docs/runbooks/08-database-permissions.md): the suite runs as
/// a login in crm_worker only; these tests add a crm_web, a crm_privacy and an over-privileged login and try what the roles
/// and the triggers must refuse. Every test bills months of its own (2037–2039).
/// </summary>
[Collection(DatabaseAdministrationCollection.Name)]
public class DatabasePermissionTests(CrmWebFactory factory)
{
    private const string Billing = "/api/v1/billing";
    private const string Contracts = "/api/v1/contracts";
    private static readonly string Password = $"Db-{Guid.NewGuid():N}aA1!";

    private sealed record Customer(Guid OrganizationId, Guid ContractId, Guid ProductId, string Marker);

    private async Task<string> LoginAsync(string login, string role)
    {
        await factory.CreateLoginAsync(login, Password, role);
        return factory.LoginConnectionString(login, Password);
    }

    /// <summary>
    /// An identity as an older version left it: db_datareader and db_datawriter, outside the application roles. The triggers
    /// must hold for it too.
    /// </summary>
    private async Task<string> LegacyWriterAsync()
    {
        const string login = "crm_legacy_writer_test";
        await factory.AdminSqlAsync($"""
            IF SUSER_ID(N'{login}') IS NULL CREATE LOGIN [{login}] WITH PASSWORD = N'{Password}', CHECK_POLICY = OFF;
            IF DATABASE_PRINCIPAL_ID(N'{login}') IS NULL CREATE USER [{login}] FOR LOGIN [{login}];
            ALTER ROLE db_datareader ADD MEMBER [{login}];
            ALTER ROLE db_datawriter ADD MEMBER [{login}];
            """);
        return factory.LoginConnectionString(login, Password);
    }

    /// <summary>Runs one statement and returns the SQL error number, or null when it succeeded.</summary>
    private static async Task<int?> ErrorOfAsync(string connectionString, string sql, params (string Name, object Value)[] parameters)
    {
        try
        {
            await ExecuteAsync(connectionString, sql, parameters);
            return null;
        }
        catch (SqlException ex)
        {
            return ex.Number;
        }
    }

    private static async Task ExecuteAsync(string connectionString, string sql, params (string Name, object Value)[] parameters)
    {
        await using var connection = new SqlConnection(connectionString);
        await connection.OpenAsync();
        await using var command = new SqlCommand(sql, connection);
        foreach (var (name, value) in parameters)
        {
            command.Parameters.AddWithValue(name, value);
        }

        await command.ExecuteNonQueryAsync();
    }

    private static async Task<T?> ScalarAsync<T>(string connectionString, string sql, params (string Name, object Value)[] parameters)
    {
        await using var connection = new SqlConnection(connectionString);
        await connection.OpenAsync();
        await using var command = new SqlCommand(sql, connection);
        foreach (var (name, value) in parameters)
        {
            command.Parameters.AddWithValue(name, value);
        }

        var result = await command.ExecuteScalarAsync();
        return result is null or DBNull ? default : (T)result;
    }

    private async Task<Customer> CustomerAsync(HttpClient admin, HttpClient finance, DateOnly start, decimal fee)
    {
        var marker = $"P{Guid.NewGuid():N}"[..10];
        var organizationId = await admin.CreateOrganizationAsync(new { name = $"{marker} Rettigheter AS", status = "Customer" });
        var productId = await CatalogApiTests.CreateProductAsync(finance, CatalogApiTests.Product(CatalogApiTests.Sku("DBP"), "Managed services", fee, decimal.Round(fee / 2, 2)));
        var contractId = (await (await admin.PostAsJsonAsync(Contracts, new
        {
            organizationId, title = $"{marker} Drift", type = "Msp", startDate = start, endDate = start.AddMonths(1).AddDays(-1), autoRenew = false,
            renewalTermMonths = 0, noticePeriodDays = 30, invoiceFrequency = "Monthly", invoiceTiming = "InAdvance", indexation = false,
        })).ReadJsonAsync()).GetProperty("id").GetGuid();
        (await admin.PostAsJsonAsync($"{Contracts}/{contractId}/lines", new { productId, quantityModel = "Fixed", quantity = 1m, unitPrice = fee, validFrom = start }))
            .StatusCode.ShouldBe(HttpStatusCode.OK);
        (await admin.PostAsync($"{Contracts}/{contractId}/activate", null)).StatusCode.ShouldBe(HttpStatusCode.OK);
        BillingApiTests.StubToken(factory);
        await BillingApiTests.LinkAsync(admin, "Organization", organizationId, "Customer", TestExternalIds.Next(700_000, 799_999));
        await BillingApiTests.LinkAsync(admin, "Product", productId, "Product", TestExternalIds.Next(10_000, 99_999));
        return new Customer(organizationId, contractId, productId, marker);
    }

    private static async Task<(Guid RunId, Guid BasisId)> CollectedAsync(HttpClient finance, DateOnly period, Customer customer)
    {
        var created = await finance.PostAsJsonAsync($"{Billing}/runs", new { year = period.Year, month = period.Month, notes = customer.Marker });
        created.StatusCode.ShouldBe(HttpStatusCode.Created, await created.Content.ReadAsStringAsync());
        var runId = (await created.ReadJsonAsync()).GetProperty("id").GetGuid();
        (await finance.RunCommandAsync(runId, "collect")).StatusCode.ShouldBe(HttpStatusCode.OK);
        var basis = (await finance.GetFromJsonAsync<JsonElement>($"{Billing}/runs/{runId}/bases?search={customer.Marker}")).EnumerateArray()
            .Single(b => b.GetProperty("organization").GetProperty("id").GetGuid() == customer.OrganizationId);
        return (runId, basis.GetProperty("id").GetGuid());
    }

    [Fact]
    public async Task AC01_the_runtime_roles_insert_audit_but_cannot_rewrite_it_or_change_the_schema()
    {
        var worker = factory.RuntimeConnectionString;
        var web = await LoginAsync("crm_web_test", DatabaseRoles.Web);
        const string insertAudit = """
            INSERT INTO audit.AuditEntries ([At], [Action], [Module], [EntityType], [EntityId], [CorrelationId])
            VALUES (SYSDATETIMEOFFSET(), N'Create', N'customers', N'PermissionProbe', NEWID(), N'dev04-ac01');
            """;

        foreach (var (name, connection) in new[] { ("crm_worker", worker), ("crm_web", web) })
        {
            // The audit trail is written with the business change and never rewritten by the application.
            (await ErrorOfAsync(connection, insertAudit)).ShouldBeNull(name);
            (await ErrorOfAsync(connection, "UPDATE audit.AuditEntries SET [Action] = N'Changed' WHERE [CorrelationId] = N'dev04-ac01';")).ShouldBe(229, name);
            (await ErrorOfAsync(connection, "DELETE FROM audit.AuditEntries WHERE [CorrelationId] = N'dev04-ac01';")).ShouldBe(229, name);

            // No DDL, no security changes, no migration history, no switching the triggers off.
            (await ErrorOfAsync(connection, "CREATE TABLE billing.Probe (Id int);")).ShouldBe(262, name);
            (await ErrorOfAsync(connection, "ALTER TABLE billing.BillingLines ADD Probe int NULL;")).ShouldBeOneOf([1088, 4902], name);
            (await ErrorOfAsync(connection, "DROP TABLE billing.BillingLines;")).ShouldBe(3701, name);
            (await ErrorOfAsync(connection, "DISABLE TRIGGER [billing].[trg_BillingLines_Protect] ON [billing].[BillingLines];")).ShouldBe(1088, name);
            (await ErrorOfAsync(connection, "DISABLE TRIGGER [audit].[trg_AuditEntries_AppendOnly] ON [audit].[AuditEntries];")).ShouldBe(1088, name);
            (await ErrorOfAsync(connection, "ALTER ROLE db_datawriter ADD MEMBER [crm_worker_test];")).ShouldBe(15151, name);
            (await ErrorOfAsync(connection, "GRANT DELETE ON SCHEMA::billing TO [crm_web];")).ShouldBeOneOf([4613, 15151, 15247], name);
            (await ErrorOfAsync(connection, "INSERT INTO billing.__EFMigrationsHistory (MigrationId, ProductVersion) VALUES (N'Probe', N'0');")).ShouldBe(229, name);
            (await ErrorOfAsync(connection, "INSERT INTO audit.RetentionPolicies (Module, RetainDays, ApprovedBy, ApprovedAt) VALUES (N'customers', 30, N'probe', SYSDATETIMEOFFSET());")).ShouldBe(229, name);
            (await ErrorOfAsync(connection, "EXEC audit.ApplyRetention @Module = N'customers', @Before = '2000-01-01';")).ShouldBe(229, name);
            (await ScalarAsync<int>(connection, "SELECT IS_ROLEMEMBER('db_datawriter') + IS_ROLEMEMBER('db_owner') + IS_ROLEMEMBER('db_ddladmin');")).ShouldBe(0, name);
        }

        // The web host never processes the outbox and never adds integrity checkpoints; the worker does both.
        const string claimOutbox = "UPDATE billing.OutboxMessages SET LockedUntil = LockedUntil WHERE 1 = 0;";
        (await ErrorOfAsync(web, claimOutbox)).ShouldBe(229);
        (await ErrorOfAsync(worker, claimOutbox)).ShouldBeNull();
        const string checkpoint = "INSERT INTO audit.IntegrityCheckpoints (FromId, ToId, Entries, ChainHash, CreatedAt) VALUES (-2, -1, 0, REPLICATE(N'0', 64), SYSDATETIMEOFFSET());";
        (await ErrorOfAsync(web, checkpoint)).ShouldBe(229);
        (await ErrorOfAsync(worker, "UPDATE audit.IntegrityCheckpoints SET Entries = Entries WHERE 1 = 0;")).ShouldBe(229);

        // DEV-07: only the worker handles messages, so only it writes receipts; the web host files replay requests and the
        // worker alone marks them applied — the web host can neither fake that nor take a request back.
        const string receipt = "INSERT INTO billing.InboxReceipts (MessageId, Handler, ProcessedAt) VALUES (NEWID(), N'PermissionProbe', SYSDATETIMEOFFSET());";
        (await ErrorOfAsync(web, receipt)).ShouldBe(229);
        (await ErrorOfAsync(worker, receipt)).ShouldBeNull();
        (await ErrorOfAsync(web, "DELETE FROM billing.InboxReceipts WHERE 1 = 0;")).ShouldBe(229);
        const string request = "INSERT INTO billing.OutboxReplayRequests (Id, MessageIds, Expected, Reason, RequestedAt) VALUES (NEWID(), N'', 0, N'permission probe', SYSDATETIMEOFFSET());";
        (await ErrorOfAsync(web, request)).ShouldBeNull();
        (await ErrorOfAsync(web, "UPDATE billing.OutboxReplayRequests SET AppliedAt = SYSDATETIMEOFFSET() WHERE 1 = 0;")).ShouldBe(229);
        (await ErrorOfAsync(web, "DELETE FROM billing.OutboxReplayRequests WHERE 1 = 0;")).ShouldBe(229);
        (await ErrorOfAsync(worker, "UPDATE billing.OutboxReplayRequests SET AppliedAt = AppliedAt WHERE 1 = 0;")).ShouldBeNull();
    }

    [Fact]
    public async Task AC01_an_identity_of_the_application_does_not_get_a_broad_role_back_on_a_rollback()
    {
        // What the migrator of the previous version did on every run (ALTER ROLE db_datawriter ADD MEMBER <app identity>) fails
        // now, for every application role, instead of quietly widening the rights again.
        var privacy = await LoginAsync("crm_privacy_rollback_test", DatabaseRoles.Privacy);
        foreach (var broad in new[] { "db_datawriter", "db_datareader", "db_owner", "db_ddladmin" })
        {
            var refused = await Should.ThrowAsync<SqlException>(() => factory.AdminSqlAsync($"ALTER ROLE [{broad}] ADD MEMBER [crm_worker_test];"));
            refused.Number.ShouldBe(51031);
            refused.Message.ShouldContain("APPLICATION_ROLE_STAYS_NARROW");
        }

        (await Should.ThrowAsync<SqlException>(() => factory.AdminSqlAsync("ALTER ROLE [db_datawriter] ADD MEMBER [crm_privacy_rollback_test];"))).Number.ShouldBe(51031);
        (await ScalarAsync<int>(factory.RuntimeConnectionString, "SELECT IS_ROLEMEMBER('db_datawriter') + IS_ROLEMEMBER('db_datareader');")).ShouldBe(0);
        (await ScalarAsync<int>(privacy, "SELECT IS_ROLEMEMBER('crm_privacy');")).ShouldBe(1);
    }

    [Fact]
    public async Task AC02_approved_lines_amounts_and_history_refuse_direct_SQL_while_export_progress_and_the_order_number_are_recorded()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "dbperm-admin");
        var finance = factory.ClientAs(CrmRoles.Finance, userKey: "dbperm-finance");
        var period = new DateOnly(2037, 1, 1);
        var customer = await CustomerAsync(admin, finance, period, 3_000m);
        var (runId, basisId) = await CollectedAsync(finance, period, customer);
        (await (await finance.RunCommandAsync(runId, "approve")).ReadJsonAsync()).GetProperty("status").GetString().ShouldBe("Approved");

        var app = factory.RuntimeConnectionString;
        (string, object)[] basis = [("@basis", basisId)];
        (string, object)[] run = [("@run", runId)];

        // The child rows: no line of an approved basis is changed, added or removed.
        (await ErrorOfAsync(app, "UPDATE billing.BillingLines SET UnitPrice = 1, LineTotal = 1 WHERE BasisId = @basis;", basis)).ShouldBe(51004);
        (await ErrorOfAsync(app, """
            INSERT INTO billing.BillingLines (Id, BasisId, [Group], Description, Quantity, UnitPrice, DiscountPct, VatRate, LineTotal, ManuallyAdjusted, CreatedAt, IsDeleted)
            VALUES (NEWID(), @basis, N'OneOff', N'Added behind the application', 1, 999, 0, 25, 999, 1, SYSDATETIMEOFFSET(), 0);
            """, basis)).ShouldBe(51004);
        (await ErrorOfAsync(app, "DELETE FROM billing.BillingLines WHERE BasisId = @basis;", basis)).ShouldBe(229);

        // The basis: amounts and payer are fixed, it never goes back to a draft and is never deleted.
        (await ErrorOfAsync(app, "UPDATE billing.BillingBases SET TotalExVat = 1 WHERE Id = @basis;", basis)).ShouldBe(51003);
        (await ErrorOfAsync(app, "UPDATE billing.BillingBases SET Status = N'Draft' WHERE Id = @basis;", basis)).ShouldBe(51003);
        (await ErrorOfAsync(app, "UPDATE billing.BillingBases SET OrganizationId = NEWID() WHERE Id = @basis;", basis)).ShouldBe(51003);
        (await ErrorOfAsync(app, "DELETE FROM billing.BillingBases WHERE Id = @basis;", basis)).ShouldBe(229);

        // The run, its approval acts and the charges keep what was approved.
        (await ErrorOfAsync(app, "UPDATE billing.BillingRuns SET ApprovedDigest = REPLICATE(N'0', 64) WHERE Id = @run;", run)).ShouldBe(51001);
        (await ErrorOfAsync(app, "UPDATE billing.BillingRuns SET Status = N'Collected' WHERE Id = @run;", run)).ShouldBe(51001);
        (await ErrorOfAsync(app, "UPDATE billing.BillingApprovals SET ContentDigest = REPLICATE(N'0', 64) WHERE RunId = @run;", run)).ShouldBe(51005);
        (await ErrorOfAsync(app, "DELETE FROM billing.BillingApprovals WHERE RunId = @run;", run)).ShouldBe(229);
        (await ErrorOfAsync(app, "UPDATE billing.Charges SET Amount = 1 WHERE BasisId = @basis;", basis)).ShouldBe(51007);
        (await ErrorOfAsync(app, "UPDATE billing.Charges SET Status = N'Reserved' WHERE BasisId = @basis;", basis)).ShouldBe(51007);

        // The transport is the application's to record: the send, the attempt and the order number go through.
        factory.PowerOffice.Given(Request.Create().WithPath("/v2/SalesOrders").UsingPost().WithBody(new WildcardMatcher($"*{customer.OrganizationId:N}*")))
            .AtPriority(1)
            .RespondWith(JsonReply(new { Id = 97_001, OrderNo = 97_001, CustomerId = 1, Status = "Draft" }));
        (await factory.WaitForRunExportAsync(finance, runId)).ShouldBeOneOf("Exported", "ExportedWithErrors");
        var exported = await finance.GetFromJsonAsync<JsonElement>($"{Billing}/bases/{basisId}");
        exported.GetProperty("status").GetString().ShouldBe("Exported");
        exported.GetProperty("orderNo").GetString().ShouldBe("97001");
        (await ScalarAsync<int>(factory.AdminConnectionString, "SELECT COUNT(*) FROM billing.BillingExportAttempts WHERE BasisId = @basis;", basis)).ShouldBeGreaterThan(0);

        // Once exported, the order number stays and the export log is only added to.
        (await ErrorOfAsync(app, "UPDATE billing.BillingBases SET OrderNo = N'1' WHERE Id = @basis;", basis)).ShouldBe(51003);
        (await ErrorOfAsync(app, "UPDATE billing.BillingBases SET Status = N'Approved' WHERE Id = @basis;", basis)).ShouldBe(51003);
        (await ErrorOfAsync(app, "UPDATE billing.BillingExportAttempts SET Message = N'rewritten' WHERE BasisId = @basis;", basis)).ShouldBe(229);
        (await ErrorOfAsync(app, "DELETE FROM billing.BillingExportAttempts WHERE BasisId = @basis;", basis)).ShouldBe(229);
        (await ErrorOfAsync(app, "UPDATE billing.Charges SET Status = N'Released' WHERE BasisId = @basis;", basis)).ShouldBe(51007);
    }

    [Fact]
    public async Task AC02_the_triggers_hold_for_an_identity_that_still_has_db_datawriter_including_cascades()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "dbperm-admin");
        var finance = factory.ClientAs(CrmRoles.Finance, userKey: "dbperm-finance");
        var period = new DateOnly(2037, 4, 1);
        var customer = await CustomerAsync(admin, finance, period, 2_000m);
        var (runId, basisId) = await CollectedAsync(finance, period, customer);
        (await (await finance.RunCommandAsync(runId, "approve")).ReadJsonAsync()).GetProperty("status").GetString().ShouldBe("Approved");
        var legacy = await LegacyWriterAsync();
        (string, object)[] basis = [("@basis", basisId)];

        (await ErrorOfAsync(legacy, "DELETE FROM billing.BillingLines WHERE BasisId = @basis;", basis)).ShouldBe(51004);
        // Deleting the basis cascades to its lines and export attempts; the whole statement is refused.
        (await ErrorOfAsync(legacy, "DELETE FROM billing.BillingBases WHERE Id = @basis;", basis)).ShouldBeOneOf([51003, 51004]);
        (await ErrorOfAsync(legacy, "DELETE FROM billing.BillingApprovals WHERE RunId = @run;", ("@run", runId))).ShouldBe(51005);
        (await ErrorOfAsync(legacy, "DELETE FROM billing.Charges WHERE BasisId = @basis;", basis)).ShouldBe(51007);
        (await ErrorOfAsync(legacy, "UPDATE audit.AuditEntries SET [Action] = N'Changed' WHERE EntityId = @basis;", basis)).ShouldBe(51011);
        (await ErrorOfAsync(legacy, "DELETE FROM audit.AuditEntries WHERE EntityId = @basis;", basis)).ShouldBe(51010);

        (await ScalarAsync<int>(factory.AdminConnectionString, "SELECT COUNT(*) FROM billing.BillingLines WHERE BasisId = @basis;", basis)).ShouldBeGreaterThan(0);
        (await finance.GetFromJsonAsync<JsonElement>($"{Billing}/bases/{basisId}")).GetProperty("totalExVat").GetDecimal().ShouldBe(2_000m);
    }

    [Fact]
    public async Task AC03_entity_framework_saves_through_the_triggers_and_keeps_its_concurrency_checks()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "dbperm-admin");
        var finance = factory.ClientAs(CrmRoles.Finance, userKey: "dbperm-finance");
        var period = new DateOnly(2038, 2, 1);
        var customer = await CustomerAsync(admin, finance, period, 1_500m);
        var (_, basisId) = await CollectedAsync(finance, period, customer);

        // A draft is the application's to change: EF Core reads the new row version back through the trigger (no OUTPUT
        // without INTO), and the next save with the old version is a concurrency conflict, not a silent overwrite.
        await using var first = factory.Services.CreateAsyncScope();
        await using var second = factory.Services.CreateAsyncScope();
        var a = first.ServiceProvider.GetRequiredService<BillingDbContext>();
        var b = second.ServiceProvider.GetRequiredService<BillingDbContext>();
        var basisA = await a.BillingBases.SingleAsync(x => x.Id == basisId);
        var basisB = await b.BillingBases.SingleAsync(x => x.Id == basisId);
        var versionBefore = (byte[])a.Entry(basisA).Property(ModuleDbContext.RowVersionProperty).CurrentValue!;

        a.Entry(basisA).Property(x => x.CustomerReference).CurrentValue = "PO-4711";
        await a.SaveChangesAsync();
        var versionAfter = (byte[])a.Entry(basisA).Property(ModuleDbContext.RowVersionProperty).CurrentValue!;
        versionAfter.ShouldNotBe(versionBefore);

        b.Entry(basisB).Property(x => x.CustomerReference).CurrentValue = "PO-0815";
        await Should.ThrowAsync<DbUpdateConcurrencyException>(() => b.SaveChangesAsync());

        // A new row on a table with an insert trigger: EF gets its generated values back.
        var charge = Charge.Reserve(
            new ChargeClaim($"dev04:{Guid.NewGuid():N}", ChargeKind.OneOff, 10m, ServiceFrom: period, ServiceTo: period),
            customer.OrganizationId, basisA, Guid.NewGuid(), DateTimeOffset.UtcNow);
        a.Charges.Add(charge);
        await a.SaveChangesAsync();
        ((byte[])a.Entry(charge).Property(ModuleDbContext.RowVersionProperty).CurrentValue!).Length.ShouldBe(8);
        a.Entry(charge).Property(x => x.Amount).CurrentValue = 12m;
        await a.SaveChangesAsync();
        (await ScalarAsync<decimal>(factory.AdminConnectionString, "SELECT Amount FROM billing.Charges WHERE Id = @id;", ("@id", charge.Id))).ShouldBe(12m);
        charge.Release(DateTimeOffset.UtcNow, "Test charge of DEV-04-AC03.").IsSuccess.ShouldBeTrue();
        await a.SaveChangesAsync();
    }

    [Fact]
    public async Task AC04_the_audit_entry_and_the_business_change_are_saved_together_or_not_at_all()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "dbperm-admin");
        var finance = factory.ClientAs(CrmRoles.Finance, userKey: "dbperm-finance");
        var period = new DateOnly(2038, 6, 1);
        var customer = await CustomerAsync(admin, finance, period, 1_200m);
        var (runId, draftId) = await CollectedAsync(finance, period, customer);
        (string, object)[] draft = [("@id", draftId)];
        const string audits = "SELECT COUNT(*) FROM audit.AuditEntries WHERE EntityId = @id;";
        Task<int> AuditsOfAsync(Guid id) => ScalarAsync<int>(factory.AdminConnectionString, audits, ("@id", id));

        // The audit insert fails (a login denied it): the business change goes with it.
        var noAudit = await LoginAsync("crm_noaudit_test", DatabaseRoles.Worker);
        await factory.AdminSqlAsync("DENY INSERT ON OBJECT::[audit].[AuditEntries] TO [crm_noaudit_test];");
        var before = await AuditsOfAsync(draftId);
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            await using var db = new BillingDbContext(new DbContextOptionsBuilder<BillingDbContext>()
                .UseSqlServer(noAudit)
                .AddInterceptors(scope.ServiceProvider.GetRequiredService<AuditingInterceptor>())
                .Options);
            var basis = await db.BillingBases.SingleAsync(x => x.Id == draftId);
            db.Entry(basis).Property(x => x.CustomerReference).CurrentValue = "LOST-WITH-ITS-AUDIT";
            (await Should.ThrowAsync<DbUpdateException>(() => db.SaveChangesAsync())).GetBaseException().ShouldBeOfType<SqlException>().Number.ShouldBe(229);
        }

        (await ScalarAsync<string>(factory.AdminConnectionString, "SELECT CustomerReference FROM billing.BillingBases WHERE Id = @id;", draft)).ShouldNotBe("LOST-WITH-ITS-AUDIT");
        (await AuditsOfAsync(draftId)).ShouldBe(before);

        // The business change is refused (an approved basis): its audit entry is not written either.
        (await (await finance.RunCommandAsync(runId, "approve")).ReadJsonAsync()).GetProperty("status").GetString().ShouldBe("Approved");
        before = await AuditsOfAsync(draftId);
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<BillingDbContext>();
            var basis = await db.BillingBases.SingleAsync(x => x.Id == draftId);
            db.Entry(basis).Property(x => x.TotalExVat).CurrentValue = 1m;
            (await Should.ThrowAsync<DbUpdateException>(() => db.SaveChangesAsync())).GetBaseException().ShouldBeOfType<SqlException>().Number.ShouldBe(51003);
        }

        (await ScalarAsync<decimal>(factory.AdminConnectionString, "SELECT TotalExVat FROM billing.BillingBases WHERE Id = @id;", draft)).ShouldBe(1_200m);
        (await AuditsOfAsync(draftId)).ShouldBe(before);

        // And an allowed change — the export moving the run on — writes both.
        before = await AuditsOfAsync(runId);
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<BillingDbContext>();
            var run = await db.BillingRuns.SingleAsync(x => x.Id == runId);
            db.Entry(run).Property(x => x.Status).CurrentValue = BillingRunStatus.Exporting;
            await db.SaveChangesAsync();
        }

        (await AuditsOfAsync(runId)).ShouldBe(before + 1);
        (await ScalarAsync<string>(factory.AdminConnectionString, "SELECT Status FROM billing.BillingRuns WHERE Id = @id;", ("@id", runId))).ShouldBe("Exporting");
    }

    [Fact]
    public async Task AC06_retention_removes_only_the_personal_part_under_an_approved_policy_and_never_touches_financial_evidence()
    {
        var privacy = await LoginAsync("crm_privacy_test", DatabaseRoles.Privacy);
        var marker = $"ret-{Guid.NewGuid():N}"[..16];
        var old = DateTimeOffset.UtcNow.AddDays(-500);
        var recent = DateTimeOffset.UtcNow.AddDays(-20);
        await factory.AdminSqlAsync($$"""
            INSERT INTO audit.AuditEntries ([At], [UserId], [UserName], [Action], [Module], [EntityType], [EntityId], [Changes], [CorrelationId], [IpAddress])
            VALUES ('{{old:O}}', NEWID(), N'Kari Nordmann', N'Update', N'customers', N'Contact', NEWID(), N'{"email":"kari@example.no"}', N'{{marker}}', N'10.0.0.7'),
                   ('{{old:O}}', NEWID(), N'Ola Nordmann', N'Update', N'customers', N'Contact', NEWID(), N'{"phone":"+47 400 00 000"}', N'{{marker}}', N'10.0.0.8'),
                   ('{{recent:O}}', NEWID(), N'Kari Nordmann', N'Update', N'customers', N'Contact', NEWID(), N'{"email":"kari@example.no"}', N'{{marker}}', N'10.0.0.7'),
                   ('{{old:O}}', NEWID(), N'Finance User', N'Update', N'billing', N'BillingBasis', NEWID(), N'{"totalExVat":1000}', N'{{marker}}', N'10.0.0.9'),
                   ('{{old:O}}', NEWID(), N'Finance User', N'Update', N'time', N'TimeEntry', NEWID(), N'{"hours":2}', N'{{marker}}', N'10.0.0.9');
            """);
        var before = DateTimeOffset.UtcNow.AddDays(-400);

        // A dry run counts and changes nothing; without an approved policy nothing else is possible (DEC-03).
        var dry = await RetentionAsync(privacy, "customers", before, dryRun: true);
        dry.Entries.ShouldBeGreaterThanOrEqualTo(2);
        (await RetentionErrorAsync(privacy, "customers", before, dryRun: false)).ShouldBe(51021);
        (await PersonalCountAsync(marker, "customers")).ShouldBe(3);

        // Financial evidence is out of reach whatever is asked, and no policy can be approved for it.
        foreach (var module in new[] { "billing", "Billing", "time", "contracts", "sales", "projects", "catalog", "licensing", "audit" })
        {
            (await RetentionErrorAsync(privacy, module, before, dryRun: true)).ShouldBe(51020, module);
        }

        (await Should.ThrowAsync<SqlException>(() => factory.AdminSqlAsync(
            "INSERT INTO audit.RetentionPolicies (Module, RetainDays, ApprovedBy, ApprovedAt, Reference) VALUES (N'billing', 3650, N'Data owner (test)', SYSDATETIMEOFFSET(), N'DEC-03');"))).Number.ShouldBe(547);

        // Once the data owner's policy is recorded (by the administrator, never by the application), the privacy operator
        // removes the personal part of old entries; the fact of each action stays, newer entries are kept.
        await factory.AdminSqlAsync("""
            IF NOT EXISTS (SELECT 1 FROM audit.RetentionPolicies WHERE Module = N'customers')
            INSERT INTO audit.RetentionPolicies (Module, RetainDays, ApprovedBy, ApprovedAt, Reference) VALUES (N'customers', 365, N'Data owner (test)', SYSDATETIMEOFFSET(), N'DEC-03 test');
            """);
        (await RetentionErrorAsync(privacy, "customers", DateTimeOffset.UtcNow.AddDays(-100), dryRun: false)).ShouldBe(51022);
        var applied = await RetentionAsync(privacy, "customers", before, dryRun: false);
        applied.Entries.ShouldBeGreaterThanOrEqualTo(2);

        (await PersonalCountAsync(marker, "customers")).ShouldBe(1);
        (await PersonalCountAsync(marker, "billing")).ShouldBe(1);
        (await PersonalCountAsync(marker, "time")).ShouldBe(1);
        (await ScalarAsync<int>(factory.AdminConnectionString, """
            SELECT COUNT(*) FROM audit.AuditEntries
            WHERE CorrelationId = @marker AND Module = N'customers' AND [Action] = N'Update' AND EntityType = N'Contact' AND [At] < @before
              AND UserId IS NULL AND UserName IS NULL AND IpAddress IS NULL AND Changes IS NULL
            """, ("@marker", marker), ("@before", before))).ShouldBe(2);
        (await ScalarAsync<int>(factory.AdminConnectionString,
            "SELECT COUNT(*) FROM audit.AuditEntries WHERE Module = N'audit' AND [Action] = N'Retention' AND Changes LIKE N'%\"module\":\"customers\"%' AND UserName = N'crm_privacy_test';"))
            .ShouldBe(1);

        // The operator has the procedure and nothing else.
        (await ErrorOfAsync(privacy, "SELECT TOP 1 UserName FROM audit.AuditEntries;")).ShouldBe(229);
        (await ErrorOfAsync(privacy, "UPDATE audit.AuditEntries SET UserName = NULL WHERE CorrelationId = @m;", ("@m", marker))).ShouldBe(229);
        (await ErrorOfAsync(privacy, "SELECT TOP 1 Id FROM billing.BillingBases;")).ShouldBe(229);
    }

    private sealed record RetentionResult(string Module, int Entries, bool DryRun);

    private static async Task<RetentionResult> RetentionAsync(string connectionString, string module, DateTimeOffset before, bool dryRun)
    {
        await using var connection = new SqlConnection(connectionString);
        await connection.OpenAsync();
        await using var command = new SqlCommand("EXEC audit.ApplyRetention @Module = @module, @Before = @before, @DryRun = @dryRun;", connection);
        command.Parameters.AddWithValue("@module", module);
        command.Parameters.AddWithValue("@before", before);
        command.Parameters.AddWithValue("@dryRun", dryRun);
        await using var reader = await command.ExecuteReaderAsync();
        (await reader.ReadAsync()).ShouldBeTrue();
        return new RetentionResult(reader.GetString(0), reader.GetInt32(2), reader.GetBoolean(3));
    }

    private static async Task<int?> RetentionErrorAsync(string connectionString, string module, DateTimeOffset before, bool dryRun)
    {
        try
        {
            await RetentionAsync(connectionString, module, before, dryRun);
            return null;
        }
        catch (SqlException ex)
        {
            return ex.Number;
        }
    }

    private Task<int> PersonalCountAsync(string marker, string module) => ScalarAsync<int>(factory.AdminConnectionString,
        "SELECT COUNT(*) FROM audit.AuditEntries WHERE CorrelationId = @marker AND Module = @module AND (UserName IS NOT NULL OR IpAddress IS NOT NULL OR Changes IS NOT NULL);",
        ("@marker", marker), ("@module", module));

    [Fact]
    public async Task The_integrity_job_chains_the_trail_finds_a_rewritten_entry_and_is_not_disturbed_by_retention()
    {
        // A baseline, then an entry with personal data that the next checkpoint chains as it is.
        (await IntegrityAsync()).Intact.ShouldBeTrue();
        var marker = $"chain-{Guid.NewGuid():N}"[..18];
        await factory.AdminSqlAsync($$"""
            INSERT INTO audit.AuditEntries ([At], [UserId], [UserName], [Action], [Module], [EntityType], [EntityId], [Changes], [CorrelationId], [IpAddress])
            VALUES ('{{DateTimeOffset.UtcNow.AddDays(-800):O}}', NEWID(), N'Kari Nordmann', N'Create', N'activities', N'Activity', NEWID(), N'{"subject":"Møte"}', N'{{marker}}', N'10.0.0.7');
            """);
        var entryId = await ScalarAsync<long>(factory.AdminConnectionString, "SELECT Id FROM audit.AuditEntries WHERE CorrelationId = @m;", ("@m", marker));
        var chained = await IntegrityAsync();
        chained.Intact.ShouldBeTrue(chained.Mismatch);
        chained.Added.ShouldNotBeNull();
        entryId.ShouldBeInRange(chained.Added!.FromId, chained.Added.ToId);

        // Retention removes the personal part only: rechecking that checkpoint (now the newest) still matches.
        var privacy = await LoginAsync("crm_privacy_chain_test", DatabaseRoles.Privacy);
        await factory.AdminSqlAsync("""
            IF NOT EXISTS (SELECT 1 FROM audit.RetentionPolicies WHERE Module = N'activities')
            INSERT INTO audit.RetentionPolicies (Module, RetainDays, ApprovedBy, ApprovedAt, Reference) VALUES (N'activities', 730, N'Data owner (test)', SYSDATETIMEOFFSET(), N'DEC-03 test');
            """);
        (await RetentionAsync(privacy, "activities", DateTimeOffset.UtcNow.AddDays(-750), dryRun: false)).Entries.ShouldBeGreaterThanOrEqualTo(1);
        (await ScalarAsync<string>(factory.AdminConnectionString, "SELECT UserName FROM audit.AuditEntries WHERE Id = @id;", ("@id", entryId))).ShouldBeNull();
        var afterRetention = await IntegrityAsync();
        afterRetention.Intact.ShouldBeTrue(afterRetention.Mismatch);
        afterRetention.Added.ShouldNotBeNull("the retention run is itself an audit entry");

        // An administrator who switches the trigger off and rewrites a fact is found: by the full check in any checkpoint,
        // by the nightly run in the newest one.
        await RewriteAsync(entryId, "Delete");
        try
        {
            var full = await VerifyAllAsync();
            full.Intact.ShouldBeFalse();
            full.Mismatch!.ShouldContain($"no longer match checkpoint {chained.Added.Id}");
        }
        finally
        {
            await RewriteAsync(entryId, "Create");
        }

        var retentionEntry = afterRetention.Added!.ToId;
        await RewriteAsync(retentionEntry, "Update");
        try
        {
            var nightly = await IntegrityAsync();
            nightly.Intact.ShouldBeFalse();
            nightly.Added.ShouldBeNull();
        }
        finally
        {
            await RewriteAsync(retentionEntry, "Retention");
        }

        (await VerifyAllAsync()).Intact.ShouldBeTrue();
    }

    [Fact]
    public async Task The_integrity_job_leaves_entries_younger_than_the_settle_time_for_its_next_run()
    {
        (await IntegrityAsync()).Intact.ShouldBeTrue();
        var marker = $"settle-{Guid.NewGuid():N}"[..19];
        await factory.AdminSqlAsync($$"""
            INSERT INTO audit.AuditEntries ([At], [Action], [Module], [EntityType], [EntityId], [CorrelationId])
            VALUES ('{{DateTimeOffset.UtcNow.AddDays(-1):O}}', N'Create', N'customers', N'Organization', NEWID(), N'{{marker}}');
            INSERT INTO audit.AuditEntries ([At], [Action], [Module], [EntityType], [EntityId], [CorrelationId])
            VALUES (SYSDATETIMEOFFSET(), N'Update', N'customers', N'Organization', NEWID(), N'{{marker}}');
            """);
        var ids = new List<long>();
        await using (var connection = new SqlConnection(factory.AdminConnectionString))
        {
            await connection.OpenAsync();
            await using var command = new SqlCommand("SELECT Id FROM audit.AuditEntries WHERE CorrelationId = @m ORDER BY Id;", connection);
            command.Parameters.AddWithValue("@m", marker);
            await using var reader = await command.ExecuteReaderAsync();
            while (await reader.ReadAsync())
            {
                ids.Add(reader.GetInt64(0));
            }
        }

        // With ten minutes to settle, the fresh entry — and anything after it — waits; the older one is chained.
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var patient = ActivatorUtilities.CreateInstance<AuditIntegrityJob>(
                scope.ServiceProvider, Microsoft.Extensions.Options.Options.Create(new AuditIntegrityOptions { SettleTime = TimeSpan.FromMinutes(10) }));
            var result = await patient.RunAsync(CancellationToken.None);
            result.Added.ShouldNotBeNull();
            result.Added!.ToId.ShouldBe(ids[0]);
        }

        var later = await IntegrityAsync();
        later.Added.ShouldNotBeNull();
        later.Added!.FromId.ShouldBe(ids[1]);
        (await VerifyAllAsync()).Intact.ShouldBeTrue();
    }

    private async Task<AuditIntegrityResult> VerifyAllAsync()
    {
        await using var scope = factory.Services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<AuditIntegrityJob>().VerifyAllAsync(CancellationToken.None);
    }

    private async Task<AuditIntegrityResult> IntegrityAsync()
    {
        await using var scope = factory.Services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<AuditIntegrityJob>().RunAsync(CancellationToken.None);
    }

    private Task RewriteAsync(long entryId, string action) => factory.AdminSqlAsync($"""
        BEGIN TRANSACTION;
        DISABLE TRIGGER [audit].[trg_AuditEntries_AppendOnly] ON [audit].[AuditEntries];
        UPDATE audit.AuditEntries SET [Action] = N'{action}' WHERE Id = {entryId};
        ENABLE TRIGGER [audit].[trg_AuditEntries_AppendOnly] ON [audit].[AuditEntries];
        COMMIT;
        """);
}
