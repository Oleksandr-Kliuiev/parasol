using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crm.TimeTracking.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class ReadPathIndexes : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateIndex(
                name: "IX_TimeEntries_WorkDate_Id",
                schema: "time",
                table: "TimeEntries",
                columns: new[] { "WorkDate", "Id" },
                descending: new[] { true, false },
                filter: "[IsDeleted] = 0")
                .Annotation("SqlServer:Include", new[] { "OrganizationId", "TechnicianId", "TechnicianName", "Hours", "Billable", "Status", "Amount" });

            migrationBuilder.CreateIndex(
                name: "IX_TimeAllocations_Active_TimeEntryId",
                schema: "time",
                table: "TimeAllocations",
                column: "TimeEntryId",
                filter: "[IsDeleted] = 0")
                .Annotation("SqlServer:Include", new[] { "Classification", "Hours", "BilledHours", "Amount" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_TimeEntries_WorkDate_Id",
                schema: "time",
                table: "TimeEntries");

            migrationBuilder.DropIndex(
                name: "IX_TimeAllocations_Active_TimeEntryId",
                schema: "time",
                table: "TimeAllocations");
        }
    }
}
