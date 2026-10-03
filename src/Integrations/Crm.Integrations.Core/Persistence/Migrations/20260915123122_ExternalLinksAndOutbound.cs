using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crm.Integrations.Core.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class ExternalLinksAndOutbound : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "ExternalLinks",
                schema: "integration",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    EntityType = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: false),
                    EntityId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    System = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: false),
                    ExternalType = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: false),
                    ExternalId = table.Column<string>(type: "nvarchar(128)", maxLength: 128, nullable: false),
                    Method = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: false),
                    LinkedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    LinkedBy = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    MovedByMergeId = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    PreviousEntityId = table.Column<Guid>(type: "uniqueidentifier", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ExternalLinks", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "ExternalRecords",
                schema: "integration",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    System = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: false),
                    ExternalType = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: false),
                    ExternalId = table.Column<string>(type: "nvarchar(128)", maxLength: 128, nullable: false),
                    ParentExternalId = table.Column<string>(type: "nvarchar(128)", maxLength: 128, nullable: true),
                    DisplayName = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: false),
                    OrgNumber = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: true),
                    Email = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: true),
                    Phone = table.Column<string>(type: "nvarchar(32)", maxLength: 32, nullable: true),
                    Domain = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: true),
                    Payload = table.Column<string>(type: "nvarchar(max)", nullable: false),
                    Hash = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: false),
                    FirstSeenAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    LastSeenAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    ExternalChangedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    IsGone = table.Column<bool>(type: "bit", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ExternalRecords", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "OutboundOperations",
                schema: "integration",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    System = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: false),
                    Operation = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: false),
                    EntityType = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: false),
                    EntityId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    IdempotencyKey = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: false),
                    Status = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: false),
                    Attempts = table.Column<int>(type: "int", nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    RequestedBy = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    NextAttemptAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    LockedUntil = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    CompletedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    LastError = table.Column<string>(type: "nvarchar(4000)", maxLength: 4000, nullable: true),
                    Result = table.Column<string>(type: "nvarchar(4000)", maxLength: 4000, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_OutboundOperations", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_ExternalLinks_EntityType_EntityId_System_ExternalType",
                schema: "integration",
                table: "ExternalLinks",
                columns: new[] { "EntityType", "EntityId", "System", "ExternalType" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_ExternalLinks_MovedByMergeId",
                schema: "integration",
                table: "ExternalLinks",
                column: "MovedByMergeId",
                filter: "[MovedByMergeId] IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "IX_ExternalLinks_System_ExternalType_ExternalId",
                schema: "integration",
                table: "ExternalLinks",
                columns: new[] { "System", "ExternalType", "ExternalId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_ExternalRecords_System_ExternalType_Email",
                schema: "integration",
                table: "ExternalRecords",
                columns: new[] { "System", "ExternalType", "Email" });

            migrationBuilder.CreateIndex(
                name: "IX_ExternalRecords_System_ExternalType_ExternalId",
                schema: "integration",
                table: "ExternalRecords",
                columns: new[] { "System", "ExternalType", "ExternalId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_ExternalRecords_System_ExternalType_OrgNumber",
                schema: "integration",
                table: "ExternalRecords",
                columns: new[] { "System", "ExternalType", "OrgNumber" });

            migrationBuilder.CreateIndex(
                name: "IX_ExternalRecords_System_ExternalType_ParentExternalId",
                schema: "integration",
                table: "ExternalRecords",
                columns: new[] { "System", "ExternalType", "ParentExternalId" });

            migrationBuilder.CreateIndex(
                name: "IX_OutboundOperations_EntityType_EntityId",
                schema: "integration",
                table: "OutboundOperations",
                columns: new[] { "EntityType", "EntityId" });

            migrationBuilder.CreateIndex(
                name: "IX_OutboundOperations_IdempotencyKey",
                schema: "integration",
                table: "OutboundOperations",
                column: "IdempotencyKey",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_OutboundOperations_Status_NextAttemptAt",
                schema: "integration",
                table: "OutboundOperations",
                columns: new[] { "Status", "NextAttemptAt" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "ExternalLinks",
                schema: "integration");

            migrationBuilder.DropTable(
                name: "ExternalRecords",
                schema: "integration");

            migrationBuilder.DropTable(
                name: "OutboundOperations",
                schema: "integration");
        }
    }
}
