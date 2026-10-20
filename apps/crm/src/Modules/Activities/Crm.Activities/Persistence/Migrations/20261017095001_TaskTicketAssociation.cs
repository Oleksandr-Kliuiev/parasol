using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crm.Activities.Persistence.Migrations;

public partial class TaskTicketAssociation : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder) =>
        migrationBuilder.AddColumn<Guid>(name: "LinkedTicketId", schema: "activities", table: "Activities", type: "uniqueidentifier", nullable: true);

    protected override void Down(MigrationBuilder migrationBuilder) =>
        migrationBuilder.DropColumn(name: "LinkedTicketId", schema: "activities", table: "Activities");
}
