using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crm.Integrations.Core.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class Webhooks : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "EarlyReadRequests",
                schema: "integration",
                columns: table => new
                {
                    System = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: false),
                    Job = table.Column<string>(type: "nvarchar(128)", maxLength: 128, nullable: false),
                    RequestedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    WaitingSince = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    ServedUpTo = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    TriggeredAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    Requests = table.Column<long>(type: "bigint", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_EarlyReadRequests", x => new { x.System, x.Job });
                });

            migrationBuilder.CreateTable(
                name: "EarlyReadTargets",
                schema: "integration",
                columns: table => new
                {
                    System = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: false),
                    Job = table.Column<string>(type: "nvarchar(128)", maxLength: 128, nullable: false),
                    ExternalId = table.Column<string>(type: "nvarchar(128)", maxLength: 128, nullable: false),
                    RequestedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_EarlyReadTargets", x => new { x.System, x.Job, x.ExternalId });
                });

            migrationBuilder.CreateTable(
                name: "WebhookStates",
                schema: "integration",
                columns: table => new
                {
                    System = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: false),
                    LastReceivedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    LastEventType = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: true),
                    Received = table.Column<long>(type: "bigint", nullable: false),
                    LastRefusedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    LastRefusal = table.Column<string>(type: "nvarchar(32)", maxLength: 32, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_WebhookStates", x => x.System);
                });

            migrationBuilder.CreateIndex(
                name: "IX_EarlyReadTargets_System_Job_RequestedAt",
                schema: "integration",
                table: "EarlyReadTargets",
                columns: new[] { "System", "Job", "RequestedAt" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "EarlyReadRequests",
                schema: "integration");

            migrationBuilder.DropTable(
                name: "EarlyReadTargets",
                schema: "integration");

            migrationBuilder.DropTable(
                name: "WebhookStates",
                schema: "integration");
        }
    }
}
