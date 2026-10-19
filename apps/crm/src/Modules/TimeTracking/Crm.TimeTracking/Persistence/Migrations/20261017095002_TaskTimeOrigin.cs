using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crm.TimeTracking.Persistence.Migrations;

public partial class TaskTimeOrigin : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder) =>
        migrationBuilder.AddColumn<Guid>(name: "SourceActivityId", schema: "time", table: "TimeEntries", type: "uniqueidentifier", nullable: true);

    protected override void Down(MigrationBuilder migrationBuilder) =>
        migrationBuilder.DropColumn(name: "SourceActivityId", schema: "time", table: "TimeEntries");
}
