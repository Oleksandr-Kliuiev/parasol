using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crm.Billing.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class ChargeIdentity : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "ChangeReason",
                schema: "billing",
                table: "BillingLines",
                type: "nvarchar(512)",
                maxLength: 512,
                nullable: true);

            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "ChangedAt",
                schema: "billing",
                table: "BillingLines",
                type: "datetimeoffset",
                nullable: true);

            migrationBuilder.AddColumn<Guid>(
                name: "ChangedBy",
                schema: "billing",
                table: "BillingLines",
                type: "uniqueidentifier",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "Conflict",
                schema: "billing",
                table: "BillingLines",
                type: "nvarchar(24)",
                maxLength: 24,
                nullable: false,
                defaultValue: "None");

            migrationBuilder.AddColumn<string>(
                name: "Decision",
                schema: "billing",
                table: "BillingLines",
                type: "nvarchar(16)",
                maxLength: 16,
                nullable: false,
                defaultValue: "None");

            migrationBuilder.AddColumn<string>(
                name: "DecisionSignature",
                schema: "billing",
                table: "BillingLines",
                type: "nvarchar(256)",
                maxLength: 256,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "Origin",
                schema: "billing",
                table: "BillingLines",
                type: "nvarchar(16)",
                maxLength: 16,
                nullable: false,
                defaultValue: "Collected");

            migrationBuilder.AddColumn<string>(
                name: "SourceDescription",
                schema: "billing",
                table: "BillingLines",
                type: "nvarchar(512)",
                maxLength: 512,
                nullable: true);

            migrationBuilder.AddColumn<decimal>(
                name: "SourceDiscountPct",
                schema: "billing",
                table: "BillingLines",
                type: "decimal(5,2)",
                precision: 5,
                scale: 2,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "SourceKey",
                schema: "billing",
                table: "BillingLines",
                type: "nvarchar(128)",
                maxLength: 128,
                nullable: true);

            migrationBuilder.AddColumn<Guid>(
                name: "SourceOrganizationId",
                schema: "billing",
                table: "BillingLines",
                type: "uniqueidentifier",
                nullable: true);

            migrationBuilder.AddColumn<decimal>(
                name: "SourceQuantity",
                schema: "billing",
                table: "BillingLines",
                type: "decimal(18,2)",
                precision: 18,
                scale: 2,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "SourceSignature",
                schema: "billing",
                table: "BillingLines",
                type: "nvarchar(256)",
                maxLength: 256,
                nullable: true);

            migrationBuilder.AddColumn<decimal>(
                name: "SourceUnitPrice",
                schema: "billing",
                table: "BillingLines",
                type: "decimal(18,4)",
                precision: 18,
                scale: 4,
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "Revision",
                schema: "billing",
                table: "BillingBases",
                type: "int",
                nullable: false,
                defaultValue: 0);

            // Expand only: existing amounts and references stay as they are (FINANCIAL_DESIGN). A line added by hand had no
            // source references; a collected line keeps Origin = Collected and no charge key, so its next collect either
            // replaces it (plain) or flags it for Finance (corrected) instead of guessing a key (ADR-011).
            migrationBuilder.Sql(
                "UPDATE [billing].[BillingLines] SET [Origin] = N'Manual' WHERE [ManuallyAdjusted] = 1 AND [SourceRefs] IS NULL;");

            migrationBuilder.CreateIndex(
                name: "IX_BillingLines_BasisId_SourceKey",
                schema: "billing",
                table: "BillingLines",
                columns: new[] { "BasisId", "SourceKey" },
                unique: true,
                filter: "[SourceKey] IS NOT NULL AND [IsDeleted] = 0");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_BillingLines_BasisId_SourceKey",
                schema: "billing",
                table: "BillingLines");

            migrationBuilder.DropColumn(
                name: "ChangeReason",
                schema: "billing",
                table: "BillingLines");

            migrationBuilder.DropColumn(
                name: "ChangedAt",
                schema: "billing",
                table: "BillingLines");

            migrationBuilder.DropColumn(
                name: "ChangedBy",
                schema: "billing",
                table: "BillingLines");

            migrationBuilder.DropColumn(
                name: "Conflict",
                schema: "billing",
                table: "BillingLines");

            migrationBuilder.DropColumn(
                name: "Decision",
                schema: "billing",
                table: "BillingLines");

            migrationBuilder.DropColumn(
                name: "DecisionSignature",
                schema: "billing",
                table: "BillingLines");

            migrationBuilder.DropColumn(
                name: "Origin",
                schema: "billing",
                table: "BillingLines");

            migrationBuilder.DropColumn(
                name: "SourceDescription",
                schema: "billing",
                table: "BillingLines");

            migrationBuilder.DropColumn(
                name: "SourceDiscountPct",
                schema: "billing",
                table: "BillingLines");

            migrationBuilder.DropColumn(
                name: "SourceKey",
                schema: "billing",
                table: "BillingLines");

            migrationBuilder.DropColumn(
                name: "SourceOrganizationId",
                schema: "billing",
                table: "BillingLines");

            migrationBuilder.DropColumn(
                name: "SourceQuantity",
                schema: "billing",
                table: "BillingLines");

            migrationBuilder.DropColumn(
                name: "SourceSignature",
                schema: "billing",
                table: "BillingLines");

            migrationBuilder.DropColumn(
                name: "SourceUnitPrice",
                schema: "billing",
                table: "BillingLines");

            migrationBuilder.DropColumn(
                name: "Revision",
                schema: "billing",
                table: "BillingBases");
        }
    }
}
