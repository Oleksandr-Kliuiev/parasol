using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crm.TimeTracking.Persistence.Migrations;

public partial class TimeEntryCreateReceipts : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder) =>
        migrationBuilder.CreateTable(
            name: "TimeEntryCreateReceipts",
            schema: "time",
            columns: table => new
            {
                ClientRequestId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                RequestedBy = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                IntentHash = table.Column<string>(type: "varchar(64)", unicode: false, maxLength: 64, nullable: false),
                TimeEntryId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                AcceptedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
            },
            constraints: table => table.PrimaryKey("PK_TimeEntryCreateReceipts", x => x.ClientRequestId));

    protected override void Down(MigrationBuilder migrationBuilder) =>
        migrationBuilder.DropTable(name: "TimeEntryCreateReceipts", schema: "time");
}
