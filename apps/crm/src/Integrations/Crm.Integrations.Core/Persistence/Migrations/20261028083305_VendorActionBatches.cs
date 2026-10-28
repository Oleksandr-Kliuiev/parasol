using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crm.Integrations.Core.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class VendorActionBatches : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<Guid>(
                name: "BatchId",
                schema: "integration",
                table: "VendorActions",
                type: "uniqueidentifier",
                nullable: true);

            migrationBuilder.CreateIndex(
                name: "IX_VendorActions_BatchId",
                schema: "integration",
                table: "VendorActions",
                column: "BatchId",
                filter: "[BatchId] IS NOT NULL");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_VendorActions_BatchId",
                schema: "integration",
                table: "VendorActions");

            migrationBuilder.DropColumn(
                name: "BatchId",
                schema: "integration",
                table: "VendorActions");
        }
    }
}
