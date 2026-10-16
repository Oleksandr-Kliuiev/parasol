using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crm.Identity.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class SessionsAndConfirmedRoles : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "Roles",
                schema: "identity",
                table: "Users",
                type: "nvarchar(256)",
                maxLength: 256,
                nullable: false,
                defaultValue: "");

            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "RolesVerifiedAt",
                schema: "identity",
                table: "Users",
                type: "datetimeoffset",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "RolesVersion",
                schema: "identity",
                table: "Users",
                type: "int",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.CreateTable(
                name: "DirectoryRoleConfirmations",
                schema: "identity",
                columns: table => new
                {
                    TenantId = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: false),
                    ConfirmedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_DirectoryRoleConfirmations", x => x.TenantId);
                });

            migrationBuilder.CreateTable(
                name: "UserSessions",
                schema: "identity",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    UserId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    StartedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    EndedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    EndReason = table.Column<string>(type: "nvarchar(32)", maxLength: 32, nullable: true),
                    RowVersion = table.Column<byte[]>(type: "rowversion", rowVersion: true, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_UserSessions", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_UserSessions_UserId",
                schema: "identity",
                table: "UserSessions",
                column: "UserId");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "DirectoryRoleConfirmations",
                schema: "identity");

            migrationBuilder.DropTable(
                name: "UserSessions",
                schema: "identity");

            migrationBuilder.DropColumn(
                name: "Roles",
                schema: "identity",
                table: "Users");

            migrationBuilder.DropColumn(
                name: "RolesVerifiedAt",
                schema: "identity",
                table: "Users");

            migrationBuilder.DropColumn(
                name: "RolesVersion",
                schema: "identity",
                table: "Users");
        }
    }
}
