using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crm.Service.Persistence.Migrations;

/// <summary>Expand only. Historical mirrors keep unknown owner proof and unknown import time.</summary>
public partial class TicketOwnerProvenance : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.AddColumn<long>(name: "OwnerCustomerId", schema: "service", table: "Tickets", type: "bigint", nullable: true);
        migrationBuilder.AddColumn<Guid>(name: "OwnerLinkId", schema: "service", table: "Tickets", type: "uniqueidentifier", nullable: true);
        migrationBuilder.AddColumn<DateTimeOffset>(name: "ImportedAt", schema: "service", table: "Tickets", type: "datetimeoffset", nullable: true);
    }

    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropColumn(name: "OwnerCustomerId", schema: "service", table: "Tickets");
        migrationBuilder.DropColumn(name: "OwnerLinkId", schema: "service", table: "Tickets");
        migrationBuilder.DropColumn(name: "ImportedAt", schema: "service", table: "Tickets");
    }
}
