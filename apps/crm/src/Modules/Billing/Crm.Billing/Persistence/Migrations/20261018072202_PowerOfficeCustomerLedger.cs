using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crm.Billing.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class PowerOfficeCustomerLedger : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "CustomerLedgerSnapshots",
                schema: "billing",
                columns: table => new
                {
                    System = table.Column<string>(type: "nvarchar(32)", maxLength: 32, nullable: false),
                    CustomerKey = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: false),
                    OrganizationId = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    ScanId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    ReadStartedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    SavedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_CustomerLedgerSnapshots", x => new { x.System, x.CustomerKey });
                });

            migrationBuilder.CreateTable(
                name: "CustomerLedgerEntries",
                schema: "billing",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    System = table.Column<string>(type: "nvarchar(32)", maxLength: 32, nullable: false),
                    ExternalId = table.Column<long>(type: "bigint", nullable: false),
                    CustomerKey = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: false),
                    VoucherId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    MatchId = table.Column<long>(type: "bigint", nullable: true),
                    Kind = table.Column<string>(type: "nvarchar(24)", maxLength: 24, nullable: false),
                    PostingDate = table.Column<DateOnly>(type: "date", nullable: false),
                    LastChangedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    LastSeenScanId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    LastSeenAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    SnapshotJson = table.Column<string>(type: "nvarchar(max)", nullable: false),
                    RowVersion = table.Column<byte[]>(type: "rowversion", rowVersion: true, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_CustomerLedgerEntries", x => x.Id);
                    table.ForeignKey(
                        name: "FK_CustomerLedgerEntries_CustomerLedgerSnapshots_System_CustomerKey",
                        columns: x => new { x.System, x.CustomerKey },
                        principalSchema: "billing",
                        principalTable: "CustomerLedgerSnapshots",
                        principalColumns: new[] { "System", "CustomerKey" },
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "CustomerLedgerVersions",
                schema: "billing",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    EntryId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    SourceChangedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    ObservedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    SnapshotJson = table.Column<string>(type: "nvarchar(max)", nullable: false),
                    RowVersion = table.Column<byte[]>(type: "rowversion", rowVersion: true, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_CustomerLedgerVersions", x => x.Id);
                    table.ForeignKey(
                        name: "FK_CustomerLedgerVersions_CustomerLedgerEntries_EntryId",
                        column: x => x.EntryId,
                        principalSchema: "billing",
                        principalTable: "CustomerLedgerEntries",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateIndex(
                name: "IX_CustomerLedgerEntries_System_CustomerKey_LastSeenScanId_MatchId",
                schema: "billing",
                table: "CustomerLedgerEntries",
                columns: new[] { "System", "CustomerKey", "LastSeenScanId", "MatchId" });

            migrationBuilder.CreateIndex(
                name: "IX_CustomerLedgerEntries_System_ExternalId",
                schema: "billing",
                table: "CustomerLedgerEntries",
                columns: new[] { "System", "ExternalId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_CustomerLedgerEntries_System_VoucherId",
                schema: "billing",
                table: "CustomerLedgerEntries",
                columns: new[] { "System", "VoucherId" });

            migrationBuilder.CreateIndex(
                name: "IX_CustomerLedgerSnapshots_OrganizationId",
                schema: "billing",
                table: "CustomerLedgerSnapshots",
                column: "OrganizationId");

            migrationBuilder.CreateIndex(
                name: "IX_CustomerLedgerVersions_EntryId_ObservedAt",
                schema: "billing",
                table: "CustomerLedgerVersions",
                columns: new[] { "EntryId", "ObservedAt" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("IF EXISTS (SELECT 1 FROM [billing].[CustomerLedgerEntries]) OR EXISTS (SELECT 1 FROM [billing].[CustomerLedgerVersions]) OR EXISTS (SELECT 1 FROM [billing].[CustomerLedgerSnapshots]) THROW 51000, 'Export and reconcile customer ledger history before rolling back this migration.', 1;");
            migrationBuilder.DropTable(
                name: "CustomerLedgerVersions",
                schema: "billing");

            migrationBuilder.DropTable(
                name: "CustomerLedgerEntries",
                schema: "billing");

            migrationBuilder.DropTable(
                name: "CustomerLedgerSnapshots",
                schema: "billing");
        }
    }
}
