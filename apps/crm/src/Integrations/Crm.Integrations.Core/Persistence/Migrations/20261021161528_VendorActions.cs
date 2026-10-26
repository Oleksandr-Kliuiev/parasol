using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crm.Integrations.Core.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class VendorActions : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "VendorActions",
                schema: "integration",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    System = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: false),
                    Kind = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: false),
                    Level = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: false),
                    TargetType = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: false),
                    TargetId = table.Column<string>(type: "nvarchar(128)", maxLength: 128, nullable: false),
                    TargetName = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: false),
                    OrganizationId = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    ExternalCustomerId = table.Column<string>(type: "nvarchar(128)", maxLength: 128, nullable: true),
                    Parameters = table.Column<string>(type: "nvarchar(max)", nullable: false),
                    Fingerprint = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: false),
                    Reason = table.Column<string>(type: "nvarchar(500)", maxLength: 500, nullable: true),
                    RequestedBy = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    RequestedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    NotBefore = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    CommandKey = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    OutboundOperationId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    Status = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: false),
                    OutcomeCode = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: true),
                    Outcome = table.Column<string>(type: "nvarchar(500)", maxLength: 500, nullable: true),
                    Reference = table.Column<string>(type: "nvarchar(128)", maxLength: 128, nullable: true),
                    MayHaveSent = table.Column<bool>(type: "bit", nullable: false),
                    Attempts = table.Column<int>(type: "int", nullable: false),
                    StartedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    CompletedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    ClosedBy = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    ClosedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    CloseReason = table.Column<string>(type: "nvarchar(500)", maxLength: 500, nullable: true),
                    RowVersion = table.Column<byte[]>(type: "rowversion", rowVersion: true, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_VendorActions", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_VendorActions_OrganizationId",
                schema: "integration",
                table: "VendorActions",
                column: "OrganizationId");

            migrationBuilder.CreateIndex(
                name: "IX_VendorActions_OutboundOperationId",
                schema: "integration",
                table: "VendorActions",
                column: "OutboundOperationId",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_VendorActions_RequestedAt_Id",
                schema: "integration",
                table: "VendorActions",
                columns: new[] { "RequestedAt", "Id" });

            migrationBuilder.CreateIndex(
                name: "IX_VendorActions_RequestedBy_CommandKey",
                schema: "integration",
                table: "VendorActions",
                columns: new[] { "RequestedBy", "CommandKey" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_VendorActions_Status_RequestedAt",
                schema: "integration",
                table: "VendorActions",
                columns: new[] { "Status", "RequestedAt" });

            migrationBuilder.CreateIndex(
                name: "IX_VendorActions_TargetType_TargetId_RequestedAt",
                schema: "integration",
                table: "VendorActions",
                columns: new[] { "TargetType", "TargetId", "RequestedAt" });

            migrationBuilder.CreateIndex(
                name: "UX_VendorActions_Sending",
                schema: "integration",
                table: "VendorActions",
                columns: new[] { "System", "TargetType", "TargetId" },
                unique: true,
                filter: "[Status] = 'Sending'");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "VendorActions",
                schema: "integration");
        }
    }
}
