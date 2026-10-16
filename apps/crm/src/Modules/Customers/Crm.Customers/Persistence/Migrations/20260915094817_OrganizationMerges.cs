using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crm.Customers.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class OrganizationMerges : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<Guid>(
                name: "MergedIntoId",
                schema: "customers",
                table: "Organizations",
                type: "uniqueidentifier",
                nullable: true);

            migrationBuilder.CreateTable(
                name: "DuplicateDismissals",
                schema: "customers",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    FirstOrganizationId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    SecondOrganizationId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    RowVersion = table.Column<byte[]>(type: "rowversion", rowVersion: true, nullable: true),
                    CreatedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    ModifiedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    ModifiedBy = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    IsDeleted = table.Column<bool>(type: "bit", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_DuplicateDismissals", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "OrganizationMerges",
                schema: "customers",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    TargetId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    SourceId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    TargetBefore = table.Column<string>(type: "nvarchar(max)", nullable: false),
                    SourceBefore = table.Column<string>(type: "nvarchar(max)", nullable: false),
                    MovedAffiliationIds = table.Column<string>(type: "nvarchar(max)", nullable: false),
                    UndoneAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    TargetModifiedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    RowVersion = table.Column<byte[]>(type: "rowversion", rowVersion: true, nullable: true),
                    CreatedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    ModifiedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    ModifiedBy = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    IsDeleted = table.Column<bool>(type: "bit", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_OrganizationMerges", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_Organizations_MergedIntoId",
                schema: "customers",
                table: "Organizations",
                column: "MergedIntoId",
                filter: "[MergedIntoId] IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "IX_DuplicateDismissals_FirstOrganizationId_SecondOrganizationId",
                schema: "customers",
                table: "DuplicateDismissals",
                columns: new[] { "FirstOrganizationId", "SecondOrganizationId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_OrganizationMerges_SourceId",
                schema: "customers",
                table: "OrganizationMerges",
                column: "SourceId");

            migrationBuilder.CreateIndex(
                name: "IX_OrganizationMerges_TargetId",
                schema: "customers",
                table: "OrganizationMerges",
                column: "TargetId");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "DuplicateDismissals",
                schema: "customers");

            migrationBuilder.DropTable(
                name: "OrganizationMerges",
                schema: "customers");

            migrationBuilder.DropIndex(
                name: "IX_Organizations_MergedIntoId",
                schema: "customers",
                table: "Organizations");

            migrationBuilder.DropColumn(
                name: "MergedIntoId",
                schema: "customers",
                table: "Organizations");
        }
    }
}
