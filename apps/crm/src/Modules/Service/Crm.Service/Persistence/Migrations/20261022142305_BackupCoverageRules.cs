using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

#pragma warning disable CA1814 // Prefer jagged arrays over multidimensional

namespace Crm.Service.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class BackupCoverageRules : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.InsertData(
                schema: "service",
                table: "CoverageRuleSettings",
                columns: new[] { "Id", "Code", "CreatedAt", "CreatedBy", "Enabled", "IsDeleted", "ModifiedAt", "ModifiedBy", "Threshold" },
                values: new object[,]
                {
                    { new Guid("0199f1a0-4000-7000-8000-000000004201"), "cloudally.backup-failed", new DateTimeOffset(new DateTime(2026, 10, 22, 0, 0, 0, 0, DateTimeKind.Unspecified), new TimeSpan(0, 0, 0, 0, 0)), null, true, false, null, null, null },
                    { new Guid("0199f1a0-4000-7000-8000-000000004202"), "cloudally.backup-late", new DateTimeOffset(new DateTime(2026, 10, 22, 0, 0, 0, 0, DateTimeKind.Unspecified), new TimeSpan(0, 0, 0, 0, 0)), null, true, false, null, null, null },
                    { new Guid("0199f1a0-4000-7000-8000-000000004203"), "cloudally.backup-paused", new DateTimeOffset(new DateTime(2026, 10, 22, 0, 0, 0, 0, DateTimeKind.Unspecified), new TimeSpan(0, 0, 0, 0, 0)), null, true, false, null, null, null },
                    { new Guid("0199f1a0-4000-7000-8000-000000004204"), "cloudally.user-not-backed-up", new DateTimeOffset(new DateTime(2026, 10, 22, 0, 0, 0, 0, DateTimeKind.Unspecified), new TimeSpan(0, 0, 0, 0, 0)), null, true, false, null, null, null }
                });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DeleteData(
                schema: "service",
                table: "CoverageRuleSettings",
                keyColumn: "Id",
                keyValue: new Guid("0199f1a0-4000-7000-8000-000000004201"));

            migrationBuilder.DeleteData(
                schema: "service",
                table: "CoverageRuleSettings",
                keyColumn: "Id",
                keyValue: new Guid("0199f1a0-4000-7000-8000-000000004202"));

            migrationBuilder.DeleteData(
                schema: "service",
                table: "CoverageRuleSettings",
                keyColumn: "Id",
                keyValue: new Guid("0199f1a0-4000-7000-8000-000000004203"));

            migrationBuilder.DeleteData(
                schema: "service",
                table: "CoverageRuleSettings",
                keyColumn: "Id",
                keyValue: new Guid("0199f1a0-4000-7000-8000-000000004204"));
        }
    }
}
