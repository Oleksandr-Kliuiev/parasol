using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crm.Service.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class DeviceInventory : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "AgentVersion",
                schema: "service",
                table: "Devices",
                type: "nvarchar(64)",
                maxLength: 64,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "AlternateId",
                schema: "service",
                table: "Devices",
                type: "nvarchar(128)",
                maxLength: 128,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "BiosVersion",
                schema: "service",
                table: "Devices",
                type: "nvarchar(128)",
                maxLength: 128,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "Disks",
                schema: "service",
                table: "Devices",
                type: "nvarchar(2000)",
                maxLength: 2000,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "DomainName",
                schema: "service",
                table: "Devices",
                type: "nvarchar(256)",
                maxLength: 256,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "IpAddresses",
                schema: "service",
                table: "Devices",
                type: "nvarchar(1024)",
                maxLength: 1024,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "LastLoginUser",
                schema: "service",
                table: "Devices",
                type: "nvarchar(256)",
                maxLength: 256,
                nullable: true);

            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "LastRebootAt",
                schema: "service",
                table: "Devices",
                type: "datetimeoffset",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "LoggedInUsers",
                schema: "service",
                table: "Devices",
                type: "nvarchar(512)",
                maxLength: 512,
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "Memory",
                schema: "service",
                table: "Devices",
                type: "int",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "Model",
                schema: "service",
                table: "Devices",
                type: "nvarchar(256)",
                maxLength: 256,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "Motherboard",
                schema: "service",
                table: "Devices",
                type: "nvarchar(256)",
                maxLength: 256,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "OsBuild",
                schema: "service",
                table: "Devices",
                type: "nvarchar(64)",
                maxLength: 64,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "OsVersion",
                schema: "service",
                table: "Devices",
                type: "nvarchar(64)",
                maxLength: 64,
                nullable: true);

            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "PatchesCollectedAt",
                schema: "service",
                table: "Devices",
                type: "datetimeoffset",
                nullable: true);

            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "PatchesReadAt",
                schema: "service",
                table: "Devices",
                type: "datetimeoffset",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "Processor",
                schema: "service",
                table: "Devices",
                type: "nvarchar(256)",
                maxLength: 256,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "ProcessorClock",
                schema: "service",
                table: "Devices",
                type: "nvarchar(32)",
                maxLength: 32,
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "ProcessorCores",
                schema: "service",
                table: "Devices",
                type: "int",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "PublicIp",
                schema: "service",
                table: "Devices",
                type: "nvarchar(64)",
                maxLength: 64,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "Vendor",
                schema: "service",
                table: "Devices",
                type: "nvarchar(128)",
                maxLength: 128,
                nullable: true);

            migrationBuilder.CreateTable(
                name: "DevicePatches",
                schema: "service",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    DeviceId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    Installed = table.Column<bool>(type: "bit", nullable: false),
                    KbId = table.Column<string>(type: "nvarchar(32)", maxLength: 32, nullable: true),
                    Name = table.Column<string>(type: "nvarchar(512)", maxLength: 512, nullable: false),
                    Class = table.Column<string>(type: "nvarchar(128)", maxLength: 128, nullable: true),
                    InstalledAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    Status = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: true),
                    RowVersion = table.Column<byte[]>(type: "rowversion", rowVersion: true, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_DevicePatches", x => x.Id);
                    table.ForeignKey(
                        name: "FK_DevicePatches_Devices_DeviceId",
                        column: x => x.DeviceId,
                        principalSchema: "service",
                        principalTable: "Devices",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_DevicePatches_DeviceId_Installed",
                schema: "service",
                table: "DevicePatches",
                columns: new[] { "DeviceId", "Installed" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "DevicePatches",
                schema: "service");

            migrationBuilder.DropColumn(
                name: "AgentVersion",
                schema: "service",
                table: "Devices");

            migrationBuilder.DropColumn(
                name: "AlternateId",
                schema: "service",
                table: "Devices");

            migrationBuilder.DropColumn(
                name: "BiosVersion",
                schema: "service",
                table: "Devices");

            migrationBuilder.DropColumn(
                name: "Disks",
                schema: "service",
                table: "Devices");

            migrationBuilder.DropColumn(
                name: "DomainName",
                schema: "service",
                table: "Devices");

            migrationBuilder.DropColumn(
                name: "IpAddresses",
                schema: "service",
                table: "Devices");

            migrationBuilder.DropColumn(
                name: "LastLoginUser",
                schema: "service",
                table: "Devices");

            migrationBuilder.DropColumn(
                name: "LastRebootAt",
                schema: "service",
                table: "Devices");

            migrationBuilder.DropColumn(
                name: "LoggedInUsers",
                schema: "service",
                table: "Devices");

            migrationBuilder.DropColumn(
                name: "Memory",
                schema: "service",
                table: "Devices");

            migrationBuilder.DropColumn(
                name: "Model",
                schema: "service",
                table: "Devices");

            migrationBuilder.DropColumn(
                name: "Motherboard",
                schema: "service",
                table: "Devices");

            migrationBuilder.DropColumn(
                name: "OsBuild",
                schema: "service",
                table: "Devices");

            migrationBuilder.DropColumn(
                name: "OsVersion",
                schema: "service",
                table: "Devices");

            migrationBuilder.DropColumn(
                name: "PatchesCollectedAt",
                schema: "service",
                table: "Devices");

            migrationBuilder.DropColumn(
                name: "PatchesReadAt",
                schema: "service",
                table: "Devices");

            migrationBuilder.DropColumn(
                name: "Processor",
                schema: "service",
                table: "Devices");

            migrationBuilder.DropColumn(
                name: "ProcessorClock",
                schema: "service",
                table: "Devices");

            migrationBuilder.DropColumn(
                name: "ProcessorCores",
                schema: "service",
                table: "Devices");

            migrationBuilder.DropColumn(
                name: "PublicIp",
                schema: "service",
                table: "Devices");

            migrationBuilder.DropColumn(
                name: "Vendor",
                schema: "service",
                table: "Devices");
        }
    }
}
