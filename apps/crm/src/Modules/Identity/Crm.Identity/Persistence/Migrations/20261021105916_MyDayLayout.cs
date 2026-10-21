using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crm.Identity.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class MyDayLayout : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "MyDayLayout",
                schema: "identity",
                table: "Users",
                type: "nvarchar(16)",
                maxLength: 16,
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "MyDayLayout",
                schema: "identity",
                table: "Users");
        }
    }
}
