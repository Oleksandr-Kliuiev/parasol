using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crm.Customers.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class ImportRuns : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "ImportRuns",
                schema: "customers",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    SourceSha256 = table.Column<string>(type: "nchar(64)", fixedLength: true, maxLength: 64, nullable: false),
                    MappingVersion = table.Column<string>(type: "nvarchar(32)", maxLength: 32, nullable: false),
                    RepeatKey = table.Column<string>(type: "nchar(64)", fixedLength: true, maxLength: 64, nullable: false),
                    Mode = table.Column<string>(type: "nvarchar(8)", maxLength: 8, nullable: false),
                    Status = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: false),
                    RowsTotal = table.Column<int>(type: "int", nullable: false),
                    Created = table.Column<int>(type: "int", nullable: false),
                    Updated = table.Column<int>(type: "int", nullable: false),
                    Unchanged = table.Column<int>(type: "int", nullable: false),
                    Conflict = table.Column<int>(type: "int", nullable: false),
                    Rejected = table.Column<int>(type: "int", nullable: false),
                    ContactsWritten = table.Column<int>(type: "int", nullable: false),
                    LastCommittedLine = table.Column<int>(type: "int", nullable: false),
                    StartedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    UpdatedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    FinishedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    UserId = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    FailedFromLine = table.Column<int>(type: "int", nullable: true),
                    FailedToLine = table.Column<int>(type: "int", nullable: true),
                    FailureCode = table.Column<string>(type: "nvarchar(48)", maxLength: 48, nullable: true),
                    SummaryJson = table.Column<string>(type: "nvarchar(4000)", maxLength: 4000, nullable: true),
                    RowVersion = table.Column<byte[]>(type: "rowversion", rowVersion: true, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ImportRuns", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "ImportRowOutcomes",
                schema: "customers",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    RunId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    Line = table.Column<int>(type: "int", nullable: false),
                    SourceKey = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: true),
                    Action = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: false),
                    ReasonCode = table.Column<string>(type: "nvarchar(48)", maxLength: 48, nullable: true),
                    OrganizationId = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    ContactId = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    ContactAction = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: true),
                    FieldsChanged = table.Column<string>(type: "nvarchar(512)", maxLength: 512, nullable: true),
                    ConflictFields = table.Column<string>(type: "nvarchar(512)", maxLength: 512, nullable: true),
                    Warnings = table.Column<string>(type: "nvarchar(512)", maxLength: 512, nullable: true),
                    RowVersion = table.Column<byte[]>(type: "rowversion", rowVersion: true, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ImportRowOutcomes", x => x.Id);
                    table.ForeignKey(
                        name: "FK_ImportRowOutcomes_ImportRuns_RunId",
                        column: x => x.RunId,
                        principalSchema: "customers",
                        principalTable: "ImportRuns",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "ImportRunEntities",
                schema: "customers",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    RunId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    EntityType = table.Column<string>(type: "nvarchar(24)", maxLength: 24, nullable: false),
                    EntityId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    Action = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: false),
                    Fields = table.Column<string>(type: "nvarchar(512)", maxLength: 512, nullable: true),
                    RowVersion = table.Column<byte[]>(type: "rowversion", rowVersion: true, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ImportRunEntities", x => x.Id);
                    table.ForeignKey(
                        name: "FK_ImportRunEntities_ImportRuns_RunId",
                        column: x => x.RunId,
                        principalSchema: "customers",
                        principalTable: "ImportRuns",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateIndex(
                name: "IX_ImportRowOutcomes_RunId_Action",
                schema: "customers",
                table: "ImportRowOutcomes",
                columns: new[] { "RunId", "Action" });

            migrationBuilder.CreateIndex(
                name: "IX_ImportRowOutcomes_RunId_Line",
                schema: "customers",
                table: "ImportRowOutcomes",
                columns: new[] { "RunId", "Line" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_ImportRunEntities_RunId_EntityType_EntityId",
                schema: "customers",
                table: "ImportRunEntities",
                columns: new[] { "RunId", "EntityType", "EntityId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_ImportRuns_RepeatKey",
                schema: "customers",
                table: "ImportRuns",
                column: "RepeatKey",
                unique: true,
                filter: "[Mode] = 'Real'");

            migrationBuilder.CreateIndex(
                name: "IX_ImportRuns_StartedAt_Id",
                schema: "customers",
                table: "ImportRuns",
                columns: new[] { "StartedAt", "Id" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "ImportRowOutcomes",
                schema: "customers");

            migrationBuilder.DropTable(
                name: "ImportRunEntities",
                schema: "customers");

            migrationBuilder.DropTable(
                name: "ImportRuns",
                schema: "customers");
        }
    }
}
