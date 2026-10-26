using Crm.Activities.Contracts;
using Crm.Activities.Domain;
using Crm.Activities.Persistence;
using Crm.Infrastructure.Persistence;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.DependencyInjection;

namespace Crm.IntegrationTests;

/// <summary>M38: a source-task receipt is permanent for both runtime identities, as the time receipts are (M22).</summary>
[Collection(DatabaseAdministrationCollection.Name)]
public sealed class SourceTaskReceiptPermissionTests(CrmWebFactory factory)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Theory]
    [InlineData(DatabaseRoles.Web)] [InlineData(DatabaseRoles.Worker)]
    public async Task Both_runtime_roles_can_insert_and_read_receipts_but_cannot_rewrite_or_delete_them(string role)
    {
        var organization = await SourceTaskTestSupport.Organization(factory);
        Guid activityId;
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<ActivitiesDbContext>();
            var task = Activity.Create(new(ActivityType.Task, organization, null, null, null, "Synthetic receipt task", null, null,
                ActivityPriority.Normal, null), DateTimeOffset.UtcNow).Value;
            db.Activities.Add(task);
            await db.SaveChangesAsync(Ct);
            activityId = task.Id;
        }

        var source = SourceTaskTestSupport.Source();
        var key = SourceTaskIdentityRules.Key(source);
        var user = "source_receipt_" + Guid.NewGuid().ToString("N");
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
                    insert.CommandText = """
                        INSERT INTO [activities].[SourceTaskLinks] ([SourceKey],[ActivityId],[System],[WorkspaceId],[ClientId],[ObservationId],[TargetKind],[CreatedAt],[CreatedBy])
                        VALUES (@key,@activity,@system,@kind,@customer,@alert,N'Task',SYSDATETIMEOFFSET(),@employee);
                        """;
                    insert.Parameters.AddWithValue("key", key); insert.Parameters.AddWithValue("activity", activityId);
                    insert.Parameters.AddWithValue("system", source.System); insert.Parameters.AddWithValue("kind", source.SourceKind);
                    insert.Parameters.AddWithValue("customer", source.ExternalCustomerId); insert.Parameters.AddWithValue("alert", source.ExternalId);
                    insert.Parameters.AddWithValue("employee", Guid.NewGuid());
                    (await insert.ExecuteNonQueryAsync(Ct)).ShouldBe(1);
                }
                await using (var select = connection.CreateCommand())
                {
                    select.CommandText = "SELECT COUNT(*) FROM [activities].[SourceTaskLinks] WHERE [SourceKey]=@key";
                    select.Parameters.AddWithValue("key", key); (await select.ExecuteScalarAsync(Ct)).ShouldBe(1);
                }
                foreach (var sql in new[] { "UPDATE [activities].[SourceTaskLinks] SET [ObservationId]=N'another-alert' WHERE [SourceKey]=@key",
                    "DELETE FROM [activities].[SourceTaskLinks] WHERE [SourceKey]=@key" })
                {
                    await using var mutation = connection.CreateCommand(); mutation.CommandText = sql;
                    mutation.Parameters.AddWithValue("key", key);
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
