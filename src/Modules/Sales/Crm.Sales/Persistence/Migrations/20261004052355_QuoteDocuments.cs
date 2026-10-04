using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crm.Sales.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class QuoteDocuments : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "QuoteDocuments",
                schema: "sales",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    QuoteId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    RootId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    VersionNo = table.Column<int>(type: "int", nullable: false),
                    Revision = table.Column<int>(type: "int", nullable: false),
                    Origin = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: false),
                    Status = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: false),
                    ObjectKey = table.Column<string>(type: "nvarchar(400)", maxLength: 400, nullable: false),
                    FileName = table.Column<string>(type: "nvarchar(128)", maxLength: 128, nullable: false),
                    MediaType = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: false),
                    SnapshotJson = table.Column<string>(type: "nvarchar(max)", nullable: false),
                    SnapshotSha256 = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: false),
                    ContentSha256 = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: true),
                    Length = table.Column<long>(type: "bigint", nullable: true),
                    RendererVersion = table.Column<string>(type: "nvarchar(32)", maxLength: 32, nullable: true),
                    CreatedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    ReadyAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    RowVersion = table.Column<byte[]>(type: "rowversion", rowVersion: true, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_QuoteDocuments", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_QuoteDocuments_ObjectKey",
                schema: "sales",
                table: "QuoteDocuments",
                column: "ObjectKey",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_QuoteDocuments_QuoteId_Revision",
                schema: "sales",
                table: "QuoteDocuments",
                columns: new[] { "QuoteId", "Revision" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_QuoteDocuments_Status",
                schema: "sales",
                table: "QuoteDocuments",
                column: "Status");

            // DEV-08: a quote document is never deleted and, once Ready, never changes; a Preparing one only becomes Ready with
            // the hash and length of the stored PDF. Holds for every identity (Persistence/SalesTriggers.cs).
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
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "QuoteDocuments",
                schema: "sales");
        }
    }
}
