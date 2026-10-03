using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crm.Customers.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class Initial : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.EnsureSchema(
                name: "customers");

            migrationBuilder.CreateTable(
                name: "Contacts",
                schema: "customers",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    FirstName = table.Column<string>(type: "nvarchar(128)", maxLength: 128, nullable: false),
                    LastName = table.Column<string>(type: "nvarchar(128)", maxLength: 128, nullable: false),
                    Email = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: true),
                    Phone = table.Column<string>(type: "nvarchar(32)", maxLength: 32, nullable: true),
                    MobilePhone = table.Column<string>(type: "nvarchar(32)", maxLength: 32, nullable: true),
                    PreferredLanguage = table.Column<string>(type: "nvarchar(8)", maxLength: 8, nullable: true),
                    RowVersion = table.Column<byte[]>(type: "rowversion", rowVersion: true, nullable: true),
                    CreatedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    ModifiedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    ModifiedBy = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    IsDeleted = table.Column<bool>(type: "bit", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Contacts", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "Organizations",
                schema: "customers",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    Name = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: false),
                    OrgNumber = table.Column<string>(type: "nchar(9)", fixedLength: true, maxLength: 9, nullable: true),
                    LegalForm = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: true),
                    Status = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: false),
                    NaceCode = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: true),
                    Website = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: true),
                    Phone = table.Column<string>(type: "nvarchar(32)", maxLength: 32, nullable: true),
                    Email = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: true),
                    InvoiceEmail = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: true),
                    EhfEnabled = table.Column<bool>(type: "bit", nullable: false),
                    AccountManagerId = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    PrimaryTechnicianId = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    Domains = table.Column<string>(type: "nvarchar(max)", nullable: false),
                    RegistryStatus = table.Column<string>(type: "nvarchar(24)", maxLength: 24, nullable: false),
                    RegistryCheckedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    RowVersion = table.Column<byte[]>(type: "rowversion", rowVersion: true, nullable: true),
                    BillingAddress_City = table.Column<string>(type: "nvarchar(128)", maxLength: 128, nullable: true),
                    BillingAddress_CountryCode = table.Column<string>(type: "nvarchar(2)", maxLength: 2, nullable: true),
                    BillingAddress_PostalCode = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: true),
                    BillingAddress_Street = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: true),
                    PostalAddress_City = table.Column<string>(type: "nvarchar(128)", maxLength: 128, nullable: true),
                    PostalAddress_CountryCode = table.Column<string>(type: "nvarchar(2)", maxLength: 2, nullable: true),
                    PostalAddress_PostalCode = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: true),
                    PostalAddress_Street = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: true),
                    VisitAddress_City = table.Column<string>(type: "nvarchar(128)", maxLength: 128, nullable: true),
                    VisitAddress_CountryCode = table.Column<string>(type: "nvarchar(2)", maxLength: 2, nullable: true),
                    VisitAddress_PostalCode = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: true),
                    VisitAddress_Street = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: true),
                    CreatedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    ModifiedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    ModifiedBy = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    IsDeleted = table.Column<bool>(type: "bit", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Organizations", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "OutboxMessages",
                schema: "customers",
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
                name: "OrganizationContacts",
                schema: "customers",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    OrganizationId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    ContactId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    Title = table.Column<string>(type: "nvarchar(128)", maxLength: 128, nullable: true),
                    Roles = table.Column<int>(type: "int", nullable: false),
                    IsPrimary = table.Column<bool>(type: "bit", nullable: false),
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
                    table.PrimaryKey("PK_OrganizationContacts", x => x.Id);
                    table.ForeignKey(
                        name: "FK_OrganizationContacts_Contacts_ContactId",
                        column: x => x.ContactId,
                        principalSchema: "customers",
                        principalTable: "Contacts",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_OrganizationContacts_Organizations_OrganizationId",
                        column: x => x.OrganizationId,
                        principalSchema: "customers",
                        principalTable: "Organizations",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateIndex(
                name: "IX_Contacts_Email",
                schema: "customers",
                table: "Contacts",
                column: "Email",
                unique: true,
                filter: "[Email] IS NOT NULL AND [IsDeleted] = 0");

            migrationBuilder.CreateIndex(
                name: "IX_Contacts_LastName_FirstName",
                schema: "customers",
                table: "Contacts",
                columns: new[] { "LastName", "FirstName" });

            migrationBuilder.CreateIndex(
                name: "IX_OrganizationContacts_ContactId",
                schema: "customers",
                table: "OrganizationContacts",
                column: "ContactId");

            migrationBuilder.CreateIndex(
                name: "IX_OrganizationContacts_OrganizationId_ContactId",
                schema: "customers",
                table: "OrganizationContacts",
                columns: new[] { "OrganizationId", "ContactId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_Organizations_AccountManagerId",
                schema: "customers",
                table: "Organizations",
                column: "AccountManagerId");

            migrationBuilder.CreateIndex(
                name: "IX_Organizations_Name_Id",
                schema: "customers",
                table: "Organizations",
                columns: new[] { "Name", "Id" });

            migrationBuilder.CreateIndex(
                name: "IX_Organizations_OrgNumber",
                schema: "customers",
                table: "Organizations",
                column: "OrgNumber",
                unique: true,
                filter: "[OrgNumber] IS NOT NULL AND [IsDeleted] = 0");

            migrationBuilder.CreateIndex(
                name: "IX_OutboxMessages_ProcessedAt_OccurredAt",
                schema: "customers",
                table: "OutboxMessages",
                columns: new[] { "ProcessedAt", "OccurredAt" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "OrganizationContacts",
                schema: "customers");

            migrationBuilder.DropTable(
                name: "OutboxMessages",
                schema: "customers");

            migrationBuilder.DropTable(
                name: "Contacts",
                schema: "customers");

            migrationBuilder.DropTable(
                name: "Organizations",
                schema: "customers");
        }
    }
}
