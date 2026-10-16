using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crm.Integrations.Core.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class IntegrationSwitches : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "IntegrationSwitches",
                schema: "integration",
                columns: table => new
                {
                    System = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: false),
                    IsPaused = table.Column<bool>(type: "bit", nullable: false),
                    Reason = table.Column<string>(type: "nvarchar(512)", maxLength: 512, nullable: true),
                    PausedBy = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: true),
                    PausedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_IntegrationSwitches", x => x.System);
                });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "IntegrationSwitches",
                schema: "integration");
        }
    }
}
