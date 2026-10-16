using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crm.Privacy.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class PrivacyCases : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.EnsureSchema(
                name: "privacy");

            migrationBuilder.CreateSequence<int>(
                name: "CaseNumbers",
                schema: "privacy");

            migrationBuilder.CreateTable(
                name: "Cases",
                schema: "privacy",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    Number = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: false),
                    Kind = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: false),
                    SubjectKind = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: false),
                    SubjectId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    Status = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: false),
                    Channel = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: false),
                    ReceivedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    DueOn = table.Column<DateOnly>(type: "date", nullable: false),
                    Note = table.Column<string>(type: "nvarchar(500)", maxLength: 500, nullable: true),
                    VerifiedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    VerifiedBy = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    VerificationMethod = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: true),
                    VerificationNote = table.Column<string>(type: "nvarchar(500)", maxLength: 500, nullable: true),
                    PlanJson = table.Column<string>(type: "nvarchar(max)", nullable: true),
                    PlanDigest = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: true),
                    PreviewedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    CompletedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    CompletedBy = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    ReceiptJson = table.Column<string>(type: "nvarchar(max)", nullable: true),
                    ExportSha256 = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: true),
                    RejectionReason = table.Column<string>(type: "nvarchar(500)", maxLength: 500, nullable: true),
                    RowVersion = table.Column<byte[]>(type: "rowversion", rowVersion: true, nullable: true),
                    CreatedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    ModifiedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    ModifiedBy = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    IsDeleted = table.Column<bool>(type: "bit", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Cases", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "ErasedRecords",
                schema: "privacy",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("SqlServer:Identity", "1, 1"),
                    ManifestId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    Module = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: false),
                    EntityType = table.Column<string>(type: "nvarchar(128)", maxLength: 128, nullable: false),
                    EntityId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    Action = table.Column<string>(type: "nvarchar(24)", maxLength: 24, nullable: false),
                    DataClass = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ErasedRecords", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "ErasureManifests",
                schema: "privacy",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    CaseId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    CaseNumber = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: false),
                    ExecutedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    ContentJson = table.Column<string>(type: "nvarchar(max)", nullable: false),
                    Sha256 = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: false),
                    StoreKey = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: true),
                    StoredAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    ReplayedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    RowVersion = table.Column<byte[]>(type: "rowversion", rowVersion: true, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ErasureManifests", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "InboxReceipts",
                schema: "privacy",
                columns: table => new
                {
                    MessageId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    Handler = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: false),
                    ProcessedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_InboxReceipts", x => new { x.MessageId, x.Handler });
                });

            migrationBuilder.CreateTable(
                name: "Keys",
                schema: "privacy",
                columns: table => new
                {
                    Name = table.Column<string>(type: "nvarchar(32)", maxLength: 32, nullable: false),
                    Value = table.Column<byte[]>(type: "varbinary(64)", maxLength: 64, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Keys", x => x.Name);
                });

            migrationBuilder.CreateTable(
                name: "LegalHolds",
                schema: "privacy",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    Module = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: false),
                    EntityType = table.Column<string>(type: "nvarchar(128)", maxLength: 128, nullable: false),
                    EntityId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    Reason = table.Column<string>(type: "nvarchar(24)", maxLength: 24, nullable: false),
                    Explanation = table.Column<string>(type: "nvarchar(1000)", maxLength: 1000, nullable: false),
                    Until = table.Column<DateOnly>(type: "date", nullable: false),
                    ReleasedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    ReleasedBy = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    ReleaseReason = table.Column<string>(type: "nvarchar(500)", maxLength: 500, nullable: true),
                    RowVersion = table.Column<byte[]>(type: "rowversion", rowVersion: true, nullable: true),
                    CreatedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    ModifiedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    ModifiedBy = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    IsDeleted = table.Column<bool>(type: "bit", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_LegalHolds", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "OutboxMessages",
                schema: "privacy",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    Type = table.Column<string>(type: "nvarchar(500)", maxLength: 500, nullable: false),
                    Payload = table.Column<string>(type: "nvarchar(max)", nullable: false),
                    OccurredAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    CorrelationId = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: true),
                    Status = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: false, defaultValue: "Pending"),
                    ProcessedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    NextAttemptAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    LockedUntil = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    LeaseOwner = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    Attempts = table.Column<int>(type: "int", nullable: false),
                    LastError = table.Column<string>(type: "nvarchar(max)", nullable: true),
                    DeadLetteredAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    DeliveredHandlers = table.Column<string>(type: "nvarchar(4000)", maxLength: 4000, nullable: true),
                    Replays = table.Column<int>(type: "int", nullable: false, defaultValue: 0)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_OutboxMessages", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "OutboxReplayRequests",
                schema: "privacy",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    MessageIds = table.Column<string>(type: "nvarchar(4000)", maxLength: 4000, nullable: false),
                    Expected = table.Column<int>(type: "int", nullable: false),
                    Reason = table.Column<string>(type: "nvarchar(512)", maxLength: 512, nullable: false),
                    RequestedBy = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    RequestedByName = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: true),
                    RequestedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    AppliedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    Applied = table.Column<int>(type: "int", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_OutboxReplayRequests", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "RetentionPolicies",
                schema: "privacy",
                columns: table => new
                {
                    DataClass = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: false),
                    RetainDays = table.Column<int>(type: "int", nullable: false),
                    ApprovedBy = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: false),
                    ApprovedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    Reference = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_RetentionPolicies", x => x.DataClass);
                    table.CheckConstraint("CK_RetentionPolicies_RetainDays", "[RetainDays] >= 30");
                });

            migrationBuilder.CreateTable(
                name: "RetentionRuns",
                schema: "privacy",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    StartedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    FinishedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    Mode = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: false),
                    ReportJson = table.Column<string>(type: "nvarchar(max)", nullable: false),
                    Failed = table.Column<bool>(type: "bit", nullable: false),
                    RowVersion = table.Column<byte[]>(type: "rowversion", rowVersion: true, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_RetentionRuns", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "Suppressions",
                schema: "privacy",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    Kind = table.Column<string>(type: "nvarchar(24)", maxLength: 24, nullable: false),
                    Value = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: false),
                    CaseId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    LiftedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    LiftedBy = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    LiftReason = table.Column<string>(type: "nvarchar(500)", maxLength: 500, nullable: true),
                    RowVersion = table.Column<byte[]>(type: "rowversion", rowVersion: true, nullable: true),
                    CreatedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    ModifiedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    ModifiedBy = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    IsDeleted = table.Column<bool>(type: "bit", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Suppressions", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_Cases_Number",
                schema: "privacy",
                table: "Cases",
                column: "Number",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_Cases_Status",
                schema: "privacy",
                table: "Cases",
                column: "Status");

            migrationBuilder.CreateIndex(
                name: "IX_Cases_SubjectKind_SubjectId",
                schema: "privacy",
                table: "Cases",
                columns: new[] { "SubjectKind", "SubjectId" });

            migrationBuilder.CreateIndex(
                name: "IX_ErasedRecords_ManifestId",
                schema: "privacy",
                table: "ErasedRecords",
                column: "ManifestId");

            migrationBuilder.CreateIndex(
                name: "IX_ErasedRecords_Module_EntityType_EntityId",
                schema: "privacy",
                table: "ErasedRecords",
                columns: new[] { "Module", "EntityType", "EntityId" });

            migrationBuilder.CreateIndex(
                name: "IX_ErasureManifests_CaseId",
                schema: "privacy",
                table: "ErasureManifests",
                column: "CaseId",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_InboxReceipts_ProcessedAt",
                schema: "privacy",
                table: "InboxReceipts",
                column: "ProcessedAt");

            migrationBuilder.CreateIndex(
                name: "IX_LegalHolds_Module_EntityType_EntityId",
                schema: "privacy",
                table: "LegalHolds",
                columns: new[] { "Module", "EntityType", "EntityId" });

            migrationBuilder.CreateIndex(
                name: "IX_OutboxMessages_ProcessedAt_OccurredAt",
                schema: "privacy",
                table: "OutboxMessages",
                columns: new[] { "ProcessedAt", "OccurredAt" });

            migrationBuilder.CreateIndex(
                name: "IX_OutboxMessages_Status_NextAttemptAt",
                schema: "privacy",
                table: "OutboxMessages",
                columns: new[] { "Status", "NextAttemptAt" });

            migrationBuilder.CreateIndex(
                name: "IX_OutboxReplayRequests_AppliedAt",
                schema: "privacy",
                table: "OutboxReplayRequests",
                column: "AppliedAt");

            migrationBuilder.CreateIndex(
                name: "IX_RetentionRuns_StartedAt",
                schema: "privacy",
                table: "RetentionRuns",
                column: "StartedAt");

            migrationBuilder.CreateIndex(
                name: "IX_Suppressions_CaseId",
                schema: "privacy",
                table: "Suppressions",
                column: "CaseId");

            migrationBuilder.CreateIndex(
                name: "IX_Suppressions_Kind_Value",
                schema: "privacy",
                table: "Suppressions",
                columns: new[] { "Kind", "Value" },
                unique: true,
                filter: "[LiftedAt] IS NULL");

            // DEV-11: the installation's key for suppression hashes — random, created here once, never shown; the application
            // may read it but not write it (PrivacyDatabasePermissions).
            migrationBuilder.Sql("""
                IF NOT EXISTS (SELECT 1 FROM [privacy].[Keys] WHERE [Name] = N'suppression')
                    INSERT INTO [privacy].[Keys] ([Name], [Value]) VALUES (N'suppression', CRYPT_GEN_RANDOM(32));
                """);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "Cases",
                schema: "privacy");

            migrationBuilder.DropTable(
                name: "ErasedRecords",
                schema: "privacy");

            migrationBuilder.DropTable(
                name: "ErasureManifests",
                schema: "privacy");

            migrationBuilder.DropTable(
                name: "InboxReceipts",
                schema: "privacy");

            migrationBuilder.DropTable(
                name: "Keys",
                schema: "privacy");

            migrationBuilder.DropTable(
                name: "LegalHolds",
                schema: "privacy");

            migrationBuilder.DropTable(
                name: "OutboxMessages",
                schema: "privacy");

            migrationBuilder.DropTable(
                name: "OutboxReplayRequests",
                schema: "privacy");

            migrationBuilder.DropTable(
                name: "RetentionPolicies",
                schema: "privacy");

            migrationBuilder.DropTable(
                name: "RetentionRuns",
                schema: "privacy");

            migrationBuilder.DropTable(
                name: "Suppressions",
                schema: "privacy");

            migrationBuilder.DropSequence(
                name: "CaseNumbers",
                schema: "privacy");
        }
    }
}
