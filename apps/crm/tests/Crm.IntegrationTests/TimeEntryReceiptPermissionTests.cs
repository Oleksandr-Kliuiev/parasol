using Crm.Infrastructure.Persistence;
using Microsoft.Data.SqlClient;

namespace Crm.IntegrationTests;

[Collection(DatabaseAdministrationCollection.Name)]
public sealed class TimeEntryReceiptPermissionTests(CrmWebFactory factory)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Theory]
    [InlineData(DatabaseRoles.Web)] [InlineData(DatabaseRoles.Worker)]
    public async Task Both_runtime_roles_can_insert_and_read_receipts_but_cannot_rewrite_or_delete_them(string role)
    {
        var user = "receipt_role_" + Guid.NewGuid().ToString("N"); var request = Guid.NewGuid();
        await factory.AdminSqlAsync($"CREATE USER [{user}] WITHOUT LOGIN; ALTER ROLE [{role}] ADD MEMBER [{user}];");
        try
        {
            await using var connection = new SqlConnection(factory.AdminConnectionString); await connection.OpenAsync(Ct);
            await using (var impersonate = connection.CreateCommand())
            { impersonate.CommandText = $"EXECUTE AS USER = N'{user}';"; await impersonate.ExecuteNonQueryAsync(Ct); }
            try
            {
                await using (var insert = connection.CreateCommand())
                {
                    insert.CommandText = "INSERT INTO [time].[TimeEntryCreateReceipts] ([ClientRequestId],[RequestedBy],[IntentHash],[TimeEntryId],[AcceptedAt]) VALUES (@request,@employee,@hash,@entry,SYSDATETIMEOFFSET());";
                    insert.Parameters.AddWithValue("request", request); insert.Parameters.AddWithValue("employee", Guid.NewGuid());
                    insert.Parameters.AddWithValue("hash", new string('A', 64)); insert.Parameters.AddWithValue("entry", Guid.NewGuid());
                    (await insert.ExecuteNonQueryAsync(Ct)).ShouldBe(1);
                }
                await using (var select = connection.CreateCommand())
                {
                    select.CommandText = "SELECT COUNT(*) FROM [time].[TimeEntryCreateReceipts] WHERE [ClientRequestId]=@request";
                    select.Parameters.AddWithValue("request", request); (await select.ExecuteScalarAsync(Ct)).ShouldBe(1);
                }
                foreach (var sql in new[] { "UPDATE [time].[TimeEntryCreateReceipts] SET [IntentHash]=@hash WHERE [ClientRequestId]=@request",
                    "DELETE FROM [time].[TimeEntryCreateReceipts] WHERE [ClientRequestId]=@request" })
                {
                    await using var mutation = connection.CreateCommand(); mutation.CommandText = sql;
                    mutation.Parameters.AddWithValue("request", request); mutation.Parameters.AddWithValue("hash", new string('B', 64));
                    (await Should.ThrowAsync<SqlException>(() => mutation.ExecuteNonQueryAsync(Ct))).Number.ShouldBe(229);
                }
            }
            finally
            {
                await using var revert = connection.CreateCommand(); revert.CommandText = "REVERT;"; await revert.ExecuteNonQueryAsync(Ct);
            }
        }
        finally { await factory.AdminSqlAsync($"ALTER ROLE [{role}] DROP MEMBER [{user}]; DROP USER [{user}];"); }
    }
}
