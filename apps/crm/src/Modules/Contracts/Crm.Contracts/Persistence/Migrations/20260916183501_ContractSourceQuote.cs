using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crm.Contracts.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class ContractSourceQuote : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<Guid>(
                name: "SourceQuoteId",
                schema: "contracts",
                table: "Contracts",
                type: "uniqueidentifier",
                nullable: true);

            migrationBuilder.CreateIndex(
                name: "IX_Contracts_SourceQuoteId",
                schema: "contracts",
                table: "Contracts",
                column: "SourceQuoteId");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_Contracts_SourceQuoteId",
                schema: "contracts",
                table: "Contracts");

            migrationBuilder.DropColumn(
                name: "SourceQuoteId",
                schema: "contracts",
                table: "Contracts");
        }
    }
}
