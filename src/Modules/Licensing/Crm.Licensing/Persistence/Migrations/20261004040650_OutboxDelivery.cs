using System;
using Crm.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crm.Licensing.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class OutboxDelivery : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "DeadLetteredAt",
                schema: "licensing",
                table: "OutboxMessages",
                type: "datetimeoffset",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "DeliveredHandlers",
                schema: "licensing",
                table: "OutboxMessages",
                type: "nvarchar(4000)",
                maxLength: 4000,
                nullable: true);

            migrationBuilder.AddColumn<Guid>(
                name: "LeaseOwner",
                schema: "licensing",
                table: "OutboxMessages",
                type: "uniqueidentifier",
                nullable: true);

            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "NextAttemptAt",
                schema: "licensing",
                table: "OutboxMessages",
                type: "datetimeoffset",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "Replays",
                schema: "licensing",
                table: "OutboxMessages",
                type: "int",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<string>(
                name: "Status",
                schema: "licensing",
                table: "OutboxMessages",
                type: "nvarchar(16)",
                maxLength: 16,
                nullable: false,
                defaultValue: "Pending");

            migrationBuilder.CreateTable(
                name: "InboxReceipts",
                schema: "licensing",
                columns: table => new
                {
                    MessageId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    Handler = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: false),
                    ProcessedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_InboxReceipts", x => new { x.MessageId, x.Handler });
                });

            migrationBuilder.CreateTable(
                name: "OutboxReplayRequests",
                schema: "licensing",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    MessageIds = table.Column<string>(type: "nvarchar(4000)", maxLength: 4000, nullable: false),
                    Expected = table.Column<int>(type: "int", nullable: false),
                    Reason = table.Column<string>(type: "nvarchar(512)", maxLength: 512, nullable: false),
                    RequestedBy = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    RequestedByName = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: true),
                    RequestedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    AppliedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    Applied = table.Column<int>(type: "int", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_OutboxReplayRequests", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_OutboxMessages_Status_NextAttemptAt",
                schema: "licensing",
                table: "OutboxMessages",
                columns: new[] { "Status", "NextAttemptAt" });

            migrationBuilder.CreateIndex(
                name: "IX_InboxReceipts_ProcessedAt",
                schema: "licensing",
                table: "InboxReceipts",
                column: "ProcessedAt");

            migrationBuilder.CreateIndex(
                name: "IX_OutboxReplayRequests_AppliedAt",
                schema: "licensing",
                table: "OutboxReplayRequests",
                column: "AppliedAt");

            // DEV-07: rows written before have an explicit state; those that used up their attempts become dead letters.
            migrationBuilder.Sql(OutboxMigrationSql.Backfill("licensing"));
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "InboxReceipts",
                schema: "licensing");

            migrationBuilder.DropTable(
                name: "OutboxReplayRequests",
                schema: "licensing");

            migrationBuilder.DropIndex(
                name: "IX_OutboxMessages_Status_NextAttemptAt",
                schema: "licensing",
                table: "OutboxMessages");

            migrationBuilder.DropColumn(
                name: "DeadLetteredAt",
                schema: "licensing",
                table: "OutboxMessages");

            migrationBuilder.DropColumn(
                name: "DeliveredHandlers",
                schema: "licensing",
                table: "OutboxMessages");

            migrationBuilder.DropColumn(
                name: "LeaseOwner",
                schema: "licensing",
                table: "OutboxMessages");

            migrationBuilder.DropColumn(
                name: "NextAttemptAt",
                schema: "licensing",
                table: "OutboxMessages");

            migrationBuilder.DropColumn(
                name: "Replays",
                schema: "licensing",
                table: "OutboxMessages");

            migrationBuilder.DropColumn(
                name: "Status",
                schema: "licensing",
                table: "OutboxMessages");
        }
    }
}
