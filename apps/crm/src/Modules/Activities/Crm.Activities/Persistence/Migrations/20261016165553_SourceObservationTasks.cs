using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crm.Activities.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class SourceObservationTasks : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "SourceTaskLinks",
                schema: "activities",
                columns: table => new
                {
                    SourceKey = table.Column<string>(type: "varchar(64)", unicode: false, maxLength: 64, nullable: false),
                    ActivityId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    System = table.Column<string>(type: "nvarchar(32)", maxLength: 32, nullable: false),
                    WorkspaceId = table.Column<string>(type: "nvarchar(128)", maxLength: 128, nullable: false),
                    ClientId = table.Column<string>(type: "nvarchar(128)", maxLength: 128, nullable: false),
                    ObservationId = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: false),
                    TargetKind = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uniqueidentifier", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_SourceTaskLinks", x => x.SourceKey);
                    table.ForeignKey(
                        name: "FK_SourceTaskLinks_Activities_ActivityId",
                        column: x => x.ActivityId,
                        principalSchema: "activities",
                        principalTable: "Activities",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateIndex(
                name: "IX_SourceTaskLinks_ActivityId",
                schema: "activities",
                table: "SourceTaskLinks",
                column: "ActivityId",
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "SourceTaskLinks",
                schema: "activities");
        }
    }
}
