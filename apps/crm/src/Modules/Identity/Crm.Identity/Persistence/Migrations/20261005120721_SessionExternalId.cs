using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crm.Identity.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class SessionExternalId : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "ExternalSessionHash",
                schema: "identity",
                table: "UserSessions",
                type: "varchar(64)",
                unicode: false,
                maxLength: 64,
                nullable: true);

            migrationBuilder.CreateIndex(
                name: "IX_UserSessions_ExternalSessionHash",
                schema: "identity",
                table: "UserSessions",
                column: "ExternalSessionHash",
                filter: "[ExternalSessionHash] IS NOT NULL");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_UserSessions_ExternalSessionHash",
                schema: "identity",
                table: "UserSessions");

            migrationBuilder.DropColumn(
                name: "ExternalSessionHash",
                schema: "identity",
                table: "UserSessions");
        }
    }
}
