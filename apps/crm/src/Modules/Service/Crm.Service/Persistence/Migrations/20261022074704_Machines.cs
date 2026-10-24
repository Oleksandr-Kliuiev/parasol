using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crm.Service.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class Machines : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "MacAddresses",
                schema: "service",
                table: "Devices",
                type: "nvarchar(1024)",
                maxLength: 1024,
                nullable: true);

            migrationBuilder.AddColumn<Guid>(
                name: "MachineId",
                schema: "service",
                table: "Devices",
                type: "uniqueidentifier",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "SerialNumber",
                schema: "service",
                table: "Devices",
                type: "nvarchar(128)",
                maxLength: 128,
                nullable: true);

            migrationBuilder.CreateTable(
                name: "MachineLinkDecisions",
                schema: "service",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    OrganizationId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    DeviceId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    OtherDeviceId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    Kind = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: false),
                    RowVersion = table.Column<byte[]>(type: "rowversion", rowVersion: true, nullable: true),
                    CreatedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    ModifiedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    ModifiedBy = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    IsDeleted = table.Column<bool>(type: "bit", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_MachineLinkDecisions", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "MachineProposals",
                schema: "service",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    OrganizationId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    MachineId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    OtherMachineId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    DeviceId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    OtherDeviceId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    Evidence = table.Column<int>(type: "int", nullable: false),
                    FoundAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    RowVersion = table.Column<byte[]>(type: "rowversion", rowVersion: true, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_MachineProposals", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "Machines",
                schema: "service",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    OrganizationId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    Name = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: false),
                    Type = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: false),
                    Os = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: true),
                    Online = table.Column<bool>(type: "bit", nullable: false),
                    LastSeenAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    CreatedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    RemovedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    RowVersion = table.Column<byte[]>(type: "rowversion", rowVersion: true, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Machines", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_Devices_MachineId",
                schema: "service",
                table: "Devices",
                column: "MachineId",
                filter: "[MachineId] IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "IX_MachineLinkDecisions_DeviceId_OtherDeviceId",
                schema: "service",
                table: "MachineLinkDecisions",
                columns: new[] { "DeviceId", "OtherDeviceId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_MachineLinkDecisions_OrganizationId",
                schema: "service",
                table: "MachineLinkDecisions",
                column: "OrganizationId");

            migrationBuilder.CreateIndex(
                name: "IX_MachineProposals_MachineId_OtherMachineId",
                schema: "service",
                table: "MachineProposals",
                columns: new[] { "MachineId", "OtherMachineId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_MachineProposals_OrganizationId",
                schema: "service",
                table: "MachineProposals",
                column: "OrganizationId");

            migrationBuilder.CreateIndex(
                name: "IX_MachineProposals_OtherMachineId",
                schema: "service",
                table: "MachineProposals",
                column: "OtherMachineId");

            migrationBuilder.CreateIndex(
                name: "IX_Machines_OrganizationId_RemovedAt_Name",
                schema: "service",
                table: "Machines",
                columns: new[] { "OrganizationId", "RemovedAt", "Name" });

            // M40: every device stored so far is a machine of its own until the next device read matches the customer's devices.
            migrationBuilder.Sql("""
                INSERT INTO [service].[Machines] ([Id], [OrganizationId], [Name], [Type], [Os], [Online], [LastSeenAt], [CreatedAt], [RemovedAt])
                SELECT d.[Id], d.[OrganizationId], d.[MachineName], d.[Type], d.[Os], d.[Online], d.[LastSeenAt], d.[FirstSeenAt], d.[RemovedAt]
                FROM [service].[Devices] d
                WHERE d.[MachineId] IS NULL;
                UPDATE [service].[Devices] SET [MachineId] = [Id] WHERE [MachineId] IS NULL;
                """);

            migrationBuilder.AddForeignKey(
                name: "FK_Devices_Machines_MachineId",
                schema: "service",
                table: "Devices",
                column: "MachineId",
                principalSchema: "service",
                principalTable: "Machines",
                principalColumn: "Id",
                onDelete: ReferentialAction.Restrict);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropForeignKey(
                name: "FK_Devices_Machines_MachineId",
                schema: "service",
                table: "Devices");

            migrationBuilder.DropTable(
                name: "MachineLinkDecisions",
                schema: "service");

            migrationBuilder.DropTable(
                name: "MachineProposals",
                schema: "service");

            migrationBuilder.DropTable(
                name: "Machines",
                schema: "service");

            migrationBuilder.DropIndex(
                name: "IX_Devices_MachineId",
                schema: "service",
                table: "Devices");

            migrationBuilder.DropColumn(
                name: "MacAddresses",
                schema: "service",
                table: "Devices");

            migrationBuilder.DropColumn(
                name: "MachineId",
                schema: "service",
                table: "Devices");

            migrationBuilder.DropColumn(
                name: "SerialNumber",
                schema: "service",
                table: "Devices");
        }
    }
}
