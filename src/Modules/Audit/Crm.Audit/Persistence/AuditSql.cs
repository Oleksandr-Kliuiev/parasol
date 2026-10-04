namespace Crm.Audit.Persistence;

/// <summary>
/// Database objects that keep the audit trail append-only (DEV-04): the trigger, the approved retention policies and the
/// retention procedure the privacy operator runs. Financial evidence is outside retention's reach whatever is asked (DEC-03);
/// until a policy for a module is approved, only a dry run is possible.
/// </summary>
internal static class AuditSql
{
    public const string AppendOnlyTrigger = "trg_AuditEntries_AppendOnly";

    /// <summary>
    /// Modules (as audit entries name them: the module schema) whose audit is evidence of financial records — billing, contracts,
    /// time, sales, projects, prices, licence costs — and the audit itself. Retention never applies to them (DEC-03); the list
    /// changes only with an approved decision and a migration.
    /// </summary>
    public static readonly IReadOnlyList<string> ProtectedModules = ["billing", "contracts", "time", "sales", "projects", "catalog", "licensing", "audit"];

    private static string ProtectedList => string.Join(", ", ProtectedModules.Select(m => $"N'{m}'"));

    public const string CreateTrigger = """
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
        """;

    public static string CreatePolicies => $"""
        IF OBJECT_ID(N'[audit].[RetentionPolicies]', N'U') IS NULL
        CREATE TABLE [audit].[RetentionPolicies] (
            [Module] nvarchar(64) NOT NULL CONSTRAINT [PK_RetentionPolicies] PRIMARY KEY
                CONSTRAINT [CK_RetentionPolicies_Module] CHECK (LOWER([Module]) NOT IN ({ProtectedList})),
            [RetainDays] int NOT NULL CONSTRAINT [CK_RetentionPolicies_RetainDays] CHECK ([RetainDays] >= 30),
            [ApprovedBy] nvarchar(256) NOT NULL,
            [ApprovedAt] datetimeoffset NOT NULL,
            [Reference] nvarchar(256) NULL);
        """;

    public static string CreateProcedure => $$"""
        CREATE OR ALTER PROCEDURE [audit].[ApplyRetention] @Module nvarchar(64), @Before datetimeoffset, @DryRun bit = 1 AS
        BEGIN
            SET NOCOUNT ON;
            SET XACT_ABORT ON;
            -- Audit of financial records is mandatory evidence (bookkeeping duty, DEC-03): retention never applies to it.
            IF @Module IS NULL OR LOWER(@Module) IN ({{ProtectedList}})
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
        """;
}
