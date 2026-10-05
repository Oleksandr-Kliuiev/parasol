using Crm.Service.Persistence;
using Crm.TimeTracking.Persistence;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crm.IntegrationTests;

/// <summary>The privileged fixture migrator installs the measured read-path indexes; runtime hosts never create them.</summary>
public sealed class ReadPathIndexTests(CrmWebFactory factory)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Migrated_indexes_preserve_filters_covering_columns_and_key_order_and_match_the_EF_models()
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var service = scope.ServiceProvider.GetRequiredService<ServiceDbContext>();
        var time = scope.ServiceProvider.GetRequiredService<TimeTrackingDbContext>();
        service.Database.HasPendingModelChanges().ShouldBeFalse("Service snapshot must match its current model");
        time.Database.HasPendingModelChanges().ShouldBeFalse("TimeTracking snapshot must match its current model");
        (await service.Database.GetAppliedMigrationsAsync(Ct)).ShouldContain("20261004220000_ReadPathIndexes");
        (await time.Database.GetAppliedMigrationsAsync(Ct)).ShouldContain("20261004220001_ReadPathIndexes");

        await using var connection = new SqlConnection(factory.AdminConnectionString);
        await connection.OpenAsync(Ct);
        await using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT SCHEMA_NAME(t.schema_id), t.name, i.name, i.filter_definition, i.is_disabled,
                   c.name, ic.key_ordinal, ic.is_descending_key, ic.is_included_column
            FROM sys.tables t
            JOIN sys.indexes i ON i.object_id=t.object_id
            JOIN sys.index_columns ic ON ic.object_id=i.object_id AND ic.index_id=i.index_id
            JOIN sys.columns c ON c.object_id=ic.object_id AND c.column_id=ic.column_id
            WHERE (SCHEMA_NAME(t.schema_id)='service' AND t.name='Tickets' AND i.name='IX_Tickets_IsOpen')
               OR (SCHEMA_NAME(t.schema_id)='time' AND t.name='TimeEntries' AND i.name='IX_TimeEntries_WorkDate_Id')
               OR (SCHEMA_NAME(t.schema_id)='time' AND t.name='TimeAllocations'
                   AND i.name IN ('IX_TimeAllocations_Active_TimeEntryId','IX_TimeAllocations_TimeEntryId'));
            """;
        var columns = new List<IndexColumn>();
        await using (var reader = await command.ExecuteReaderAsync(Ct))
        {
            while (await reader.ReadAsync(Ct))
            {
                columns.Add(new(reader.GetString(0), reader.GetString(1), reader.GetString(2),
                    reader.IsDBNull(3) ? null : reader.GetString(3), reader.GetBoolean(4), reader.GetString(5),
                    reader.GetByte(6), reader.GetBoolean(7), reader.GetBoolean(8)));
            }
        }

        Check("service", "Tickets", "IX_Tickets_IsOpen", "IsOpen=1", [("IsOpen", false)], ["TechnicianUserId"]);
        Check("time", "TimeEntries", "IX_TimeEntries_WorkDate_Id", "IsDeleted=0", [("WorkDate", true), ("Id", false)],
            ["OrganizationId", "TechnicianId", "TechnicianName", "Hours", "Billable", "Status", "Amount"]);
        Check("time", "TimeAllocations", "IX_TimeAllocations_Active_TimeEntryId", "IsDeleted=0", [("TimeEntryId", false)],
            ["Classification", "Hours", "BilledHours", "Amount"]);
        // Expand-only migration: the old unfiltered FK index remains available to existing write/query paths.
        Check("time", "TimeAllocations", "IX_TimeAllocations_TimeEntryId", "", [("TimeEntryId", false)], []);

        void Check(string schema, string table, string index, string filter, (string Column, bool Descending)[] keys, string[] included)
        {
            var actual = columns.Where(c => c.Schema == schema && c.Table == table && c.Index == index).ToList();
            actual.ShouldNotBeEmpty($"{schema}.{table}.{index} must exist after migration");
            actual.ShouldAllBe(c => !c.Disabled);
            Normalize(actual[0].Filter).ShouldBe(filter, index);
            actual.Where(c => !c.Included).OrderBy(c => c.Ordinal).Select(c => (c.Column, c.Descending)).ShouldBe(keys, index);
            actual.Where(c => c.Included).Select(c => c.Column).Order().ShouldBe(included.Order(), index);
        }
    }

    private static string Normalize(string? filter) => string.Concat((filter ?? "").Where(c => !char.IsWhiteSpace(c) && c is not ('[' or ']' or '(' or ')')));

    private sealed record IndexColumn(string Schema, string Table, string Index, string? Filter, bool Disabled,
        string Column, byte Ordinal, bool Descending, bool Included);
}
