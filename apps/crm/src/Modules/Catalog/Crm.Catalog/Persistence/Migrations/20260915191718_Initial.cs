using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crm.Catalog.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class Initial : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.EnsureSchema(
                name: "catalog");

            migrationBuilder.CreateTable(
                name: "CustomerCategories",
                schema: "catalog",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    Code = table.Column<string>(type: "nvarchar(32)", maxLength: 32, nullable: false),
                    Name = table.Column<string>(type: "nvarchar(128)", maxLength: 128, nullable: false),
                    LicenseMarkupPct = table.Column<decimal>(type: "decimal(7,2)", precision: 7, scale: 2, nullable: false),
                    IsDefault = table.Column<bool>(type: "bit", nullable: false),
                    RowVersion = table.Column<byte[]>(type: "rowversion", rowVersion: true, nullable: true),
                    CreatedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    ModifiedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    ModifiedBy = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    IsDeleted = table.Column<bool>(type: "bit", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_CustomerCategories", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "OutboxMessages",
                schema: "catalog",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    Type = table.Column<string>(type: "nvarchar(500)", maxLength: 500, nullable: false),
                    Payload = table.Column<string>(type: "nvarchar(max)", nullable: false),
                    OccurredAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    CorrelationId = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: true),
                    ProcessedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    LockedUntil = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    Attempts = table.Column<int>(type: "int", nullable: false),
                    LastError = table.Column<string>(type: "nvarchar(max)", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_OutboxMessages", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "PriceLists",
                schema: "catalog",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    Name = table.Column<string>(type: "nvarchar(128)", maxLength: 128, nullable: false),
                    CustomerCategory = table.Column<string>(type: "nvarchar(32)", maxLength: 32, nullable: false),
                    ValidFrom = table.Column<DateOnly>(type: "date", nullable: false),
                    ValidTo = table.Column<DateOnly>(type: "date", nullable: true),
                    Currency = table.Column<string>(type: "nchar(3)", fixedLength: true, maxLength: 3, nullable: false),
                    Status = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: false),
                    RowVersion = table.Column<byte[]>(type: "rowversion", rowVersion: true, nullable: true),
                    CreatedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    ModifiedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    ModifiedBy = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    IsDeleted = table.Column<bool>(type: "bit", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_PriceLists", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "Products",
                schema: "catalog",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    Sku = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: false),
                    Name = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: false),
                    NameEn = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: true),
                    Description = table.Column<string>(type: "nvarchar(2000)", maxLength: 2000, nullable: true),
                    Type = table.Column<string>(type: "nvarchar(24)", maxLength: 24, nullable: false),
                    BusinessLine = table.Column<string>(type: "nvarchar(24)", maxLength: 24, nullable: false),
                    Unit = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: false),
                    BillingPeriod = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: false),
                    VatRate = table.Column<decimal>(type: "decimal(5,2)", precision: 5, scale: 2, nullable: false),
                    ListPrice = table.Column<decimal>(type: "decimal(18,2)", precision: 18, scale: 2, nullable: false),
                    UnitCost = table.Column<decimal>(type: "decimal(18,2)", precision: 18, scale: 2, nullable: true),
                    Currency = table.Column<string>(type: "nchar(3)", fixedLength: true, maxLength: 3, nullable: false),
                    MicrosoftOfferId = table.Column<string>(type: "nvarchar(128)", maxLength: 128, nullable: true),
                    CommitmentTerm = table.Column<string>(type: "nvarchar(8)", maxLength: 8, nullable: false),
                    AteraWorkType = table.Column<string>(type: "nvarchar(128)", maxLength: 128, nullable: true),
                    RevenueAccount = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: true),
                    IsActive = table.Column<bool>(type: "bit", nullable: false),
                    ComponentsJson = table.Column<string>(type: "nvarchar(max)", nullable: true),
                    RowVersion = table.Column<byte[]>(type: "rowversion", rowVersion: true, nullable: true),
                    CreatedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    ModifiedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    ModifiedBy = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    IsDeleted = table.Column<bool>(type: "bit", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Products", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "PriceListItems",
                schema: "catalog",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    PriceListId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    ProductId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    UnitPrice = table.Column<decimal>(type: "decimal(18,2)", precision: 18, scale: 2, nullable: false),
                    UnitCost = table.Column<decimal>(type: "decimal(18,2)", precision: 18, scale: 2, nullable: true),
                    PartnerPrice = table.Column<decimal>(type: "decimal(18,4)", precision: 18, scale: 4, nullable: true),
                    PartnerCurrency = table.Column<string>(type: "nchar(3)", fixedLength: true, maxLength: 3, nullable: true),
                    ExchangeRate = table.Column<decimal>(type: "decimal(18,6)", precision: 18, scale: 6, nullable: true),
                    RowVersion = table.Column<byte[]>(type: "rowversion", rowVersion: true, nullable: true),
                    CreatedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    ModifiedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    ModifiedBy = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    IsDeleted = table.Column<bool>(type: "bit", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_PriceListItems", x => x.Id);
                    table.ForeignKey(
                        name: "FK_PriceListItems_PriceLists_PriceListId",
                        column: x => x.PriceListId,
                        principalSchema: "catalog",
                        principalTable: "PriceLists",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_PriceListItems_Products_ProductId",
                        column: x => x.ProductId,
                        principalSchema: "catalog",
                        principalTable: "Products",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateIndex(
                name: "IX_CustomerCategories_Code",
                schema: "catalog",
                table: "CustomerCategories",
                column: "Code",
                unique: true,
                filter: "[IsDeleted] = 0");

            migrationBuilder.CreateIndex(
                name: "IX_OutboxMessages_ProcessedAt_OccurredAt",
                schema: "catalog",
                table: "OutboxMessages",
                columns: new[] { "ProcessedAt", "OccurredAt" });

            migrationBuilder.CreateIndex(
                name: "IX_PriceListItems_PriceListId_ProductId",
                schema: "catalog",
                table: "PriceListItems",
                columns: new[] { "PriceListId", "ProductId" },
                unique: true,
                filter: "[IsDeleted] = 0");

            migrationBuilder.CreateIndex(
                name: "IX_PriceListItems_ProductId",
                schema: "catalog",
                table: "PriceListItems",
                column: "ProductId");

            migrationBuilder.CreateIndex(
                name: "IX_PriceLists_CustomerCategory_ValidFrom",
                schema: "catalog",
                table: "PriceLists",
                columns: new[] { "CustomerCategory", "ValidFrom" });

            migrationBuilder.CreateIndex(
                name: "IX_Products_Name_Id",
                schema: "catalog",
                table: "Products",
                columns: new[] { "Name", "Id" });

            migrationBuilder.CreateIndex(
                name: "IX_Products_Sku",
                schema: "catalog",
                table: "Products",
                column: "Sku",
                unique: true,
                filter: "[IsDeleted] = 0");

            // Default customer category, so price lists can be created right after installation.
            migrationBuilder.InsertData(
                schema: "catalog",
                table: "CustomerCategories",
                columns: ["Id", "Code", "Name", "LicenseMarkupPct", "IsDefault", "CreatedAt", "IsDeleted"],
                values: new object[] { new Guid("00000000-0000-0000-0000-00000000c001"), "STANDARD", "Standard", 15m, true, new DateTimeOffset(2026, 9, 15, 0, 0, 0, TimeSpan.Zero), false });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "CustomerCategories",
                schema: "catalog");

            migrationBuilder.DropTable(
                name: "OutboxMessages",
                schema: "catalog");

            migrationBuilder.DropTable(
                name: "PriceListItems",
                schema: "catalog");

            migrationBuilder.DropTable(
                name: "PriceLists",
                schema: "catalog");

            migrationBuilder.DropTable(
                name: "Products",
                schema: "catalog");
        }
    }
}
