using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crm.TimeTracking.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class TimeEntryProject : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<Guid>(
                name: "ProjectId",
                schema: "time",
                table: "TimeEntries",
                type: "uniqueidentifier",
                nullable: true);

            migrationBuilder.CreateIndex(
                name: "IX_TimeEntries_ProjectId",
                schema: "time",
                table: "TimeEntries",
                column: "ProjectId",
                filter: "[ProjectId] IS NOT NULL");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_TimeEntries_ProjectId",
                schema: "time",
                table: "TimeEntries");

            migrationBuilder.DropColumn(
                name: "ProjectId",
                schema: "time",
                table: "TimeEntries");
        }
    }
}
