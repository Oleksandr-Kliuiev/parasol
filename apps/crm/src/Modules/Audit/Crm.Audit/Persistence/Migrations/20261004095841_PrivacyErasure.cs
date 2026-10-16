using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crm.Audit.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class PrivacyErasure : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // DEV-11: verbatim as when this migration was made; Persistence/AuditSql holds the current definition.
            migrationBuilder.Sql("""
                CREATE OR ALTER PROCEDURE [audit].[ClearErasedPayloads] @DryRun bit = 1 AS
                BEGIN
                    SET NOCOUNT ON;
                    SET XACT_ABORT ON;
                    DECLARE @Due TABLE ([Id] bigint PRIMARY KEY);
                    INSERT INTO @Due ([Id])
                    SELECT e.[Id] FROM [audit].[AuditEntries] e
                    WHERE e.[Changes] IS NOT NULL AND e.[Action] <> N'Erase'
                      AND LOWER(e.[Module]) NOT IN (N'billing', N'contracts', N'time', N'sales', N'projects', N'catalog', N'licensing', N'audit')
                      AND EXISTS (SELECT 1 FROM [privacy].[ErasedRecords] r
                                  WHERE r.[Module] = e.[Module] AND r.[EntityType] = e.[EntityType] AND r.[EntityId] = e.[EntityId]);
                    DECLARE @Entries int = (SELECT COUNT(*) FROM @Due);

                    IF @DryRun = 0 AND @Entries > 0
                    BEGIN
                        BEGIN TRY
                            BEGIN TRANSACTION;
                            EXEC sp_set_session_context @key = N'crm.audit-retention', @value = 1;
                            UPDATE e SET [Changes] = NULL FROM [audit].[AuditEntries] e JOIN @Due d ON d.[Id] = e.[Id];
                            EXEC sp_set_session_context @key = N'crm.audit-retention', @value = NULL;
                            INSERT INTO [audit].[AuditEntries] ([At], [UserId], [UserName], [Action], [Module], [EntityType], [EntityId], [Changes], [CorrelationId], [IpAddress])
                            VALUES (SYSDATETIMEOFFSET(), NULL, ORIGINAL_LOGIN(), N'Erase', N'audit', N'AuditEntry', '00000000-0000-0000-0000-000000000000',
                                    CONCAT(N'{"erasedRecords":true,"entries":', @Entries, N'}'), NULL, NULL);
                            COMMIT;
                        END TRY
                        BEGIN CATCH
                            IF @@TRANCOUNT > 0 ROLLBACK;
                            EXEC sp_set_session_context @key = N'crm.audit-retention', @value = NULL;
                            THROW;
                        END CATCH
                    END

                    SELECT @Entries AS [Entries], @DryRun AS [DryRun];
                END
                """);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("DROP PROCEDURE IF EXISTS [audit].[ClearErasedPayloads];");
        }
    }
}
