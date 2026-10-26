using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crm.Security.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class HuntressMirror : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "Incidents",
                schema: "security",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    System = table.Column<string>(type: "nvarchar(32)", maxLength: 32, nullable: false),
                    ExternalId = table.Column<long>(type: "bigint", nullable: false),
                    OrganizationId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    ExternalOrganizationId = table.Column<long>(type: "bigint", nullable: false),
                    AgentExternalId = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: true),
                    DeviceName = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: true),
                    Status = table.Column<string>(type: "nvarchar(32)", maxLength: 32, nullable: false),
                    Severity = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: false),
                    Subject = table.Column<string>(type: "nvarchar(512)", maxLength: 512, nullable: false),
                    Summary = table.Column<string>(type: "nvarchar(4000)", maxLength: 4000, nullable: true),
                    Body = table.Column<string>(type: "nvarchar(max)", maxLength: 16000, nullable: true),
                    Platform = table.Column<string>(type: "nvarchar(32)", maxLength: 32, nullable: true),
                    IndicatorTypes = table.Column<string>(type: "nvarchar(512)", maxLength: 512, nullable: true),
                    IndicatorCounts = table.Column<string>(type: "nvarchar(1024)", maxLength: 1024, nullable: true),
                    SentAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    ClosedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    StatusUpdatedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    UpdatedAtSource = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    Url = table.Column<string>(type: "nvarchar(512)", maxLength: 512, nullable: true),
                    FirstReadAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    ReadAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    RemediationsReadAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    CommentsReadAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    RowVersion = table.Column<byte[]>(type: "rowversion", rowVersion: true, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Incidents", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "Notices",
                schema: "security",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    System = table.Column<string>(type: "nvarchar(32)", maxLength: 32, nullable: false),
                    Kind = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: false),
                    ExternalId = table.Column<long>(type: "bigint", nullable: false),
                    OrganizationId = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    ExternalOrganizationIds = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: true),
                    Status = table.Column<string>(type: "nvarchar(32)", maxLength: 32, nullable: false),
                    Severity = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: false),
                    Subject = table.Column<string>(type: "nvarchar(512)", maxLength: 512, nullable: false),
                    Type = table.Column<string>(type: "nvarchar(128)", maxLength: 128, nullable: true),
                    TypeCode = table.Column<string>(type: "nvarchar(128)", maxLength: 128, nullable: true),
                    Subtype = table.Column<string>(type: "nvarchar(128)", maxLength: 128, nullable: true),
                    Entities = table.Column<string>(type: "nvarchar(4000)", maxLength: 4000, nullable: true),
                    AllEntities = table.Column<bool>(type: "bit", nullable: false),
                    CreatedAtSource = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    ResolvedAtSource = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    UpdatedAtSource = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    Url = table.Column<string>(type: "nvarchar(512)", maxLength: 512, nullable: true),
                    FirstReadAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    ReadAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    EntitiesReadAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    RowVersion = table.Column<byte[]>(type: "rowversion", rowVersion: true, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Notices", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "ProductUsages",
                schema: "security",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    System = table.Column<string>(type: "nvarchar(32)", maxLength: 32, nullable: false),
                    ExternalOrganizationId = table.Column<long>(type: "bigint", nullable: false),
                    OrganizationId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    Name = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: false),
                    AgentsCount = table.Column<int>(type: "int", nullable: true),
                    BillableAgents = table.Column<int>(type: "int", nullable: true),
                    UnresponsiveAgents = table.Column<int>(type: "int", nullable: true),
                    OutdatedAgents = table.Column<int>(type: "int", nullable: true),
                    IsolatedAgents = table.Column<int>(type: "int", nullable: true),
                    BillableIdentities = table.Column<int>(type: "int", nullable: true),
                    SatLearners = table.Column<int>(type: "int", nullable: true),
                    BillableLogSources = table.Column<int>(type: "int", nullable: true),
                    ReadAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    RowVersion = table.Column<byte[]>(type: "rowversion", rowVersion: true, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ProductUsages", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "SummaryReports",
                schema: "security",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    System = table.Column<string>(type: "nvarchar(32)", maxLength: 32, nullable: false),
                    ExternalId = table.Column<long>(type: "bigint", nullable: false),
                    OrganizationId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    ExternalOrganizationId = table.Column<long>(type: "bigint", nullable: false),
                    Type = table.Column<string>(type: "nvarchar(32)", maxLength: 32, nullable: false),
                    PeriodStart = table.Column<DateOnly>(type: "date", nullable: true),
                    PeriodEnd = table.Column<DateOnly>(type: "date", nullable: true),
                    Url = table.Column<string>(type: "nvarchar(512)", maxLength: 512, nullable: true),
                    AgentsCount = table.Column<int>(type: "int", nullable: true),
                    IncidentsReported = table.Column<int>(type: "int", nullable: true),
                    IncidentsResolved = table.Column<int>(type: "int", nullable: true),
                    SignalsDetected = table.Column<long>(type: "bigint", nullable: true),
                    SignalsInvestigated = table.Column<long>(type: "bigint", nullable: true),
                    EventsAnalyzed = table.Column<long>(type: "bigint", nullable: true),
                    CreatedAtSource = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    ReadAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    RowVersion = table.Column<byte[]>(type: "rowversion", rowVersion: true, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_SummaryReports", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "IncidentComments",
                schema: "security",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    IncidentId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    ExternalId = table.Column<long>(type: "bigint", nullable: false),
                    Body = table.Column<string>(type: "nvarchar(4000)", maxLength: 4000, nullable: false),
                    Author = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: true),
                    CreatedAtSource = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    UpdatedAtSource = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    RowVersion = table.Column<byte[]>(type: "rowversion", rowVersion: true, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_IncidentComments", x => x.Id);
                    table.ForeignKey(
                        name: "FK_IncidentComments_Incidents_IncidentId",
                        column: x => x.IncidentId,
                        principalSchema: "security",
                        principalTable: "Incidents",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "Remediations",
                schema: "security",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    IncidentId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    ExternalId = table.Column<long>(type: "bigint", nullable: false),
                    Type = table.Column<string>(type: "nvarchar(32)", maxLength: 32, nullable: false),
                    Action = table.Column<string>(type: "nvarchar(512)", maxLength: 512, nullable: true),
                    Parameters = table.Column<string>(type: "nvarchar(4000)", maxLength: 4000, nullable: true),
                    Status = table.Column<string>(type: "nvarchar(32)", maxLength: 32, nullable: false),
                    ApprovedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    ApprovedBy = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: true),
                    CompletedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    RowVersion = table.Column<byte[]>(type: "rowversion", rowVersion: true, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Remediations", x => x.Id);
                    table.ForeignKey(
                        name: "FK_Remediations_Incidents_IncidentId",
                        column: x => x.IncidentId,
                        principalSchema: "security",
                        principalTable: "Incidents",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_IncidentComments_IncidentId_ExternalId",
                schema: "security",
                table: "IncidentComments",
                columns: new[] { "IncidentId", "ExternalId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_Incidents_OrganizationId_Status",
                schema: "security",
                table: "Incidents",
                columns: new[] { "OrganizationId", "Status" });

            migrationBuilder.CreateIndex(
                name: "IX_Incidents_System_ExternalId",
                schema: "security",
                table: "Incidents",
                columns: new[] { "System", "ExternalId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_Notices_OrganizationId_Status",
                schema: "security",
                table: "Notices",
                columns: new[] { "OrganizationId", "Status" });

            migrationBuilder.CreateIndex(
                name: "IX_Notices_System_Kind_ExternalId",
                schema: "security",
                table: "Notices",
                columns: new[] { "System", "Kind", "ExternalId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_ProductUsages_OrganizationId",
                schema: "security",
                table: "ProductUsages",
                column: "OrganizationId");

            migrationBuilder.CreateIndex(
                name: "IX_ProductUsages_System_ExternalOrganizationId",
                schema: "security",
                table: "ProductUsages",
                columns: new[] { "System", "ExternalOrganizationId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_Remediations_IncidentId_ExternalId",
                schema: "security",
                table: "Remediations",
                columns: new[] { "IncidentId", "ExternalId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_SummaryReports_OrganizationId_PeriodStart",
                schema: "security",
                table: "SummaryReports",
                columns: new[] { "OrganizationId", "PeriodStart" });

            migrationBuilder.CreateIndex(
                name: "IX_SummaryReports_System_ExternalId",
                schema: "security",
                table: "SummaryReports",
                columns: new[] { "System", "ExternalId" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "IncidentComments",
                schema: "security");

            migrationBuilder.DropTable(
                name: "Notices",
                schema: "security");

            migrationBuilder.DropTable(
                name: "ProductUsages",
                schema: "security");

            migrationBuilder.DropTable(
                name: "Remediations",
                schema: "security");

            migrationBuilder.DropTable(
                name: "SummaryReports",
                schema: "security");

            migrationBuilder.DropTable(
                name: "Incidents",
                schema: "security");
        }
    }
}
