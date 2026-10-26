using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crm.Service.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class CoverageGaps : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(
                name: "CleanChecks",
                schema: "service",
                table: "Alerts",
                type: "int",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<string>(
                name: "Facts",
                schema: "service",
                table: "Alerts",
                type: "nvarchar(1024)",
                maxLength: 1024,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "Rule",
                schema: "service",
                table: "Alerts",
                type: "nvarchar(64)",
                maxLength: 64,
                nullable: true);

            migrationBuilder.CreateTable(
                name: "CoverageRuleSettings",
                schema: "service",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    Code = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: false),
                    Enabled = table.Column<bool>(type: "bit", nullable: false),
                    Threshold = table.Column<int>(type: "int", nullable: true),
                    RowVersion = table.Column<byte[]>(type: "rowversion", rowVersion: true, nullable: true),
                    CreatedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    ModifiedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    ModifiedBy = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    IsDeleted = table.Column<bool>(type: "bit", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_CoverageRuleSettings", x => x.Id);
                });

            migrationBuilder.InsertData(
                schema: "service",
                table: "CoverageRuleSettings",
                columns: new[] { "Id", "Code", "CreatedAt", "CreatedBy", "Enabled", "IsDeleted", "ModifiedAt", "ModifiedBy", "Threshold" },
                values: new object[] { new Guid("0199f1a0-4000-7000-8000-000000004001"), "atera.agent-silent", new DateTimeOffset(new DateTime(2026, 10, 22, 0, 0, 0, 0, DateTimeKind.Unspecified), new TimeSpan(0, 0, 0, 0, 0)), null, true, false, null, null, null });

            migrationBuilder.CreateIndex(
                name: "IX_CoverageRuleSettings_Code",
                schema: "service",
                table: "CoverageRuleSettings",
                column: "Code",
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "CoverageRuleSettings",
                schema: "service");

            migrationBuilder.DropColumn(
                name: "CleanChecks",
                schema: "service",
                table: "Alerts");

            migrationBuilder.DropColumn(
                name: "Facts",
                schema: "service",
                table: "Alerts");

            migrationBuilder.DropColumn(
                name: "Rule",
                schema: "service",
                table: "Alerts");
        }
    }
}
