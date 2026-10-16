using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crm.Integrations.Core.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class WorkerHeartbeats : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "WorkerHeartbeats",
                schema: "integration",
                columns: table => new
                {
                    Component = table.Column<string>(type: "nvarchar(32)", maxLength: 32, nullable: false),
                    Instance = table.Column<string>(type: "nvarchar(128)", maxLength: 128, nullable: false),
                    BeatAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    Detail = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_WorkerHeartbeats", x => new { x.Component, x.Instance });
                });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "WorkerHeartbeats",
                schema: "integration");
        }
    }
}
