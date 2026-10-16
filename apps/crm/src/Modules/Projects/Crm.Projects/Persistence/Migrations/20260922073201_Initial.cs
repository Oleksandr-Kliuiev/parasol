using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crm.Projects.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class Initial : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.EnsureSchema(
                name: "projects");

            migrationBuilder.CreateSequence<int>(
                name: "ProjectNumbers",
                schema: "projects");

            migrationBuilder.CreateTable(
                name: "OutboxMessages",
                schema: "projects",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    Type = table.Column<string>(type: "nvarchar(500)", maxLength: 500, nullable: false),
                    Payload = table.Column<string>(type: "nvarchar(max)", nullable: false),
                    OccurredAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    CorrelationId = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: true),
                    ProcessedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    LockedUntil = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    Attempts = table.Column<int>(type: "int", nullable: false),
                    LastError = table.Column<string>(type: "nvarchar(max)", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_OutboxMessages", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "Projects",
                schema: "projects",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    Number = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: false),
                    OrganizationId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    Name = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: false),
                    Type = table.Column<string>(type: "nvarchar(32)", maxLength: 32, nullable: false),
                    Status = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: false),
                    BillingModel = table.Column<string>(type: "nvarchar(24)", maxLength: 24, nullable: false),
                    ManagerId = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    StartDate = table.Column<DateOnly>(type: "date", nullable: false),
                    EndDate = table.Column<DateOnly>(type: "date", nullable: true),
                    BudgetHours = table.Column<decimal>(type: "decimal(18,2)", precision: 18, scale: 2, nullable: false),
                    BudgetAmount = table.Column<decimal>(type: "decimal(18,2)", precision: 18, scale: 2, nullable: false),
                    ContractId = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    OpportunityId = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    Notes = table.Column<string>(type: "nvarchar(4000)", maxLength: 4000, nullable: true),
                    CompletedOn = table.Column<DateOnly>(type: "date", nullable: true),
                    RowVersion = table.Column<byte[]>(type: "rowversion", rowVersion: true, nullable: true),
                    CreatedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    ModifiedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    ModifiedBy = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    IsDeleted = table.Column<bool>(type: "bit", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Projects", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "ProjectPhases",
                schema: "projects",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    ProjectId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    Order = table.Column<int>(type: "int", nullable: false),
                    Name = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: false),
                    Status = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: false),
                    PlannedStart = table.Column<DateOnly>(type: "date", nullable: true),
                    PlannedEnd = table.Column<DateOnly>(type: "date", nullable: true),
                    PlannedHours = table.Column<decimal>(type: "decimal(18,2)", precision: 18, scale: 2, nullable: false),
                    Fee = table.Column<decimal>(type: "decimal(18,2)", precision: 18, scale: 2, nullable: false),
                    BillOnCompletion = table.Column<bool>(type: "bit", nullable: false),
                    ProductId = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    CompletedOn = table.Column<DateOnly>(type: "date", nullable: true),
                    RowVersion = table.Column<byte[]>(type: "rowversion", rowVersion: true, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ProjectPhases", x => x.Id);
                    table.ForeignKey(
                        name: "FK_ProjectPhases_Projects_ProjectId",
                        column: x => x.ProjectId,
                        principalSchema: "projects",
                        principalTable: "Projects",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "ProjectTasks",
                schema: "projects",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    PhaseId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    Title = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: false),
                    AssigneeId = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    DueDate = table.Column<DateOnly>(type: "date", nullable: true),
                    EstimatedHours = table.Column<decimal>(type: "decimal(18,2)", precision: 18, scale: 2, nullable: false),
                    Status = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: false),
                    Notes = table.Column<string>(type: "nvarchar(2000)", maxLength: 2000, nullable: true),
                    RowVersion = table.Column<byte[]>(type: "rowversion", rowVersion: true, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ProjectTasks", x => x.Id);
                    table.ForeignKey(
                        name: "FK_ProjectTasks_ProjectPhases_PhaseId",
                        column: x => x.PhaseId,
                        principalSchema: "projects",
                        principalTable: "ProjectPhases",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_OutboxMessages_ProcessedAt_OccurredAt",
                schema: "projects",
                table: "OutboxMessages",
                columns: new[] { "ProcessedAt", "OccurredAt" });

            migrationBuilder.CreateIndex(
                name: "IX_ProjectPhases_ProjectId",
                schema: "projects",
                table: "ProjectPhases",
                column: "ProjectId");

            migrationBuilder.CreateIndex(
                name: "IX_Projects_ManagerId",
                schema: "projects",
                table: "Projects",
                column: "ManagerId");

            migrationBuilder.CreateIndex(
                name: "IX_Projects_Number",
                schema: "projects",
                table: "Projects",
                column: "Number",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_Projects_OrganizationId_Status",
                schema: "projects",
                table: "Projects",
                columns: new[] { "OrganizationId", "Status" });

            migrationBuilder.CreateIndex(
                name: "IX_ProjectTasks_AssigneeId_Status",
                schema: "projects",
                table: "ProjectTasks",
                columns: new[] { "AssigneeId", "Status" });

            migrationBuilder.CreateIndex(
                name: "IX_ProjectTasks_PhaseId",
                schema: "projects",
                table: "ProjectTasks",
                column: "PhaseId");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "OutboxMessages",
                schema: "projects");

            migrationBuilder.DropTable(
                name: "ProjectTasks",
                schema: "projects");

            migrationBuilder.DropTable(
                name: "ProjectPhases",
                schema: "projects");

            migrationBuilder.DropTable(
                name: "Projects",
                schema: "projects");

            migrationBuilder.DropSequence(
                name: "ProjectNumbers",
                schema: "projects");
        }
    }
}
