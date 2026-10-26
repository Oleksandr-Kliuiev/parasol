using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crm.Service.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class TicketConversations : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "CommentsReadAt",
                schema: "service",
                table: "Tickets",
                type: "datetimeoffset",
                nullable: true);

            migrationBuilder.CreateTable(
                name: "TicketComments",
                schema: "service",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    TicketId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    System = table.Column<string>(type: "nvarchar(32)", maxLength: 32, nullable: false),
                    ExternalId = table.Column<string>(type: "nvarchar(128)", maxLength: 128, nullable: false),
                    Text = table.Column<string>(type: "nvarchar(max)", nullable: false),
                    IsInternal = table.Column<bool>(type: "bit", nullable: false),
                    Author = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: false),
                    AuthorName = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: true),
                    TechnicianUserId = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    CreatedAtSource = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    SyncedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    RowVersion = table.Column<byte[]>(type: "rowversion", rowVersion: true, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_TicketComments", x => x.Id);
                    table.ForeignKey(
                        name: "FK_TicketComments_Tickets_TicketId",
                        column: x => x.TicketId,
                        principalSchema: "service",
                        principalTable: "Tickets",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_Tickets_IsOpen_CreatedAtSource",
                schema: "service",
                table: "Tickets",
                columns: new[] { "IsOpen", "CreatedAtSource" });

            migrationBuilder.CreateIndex(
                name: "IX_Tickets_TechnicianUserId_IsOpen",
                schema: "service",
                table: "Tickets",
                columns: new[] { "TechnicianUserId", "IsOpen" },
                filter: "[TechnicianUserId] IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "IX_TicketComments_System_ExternalId",
                schema: "service",
                table: "TicketComments",
                columns: new[] { "System", "ExternalId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_TicketComments_TicketId_CreatedAtSource",
                schema: "service",
                table: "TicketComments",
                columns: new[] { "TicketId", "CreatedAtSource" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "TicketComments",
                schema: "service");

            migrationBuilder.DropIndex(
                name: "IX_Tickets_IsOpen_CreatedAtSource",
                schema: "service",
                table: "Tickets");

            migrationBuilder.DropIndex(
                name: "IX_Tickets_TechnicianUserId_IsOpen",
                schema: "service",
                table: "Tickets");

            migrationBuilder.DropColumn(
                name: "CommentsReadAt",
                schema: "service",
                table: "Tickets");
        }
    }
}
