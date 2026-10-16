using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crm.Sales.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class Quotes : Migration
    {
        private static readonly DateTimeOffset Seeded = new(2026, 9, 16, 0, 0, 0, TimeSpan.Zero);

        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateSequence(
                name: "QuoteNumbers",
                schema: "sales");

            migrationBuilder.CreateTable(
                name: "Quotes",
                schema: "sales",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    Number = table.Column<string>(type: "nvarchar(32)", maxLength: 32, nullable: false),
                    RootId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    VersionNo = table.Column<int>(type: "int", nullable: false),
                    OrganizationId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    ContactId = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    OpportunityId = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    Title = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: false),
                    OwnerId = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    Language = table.Column<string>(type: "nvarchar(8)", maxLength: 8, nullable: false),
                    IssuedOn = table.Column<DateOnly>(type: "date", nullable: false),
                    ValidUntil = table.Column<DateOnly>(type: "date", nullable: false),
                    TermMonths = table.Column<int>(type: "int", nullable: false),
                    IntroText = table.Column<string>(type: "nvarchar(4000)", maxLength: 4000, nullable: true),
                    TermsText = table.Column<string>(type: "nvarchar(max)", maxLength: 8000, nullable: true),
                    CustomerReference = table.Column<string>(type: "nvarchar(128)", maxLength: 128, nullable: true),
                    Status = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: false),
                    MaxDiscountPct = table.Column<decimal>(type: "decimal(5,2)", precision: 5, scale: 2, nullable: false),
                    ApprovalRequestedBy = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    ApprovalRequestedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    ApprovedBy = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    ApprovedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    RejectedReason = table.Column<string>(type: "nvarchar(512)", maxLength: 512, nullable: true),
                    SentBy = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    SentAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    SentTo = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: true),
                    DecidedOn = table.Column<DateOnly>(type: "date", nullable: true),
                    DeclineReason = table.Column<string>(type: "nvarchar(512)", maxLength: 512, nullable: true),
                    RowVersion = table.Column<byte[]>(type: "rowversion", rowVersion: true, nullable: true),
                    CreatedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    ModifiedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    ModifiedBy = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    IsDeleted = table.Column<bool>(type: "bit", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Quotes", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "QuoteTemplates",
                schema: "sales",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    Name = table.Column<string>(type: "nvarchar(128)", maxLength: 128, nullable: false),
                    Language = table.Column<string>(type: "nvarchar(8)", maxLength: 8, nullable: false),
                    IntroText = table.Column<string>(type: "nvarchar(4000)", maxLength: 4000, nullable: true),
                    TermsText = table.Column<string>(type: "nvarchar(max)", maxLength: 8000, nullable: true),
                    FooterText = table.Column<string>(type: "nvarchar(512)", maxLength: 512, nullable: true),
                    ValidityDays = table.Column<int>(type: "int", nullable: false),
                    IsDefault = table.Column<bool>(type: "bit", nullable: false),
                    IsActive = table.Column<bool>(type: "bit", nullable: false),
                    RowVersion = table.Column<byte[]>(type: "rowversion", rowVersion: true, nullable: true),
                    CreatedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    ModifiedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    ModifiedBy = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    IsDeleted = table.Column<bool>(type: "bit", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_QuoteTemplates", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "QuoteLines",
                schema: "sales",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    QuoteId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    ProductId = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    Sku = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: true),
                    Name = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: false),
                    Description = table.Column<string>(type: "nvarchar(1000)", maxLength: 1000, nullable: true),
                    Quantity = table.Column<decimal>(type: "decimal(18,2)", precision: 18, scale: 2, nullable: false),
                    UnitPrice = table.Column<decimal>(type: "decimal(18,2)", precision: 18, scale: 2, nullable: false),
                    DiscountPct = table.Column<decimal>(type: "decimal(5,2)", precision: 5, scale: 2, nullable: false),
                    Recurrence = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: false),
                    VatRate = table.Column<decimal>(type: "decimal(5,2)", precision: 5, scale: 2, nullable: false),
                    Sort = table.Column<int>(type: "int", nullable: false),
                    RowVersion = table.Column<byte[]>(type: "rowversion", rowVersion: true, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_QuoteLines", x => x.Id);
                    table.ForeignKey(
                        name: "FK_QuoteLines_Quotes_QuoteId",
                        column: x => x.QuoteId,
                        principalSchema: "sales",
                        principalTable: "Quotes",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_QuoteLines_ProductId",
                schema: "sales",
                table: "QuoteLines",
                column: "ProductId");

            migrationBuilder.CreateIndex(
                name: "IX_QuoteLines_QuoteId",
                schema: "sales",
                table: "QuoteLines",
                column: "QuoteId");

            migrationBuilder.CreateIndex(
                name: "IX_Quotes_Number_VersionNo",
                schema: "sales",
                table: "Quotes",
                columns: new[] { "Number", "VersionNo" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_Quotes_OpportunityId",
                schema: "sales",
                table: "Quotes",
                column: "OpportunityId");

            migrationBuilder.CreateIndex(
                name: "IX_Quotes_OrganizationId_Status",
                schema: "sales",
                table: "Quotes",
                columns: new[] { "OrganizationId", "Status" });

            migrationBuilder.CreateIndex(
                name: "IX_Quotes_OwnerId",
                schema: "sales",
                table: "Quotes",
                column: "OwnerId");

            migrationBuilder.CreateIndex(
                name: "IX_Quotes_RootId_VersionNo",
                schema: "sales",
                table: "Quotes",
                columns: new[] { "RootId", "VersionNo" });

            migrationBuilder.CreateIndex(
                name: "IX_Quotes_Status_ValidUntil",
                schema: "sales",
                table: "Quotes",
                columns: new[] { "Status", "ValidUntil" });

            migrationBuilder.CreateIndex(
                name: "IX_QuoteTemplates_Language_IsActive",
                schema: "sales",
                table: "QuoteTemplates",
                columns: new[] { "Language", "IsActive" });

            // Two starting templates so the first quote already has wording; administrators edit them in the interface.
            migrationBuilder.InsertData(
                schema: "sales",
                table: "QuoteTemplates",
                columns: ["Id", "Name", "Language", "IntroText", "TermsText", "FooterText", "ValidityDays", "IsDefault", "IsActive", "CreatedAt", "IsDeleted"],
                values: new object[,]
                {
                    {
                        new Guid("00000000-0000-0000-0000-0000000055a1"), "Standard (norsk)", "nb",
                        "Takk for en hyggelig samtale. Under følger vårt tilbud på de tjenestene vi snakket om.",
                        "Avtalen løper fra oppstartsdato og faktureres månedlig på forskudd. Oppsigelsestid er tre måneder. "
                        + "Priser justeres årlig per 1. januar. Alle priser er eksklusive merverdiavgift.",
                        "Vardahei AS", 30, true, true, Seeded, false
                    },
                    {
                        new Guid("00000000-0000-0000-0000-0000000055a2"), "Standard (English)", "en",
                        "Thank you for the good conversation. Below is our quote for the services we discussed.",
                        "The agreement runs from the start date and is invoiced monthly in advance. The notice period is three months. "
                        + "Prices are adjusted annually on 1 January. All prices exclude VAT.",
                        "Vardahei AS", 30, true, true, Seeded, false
                    },
                });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "QuoteLines",
                schema: "sales");

            migrationBuilder.DropTable(
                name: "QuoteTemplates",
                schema: "sales");

            migrationBuilder.DropTable(
                name: "Quotes",
                schema: "sales");

            migrationBuilder.DropSequence(
                name: "QuoteNumbers",
                schema: "sales");
        }
    }
}
