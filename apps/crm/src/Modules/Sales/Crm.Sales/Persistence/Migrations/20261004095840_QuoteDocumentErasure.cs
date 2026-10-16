using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crm.Sales.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class QuoteDocumentErasure : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "ErasedAt",
                schema: "sales",
                table: "QuoteDocuments",
                type: "datetimeoffset",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "ErasureReference",
                schema: "sales",
                table: "QuoteDocuments",
                type: "nvarchar(32)",
                maxLength: 32,
                nullable: true);

            // DEV-11: verbatim as when this migration was made. The privacy operator's procedure is the only way a document
            // changes after it is ready — emptied snapshot, stored object let go, once, status kept so older releases still read
            // the row — and only for a caller in crm_privacy: the application, which may update Preparing rows, cannot take
            // that path by setting the session flag itself. An erased document never changes again.
            migrationBuilder.Sql("""
                CREATE OR ALTER TRIGGER [sales].[trg_QuoteDocuments_Protect] ON [sales].[QuoteDocuments] AFTER UPDATE, DELETE AS
                BEGIN
                    SET NOCOUNT ON;
                    IF EXISTS (SELECT 1 FROM deleted d LEFT JOIN inserted i ON i.Id = d.Id WHERE i.Id IS NULL)
                        THROW 51011, N'QUOTE_DOCUMENT_IMMUTABLE: a quote document is never deleted, and once ready it never changes (DEV-08).', 1;
                    IF ISNULL(CAST(SESSION_CONTEXT(N'crm.privacy-erasure') AS int), 0) = 1 AND IS_MEMBER(N'crm_privacy') = 1
                    BEGIN
                        IF EXISTS (
                            SELECT 1 FROM deleted d JOIN inserted i ON i.Id = d.Id
                            WHERE d.ErasedAt IS NOT NULL
                               OR i.ErasedAt IS NULL
                               OR i.ErasureReference IS NULL
                               OR i.SnapshotJson <> N'{}'
                               OR i.ObjectKey <> CONCAT(N'erased/', LOWER(CONVERT(nvarchar(36), i.Id)))
                               OR EXISTS (SELECT i.QuoteId, i.RootId, i.VersionNo, i.Revision, i.Origin, i.Status, i.FileName, i.MediaType, i.SnapshotSha256,
                                                 i.ContentSha256, i.Length, i.RendererVersion, i.CreatedAt, i.CreatedBy, i.ReadyAt
                                          EXCEPT
                                          SELECT d.QuoteId, d.RootId, d.VersionNo, d.Revision, d.Origin, d.Status, d.FileName, d.MediaType, d.SnapshotSha256,
                                                 d.ContentSha256, d.Length, d.RendererVersion, d.CreatedAt, d.CreatedBy, d.ReadyAt))
                            THROW 51013, N'QUOTE_DOCUMENT_ERASURE: an erasure only empties the snapshot and lets go of the stored object, once (DEV-11).', 1;
                        RETURN;
                    END
                    IF EXISTS (
                        SELECT 1 FROM deleted d JOIN inserted i ON i.Id = d.Id
                        WHERE d.Status = N'Ready'
                           OR d.ErasedAt IS NOT NULL
                           OR i.Status <> N'Ready'
                           OR i.ContentSha256 IS NULL
                           OR i.Length IS NULL
                           OR EXISTS (SELECT i.QuoteId, i.RootId, i.VersionNo, i.Revision, i.Origin, i.ObjectKey, i.FileName, i.MediaType,
                                             i.SnapshotJson, i.SnapshotSha256, i.CreatedAt, i.CreatedBy, i.ErasedAt, i.ErasureReference
                                      EXCEPT
                                      SELECT d.QuoteId, d.RootId, d.VersionNo, d.Revision, d.Origin, d.ObjectKey, d.FileName, d.MediaType,
                                             d.SnapshotJson, d.SnapshotSha256, d.CreatedAt, d.CreatedBy, d.ErasedAt, d.ErasureReference))
                        THROW 51011, N'QUOTE_DOCUMENT_IMMUTABLE: a quote document is never deleted, and once ready it never changes (DEV-08).', 1;
                END
                """);

            // The privacy operator's procedure: documents an executed privacy case covered (privacy.ErasedRecords, the privacy
            // module's SQL contract for operator procedures) are erased; a dry run, the default, only counts.
            migrationBuilder.Sql("""
                CREATE OR ALTER PROCEDURE [sales].[ClearErasedDocuments] @DryRun bit = 1 AS
                BEGIN
                    SET NOCOUNT ON;
                    SET XACT_ABORT ON;
                    DECLARE @Due TABLE ([Id] uniqueidentifier PRIMARY KEY, [Reference] nvarchar(32) NOT NULL);
                    INSERT INTO @Due ([Id], [Reference])
                    SELECT d.[Id], MIN(m.[CaseNumber])
                    FROM [sales].[QuoteDocuments] d
                    JOIN [privacy].[ErasedRecords] r
                      ON r.[Module] = N'sales' AND r.[EntityType] = N'QuoteDocument' AND r.[EntityId] = d.[Id] AND r.[Action] = N'OperatorErasure'
                    JOIN [privacy].[ErasureManifests] m ON m.[Id] = r.[ManifestId]
                    WHERE d.[ErasedAt] IS NULL
                    GROUP BY d.[Id];
                    DECLARE @Documents int = (SELECT COUNT(*) FROM @Due);

                    IF @DryRun = 0 AND @Documents > 0
                    BEGIN
                        BEGIN TRY
                            BEGIN TRANSACTION;
                            EXEC sp_set_session_context @key = N'crm.privacy-erasure', @value = 1;
                            UPDATE d SET [SnapshotJson] = N'{}', [ObjectKey] = CONCAT(N'erased/', LOWER(CONVERT(nvarchar(36), d.[Id]))),
                                         [ErasedAt] = SYSDATETIMEOFFSET(), [ErasureReference] = due.[Reference]
                            FROM [sales].[QuoteDocuments] d JOIN @Due due ON due.[Id] = d.[Id];
                            EXEC sp_set_session_context @key = N'crm.privacy-erasure', @value = NULL;
                            INSERT INTO [audit].[AuditEntries] ([At], [UserId], [UserName], [Action], [Module], [EntityType], [EntityId], [Changes], [CorrelationId], [IpAddress])
                            VALUES (SYSDATETIMEOFFSET(), NULL, ORIGINAL_LOGIN(), N'Erase', N'sales', N'QuoteDocument', '00000000-0000-0000-0000-000000000000',
                                    CONCAT(N'{"documents":', @Documents, N'}'), NULL, NULL);
                            COMMIT;
                        END TRY
                        BEGIN CATCH
                            IF @@TRANCOUNT > 0 ROLLBACK;
                            EXEC sp_set_session_context @key = N'crm.privacy-erasure', @value = NULL;
                            THROW;
                        END CATCH
                    END

                    SELECT @Documents AS [Documents], @DryRun AS [DryRun];
                END
                """);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("DROP PROCEDURE IF EXISTS [sales].[ClearErasedDocuments];");
            // Back to the DEV-08 definition (as migration QuoteDocuments wrote it): no erasure path.
            migrationBuilder.Sql("""
                CREATE OR ALTER TRIGGER [sales].[trg_QuoteDocuments_Protect] ON [sales].[QuoteDocuments] AFTER UPDATE, DELETE AS
                BEGIN
                    SET NOCOUNT ON;
                    IF EXISTS (
                        SELECT 1 FROM deleted d LEFT JOIN inserted i ON i.Id = d.Id
                        WHERE i.Id IS NULL
                           OR d.Status = N'Ready'
                           OR i.Status <> N'Ready'
                           OR i.ContentSha256 IS NULL
                           OR i.Length IS NULL
                           OR EXISTS (SELECT i.QuoteId, i.RootId, i.VersionNo, i.Revision, i.Origin, i.ObjectKey, i.FileName, i.MediaType,
                                             i.SnapshotJson, i.SnapshotSha256, i.CreatedAt, i.CreatedBy
                                      EXCEPT
                                      SELECT d.QuoteId, d.RootId, d.VersionNo, d.Revision, d.Origin, d.ObjectKey, d.FileName, d.MediaType,
                                             d.SnapshotJson, d.SnapshotSha256, d.CreatedAt, d.CreatedBy))
                        THROW 51011, N'QUOTE_DOCUMENT_IMMUTABLE: a quote document is never deleted, and once ready it never changes (DEV-08).', 1;
                END
                """);

            migrationBuilder.DropColumn(
                name: "ErasedAt",
                schema: "sales",
                table: "QuoteDocuments");

            migrationBuilder.DropColumn(
                name: "ErasureReference",
                schema: "sales",
                table: "QuoteDocuments");
        }
    }
}
