using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crm.Security.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class HuntressUsageDays : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "UsageDays",
                schema: "security",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    System = table.Column<string>(type: "nvarchar(32)", maxLength: 32, nullable: false),
                    ExternalOrganizationId = table.Column<long>(type: "bigint", nullable: false),
                    OrganizationId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    Day = table.Column<DateOnly>(type: "date", nullable: false),
                    AgentsCount = table.Column<int>(type: "int", nullable: true),
                    BillableAgents = table.Column<int>(type: "int", nullable: true),
                    ReadAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    RowVersion = table.Column<byte[]>(type: "rowversion", rowVersion: true, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_UsageDays", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_UsageDays_OrganizationId_Day",
                schema: "security",
                table: "UsageDays",
                columns: new[] { "OrganizationId", "Day" });

            migrationBuilder.CreateIndex(
                name: "IX_UsageDays_System_ExternalOrganizationId_Day",
                schema: "security",
                table: "UsageDays",
                columns: new[] { "System", "ExternalOrganizationId", "Day" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "UsageDays",
                schema: "security");
        }
    }
}
