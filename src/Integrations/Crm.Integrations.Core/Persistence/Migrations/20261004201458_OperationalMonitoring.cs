using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crm.Integrations.Core.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class OperationalMonitoring : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "ExceptionTriages",
                schema: "integration",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    Key = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: false),
                    Category = table.Column<string>(type: "nvarchar(32)", maxLength: 32, nullable: false),
                    Source = table.Column<string>(type: "nvarchar(128)", maxLength: 128, nullable: false),
                    Kind = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: false),
                    RequiredPermission = table.Column<string>(type: "nvarchar(128)", maxLength: 128, nullable: true),
                    OwnerId = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    Status = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: false),
                    Comment = table.Column<string>(type: "nvarchar(2000)", maxLength: 2000, nullable: true),
                    UpdatedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    RowVersion = table.Column<byte[]>(type: "rowversion", rowVersion: true, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ExceptionTriages", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "SyncSuccesses",
                schema: "integration",
                columns: table => new
                {
                    System = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: false),
                    Job = table.Column<string>(type: "nvarchar(128)", maxLength: 128, nullable: false),
                    SucceededAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_SyncSuccesses", x => new { x.System, x.Job });
                });

            // Existing successful history seeds the checkpoint; failed/skipped/partial runs never do.
            migrationBuilder.Sql("""
                INSERT INTO [integration].[SyncSuccesses] ([System], [Job], [SucceededAt])
                SELECT [System], [Job], MAX([FinishedAt]) FROM [integration].[SyncRuns]
                WHERE [Status] = N'Succeeded' AND [Failed] = 0 AND [FinishedAt] IS NOT NULL AND [Job] <> N'connection-test'
                GROUP BY [System], [Job];
                """);

            migrationBuilder.CreateIndex(
                name: "IX_ExceptionTriages_Key",
                schema: "integration",
                table: "ExceptionTriages",
                column: "Key",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_ExceptionTriages_Status_UpdatedAt",
                schema: "integration",
                table: "ExceptionTriages",
                columns: new[] { "Status", "UpdatedAt" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "ExceptionTriages",
                schema: "integration");

            migrationBuilder.DropTable(
                name: "SyncSuccesses",
                schema: "integration");
        }
    }
}
