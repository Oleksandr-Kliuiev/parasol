using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crm.Activities.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class OutlookActivities : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "CalendarSyncedAt",
                schema: "activities",
                table: "Activities",
                type: "datetimeoffset",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "DurationMinutes",
                schema: "activities",
                table: "Activities",
                type: "int",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "ExternalMessageId",
                schema: "activities",
                table: "Activities",
                type: "nvarchar(512)",
                maxLength: 512,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "FromAddress",
                schema: "activities",
                table: "Activities",
                type: "nvarchar(256)",
                maxLength: 256,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "GraphEventId",
                schema: "activities",
                table: "Activities",
                type: "nvarchar(512)",
                maxLength: 512,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "Location",
                schema: "activities",
                table: "Activities",
                type: "nvarchar(256)",
                maxLength: 256,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "WebLink",
                schema: "activities",
                table: "Activities",
                type: "nvarchar(1024)",
                maxLength: 1024,
                nullable: true);

            migrationBuilder.CreateIndex(
                name: "IX_Activities_GraphEventId",
                schema: "activities",
                table: "Activities",
                column: "GraphEventId",
                filter: "[GraphEventId] IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "IX_Activities_OrganizationId_ExternalMessageId",
                schema: "activities",
                table: "Activities",
                columns: new[] { "OrganizationId", "ExternalMessageId" },
                unique: true,
                filter: "[ExternalMessageId] IS NOT NULL");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_Activities_GraphEventId",
                schema: "activities",
                table: "Activities");

            migrationBuilder.DropIndex(
                name: "IX_Activities_OrganizationId_ExternalMessageId",
                schema: "activities",
                table: "Activities");

            migrationBuilder.DropColumn(
                name: "CalendarSyncedAt",
                schema: "activities",
                table: "Activities");

            migrationBuilder.DropColumn(
                name: "DurationMinutes",
                schema: "activities",
                table: "Activities");

            migrationBuilder.DropColumn(
                name: "ExternalMessageId",
                schema: "activities",
                table: "Activities");

            migrationBuilder.DropColumn(
                name: "FromAddress",
                schema: "activities",
                table: "Activities");

            migrationBuilder.DropColumn(
                name: "GraphEventId",
                schema: "activities",
                table: "Activities");

            migrationBuilder.DropColumn(
                name: "Location",
                schema: "activities",
                table: "Activities");

            migrationBuilder.DropColumn(
                name: "WebLink",
                schema: "activities",
                table: "Activities");
        }
    }
}
