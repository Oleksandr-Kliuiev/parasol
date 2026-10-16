using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crm.Service.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class ReadPathIndexes : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateIndex(
                name: "IX_Tickets_IsOpen",
                schema: "service",
                table: "Tickets",
                column: "IsOpen",
                filter: "[IsOpen] = 1")
                .Annotation("SqlServer:Include", new[] { "TechnicianUserId" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_Tickets_IsOpen",
                schema: "service",
                table: "Tickets");
        }
    }
}
