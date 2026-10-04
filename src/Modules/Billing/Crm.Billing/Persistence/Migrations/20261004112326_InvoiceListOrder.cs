using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crm.Billing.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class InvoiceListOrder : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateIndex(
                name: "IX_Invoices_InvoiceDate_InvoiceNo_Id",
                schema: "billing",
                table: "Invoices",
                columns: new[] { "InvoiceDate", "InvoiceNo", "Id" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_Invoices_InvoiceDate_InvoiceNo_Id",
                schema: "billing",
                table: "Invoices");
        }
    }
}
