using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

#pragma warning disable CA1814 // Prefer jagged arrays over multidimensional

namespace Crm.Service.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class HuntressDevices : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "AgentVersionSince",
                schema: "service",
                table: "Devices",
                type: "datetimeoffset",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "AntivirusPolicyStatus",
                schema: "service",
                table: "Devices",
                type: "nvarchar(64)",
                maxLength: 64,
                nullable: true);

            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "AntivirusReportedAt",
                schema: "service",
                table: "Devices",
                type: "datetimeoffset",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "AntivirusStatus",
                schema: "service",
                table: "Devices",
                type: "nvarchar(64)",
                maxLength: 64,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "AntivirusSubstatus",
                schema: "service",
                table: "Devices",
                type: "nvarchar(128)",
                maxLength: 128,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "Isolation",
                schema: "service",
                table: "Devices",
                type: "nvarchar(32)",
                maxLength: 32,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "Platform",
                schema: "service",
                table: "Devices",
                type: "nvarchar(16)",
                maxLength: 16,
                nullable: true);

            migrationBuilder.AddColumn<bool>(
                name: "ConfirmClose",
                schema: "service",
                table: "Alerts",
                type: "bit",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "SourceClosedAt",
                schema: "service",
                table: "Alerts",
                type: "datetimeoffset",
                nullable: true);

            migrationBuilder.InsertData(
                schema: "service",
                table: "CoverageRuleSettings",
                columns: new[] { "Id", "Code", "CreatedAt", "CreatedBy", "Enabled", "IsDeleted", "ModifiedAt", "ModifiedBy", "Threshold" },
                values: new object[,]
                {
                    { new Guid("0199f1a0-4000-7000-8000-000000004101"), "huntress.agent-missing", new DateTimeOffset(new DateTime(2026, 10, 22, 0, 0, 0, 0, DateTimeKind.Unspecified), new TimeSpan(0, 0, 0, 0, 0)), null, true, false, null, null, null },
                    { new Guid("0199f1a0-4000-7000-8000-000000004102"), "atera.agent-missing", new DateTimeOffset(new DateTime(2026, 10, 22, 0, 0, 0, 0, DateTimeKind.Unspecified), new TimeSpan(0, 0, 0, 0, 0)), null, true, false, null, null, null },
                    { new Guid("0199f1a0-4000-7000-8000-000000004103"), "huntress.agent-silent", new DateTimeOffset(new DateTime(2026, 10, 22, 0, 0, 0, 0, DateTimeKind.Unspecified), new TimeSpan(0, 0, 0, 0, 0)), null, true, false, null, null, null },
                    { new Guid("0199f1a0-4000-7000-8000-000000004104"), "huntress.agent-outdated", new DateTimeOffset(new DateTime(2026, 10, 22, 0, 0, 0, 0, DateTimeKind.Unspecified), new TimeSpan(0, 0, 0, 0, 0)), null, true, false, null, null, null },
                    { new Guid("0199f1a0-4000-7000-8000-000000004105"), "huntress.defender-off", new DateTimeOffset(new DateTime(2026, 10, 22, 0, 0, 0, 0, DateTimeKind.Unspecified), new TimeSpan(0, 0, 0, 0, 0)), null, true, false, null, null, null }
                });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DeleteData(
                schema: "service",
                table: "CoverageRuleSettings",
                keyColumn: "Id",
                keyValue: new Guid("0199f1a0-4000-7000-8000-000000004101"));

            migrationBuilder.DeleteData(
                schema: "service",
                table: "CoverageRuleSettings",
                keyColumn: "Id",
                keyValue: new Guid("0199f1a0-4000-7000-8000-000000004102"));

            migrationBuilder.DeleteData(
                schema: "service",
                table: "CoverageRuleSettings",
                keyColumn: "Id",
                keyValue: new Guid("0199f1a0-4000-7000-8000-000000004103"));

            migrationBuilder.DeleteData(
                schema: "service",
                table: "CoverageRuleSettings",
                keyColumn: "Id",
                keyValue: new Guid("0199f1a0-4000-7000-8000-000000004104"));

            migrationBuilder.DeleteData(
                schema: "service",
                table: "CoverageRuleSettings",
                keyColumn: "Id",
                keyValue: new Guid("0199f1a0-4000-7000-8000-000000004105"));

            migrationBuilder.DropColumn(
                name: "AgentVersionSince",
                schema: "service",
                table: "Devices");

            migrationBuilder.DropColumn(
                name: "AntivirusPolicyStatus",
                schema: "service",
                table: "Devices");

            migrationBuilder.DropColumn(
                name: "AntivirusReportedAt",
                schema: "service",
                table: "Devices");

            migrationBuilder.DropColumn(
                name: "AntivirusStatus",
                schema: "service",
                table: "Devices");

            migrationBuilder.DropColumn(
                name: "AntivirusSubstatus",
                schema: "service",
                table: "Devices");

            migrationBuilder.DropColumn(
                name: "Isolation",
                schema: "service",
                table: "Devices");

            migrationBuilder.DropColumn(
                name: "Platform",
                schema: "service",
                table: "Devices");

            migrationBuilder.DropColumn(
                name: "ConfirmClose",
                schema: "service",
                table: "Alerts");

            migrationBuilder.DropColumn(
                name: "SourceClosedAt",
                schema: "service",
                table: "Alerts");
        }
    }
}
