using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crm.Billing.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class PowerOfficeInvoiceDocuments : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "InvoiceDocumentChecks",
                schema: "billing",
                columns: table => new
                {
                    InvoiceId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    HasPdf = table.Column<bool>(type: "bit", nullable: true),
                    CheckedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_InvoiceDocumentChecks", x => x.InvoiceId);
                    table.ForeignKey(
                        name: "FK_InvoiceDocumentChecks_Invoices_InvoiceId",
                        column: x => x.InvoiceId,
                        principalSchema: "billing",
                        principalTable: "Invoices",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "InvoiceDocuments",
                schema: "billing",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    InvoiceId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    SourceName = table.Column<string>(type: "nvarchar(240)", maxLength: 240, nullable: false, collation: "Latin1_General_100_BIN2"),
                    ContentSha256 = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: false),
                    ObjectKey = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: false),
                    Length = table.Column<long>(type: "bigint", nullable: false),
                    ImportedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    RowVersion = table.Column<byte[]>(type: "rowversion", rowVersion: true, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_InvoiceDocuments", x => x.Id);
                    table.ForeignKey(
                        name: "FK_InvoiceDocuments_Invoices_InvoiceId",
                        column: x => x.InvoiceId,
                        principalSchema: "billing",
                        principalTable: "Invoices",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateIndex(
                name: "IX_InvoiceDocuments_InvoiceId_SourceName_ContentSha256",
                schema: "billing",
                table: "InvoiceDocuments",
                columns: new[] { "InvoiceId", "SourceName", "ContentSha256" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("""
                IF EXISTS (SELECT 1 FROM [billing].[InvoiceDocuments]) OR EXISTS (SELECT 1 FROM [billing].[InvoiceDocumentChecks])
                    THROW 51000, 'Cannot remove imported invoice document history.', 1;
                """);

            migrationBuilder.DropTable(
                name: "InvoiceDocumentChecks",
                schema: "billing");

            migrationBuilder.DropTable(
                name: "InvoiceDocuments",
                schema: "billing");
        }
    }
}
