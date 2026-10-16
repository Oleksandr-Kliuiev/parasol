using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crm.Contracts.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class Initial : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.EnsureSchema(
                name: "contracts");

            migrationBuilder.CreateSequence(
                name: "ContractNumbers",
                schema: "contracts");

            migrationBuilder.CreateTable(
                name: "OutboxMessages",
                schema: "contracts",
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
                name: "Reminders",
                schema: "contracts",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    Kind = table.Column<string>(type: "nvarchar(24)", maxLength: 24, nullable: false),
                    OrganizationId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    ContractId = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    HourBankId = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    AssigneeId = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    DueDate = table.Column<DateOnly>(type: "date", nullable: false),
                    DaysBefore = table.Column<int>(type: "int", nullable: true),
                    DeduplicationKey = table.Column<string>(type: "nvarchar(128)", maxLength: 128, nullable: false),
                    AcknowledgedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    AcknowledgedBy = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    RowVersion = table.Column<byte[]>(type: "rowversion", rowVersion: true, nullable: true),
                    CreatedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    ModifiedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    ModifiedBy = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    IsDeleted = table.Column<bool>(type: "bit", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Reminders", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "SlaPolicies",
                schema: "contracts",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    Name = table.Column<string>(type: "nvarchar(128)", maxLength: 128, nullable: false),
                    Coverage = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: false),
                    IncludedHoursPerMonth = table.Column<decimal>(type: "decimal(9,2)", precision: 9, scale: 2, nullable: false),
                    OverageRate = table.Column<decimal>(type: "decimal(18,2)", precision: 18, scale: 2, nullable: true),
                    AfterHoursMultiplier = table.Column<decimal>(type: "decimal(5,2)", precision: 5, scale: 2, nullable: false),
                    CoveredWorkTypes = table.Column<string>(type: "nvarchar(512)", maxLength: 512, nullable: true),
                    AteraValue = table.Column<string>(type: "nvarchar(128)", maxLength: 128, nullable: true),
                    IsActive = table.Column<bool>(type: "bit", nullable: false),
                    RowVersion = table.Column<byte[]>(type: "rowversion", rowVersion: true, nullable: true),
                    P1_ResolutionMinutes = table.Column<int>(type: "int", nullable: false),
                    P1_ResponseMinutes = table.Column<int>(type: "int", nullable: false),
                    P2_ResolutionMinutes = table.Column<int>(type: "int", nullable: false),
                    P2_ResponseMinutes = table.Column<int>(type: "int", nullable: false),
                    P3_ResolutionMinutes = table.Column<int>(type: "int", nullable: false),
                    P3_ResponseMinutes = table.Column<int>(type: "int", nullable: false),
                    P4_ResolutionMinutes = table.Column<int>(type: "int", nullable: false),
                    P4_ResponseMinutes = table.Column<int>(type: "int", nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    ModifiedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    ModifiedBy = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    IsDeleted = table.Column<bool>(type: "bit", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_SlaPolicies", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "Contracts",
                schema: "contracts",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    Number = table.Column<string>(type: "nvarchar(32)", maxLength: 32, nullable: false),
                    OrganizationId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    Title = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: false),
                    Type = table.Column<string>(type: "nvarchar(24)", maxLength: 24, nullable: false),
                    Status = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: false),
                    StartDate = table.Column<DateOnly>(type: "date", nullable: false),
                    EndDate = table.Column<DateOnly>(type: "date", nullable: true),
                    AutoRenew = table.Column<bool>(type: "bit", nullable: false),
                    RenewalTermMonths = table.Column<int>(type: "int", nullable: false),
                    NoticePeriodDays = table.Column<int>(type: "int", nullable: false),
                    SlaPolicyId = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    InvoiceFrequency = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: false),
                    InvoiceTiming = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: false),
                    PriceCategory = table.Column<string>(type: "nvarchar(32)", maxLength: 32, nullable: true),
                    Indexation = table.Column<bool>(type: "bit", nullable: false),
                    NextIndexationDate = table.Column<DateOnly>(type: "date", nullable: true),
                    CustomerReference = table.Column<string>(type: "nvarchar(128)", maxLength: 128, nullable: true),
                    OwnerId = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    Notes = table.Column<string>(type: "nvarchar(4000)", maxLength: 4000, nullable: true),
                    NoticeGivenOn = table.Column<DateOnly>(type: "date", nullable: true),
                    EndDateBeforeNotice = table.Column<DateOnly>(type: "date", nullable: true),
                    EndedOn = table.Column<DateOnly>(type: "date", nullable: true),
                    RenewalCount = table.Column<int>(type: "int", nullable: false),
                    MovedByMergeId = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    PreviousOrganizationId = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    RowVersion = table.Column<byte[]>(type: "rowversion", rowVersion: true, nullable: true),
                    CreatedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    ModifiedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    ModifiedBy = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    IsDeleted = table.Column<bool>(type: "bit", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Contracts", x => x.Id);
                    table.ForeignKey(
                        name: "FK_Contracts_SlaPolicies_SlaPolicyId",
                        column: x => x.SlaPolicyId,
                        principalSchema: "contracts",
                        principalTable: "SlaPolicies",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "ContractLines",
                schema: "contracts",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    ContractId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    SeriesId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    Version = table.Column<int>(type: "int", nullable: false),
                    ProductId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    Description = table.Column<string>(type: "nvarchar(512)", maxLength: 512, nullable: true),
                    QuantityModel = table.Column<string>(type: "nvarchar(24)", maxLength: 24, nullable: false),
                    DeviceFilter = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: false),
                    Quantity = table.Column<decimal>(type: "decimal(18,2)", precision: 18, scale: 2, nullable: false),
                    UnitPrice = table.Column<decimal>(type: "decimal(18,2)", precision: 18, scale: 2, nullable: true),
                    DiscountPct = table.Column<decimal>(type: "decimal(5,2)", precision: 5, scale: 2, nullable: false),
                    ValidFrom = table.Column<DateOnly>(type: "date", nullable: false),
                    ValidTo = table.Column<DateOnly>(type: "date", nullable: true),
                    RowVersion = table.Column<byte[]>(type: "rowversion", rowVersion: true, nullable: true),
                    CreatedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    ModifiedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    ModifiedBy = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    IsDeleted = table.Column<bool>(type: "bit", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ContractLines", x => x.Id);
                    table.ForeignKey(
                        name: "FK_ContractLines_Contracts_ContractId",
                        column: x => x.ContractId,
                        principalSchema: "contracts",
                        principalTable: "Contracts",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "HourBanks",
                schema: "contracts",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    OrganizationId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    ContractId = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    Name = table.Column<string>(type: "nvarchar(128)", maxLength: 128, nullable: false),
                    ValidFrom = table.Column<DateOnly>(type: "date", nullable: false),
                    ValidTo = table.Column<DateOnly>(type: "date", nullable: true),
                    PurchasedHours = table.Column<decimal>(type: "decimal(9,2)", precision: 9, scale: 2, nullable: false),
                    UsedHours = table.Column<decimal>(type: "decimal(9,2)", precision: 9, scale: 2, nullable: false),
                    OverageHours = table.Column<decimal>(type: "decimal(9,2)", precision: 9, scale: 2, nullable: false),
                    OverageRate = table.Column<decimal>(type: "decimal(18,2)", precision: 18, scale: 2, nullable: true),
                    LowBalancePct = table.Column<decimal>(type: "decimal(5,2)", precision: 5, scale: 2, nullable: false),
                    LowBalanceNotifiedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    Status = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: false),
                    MovedByMergeId = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    PreviousOrganizationId = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    RowVersion = table.Column<byte[]>(type: "rowversion", rowVersion: true, nullable: true),
                    CreatedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    ModifiedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    ModifiedBy = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    IsDeleted = table.Column<bool>(type: "bit", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_HourBanks", x => x.Id);
                    table.ForeignKey(
                        name: "FK_HourBanks_Contracts_ContractId",
                        column: x => x.ContractId,
                        principalSchema: "contracts",
                        principalTable: "Contracts",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "HourBankEntries",
                schema: "contracts",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    HourBankId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    Kind = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: false),
                    Date = table.Column<DateOnly>(type: "date", nullable: false),
                    Hours = table.Column<decimal>(type: "decimal(9,2)", precision: 9, scale: 2, nullable: false),
                    OverageHours = table.Column<decimal>(type: "decimal(9,2)", precision: 9, scale: 2, nullable: false),
                    Description = table.Column<string>(type: "nvarchar(512)", maxLength: 512, nullable: true),
                    SourceType = table.Column<string>(type: "nvarchar(32)", maxLength: 32, nullable: true),
                    SourceId = table.Column<string>(type: "nvarchar(128)", maxLength: 128, nullable: true),
                    RowVersion = table.Column<byte[]>(type: "rowversion", rowVersion: true, nullable: true),
                    CreatedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    ModifiedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    ModifiedBy = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    IsDeleted = table.Column<bool>(type: "bit", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_HourBankEntries", x => x.Id);
                    table.ForeignKey(
                        name: "FK_HourBankEntries_HourBanks_HourBankId",
                        column: x => x.HourBankId,
                        principalSchema: "contracts",
                        principalTable: "HourBanks",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateIndex(
                name: "IX_ContractLines_ContractId",
                schema: "contracts",
                table: "ContractLines",
                column: "ContractId");

            migrationBuilder.CreateIndex(
                name: "IX_ContractLines_ProductId",
                schema: "contracts",
                table: "ContractLines",
                column: "ProductId");

            migrationBuilder.CreateIndex(
                name: "IX_ContractLines_SeriesId",
                schema: "contracts",
                table: "ContractLines",
                column: "SeriesId");

            migrationBuilder.CreateIndex(
                name: "IX_Contracts_MovedByMergeId",
                schema: "contracts",
                table: "Contracts",
                column: "MovedByMergeId",
                filter: "[MovedByMergeId] IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "IX_Contracts_Number",
                schema: "contracts",
                table: "Contracts",
                column: "Number",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_Contracts_OrganizationId_Status",
                schema: "contracts",
                table: "Contracts",
                columns: new[] { "OrganizationId", "Status" });

            migrationBuilder.CreateIndex(
                name: "IX_Contracts_OwnerId",
                schema: "contracts",
                table: "Contracts",
                column: "OwnerId");

            migrationBuilder.CreateIndex(
                name: "IX_Contracts_SlaPolicyId",
                schema: "contracts",
                table: "Contracts",
                column: "SlaPolicyId");

            migrationBuilder.CreateIndex(
                name: "IX_Contracts_Status_EndDate",
                schema: "contracts",
                table: "Contracts",
                columns: new[] { "Status", "EndDate" });

            migrationBuilder.CreateIndex(
                name: "IX_HourBankEntries_HourBankId_Date",
                schema: "contracts",
                table: "HourBankEntries",
                columns: new[] { "HourBankId", "Date" });

            migrationBuilder.CreateIndex(
                name: "IX_HourBankEntries_SourceType_SourceId",
                schema: "contracts",
                table: "HourBankEntries",
                columns: new[] { "SourceType", "SourceId" },
                unique: true,
                filter: "[SourceType] IS NOT NULL AND [SourceId] IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "IX_HourBanks_ContractId",
                schema: "contracts",
                table: "HourBanks",
                column: "ContractId");

            migrationBuilder.CreateIndex(
                name: "IX_HourBanks_MovedByMergeId",
                schema: "contracts",
                table: "HourBanks",
                column: "MovedByMergeId",
                filter: "[MovedByMergeId] IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "IX_HourBanks_OrganizationId_Status",
                schema: "contracts",
                table: "HourBanks",
                columns: new[] { "OrganizationId", "Status" });

            migrationBuilder.CreateIndex(
                name: "IX_OutboxMessages_ProcessedAt_OccurredAt",
                schema: "contracts",
                table: "OutboxMessages",
                columns: new[] { "ProcessedAt", "OccurredAt" });

            migrationBuilder.CreateIndex(
                name: "IX_Reminders_AssigneeId_AcknowledgedAt",
                schema: "contracts",
                table: "Reminders",
                columns: new[] { "AssigneeId", "AcknowledgedAt" });

            migrationBuilder.CreateIndex(
                name: "IX_Reminders_DeduplicationKey",
                schema: "contracts",
                table: "Reminders",
                column: "DeduplicationKey",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_Reminders_OrganizationId",
                schema: "contracts",
                table: "Reminders",
                column: "OrganizationId");

            migrationBuilder.CreateIndex(
                name: "IX_SlaPolicies_Name",
                schema: "contracts",
                table: "SlaPolicies",
                column: "Name",
                unique: true,
                filter: "[IsDeleted] = 0");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "ContractLines",
                schema: "contracts");

            migrationBuilder.DropTable(
                name: "HourBankEntries",
                schema: "contracts");

            migrationBuilder.DropTable(
                name: "OutboxMessages",
                schema: "contracts");

            migrationBuilder.DropTable(
                name: "Reminders",
                schema: "contracts");

            migrationBuilder.DropTable(
                name: "HourBanks",
                schema: "contracts");

            migrationBuilder.DropTable(
                name: "Contracts",
                schema: "contracts");

            migrationBuilder.DropTable(
                name: "SlaPolicies",
                schema: "contracts");

            migrationBuilder.DropSequence(
                name: "ContractNumbers",
                schema: "contracts");
        }
    }
}
