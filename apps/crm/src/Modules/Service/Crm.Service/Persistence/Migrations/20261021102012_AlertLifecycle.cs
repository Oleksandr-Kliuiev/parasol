using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crm.Service.Persistence.Migrations
{
    /// <summary>
    /// Expand only (M38). Alerts keep their row across reads: a state with a default the previous release's inserts get, a kind, the
    /// source's customer, the matched device, a configured link and the times last seen and resolved; one row per source alert.
    /// </summary>
    public partial class AlertLifecycle : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<Guid>(
                name: "DeviceId",
                schema: "service",
                table: "Alerts",
                type: "uniqueidentifier",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "ExternalCustomerId",
                schema: "service",
                table: "Alerts",
                type: "nvarchar(128)",
                maxLength: 128,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "Kind",
                schema: "service",
                table: "Alerts",
                type: "nvarchar(16)",
                maxLength: 16,
                nullable: false,
                defaultValue: "Monitoring");

            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "LastSeenAt",
                schema: "service",
                table: "Alerts",
                type: "datetimeoffset",
                nullable: true);

            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "ResolvedAt",
                schema: "service",
                table: "Alerts",
                type: "datetimeoffset",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "State",
                schema: "service",
                table: "Alerts",
                type: "nvarchar(16)",
                maxLength: 16,
                nullable: false,
                defaultValue: "Open");

            migrationBuilder.AddColumn<string>(
                name: "Url",
                schema: "service",
                table: "Alerts",
                type: "nvarchar(512)",
                maxLength: 512,
                nullable: true);

            migrationBuilder.CreateIndex(
                name: "IX_Alerts_State_Severity_CreatedAtSource",
                schema: "service",
                table: "Alerts",
                columns: new[] { "State", "Severity", "CreatedAtSource" })
                .Annotation("SqlServer:Include", new[] { "OrganizationId" });

            // The previous release rewrote the whole mirror on every read and stored an alert once; should a read ever have listed
            // one twice, the newest copy stays, so the unique index below can be built. The next read restores anything removed.
            migrationBuilder.Sql("""
                WITH ranked AS (
                    SELECT ROW_NUMBER() OVER (PARTITION BY [System], [ExternalId] ORDER BY [Id] DESC) AS [Copy]
                    FROM [service].[Alerts])
                DELETE FROM ranked WHERE [Copy] > 1;
                """);

            migrationBuilder.CreateIndex(
                name: "IX_Alerts_System_ExternalId",
                schema: "service",
                table: "Alerts",
                columns: new[] { "System", "ExternalId" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_Alerts_State_Severity_CreatedAtSource",
                schema: "service",
                table: "Alerts");

            migrationBuilder.DropIndex(
                name: "IX_Alerts_System_ExternalId",
                schema: "service",
                table: "Alerts");

            migrationBuilder.DropColumn(
                name: "DeviceId",
                schema: "service",
                table: "Alerts");

            migrationBuilder.DropColumn(
                name: "ExternalCustomerId",
                schema: "service",
                table: "Alerts");

            migrationBuilder.DropColumn(
                name: "Kind",
                schema: "service",
                table: "Alerts");

            migrationBuilder.DropColumn(
                name: "LastSeenAt",
                schema: "service",
                table: "Alerts");

            migrationBuilder.DropColumn(
                name: "ResolvedAt",
                schema: "service",
                table: "Alerts");

            migrationBuilder.DropColumn(
                name: "State",
                schema: "service",
                table: "Alerts");

            migrationBuilder.DropColumn(
                name: "Url",
                schema: "service",
                table: "Alerts");
        }
    }
}
