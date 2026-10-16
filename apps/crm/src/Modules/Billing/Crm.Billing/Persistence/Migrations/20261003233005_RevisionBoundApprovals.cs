using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crm.Billing.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class RevisionBoundApprovals : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "ApprovedDigest",
                schema: "billing",
                table: "BillingRuns",
                type: "nvarchar(64)",
                maxLength: 64,
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "ApprovedRevision",
                schema: "billing",
                table: "BillingRuns",
                type: "int",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "ContentRevision",
                schema: "billing",
                table: "BillingRuns",
                type: "int",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.CreateTable(
                name: "BillingApprovals",
                schema: "billing",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    RunId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    Kind = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: false),
                    ApprovedBy = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    ApprovedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    ContentRevision = table.Column<int>(type: "int", nullable: false),
                    ContentDigest = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: false),
                    Policy = table.Column<string>(type: "nvarchar(128)", maxLength: 128, nullable: false),
                    RequiredSecond = table.Column<bool>(type: "bit", nullable: false),
                    InvalidatedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    InvalidationReason = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: true),
                    RowVersion = table.Column<byte[]>(type: "rowversion", rowVersion: true, nullable: true),
                    CreatedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    ModifiedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    ModifiedBy = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    IsDeleted = table.Column<bool>(type: "bit", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_BillingApprovals", x => x.Id);
                    table.ForeignKey(
                        name: "FK_BillingApprovals_BillingRuns_RunId",
                        column: x => x.RunId,
                        principalSchema: "billing",
                        principalTable: "BillingRuns",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateIndex(
                name: "IX_BillingApprovals_RunId_ContentRevision",
                schema: "billing",
                table: "BillingApprovals",
                columns: new[] { "RunId", "ContentRevision" });

            // ADR-012, existing data. Approvals of runs released before DEV-02 become acts of a sealed legacy revision 0: they are
            // kept, but no content digest exists for them. Approvals of runs still in review were given to content nobody can
            // name any more; they are kept as set aside ("Migrated") and the run waits for fresh approvals of revision 1.
            migrationBuilder.Sql("""
                INSERT INTO [billing].[BillingApprovals] ([Id], [RunId], [Kind], [ApprovedBy], [ApprovedAt], [ContentRevision], [ContentDigest], [Policy], [RequiredSecond], [InvalidatedAt], [InvalidationReason], [CreatedAt], [IsDeleted])
                SELECT NEWID(), r.[Id], a.[Kind], a.[UserId], COALESCE(r.[ApprovedAt], r.[ModifiedAt], r.[CreatedAt]), 0, N'legacy', N'legacy', r.[RequiresSecondApproval],
                       CASE WHEN r.[Status] IN (N'Collected', N'InReview') THEN SYSDATETIMEOFFSET() END,
                       CASE WHEN r.[Status] IN (N'Collected', N'InReview') THEN N'Migrated' END,
                       SYSDATETIMEOFFSET(), 0
                FROM [billing].[BillingRuns] r
                CROSS APPLY (VALUES (N'First', r.[ApprovedBy]), (N'Second', r.[SecondApprovedBy])) a([Kind], [UserId])
                WHERE a.[UserId] IS NOT NULL;
                """);
            migrationBuilder.Sql("""
                UPDATE [billing].[BillingRuns] SET [ApprovedRevision] = 0, [ApprovedDigest] = N'legacy'
                WHERE [Status] IN (N'Approved', N'Exporting', N'Exported', N'ExportedWithErrors', N'Closed');
                """);
            migrationBuilder.Sql("""
                UPDATE [billing].[BillingRuns] SET [Status] = N'Collected', [ApprovedBy] = NULL, [SecondApprovedBy] = NULL, [ContentRevision] = 1
                WHERE [Status] IN (N'Collected', N'InReview') AND ([ApprovedBy] IS NOT NULL OR [SecondApprovedBy] IS NOT NULL);
                """);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            // The approval acts are the record of who approved which content (ADR-012). A rollback keeps them in an archive table
            // the previous version does not know, instead of dropping them; runs keep the ApprovedBy/SecondApprovedBy columns it reads.
            migrationBuilder.Sql("""
                DECLARE @archive sysname = CONCAT(N'BillingApprovals_rollback_', FORMAT(SYSUTCDATETIME(), 'yyyyMMddHHmmssfff'));
                DECLARE @copy nvarchar(max) = CONCAT(N'SELECT * INTO [billing].', QUOTENAME(@archive), N' FROM [billing].[BillingApprovals];');
                EXEC sp_executesql @copy;
                """);

            migrationBuilder.DropTable(
                name: "BillingApprovals",
                schema: "billing");

            migrationBuilder.DropColumn(
                name: "ApprovedDigest",
                schema: "billing",
                table: "BillingRuns");

            migrationBuilder.DropColumn(
                name: "ApprovedRevision",
                schema: "billing",
                table: "BillingRuns");

            migrationBuilder.DropColumn(
                name: "ContentRevision",
                schema: "billing",
                table: "BillingRuns");
        }
    }
}
