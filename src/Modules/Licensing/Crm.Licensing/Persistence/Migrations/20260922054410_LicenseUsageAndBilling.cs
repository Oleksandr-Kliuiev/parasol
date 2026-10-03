using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crm.Licensing.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class LicenseUsageAndBilling : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "LicenseSnapshots",
                schema: "licensing",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    OrganizationId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    SnapshotDate = table.Column<DateOnly>(type: "date", nullable: false),
                    SkuId = table.Column<string>(type: "nvarchar(128)", maxLength: 128, nullable: false),
                    SkuPartNumber = table.Column<string>(type: "nvarchar(128)", maxLength: 128, nullable: false),
                    Purchased = table.Column<int>(type: "int", nullable: false),
                    Assigned = table.Column<int>(type: "int", nullable: false),
                    ReadAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    RowVersion = table.Column<byte[]>(type: "rowversion", rowVersion: true, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_LicenseSnapshots", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "MsBilledLines",
                schema: "licensing",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    LineKey = table.Column<string>(type: "nvarchar(512)", maxLength: 512, nullable: false),
                    Source = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: false),
                    PeriodStart = table.Column<DateOnly>(type: "date", nullable: false),
                    PeriodEnd = table.Column<DateOnly>(type: "date", nullable: false),
                    InvoiceId = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: true),
                    CspCustomerId = table.Column<string>(type: "nvarchar(128)", maxLength: 128, nullable: false),
                    CspCustomerName = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: true),
                    OrganizationId = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    SubscriptionId = table.Column<string>(type: "nvarchar(128)", maxLength: 128, nullable: true),
                    OfferId = table.Column<string>(type: "nvarchar(128)", maxLength: 128, nullable: false),
                    OfferName = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: true),
                    Quantity = table.Column<decimal>(type: "decimal(18,2)", precision: 18, scale: 2, nullable: false),
                    UnitPrice = table.Column<decimal>(type: "decimal(18,4)", precision: 18, scale: 4, nullable: false),
                    Total = table.Column<decimal>(type: "decimal(18,2)", precision: 18, scale: 2, nullable: false),
                    Currency = table.Column<string>(type: "nvarchar(3)", maxLength: 3, nullable: false),
                    ImportedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    RowVersion = table.Column<byte[]>(type: "rowversion", rowVersion: true, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_MsBilledLines", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_LicenseSnapshots_OrganizationId_SnapshotDate_SkuId",
                schema: "licensing",
                table: "LicenseSnapshots",
                columns: new[] { "OrganizationId", "SnapshotDate", "SkuId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_LicenseSnapshots_SnapshotDate",
                schema: "licensing",
                table: "LicenseSnapshots",
                column: "SnapshotDate");

            migrationBuilder.CreateIndex(
                name: "IX_MsBilledLines_LineKey",
                schema: "licensing",
                table: "MsBilledLines",
                column: "LineKey",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_MsBilledLines_PeriodStart_OrganizationId",
                schema: "licensing",
                table: "MsBilledLines",
                columns: new[] { "PeriodStart", "OrganizationId" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "LicenseSnapshots",
                schema: "licensing");

            migrationBuilder.DropTable(
                name: "MsBilledLines",
                schema: "licensing");
        }
    }
}
