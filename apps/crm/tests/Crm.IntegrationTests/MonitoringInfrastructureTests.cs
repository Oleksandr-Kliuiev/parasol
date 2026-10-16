using System.Collections.Concurrent;
using System.Diagnostics.Metrics;
using Crm.Infrastructure.Persistence;
using Crm.Integrations.Core.Persistence;
using Crm.Worker;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

namespace Crm.IntegrationTests;

[Collection(DatabaseAdministrationCollection.Name)]
public sealed class MonitoringInfrastructureTests(CrmWebFactory factory)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Upgrade_backfills_only_complete_success_and_is_repeatable()
    {
        var name = "crm_dev17_upgrade_" + Guid.NewGuid().ToString("N");
        await factory.AdminSqlAsync($"CREATE DATABASE [{name}]");
        try
        {
            var connection = new SqlConnectionStringBuilder(factory.AdminConnectionString) { InitialCatalog = name }.ConnectionString;
            await using var db = new IntegrationDbContext(new DbContextOptionsBuilder<IntegrationDbContext>().UseSqlServer(connection,
                sql => sql.MigrationsHistoryTable("__EFMigrationsHistory", "integration")).Options);
            var migrator = db.GetService<IMigrator>();
            await migrator.MigrateAsync("20261004040653_OutboxDelivery", Ct);
            await db.Database.ExecuteSqlRawAsync("""
                INSERT INTO integration.SyncRuns (Id, System, Job, StartedAt, FinishedAt, Status, [Read], Changed, Failed)
                VALUES
                  (NEWID(),'provider','tickets','2026-10-01T10:00:00+00:00','2026-10-01T10:01:00+00:00','Succeeded',1,1,0),
                  (NEWID(),'provider','tickets','2026-10-01T11:00:00+00:00','2026-10-01T11:01:00+00:00','Failed',1,1,1),
                  (NEWID(),'provider','tickets','2026-10-01T12:00:00+00:00','2026-10-01T12:01:00+00:00','Skipped',0,0,0),
                  (NEWID(),'provider','tickets','2026-10-01T13:00:00+00:00','2026-10-01T13:01:00+00:00','Succeeded',2,1,1),
                  (NEWID(),'provider','connection-test','2026-10-01T14:00:00+00:00','2026-10-01T14:01:00+00:00','Succeeded',0,0,0);
                """, Ct);
            // Fail after the tables/backfill, before the final index. EF must roll the whole migration back so it can resume.
            await db.Database.ExecuteSqlRawAsync("""
                CREATE TRIGGER dev17_interrupt ON DATABASE FOR CREATE_INDEX AS
                BEGIN
                    IF EVENTDATA().value('(/EVENT_INSTANCE/ObjectName)[1]', 'nvarchar(256)') = N'IX_ExceptionTriages_Key'
                        THROW 51017, 'Synthetic migration interruption', 1;
                END
                """, Ct);
            await Should.ThrowAsync<SqlException>(() => db.Database.MigrateAsync(Ct));
            (await db.Database.SqlQueryRaw<int>("SELECT CASE WHEN OBJECT_ID('integration.SyncSuccesses') IS NULL THEN 0 ELSE 1 END AS Value").SingleAsync(Ct)).ShouldBe(0);
            await db.Database.ExecuteSqlRawAsync("DROP TRIGGER dev17_interrupt ON DATABASE", Ct);
            await db.Database.MigrateAsync(Ct);
            await db.Database.MigrateAsync(Ct);
            var success = await db.SyncSuccesses.SingleAsync(Ct);
            success.Job.ShouldBe("tickets");
            success.SucceededAt.ShouldBe(new DateTimeOffset(2026, 10, 1, 10, 1, 0, TimeSpan.Zero));
            (await db.SyncRuns.CountAsync(Ct)).ShouldBe(5);
            (await db.ExceptionTriages.CountAsync(Ct)).ShouldBe(0);
        }
        finally
        {
            SqlConnection.ClearAllPools();
            await factory.AdminSqlAsync($"ALTER DATABASE [{name}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [{name}]");
        }
    }

    [Fact]
    public async Task Collector_emits_counts_and_explicit_zero_recovery_without_record_identifiers_or_amounts()
    {
        var observed = new ConcurrentQueue<(string Name, double Value, string Tags)>();
        using var listener = new MeterListener();
        listener.InstrumentPublished = (instrument, target) =>
        {
            if (instrument.Meter.Name == "Crm.Operations") target.EnableMeasurementEvents(instrument);
        };
        listener.SetMeasurementEventCallback<int>((instrument, value, tags, _) => observed.Enqueue((instrument.Name, value,
            string.Join(';', tags.ToArray().Select(t => $"{t.Key}={t.Value}")))));
        listener.SetMeasurementEventCallback<double>((instrument, value, tags, _) => observed.Enqueue((instrument.Name, value,
            string.Join(';', tags.ToArray().Select(t => $"{t.Key}={t.Value}")))));
        listener.Start();
        using var collector = new OperationalTelemetry(factory.Services.GetRequiredService<IServiceScopeFactory>(), TimeProvider.System,
            NullLogger<OperationalTelemetry>.Instance);
        await collector.CollectAsync(Ct);
        observed.ShouldContain(m => m.Name == "crm.outbox.depth");
        observed.ShouldContain(m => m.Name == "crm.worker.heartbeat.missing");
        observed.ShouldContain(m => m.Name == "crm.sync.failed" && m.Value == 0);
        observed.ShouldContain(m => m.Name == "crm.outbound.errors" && m.Tags.Contains("system=partnercenter"));
        observed.ShouldContain(m => m.Name == "crm.exceptions.count" && m.Value == 0);
        var serializedTags = string.Join('\n', observed.Select(m => m.Tags));
        serializedTags.ShouldNotContain("customerId=");
        serializedTags.ShouldNotContain("entityId");
        serializedTags.ShouldNotContain("amount");
        serializedTags.ShouldNotContain("947321.87");
    }
}
