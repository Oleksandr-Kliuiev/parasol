using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crm.Billing.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class InvoiceBalanceMovements : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "Kind",
                schema: "billing",
                table: "InvoicePayments",
                type: "nvarchar(24)",
                maxLength: 24,
                nullable: false,
                defaultValue: "BalanceDecrease");

            migrationBuilder.AddColumn<string>(
                name: "Source",
                schema: "billing",
                table: "InvoicePayments",
                type: "nvarchar(200)",
                maxLength: 200,
                nullable: false,
                defaultValue: "Inferred from the remaining amount");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "Kind",
                schema: "billing",
                table: "InvoicePayments");

            migrationBuilder.DropColumn(
                name: "Source",
                schema: "billing",
                table: "InvoicePayments");
        }
    }
}
