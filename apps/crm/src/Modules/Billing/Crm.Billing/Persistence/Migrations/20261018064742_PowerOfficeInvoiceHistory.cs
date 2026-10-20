using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crm.Billing.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class PowerOfficeInvoiceHistory : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_Invoices_System_InvoiceNo",
                schema: "billing",
                table: "Invoices");

            migrationBuilder.AddColumn<string>(
                name: "DocumentKind",
                schema: "billing",
                table: "Invoices",
                type: "nvarchar(24)",
                maxLength: 24,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "ExternalCustomerId",
                schema: "billing",
                table: "Invoices",
                type: "nvarchar(64)",
                maxLength: 64,
                nullable: true);

            migrationBuilder.AddColumn<Guid>(
                name: "ExternalId",
                schema: "billing",
                table: "Invoices",
                type: "uniqueidentifier",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "HistoryJson",
                schema: "billing",
                table: "Invoices",
                type: "nvarchar(max)",
                nullable: true);

            migrationBuilder.CreateIndex(
                name: "IX_Invoices_System_ExternalId",
                schema: "billing",
                table: "Invoices",
                columns: new[] { "System", "ExternalId" },
                unique: true,
                filter: "[ExternalId] IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "IX_Invoices_System_InvoiceNo",
                schema: "billing",
                table: "Invoices",
                columns: new[] { "System", "InvoiceNo" },
                unique: true,
                filter: "[ExternalId] IS NULL");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            // An automatic rollback must never discard an imported historical document or its lines.
            migrationBuilder.Sql("IF EXISTS (SELECT 1 FROM [billing].[Invoices] WHERE [ExternalId] IS NOT NULL OR [HistoryJson] IS NOT NULL) THROW 51000, 'Export and reconcile historical invoices before rolling back this migration.', 1;");
            migrationBuilder.DropIndex(
                name: "IX_Invoices_System_ExternalId",
                schema: "billing",
                table: "Invoices");

            migrationBuilder.DropIndex(
                name: "IX_Invoices_System_InvoiceNo",
                schema: "billing",
                table: "Invoices");

            migrationBuilder.DropColumn(
                name: "DocumentKind",
                schema: "billing",
                table: "Invoices");

            migrationBuilder.DropColumn(
                name: "ExternalCustomerId",
                schema: "billing",
                table: "Invoices");

            migrationBuilder.DropColumn(
                name: "ExternalId",
                schema: "billing",
                table: "Invoices");

            migrationBuilder.DropColumn(
                name: "HistoryJson",
                schema: "billing",
                table: "Invoices");

            migrationBuilder.CreateIndex(
                name: "IX_Invoices_System_InvoiceNo",
                schema: "billing",
                table: "Invoices",
                columns: new[] { "System", "InvoiceNo" },
                unique: true);
        }
    }
}
