using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crm.Identity.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class SharedTechnician : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<bool>(
                name: "Shared",
                schema: "identity",
                table: "TechnicianMappings",
                type: "bit",
                nullable: false,
                defaultValue: false);

            migrationBuilder.CreateIndex(
                name: "UX_TechnicianMappings_Shared",
                schema: "identity",
                table: "TechnicianMappings",
                column: "System",
                unique: true,
                filter: "[Shared] = 1");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "UX_TechnicianMappings_Shared",
                schema: "identity",
                table: "TechnicianMappings");

            migrationBuilder.DropColumn(
                name: "Shared",
                schema: "identity",
                table: "TechnicianMappings");
        }
    }
}
