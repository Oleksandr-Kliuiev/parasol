using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crm.Notifications.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class UrgentAlertNotices : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "DedupeKey",
                schema: "notifications",
                table: "ChannelPosts",
                type: "nvarchar(200)",
                maxLength: 200,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "Kind",
                schema: "notifications",
                table: "ChannelPosts",
                type: "nvarchar(32)",
                maxLength: 32,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "ParametersJson",
                schema: "notifications",
                table: "ChannelPosts",
                type: "nvarchar(1024)",
                maxLength: 1024,
                nullable: true);

            migrationBuilder.CreateIndex(
                name: "IX_ChannelPosts_DedupeKey",
                schema: "notifications",
                table: "ChannelPosts",
                column: "DedupeKey",
                unique: true,
                filter: "[DedupeKey] IS NOT NULL");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_ChannelPosts_DedupeKey",
                schema: "notifications",
                table: "ChannelPosts");

            migrationBuilder.DropColumn(
                name: "DedupeKey",
                schema: "notifications",
                table: "ChannelPosts");

            migrationBuilder.DropColumn(
                name: "Kind",
                schema: "notifications",
                table: "ChannelPosts");

            migrationBuilder.DropColumn(
                name: "ParametersJson",
                schema: "notifications",
                table: "ChannelPosts");
        }
    }
}
