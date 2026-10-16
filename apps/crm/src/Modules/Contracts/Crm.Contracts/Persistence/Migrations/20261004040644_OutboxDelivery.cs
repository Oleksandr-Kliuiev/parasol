using System;
using Crm.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crm.Contracts.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class OutboxDelivery : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // DEV-07: one contract per accepted quote. Duplicates from before stop the migration for a person to resolve
            // (runbook 09 §5); a duplicate contract may already be billed, so nothing is merged or removed here.
            migrationBuilder.Sql("""
                IF EXISTS (SELECT [SourceQuoteId] FROM [contracts].[Contracts] WHERE [SourceQuoteId] IS NOT NULL
                           GROUP BY [SourceQuoteId] HAVING COUNT(*) > 1)
                    THROW 51041, N'CONTRACT_QUOTE_DUPLICATES: more than one contract was drafted from the same quote. Resolve them before this migration (runbook 09 section 5, DEV-07).', 1;
                """);

            migrationBuilder.DropIndex(
                name: "IX_Contracts_SourceQuoteId",
                schema: "contracts",
                table: "Contracts");

            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "DeadLetteredAt",
                schema: "contracts",
                table: "OutboxMessages",
                type: "datetimeoffset",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "DeliveredHandlers",
                schema: "contracts",
                table: "OutboxMessages",
                type: "nvarchar(4000)",
                maxLength: 4000,
                nullable: true);

            migrationBuilder.AddColumn<Guid>(
                name: "LeaseOwner",
                schema: "contracts",
                table: "OutboxMessages",
                type: "uniqueidentifier",
                nullable: true);

            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "NextAttemptAt",
                schema: "contracts",
                table: "OutboxMessages",
                type: "datetimeoffset",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "Replays",
                schema: "contracts",
                table: "OutboxMessages",
                type: "int",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<string>(
                name: "Status",
                schema: "contracts",
                table: "OutboxMessages",
                type: "nvarchar(16)",
                maxLength: 16,
                nullable: false,
                defaultValue: "Pending");

            migrationBuilder.CreateTable(
                name: "InboxReceipts",
                schema: "contracts",
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
                schema: "contracts",
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
                schema: "contracts",
                table: "OutboxMessages",
                columns: new[] { "Status", "NextAttemptAt" });

            migrationBuilder.CreateIndex(
                name: "IX_Contracts_SourceQuoteId",
                schema: "contracts",
                table: "Contracts",
                column: "SourceQuoteId",
                unique: true,
                filter: "[SourceQuoteId] IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "IX_InboxReceipts_ProcessedAt",
                schema: "contracts",
                table: "InboxReceipts",
                column: "ProcessedAt");

            migrationBuilder.CreateIndex(
                name: "IX_OutboxReplayRequests_AppliedAt",
                schema: "contracts",
                table: "OutboxReplayRequests",
                column: "AppliedAt");

            // DEV-07: rows written before have an explicit state; those that used up their attempts become dead letters.
            migrationBuilder.Sql(OutboxMigrationSql.Backfill("contracts"));
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "InboxReceipts",
                schema: "contracts");

            migrationBuilder.DropTable(
                name: "OutboxReplayRequests",
                schema: "contracts");

            migrationBuilder.DropIndex(
                name: "IX_OutboxMessages_Status_NextAttemptAt",
                schema: "contracts",
                table: "OutboxMessages");

            migrationBuilder.DropIndex(
                name: "IX_Contracts_SourceQuoteId",
                schema: "contracts",
                table: "Contracts");

            migrationBuilder.DropColumn(
                name: "DeadLetteredAt",
                schema: "contracts",
                table: "OutboxMessages");

            migrationBuilder.DropColumn(
                name: "DeliveredHandlers",
                schema: "contracts",
                table: "OutboxMessages");

            migrationBuilder.DropColumn(
                name: "LeaseOwner",
                schema: "contracts",
                table: "OutboxMessages");

            migrationBuilder.DropColumn(
                name: "NextAttemptAt",
                schema: "contracts",
                table: "OutboxMessages");

            migrationBuilder.DropColumn(
                name: "Replays",
                schema: "contracts",
                table: "OutboxMessages");

            migrationBuilder.DropColumn(
                name: "Status",
                schema: "contracts",
                table: "OutboxMessages");

            migrationBuilder.CreateIndex(
                name: "IX_Contracts_SourceQuoteId",
                schema: "contracts",
                table: "Contracts",
                column: "SourceQuoteId");
        }
    }
}
