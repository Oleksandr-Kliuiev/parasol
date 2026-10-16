using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Crm.Authorization;
using Crm.Customers.Persistence;
using Crm.Infrastructure.Persistence;
using Crm.Integrations.Core;
using Crm.Integrations.Core.Persistence;
using Crm.Privacy.Features;
using Crm.Privacy.Persistence;
using Crm.SharedKernel.Documents;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crm.IntegrationTests;

/// <summary>
/// DEV-11-AC06: a database restored from a backup taken before an erasure brings the person back — until the deletion
/// manifest, kept outside the database in the document store, is applied again. Meanwhile the API refuses users and no
/// synchronization runs. A real BACKUP and RESTORE of a database of its own, with a document store of its own, so nothing
/// else in the test run sees the restored state.
/// </summary>
public sealed class PrivacyRestoreTests(CrmWebFactory factory) : IAsyncDisposable
{
    private readonly string _database = $"crm_restore_{Guid.NewGuid():N}"[..24];
    private readonly TestDocumentStore _store = new();

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task AC06_a_restore_from_before_an_erasure_is_held_back_until_the_manifest_from_outside_the_database_is_applied_again()
    {
        var runtime = await CreateDatabaseAsync();
        PrivacyPerson person;
        Guid caseId;
        string number;
        await using (var app = new IsolatedApp(factory, runtime, _store))
        {
            person = await PrivacyTestData.PersonAsync(factory, app);
            await AdminMasterSqlAsync($"BACKUP DATABASE [{_database}] TO DISK = N'/var/opt/mssql/data/{_database}.bak' WITH INIT, COPY_ONLY;");

            var admin = PrivacyTestData.Client(app, CrmRoles.Admin, $"prv-restore-{person.Marker.ToLowerInvariant()}");
            string etag;
            (caseId, etag) = await PrivacyTests.OpenAsync(admin, "Erasure", "Contact", person.ContactId);
            etag = await PrivacyTests.VerifyAsync(admin, caseId, etag);
            var plan = await PrivacyTests.PreviewAsync(admin, caseId, etag);
            number = (await admin.GetFromJsonAsync<JsonElement>($"/api/v1/privacy/cases/{caseId}", Ct)).GetProperty("number").GetString()!;
            (await PrivacyTests.ExecuteRawAsync(admin, caseId, plan.Etag, plan.Digest, number)).StatusCode.ShouldBe(HttpStatusCode.OK);
            (await admin.GetAsync($"/api/v1/customers/contacts/{person.ContactId}", Ct)).StatusCode.ShouldBe(HttpStatusCode.NotFound);
        }

        // The evidence outside the database: ids, actions and keyed hashes — none of the erased data — in the folder of this
        // installation.
        var manifests = new List<(string Key, string Content)>();
        await foreach (var item in _store.ListAsync(PrivacyCaseService.ManifestPrefix, Ct))
        {
            manifests.Add((item.Key, Encoding.UTF8.GetString((await _store.ReadAsync(item.Key, Ct))!)));
        }

        var (manifestKey, manifest) = manifests.ShouldHaveSingleItem();
        manifestKey.ShouldMatch("^privacy/manifests/[0-9a-f]{16}/[0-9a-f]{32}\\.json$");
        manifest.ShouldContain(person.ContactId.ToString());
        foreach (var value in person.PersonalValues)
        {
            manifest.ShouldNotContain(value);
        }

        // Another database's manifest in the same store (a store that outlived its database, or serves two): never replayed here.
        await _store.PutAsync($"{PrivacyCaseService.ManifestPrefix}0000000000000000/{Guid.NewGuid():N}.json", Encoding.UTF8.GetBytes(manifest), "application/json", Ct);

        // The database administrator restores the backup from before the erasure.
        SqlConnection.ClearAllPools();
        await AdminMasterSqlAsync($"""
            ALTER DATABASE [{_database}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
            RESTORE DATABASE [{_database}] FROM DISK = N'/var/opt/mssql/data/{_database}.bak' WITH REPLACE;
            ALTER DATABASE [{_database}] SET MULTI_USER;
            """);

        await using (var app = new IsolatedApp(factory, runtime, _store))
        {
            await using (var scope = app.Services.CreateAsyncScope())
            {
                var contact = await scope.ServiceProvider.GetRequiredService<CustomersDbContext>().Contacts.AsNoTracking().SingleAsync(c => c.Id == person.ContactId, Ct);
                contact.Email.ShouldBe(person.Email, "the restored copy has the person again");

                // Synchronizations wait, and the API answers nobody.
                var held = await scope.ServiceProvider.GetRequiredService<SyncRunner>().RunAsync("atera", "restore-probe", (_, _) => Task.CompletedTask, Ct);
                held.Status.ShouldBe(SyncRunStatus.Skipped);
                held.Message!.ShouldContain("database restore");
            }

            // A user of its own: the one who carried the erasure out came after the backup, so the restored copy has no row for them.
            var admin = PrivacyTestData.Client(app, CrmRoles.Admin, $"prv-restored-{person.Marker.ToLowerInvariant()}");
            var refused = await admin.GetAsync($"/api/v1/customers/contacts/{person.ContactId}", Ct);
            refused.StatusCode.ShouldBe(HttpStatusCode.ServiceUnavailable);
            (await refused.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe("PRIVACY_REPLAY_PENDING");

            // crm-worker applies the manifest again.
            await using (var scope = app.Services.CreateAsyncScope())
            {
                var replayed = await scope.ServiceProvider.GetRequiredService<PrivacyReplayJob>().RunAsync(Ct);
                replayed.Replayed.ShouldBe(1);
                replayed.Records.ShouldBeGreaterThan(0);
                (await scope.ServiceProvider.GetRequiredService<PrivacyReplayJob>().RunAsync(Ct)).Replayed.ShouldBe(0, "applied once");
            }

            (await admin.GetAsync($"/api/v1/customers/contacts/{person.ContactId}", Ct)).StatusCode.ShouldBe(HttpStatusCode.NotFound);

            // The restored sequence has not reached the number the replay brought back: a new request gets the next free one.
            var next = await admin.PostAsJsonAsync("/api/v1/privacy/cases", new { kind = "Access", subjectKind = "Contact", subjectId = person.ColleagueId, channel = "Email" }, Ct);
            next.StatusCode.ShouldBe(HttpStatusCode.Created, await next.Content.ReadAsStringAsync(Ct));
            (await next.ReadJsonAsync()).GetProperty("number").GetString().ShouldNotBe(number);
            var history = await admin.GetFromJsonAsync<JsonElement>($"/api/v1/audit/entities/customers/Contact/{person.ContactId}", Ct);
            history.GetRawText().ShouldNotContain(person.Email);
            var restored = await admin.GetFromJsonAsync<JsonElement>($"/api/v1/privacy/cases/{caseId}", Ct);
            (restored.GetProperty("number").GetString(), restored.GetProperty("status").GetString()).ShouldBe((number, "Completed"));
            await using (var scope = app.Services.CreateAsyncScope())
            {
                var db = scope.ServiceProvider.GetRequiredService<PrivacyDbContext>();
                (await db.ErasureManifests.AsNoTracking().SingleAsync(m => m.CaseId == caseId, Ct)).ReplayedAt.ShouldNotBeNull();
                (await db.Suppressions.AsNoTracking().CountAsync(s => s.CaseId == caseId && s.LiftedAt == null, Ct)).ShouldBe(2, "the suppressions are back");
                var record = await scope.ServiceProvider.GetRequiredService<IntegrationDbContext>().ExternalRecords.AsNoTracking()
                    .SingleAsync(r => r.Id == person.ExternalRecordId, Ct);
                record.Email.ShouldBeNull();
            }
        }
    }

    public async ValueTask DisposeAsync()
    {
        SqlConnection.ClearAllPools();
        await AdminMasterSqlAsync($"""
            IF DB_ID(N'{_database}') IS NOT NULL
            BEGIN
                ALTER DATABASE [{_database}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
                DROP DATABASE [{_database}];
            END
            """);
        if (Directory.Exists(_store.Root))
        {
            Directory.Delete(_store.Root, recursive: true);
        }
    }

    /// <summary>A database of its own, migrated by the migrator like the real one, with a login in crm_worker only.</summary>
    private async Task<string> CreateDatabaseAsync()
    {
        await AdminMasterSqlAsync($"CREATE DATABASE [{_database}];");
        var admin = new SqlConnectionStringBuilder(factory.AdminConnectionString) { InitialCatalog = _database }.ConnectionString;
        await using (var migrator = new IsolatedApp(factory, admin, _store, migrate: true))
        {
            _ = migrator.Server;
        }

        var login = _database;
        var password = $"Rs-{Guid.NewGuid():N}aA1!";
        await using (var connection = new SqlConnection(admin))
        {
            await connection.OpenAsync(Ct);
            await using var command = new SqlCommand($"""
                IF SUSER_ID(N'{login}') IS NULL CREATE LOGIN [{login}] WITH PASSWORD = N'{password}', CHECK_POLICY = OFF;
                IF DATABASE_PRINCIPAL_ID(N'{login}') IS NULL CREATE USER [{login}] FOR LOGIN [{login}];
                {DatabasePermissions.MembershipScript(login, DatabaseRoles.Worker)}
                """, connection);
            await command.ExecuteNonQueryAsync(Ct);
        }

        return new SqlConnectionStringBuilder(factory.AdminConnectionString) { InitialCatalog = _database, UserID = login, Password = password }.ConnectionString;
    }

    private async Task AdminMasterSqlAsync(string sql)
    {
        await using var connection = new SqlConnection(new SqlConnectionStringBuilder(factory.AdminConnectionString) { InitialCatalog = "master" }.ConnectionString);
        await connection.OpenAsync();
        await using var command = new SqlCommand(sql, connection) { CommandTimeout = 120 };
        await command.ExecuteNonQueryAsync();
    }

    /// <summary>crm-web on the isolated database and document store; everything else as the shared test host.</summary>
    private sealed class IsolatedApp(CrmWebFactory factory, string connectionString, IDocumentStore store, bool migrate = false) : WebApplicationFactory<Program>
    {
        protected override void ConfigureWebHost(IWebHostBuilder builder)
        {
            factory.Configure(builder, connectionString, migrate);
            builder.ConfigureTestServices(services => services.AddSingleton<IDocumentStore>(store));
        }
    }
}
