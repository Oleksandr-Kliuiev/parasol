using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crm.Licensing.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class Initial : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.EnsureSchema(
                name: "licensing");

            migrationBuilder.CreateTable(
                name: "CspSubscriptions",
                schema: "licensing",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    Source = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: false),
                    CspCustomerId = table.Column<string>(type: "nvarchar(128)", maxLength: 128, nullable: false),
                    CspCustomerName = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: true),
                    TenantId = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: true),
                    SubscriptionId = table.Column<string>(type: "nvarchar(128)", maxLength: 128, nullable: false),
                    OfferId = table.Column<string>(type: "nvarchar(128)", maxLength: 128, nullable: false),
                    OfferName = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: true),
                    Sku = table.Column<string>(type: "nvarchar(128)", maxLength: 128, nullable: true),
                    Quantity = table.Column<int>(type: "int", nullable: false),
                    Status = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: false),
                    Term = table.Column<string>(type: "nvarchar(8)", maxLength: 8, nullable: false),
                    BillingCycle = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: false),
                    StartDate = table.Column<DateOnly>(type: "date", nullable: true),
                    CommitmentEndDate = table.Column<DateOnly>(type: "date", nullable: true),
                    RenewalDate = table.Column<DateOnly>(type: "date", nullable: true),
                    AutoRenew = table.Column<bool>(type: "bit", nullable: false),
                    PurchasedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    QuantityIncreasedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    CancellationWindowEndsAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    PartnerUnitPrice = table.Column<decimal>(type: "decimal(18,4)", precision: 18, scale: 4, nullable: true),
                    OrganizationId = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    ProductId = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    SyncedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    RowVersion = table.Column<byte[]>(type: "rowversion", rowVersion: true, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_CspSubscriptions", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "OutboxMessages",
                schema: "licensing",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    Type = table.Column<string>(type: "nvarchar(500)", maxLength: 500, nullable: false),
                    Payload = table.Column<string>(type: "nvarchar(max)", nullable: false),
                    OccurredAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    CorrelationId = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: true),
                    ProcessedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    LockedUntil = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    Attempts = table.Column<int>(type: "int", nullable: false),
                    LastError = table.Column<string>(type: "nvarchar(max)", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_OutboxMessages", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_CspSubscriptions_CspCustomerId",
                schema: "licensing",
                table: "CspSubscriptions",
                column: "CspCustomerId");

            migrationBuilder.CreateIndex(
                name: "IX_CspSubscriptions_OrganizationId_Status",
                schema: "licensing",
                table: "CspSubscriptions",
                columns: new[] { "OrganizationId", "Status" });

            migrationBuilder.CreateIndex(
                name: "IX_CspSubscriptions_RenewalDate",
                schema: "licensing",
                table: "CspSubscriptions",
                column: "RenewalDate");

            migrationBuilder.CreateIndex(
                name: "IX_CspSubscriptions_Source_SubscriptionId",
                schema: "licensing",
                table: "CspSubscriptions",
                columns: new[] { "Source", "SubscriptionId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_OutboxMessages_ProcessedAt_OccurredAt",
                schema: "licensing",
                table: "OutboxMessages",
                columns: new[] { "ProcessedAt", "OccurredAt" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "CspSubscriptions",
                schema: "licensing");

            migrationBuilder.DropTable(
                name: "OutboxMessages",
                schema: "licensing");
        }
    }
}
