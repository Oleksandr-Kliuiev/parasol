using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crm.Customers.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class OrganizationGroup : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<bool>(
                name: "BilledThroughParent",
                schema: "customers",
                table: "Organizations",
                type: "bit",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<Guid>(
                name: "ParentId",
                schema: "customers",
                table: "Organizations",
                type: "uniqueidentifier",
                nullable: true);

            migrationBuilder.CreateIndex(
                name: "IX_Organizations_ParentId",
                schema: "customers",
                table: "Organizations",
                column: "ParentId",
                filter: "[ParentId] IS NOT NULL");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_Organizations_ParentId",
                schema: "customers",
                table: "Organizations");

            migrationBuilder.DropColumn(
                name: "BilledThroughParent",
                schema: "customers",
                table: "Organizations");

            migrationBuilder.DropColumn(
                name: "ParentId",
                schema: "customers",
                table: "Organizations");
        }
    }
}
