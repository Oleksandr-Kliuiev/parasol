using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crm.Service.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class GlobalSearchIndexes : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_Devices_MachineId",
                schema: "service",
                table: "Devices");

            migrationBuilder.CreateIndex(
                name: "IX_Tickets_ExternalId",
                schema: "service",
                table: "Tickets",
                column: "ExternalId");

            migrationBuilder.CreateIndex(
                name: "IX_Devices_MachineId",
                schema: "service",
                table: "Devices",
                column: "MachineId",
                filter: "[MachineId] IS NOT NULL")
                .Annotation("SqlServer:Include", new[] { "MachineName", "SerialNumber", "LastLoginUser", "LoggedInUsers" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_Tickets_ExternalId",
                schema: "service",
                table: "Tickets");

            migrationBuilder.DropIndex(
                name: "IX_Devices_MachineId",
                schema: "service",
                table: "Devices");

            migrationBuilder.CreateIndex(
                name: "IX_Devices_MachineId",
                schema: "service",
                table: "Devices",
                column: "MachineId",
                filter: "[MachineId] IS NOT NULL");
        }
    }
}
