using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crm.Audit.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AppendOnlyAudit : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "IntegrityCheckpoints",
                schema: "audit",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("SqlServer:Identity", "1, 1"),
                    FromId = table.Column<long>(type: "bigint", nullable: false),
                    ToId = table.Column<long>(type: "bigint", nullable: false),
                    Entries = table.Column<int>(type: "int", nullable: false),
                    PreviousHash = table.Column<string>(type: "nchar(64)", fixedLength: true, maxLength: 64, nullable: true),
                    ChainHash = table.Column<string>(type: "nchar(64)", fixedLength: true, maxLength: 64, nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_IntegrityCheckpoints", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_IntegrityCheckpoints_ToId",
                schema: "audit",
                table: "IntegrityCheckpoints",
                column: "ToId",
                unique: true);

            // DEV-04: the trail is append-only (the retention procedure may only remove the personal part of old entries of
            // modules with an approved policy) and the privacy operator gets that procedure and nothing else. The SQL is written
            // out as it was when this migration was made; Persistence/AuditSql holds the current definitions.
            migrationBuilder.Sql("""
                IF OBJECT_ID(N'[audit].[RetentionPolicies]', N'U') IS NULL
                CREATE TABLE [audit].[RetentionPolicies] (
                    [Module] nvarchar(64) NOT NULL CONSTRAINT [PK_RetentionPolicies] PRIMARY KEY
                        CONSTRAINT [CK_RetentionPolicies_Module] CHECK (LOWER([Module]) NOT IN (N'billing', N'contracts', N'time', N'sales', N'projects', N'catalog', N'licensing', N'audit')),
                    [RetainDays] int NOT NULL CONSTRAINT [CK_RetentionPolicies_RetainDays] CHECK ([RetainDays] >= 30),
                    [ApprovedBy] nvarchar(256) NOT NULL,
                    [ApprovedAt] datetimeoffset NOT NULL,
                    [Reference] nvarchar(256) NULL);
                """);
            migrationBuilder.Sql("""
                CREATE OR ALTER TRIGGER [audit].[trg_AuditEntries_AppendOnly] ON [audit].[AuditEntries] AFTER UPDATE, DELETE AS
                BEGIN
                    SET NOCOUNT ON;
                    IF NOT EXISTS (SELECT 1 FROM deleted) RETURN;
                    IF EXISTS (SELECT 1 FROM deleted d WHERE NOT EXISTS (SELECT 1 FROM inserted i WHERE i.Id = d.Id))
                        THROW 51010, N'AUDIT_APPEND_ONLY: audit entries are never deleted.', 1;
                    IF ISNULL(CAST(SESSION_CONTEXT(N'crm.audit-retention') AS int), 0) <> 1
                        THROW 51011, N'AUDIT_APPEND_ONLY: audit entries are changed only by the retention procedure.', 1;
                    -- Retention removes the personal part of an entry; the fact of the action stays exactly as it was.
                    IF EXISTS (
                        SELECT 1 FROM inserted i JOIN deleted d ON d.Id = i.Id
                        WHERE EXISTS (SELECT i.At, i.Action, i.Module, i.EntityType, i.EntityId, i.CorrelationId
                                      EXCEPT SELECT d.At, d.Action, d.Module, d.EntityType, d.EntityId, d.CorrelationId)
                           OR (i.UserId IS NOT NULL AND EXISTS (SELECT i.UserId EXCEPT SELECT d.UserId))
                           OR (i.UserName IS NOT NULL AND EXISTS (SELECT i.UserName EXCEPT SELECT d.UserName))
                           OR (i.IpAddress IS NOT NULL AND EXISTS (SELECT i.IpAddress EXCEPT SELECT d.IpAddress))
                           OR (i.Changes IS NOT NULL AND EXISTS (SELECT i.Changes EXCEPT SELECT d.Changes)))
                        THROW 51012, N'AUDIT_APPEND_ONLY: retention only removes the personal part of an entry.', 1;
                END
                """);
            migrationBuilder.Sql("""
                CREATE OR ALTER PROCEDURE [audit].[ApplyRetention] @Module nvarchar(64), @Before datetimeoffset, @DryRun bit = 1 AS
                BEGIN
                    SET NOCOUNT ON;
                    SET XACT_ABORT ON;
                    -- Audit of financial records is mandatory evidence (bookkeeping duty, DEC-03): retention never applies to it.
                    IF @Module IS NULL OR LOWER(@Module) IN (N'billing', N'contracts', N'time', N'sales', N'projects', N'catalog', N'licensing', N'audit')
                        THROW 51020, N'AUDIT_RETENTION_PROTECTED: the audit of financial records is kept; retention does not apply to it.', 1;
                    DECLARE @RetainDays int = (SELECT [RetainDays] FROM [audit].[RetentionPolicies] WHERE [Module] = @Module);
                    IF @DryRun = 0 AND @RetainDays IS NULL
                        THROW 51021, N'AUDIT_RETENTION_NOT_APPROVED: no approved retention policy for this module; only a dry run is possible (DEC-03).', 1;
                    IF @DryRun = 0 AND @Before > DATEADD(day, -@RetainDays, SYSDATETIMEOFFSET())
                        THROW 51022, N'AUDIT_RETENTION_TOO_RECENT: the approved policy keeps these entries longer.', 1;

                    DECLARE @Entries int = (
                        SELECT COUNT(*) FROM [audit].[AuditEntries]
                        WHERE [Module] = @Module AND [At] < @Before
                          AND ([UserId] IS NOT NULL OR [UserName] IS NOT NULL OR [IpAddress] IS NOT NULL OR [Changes] IS NOT NULL));

                    IF @DryRun = 0 AND @Entries > 0
                    BEGIN
                        BEGIN TRY
                            BEGIN TRANSACTION;
                            EXEC sp_set_session_context @key = N'crm.audit-retention', @value = 1;
                            UPDATE [audit].[AuditEntries] SET [UserId] = NULL, [UserName] = NULL, [IpAddress] = NULL, [Changes] = NULL
                            WHERE [Module] = @Module AND [At] < @Before
                              AND ([UserId] IS NOT NULL OR [UserName] IS NOT NULL OR [IpAddress] IS NOT NULL OR [Changes] IS NOT NULL);
                            EXEC sp_set_session_context @key = N'crm.audit-retention', @value = NULL;
                            -- The run itself is part of the trail: who ran it, for which module, up to when and how many entries.
                            INSERT INTO [audit].[AuditEntries] ([At], [UserId], [UserName], [Action], [Module], [EntityType], [EntityId], [Changes], [CorrelationId], [IpAddress])
                            VALUES (SYSDATETIMEOFFSET(), NULL, ORIGINAL_LOGIN(), N'Retention', N'audit', N'AuditEntry', '00000000-0000-0000-0000-000000000000',
                                    CONCAT(N'{"module":"', @Module, N'","before":"', CONVERT(nvarchar(40), @Before, 127), N'","entries":', @Entries, N'}'), NULL, NULL);
                            COMMIT;
                        END TRY
                        BEGIN CATCH
                            IF @@TRANCOUNT > 0 ROLLBACK;
                            EXEC sp_set_session_context @key = N'crm.audit-retention', @value = NULL;
                            THROW;
                        END CATCH
                    END

                    SELECT @Module AS [Module], @Before AS [Before], @Entries AS [Entries], @DryRun AS [DryRun];
                END
                """);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            // Checkpoints and approved policies are records too: a rollback keeps them in archive tables.
            migrationBuilder.Sql("""
                DECLARE @stamp nvarchar(20) = FORMAT(SYSUTCDATETIME(), 'yyyyMMddHHmmssfff');
                DECLARE @copy nvarchar(max) =
                    CONCAT(N'SELECT * INTO [audit].', QUOTENAME(CONCAT(N'IntegrityCheckpoints_rollback_', @stamp)), N' FROM [audit].[IntegrityCheckpoints];',
                           N'IF OBJECT_ID(N''[audit].[RetentionPolicies]'', N''U'') IS NOT NULL SELECT * INTO [audit].', QUOTENAME(CONCAT(N'RetentionPolicies_rollback_', @stamp)), N' FROM [audit].[RetentionPolicies];');
                EXEC sp_executesql @copy;
                """);
            migrationBuilder.Sql("DROP PROCEDURE IF EXISTS [audit].[ApplyRetention];");
            migrationBuilder.Sql("DROP TRIGGER IF EXISTS [audit].[trg_AuditEntries_AppendOnly];");
            migrationBuilder.Sql("DROP TABLE IF EXISTS [audit].[RetentionPolicies];");

            migrationBuilder.DropTable(
                name: "IntegrityCheckpoints",
                schema: "audit");
        }
    }
}
