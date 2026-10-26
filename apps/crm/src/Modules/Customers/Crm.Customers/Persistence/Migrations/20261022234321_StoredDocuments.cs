using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crm.Customers.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class StoredDocuments : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "StoredDocuments",
                schema: "customers",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    OrganizationId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    Kind = table.Column<string>(type: "nvarchar(32)", maxLength: 32, nullable: false),
                    SourceKey = table.Column<string>(type: "nvarchar(128)", maxLength: 128, nullable: false, collation: "Latin1_General_100_BIN2"),
                    PeriodStart = table.Column<DateOnly>(type: "date", nullable: false),
                    PeriodEnd = table.Column<DateOnly>(type: "date", nullable: false),
                    FileName = table.Column<string>(type: "nvarchar(240)", maxLength: 240, nullable: false),
                    MediaType = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: false),
                    ObjectKey = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: false),
                    ContentSha256 = table.Column<string>(type: "nchar(64)", fixedLength: true, maxLength: 64, nullable: false),
                    Length = table.Column<long>(type: "bigint", nullable: false),
                    Provenance = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: false),
                    RendererVersion = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: true),
                    StoredAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    RowVersion = table.Column<byte[]>(type: "rowversion", rowVersion: true, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_StoredDocuments", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_StoredDocuments_Kind_SourceKey",
                schema: "customers",
                table: "StoredDocuments",
                columns: new[] { "Kind", "SourceKey" });

            migrationBuilder.CreateIndex(
                name: "IX_StoredDocuments_OrganizationId_PeriodStart",
                schema: "customers",
                table: "StoredDocuments",
                columns: new[] { "OrganizationId", "PeriodStart" });

            migrationBuilder.CreateIndex(
                name: "IX_StoredDocuments_OrganizationId_SourceKey_ContentSha256",
                schema: "customers",
                table: "StoredDocuments",
                columns: new[] { "OrganizationId", "SourceKey", "ContentSha256" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "StoredDocuments",
                schema: "customers");
        }
    }
}
