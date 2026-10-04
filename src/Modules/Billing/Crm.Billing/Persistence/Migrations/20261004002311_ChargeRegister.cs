using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crm.Billing.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class ChargeRegister : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "Reason",
                schema: "billing",
                table: "PendingCharges",
                type: "nvarchar(512)",
                maxLength: 512,
                nullable: true);

            // Every run before the register is a regular run; the default also keeps the previous version's inserts working.
            migrationBuilder.AddColumn<string>(
                name: "Kind",
                schema: "billing",
                table: "BillingRuns",
                type: "nvarchar(16)",
                maxLength: 16,
                nullable: false,
                defaultValue: "Regular");

            migrationBuilder.AlterColumn<string>(
                name: "Result",
                schema: "billing",
                table: "BillingExportAttempts",
                type: "nvarchar(32)",
                maxLength: 32,
                nullable: false,
                oldClrType: typeof(string),
                oldType: "nvarchar(16)",
                oldMaxLength: 16);

            migrationBuilder.AlterColumn<string>(
                name: "Status",
                schema: "billing",
                table: "BillingBases",
                type: "nvarchar(32)",
                maxLength: 32,
                nullable: false,
                oldClrType: typeof(string),
                oldType: "nvarchar(16)",
                oldMaxLength: 16);

            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "SendStartedAt",
                schema: "billing",
                table: "BillingBases",
                type: "datetimeoffset",
                nullable: true);

            migrationBuilder.CreateTable(
                name: "Charges",
                schema: "billing",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    Key = table.Column<string>(type: "nvarchar(200)", maxLength: 200, nullable: false),
                    Kind = table.Column<string>(type: "nvarchar(24)", maxLength: 24, nullable: false),
                    SeriesId = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    ServiceFrom = table.Column<DateOnly>(type: "date", nullable: true),
                    ServiceTo = table.Column<DateOnly>(type: "date", nullable: true),
                    ContractLineId = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    CorrectsLineId = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    SourceOrganizationId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    PayerOrganizationId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    Currency = table.Column<string>(type: "nvarchar(3)", maxLength: 3, nullable: false),
                    Amount = table.Column<decimal>(type: "decimal(18,2)", precision: 18, scale: 2, nullable: false),
                    Status = table.Column<string>(type: "nvarchar(32)", maxLength: 32, nullable: false),
                    RunId = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    BasisId = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    LineId = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    StatusChangedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    Reason = table.Column<string>(type: "nvarchar(512)", maxLength: 512, nullable: true),
                    RowVersion = table.Column<byte[]>(type: "rowversion", rowVersion: true, nullable: true),
                    CreatedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    ModifiedAt = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: true),
                    ModifiedBy = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    IsDeleted = table.Column<bool>(type: "bit", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Charges", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_Charges_BasisId",
                schema: "billing",
                table: "Charges",
                column: "BasisId");

            migrationBuilder.CreateIndex(
                name: "IX_Charges_ContractLineId",
                schema: "billing",
                table: "Charges",
                column: "ContractLineId");

            migrationBuilder.CreateIndex(
                name: "IX_Charges_RunId_Status",
                schema: "billing",
                table: "Charges",
                columns: new[] { "RunId", "Status" });

            migrationBuilder.CreateIndex(
                name: "IX_Charges_SeriesId_ServiceFrom",
                schema: "billing",
                table: "Charges",
                columns: new[] { "SeriesId", "ServiceFrom" });

            // ADR-013, backfill. Only obligations the stored lines prove become active charges: the charge key of a collected
            // line, and the allocation, prepaid-purchase and pending-charge ids in its source references. Per key the line that
            // went furthest wins (exported, then approved, then open; then the earliest); a contract interval that overlaps one
            // already won by the same series loses too. A losing line of an approved or exported basis — billed twice, or not
            // provable at all — becomes a legacy charge for Finance (EXT-01) instead of a guessed key; one of an open basis gets
            // nothing and is dropped by its next collect.
            migrationBuilder.Sql("""
                CREATE TABLE #lines (
                    LineId uniqueidentifier NOT NULL, BasisId uniqueidentifier NOT NULL, RunId uniqueidentifier NOT NULL,
                    PayerId uniqueidentifier NOT NULL, SourceOrgId uniqueidentifier NOT NULL, BasisStatus nvarchar(32) NOT NULL,
                    Priority int NOT NULL, SortAt datetimeoffset NOT NULL, SourceKey nvarchar(200) NULL, SourceRefs nvarchar(max) NULL,
                    [Group] nvarchar(32) NOT NULL, LineTotal decimal(18,2) NOT NULL, PeriodStart date NOT NULL, PeriodEnd date NOT NULL);

                INSERT INTO #lines
                SELECT l.Id, l.BasisId, b.RunId, b.OrganizationId, COALESCE(l.SourceOrganizationId, b.OrganizationId), b.Status,
                       CASE b.Status WHEN N'Exported' THEN 1 WHEN N'Approved' THEN 2 WHEN N'Failed' THEN 2 ELSE 3 END,
                       COALESCE(b.ExportedAt, b.CreatedAt), l.SourceKey, CASE WHEN ISJSON(l.SourceRefs) = 1 THEN l.SourceRefs END, l.[Group],
                       l.LineTotal, r.PeriodStart, r.PeriodEnd
                FROM [billing].[BillingLines] l
                JOIN [billing].[BillingBases] b ON b.Id = l.BasisId
                JOIN [billing].[BillingRuns] r ON r.Id = b.RunId
                WHERE l.IsDeleted = 0 AND b.IsDeleted = 0 AND r.IsDeleted = 0
                  AND l.Origin = N'Collected' AND l.Decision <> N'Exclusion'
                  AND b.Status IN (N'Draft', N'Approved', N'Exported', N'Failed');

                CREATE TABLE #claims (
                    LineId uniqueidentifier NOT NULL, [Key] nvarchar(200) NOT NULL, Kind nvarchar(24) NOT NULL, SeriesId uniqueidentifier NULL,
                    ServiceFrom date NULL, ServiceTo date NULL, ContractLineId uniqueidentifier NULL, Amount decimal(18,2) NOT NULL);

                -- One obligation per line: contract interval, prepaid purchase, pending charge, approved allocation (detailed).
                INSERT INTO #claims
                SELECT x.LineId, x.SourceKey,
                       CASE WHEN x.SourceKey LIKE N'contract:%' THEN N'Contract' WHEN x.SourceKey LIKE N'hourbank:%' THEN N'HourBankPurchase'
                            WHEN x.SourceKey LIKE N'pending:%' THEN N'OneOff' ELSE N'Time' END,
                       CASE WHEN x.SourceKey LIKE N'contract:%' THEN TRY_CONVERT(uniqueidentifier,
                            STUFF(STUFF(STUFF(STUFF(SUBSTRING(x.SourceKey, 10, 32), 21, 0, N'-'), 17, 0, N'-'), 13, 0, N'-'), 9, 0, N'-')) END,
                       CASE WHEN x.SourceKey LIKE N'contract:%' THEN TRY_CONVERT(date, SUBSTRING(x.SourceKey, 43, 10), 23) END,
                       CASE WHEN x.SourceKey LIKE N'contract:%' THEN TRY_CONVERT(date, SUBSTRING(x.SourceKey, 54, 10), 23) END,
                       TRY_CONVERT(uniqueidentifier, JSON_VALUE(x.SourceRefs, '$.contractLineId')),
                       x.LineTotal
                FROM #lines x
                WHERE x.SourceKey LIKE N'contract:%' OR x.SourceKey LIKE N'hourbank:%' OR x.SourceKey LIKE N'pending:%'
                   OR (x.SourceKey LIKE N'time:%' AND CHARINDEX(N':', x.SourceKey, 6) = 0);

                -- Summarised hours, information lines and lines from before charge keys: one obligation per approved allocation.
                INSERT INTO #claims
                SELECT a.LineId, N'time:' + REPLACE(LOWER(a.AllocationId), N'-', N''), CASE WHEN a.[Group] = N'Info' THEN N'TimeInfo' ELSE N'Time' END,
                       NULL, NULL, NULL, NULL,
                       CASE WHEN a.[Group] = N'Info' THEN 0 ELSE ROUND(a.LineTotal / a.Allocations, 2) END
                FROM (
                    SELECT x.LineId, x.[Group], x.LineTotal, j.value AS AllocationId, COUNT(*) OVER (PARTITION BY x.LineId) AS Allocations
                    FROM #lines x CROSS APPLY OPENJSON(x.SourceRefs, '$.allocationIds') j
                    WHERE x.[Group] IN (N'HourlyWork', N'Info')
                      AND (x.SourceKey IS NULL OR x.SourceKey LIKE N'info:%' OR (x.SourceKey LIKE N'time:%' AND CHARINDEX(N':', x.SourceKey, 6) > 0))
                ) a
                WHERE TRY_CONVERT(uniqueidentifier, a.AllocationId) IS NOT NULL;

                -- Lines from before charge keys whose references prove a prepaid purchase or pending charges.
                INSERT INTO #claims
                SELECT x.LineId, N'hourbank:' + REPLACE(LOWER(JSON_VALUE(x.SourceRefs, '$.hourBankEntryId')), N'-', N''), N'HourBankPurchase', NULL, NULL, NULL, NULL, x.LineTotal
                FROM #lines x
                WHERE x.SourceKey IS NULL AND TRY_CONVERT(uniqueidentifier, JSON_VALUE(x.SourceRefs, '$.hourBankEntryId')) IS NOT NULL;

                INSERT INTO #claims
                SELECT x.LineId, N'pending:' + REPLACE(LOWER(j.value), N'-', N''), N'OneOff', NULL, NULL, NULL, NULL,
                       ROUND(x.LineTotal / COUNT(*) OVER (PARTITION BY x.LineId), 2)
                FROM #lines x CROSS APPLY OPENJSON(x.SourceRefs, '$.pendingChargeIds') j
                WHERE x.SourceKey IS NULL AND TRY_CONVERT(uniqueidentifier, j.value) IS NOT NULL;

                -- A contract key that cannot be read proves nothing.
                DELETE FROM #claims WHERE Kind = N'Contract' AND (SeriesId IS NULL OR ServiceFrom IS NULL OR ServiceTo IS NULL);

                SELECT c.*, x.BasisId, x.RunId, x.PayerId, x.SourceOrgId, x.BasisStatus, x.Priority, x.SortAt, x.PeriodStart, x.PeriodEnd,
                       ROW_NUMBER() OVER (PARTITION BY c.[Key] ORDER BY x.Priority, x.SortAt, c.LineId) AS Rank, CAST(NULL AS nvarchar(512)) AS Lost
                INTO #ranked
                FROM #claims c JOIN #lines x ON x.LineId = c.LineId;

                UPDATE #ranked SET Lost = N'Duplicate: another basis billed the same obligation (' + [Key] + N').' WHERE Rank > 1;

                UPDATE w SET Lost = N'Overlap: another basis billed days of the same contract service (' + w.[Key] + N').'
                FROM #ranked w
                WHERE w.Lost IS NULL AND w.Kind = N'Contract' AND EXISTS (
                    SELECT 1 FROM #ranked v
                    WHERE v.Lost IS NULL AND v.Kind = N'Contract' AND v.SeriesId = w.SeriesId AND v.[Key] <> w.[Key]
                      AND v.ServiceFrom <= w.ServiceTo AND v.ServiceTo >= w.ServiceFrom
                      AND (v.Priority < w.Priority OR (v.Priority = w.Priority AND (v.SortAt < w.SortAt OR (v.SortAt = w.SortAt AND v.LineId < w.LineId)))));

                INSERT INTO [billing].[Charges] ([Id], [Key], [Kind], [SeriesId], [ServiceFrom], [ServiceTo], [ContractLineId], [CorrectsLineId],
                    [SourceOrganizationId], [PayerOrganizationId], [Currency], [Amount], [Status], [RunId], [BasisId], [LineId], [StatusChangedAt],
                    [Reason], [CreatedAt], [IsDeleted])
                SELECT NEWID(), r.[Key], r.Kind, r.SeriesId, r.ServiceFrom, r.ServiceTo, r.ContractLineId, NULL, r.SourceOrgId, r.PayerId, N'NOK', r.Amount,
                       CASE r.BasisStatus WHEN N'Exported' THEN N'ExportConfirmed' WHEN N'Draft' THEN N'Reserved' ELSE N'Committed' END,
                       r.RunId, r.BasisId, r.LineId, SYSDATETIMEOFFSET(), N'Registered from the existing line (backfill).', SYSDATETIMEOFFSET(), 0
                FROM #ranked r WHERE r.Lost IS NULL;

                INSERT INTO [billing].[Charges] ([Id], [Key], [Kind], [SeriesId], [ServiceFrom], [ServiceTo], [ContractLineId], [CorrectsLineId],
                    [SourceOrganizationId], [PayerOrganizationId], [Currency], [Amount], [Status], [RunId], [BasisId], [LineId], [StatusChangedAt],
                    [Reason], [CreatedAt], [IsDeleted])
                SELECT NEWID(), N'legacy:' + REPLACE(LOWER(CONVERT(nvarchar(36), r.LineId)), N'-', N'') + N':' + r.[Key], N'Legacy', NULL, r.PeriodStart, r.PeriodEnd,
                       r.ContractLineId, NULL, r.SourceOrgId, r.PayerId, N'NOK', r.Amount, N'LegacyUnresolved', r.RunId, r.BasisId, r.LineId, SYSDATETIMEOFFSET(),
                       r.Lost, SYSDATETIMEOFFSET(), 0
                FROM #ranked r WHERE r.Lost IS NOT NULL AND r.BasisStatus <> N'Draft';

                -- Lines of approved or exported bases that prove no obligation at all: a contract line from before charge keys, hours
                -- without allocation ids.
                INSERT INTO [billing].[Charges] ([Id], [Key], [Kind], [SeriesId], [ServiceFrom], [ServiceTo], [ContractLineId], [CorrectsLineId],
                    [SourceOrganizationId], [PayerOrganizationId], [Currency], [Amount], [Status], [RunId], [BasisId], [LineId], [StatusChangedAt],
                    [Reason], [CreatedAt], [IsDeleted])
                SELECT NEWID(), N'legacy:' + REPLACE(LOWER(CONVERT(nvarchar(36), x.LineId)), N'-', N''), N'Legacy', NULL, x.PeriodStart, x.PeriodEnd,
                       TRY_CONVERT(uniqueidentifier, JSON_VALUE(x.SourceRefs, '$.contractLineId')), NULL, x.SourceOrgId, x.PayerId, N'NOK', x.LineTotal,
                       N'LegacyUnresolved', x.RunId, x.BasisId, x.LineId, SYSDATETIMEOFFSET(),
                       N'Unprovable: billed before charge keys and its references prove no obligation.', SYSDATETIMEOFFSET(), 0
                FROM #lines x
                WHERE x.BasisStatus <> N'Draft' AND x.[Group] <> N'Info' AND NOT EXISTS (SELECT 1 FROM #claims c WHERE c.LineId = x.LineId);

                DROP TABLE #ranked;
                DROP TABLE #claims;
                DROP TABLE #lines;
                """);

            // Enforced only now that every key is unique among the active charges.
            migrationBuilder.CreateIndex(
                name: "IX_Charges_Key",
                schema: "billing",
                table: "Charges",
                column: "Key",
                unique: true,
                filter: "[Status] <> 'Released' AND [IsDeleted] = 0");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            // The register is the record of what was billed (ADR-013): a rollback keeps it in an archive table the previous
            // version does not know. A basis waiting for reconciliation becomes Failed, which the previous version understands
            // and which only a person sends again; its attempts say why.
            migrationBuilder.Sql("""
                DECLARE @archive sysname = CONCAT(N'Charges_rollback_', FORMAT(SYSUTCDATETIME(), 'yyyyMMddHHmmssfff'));
                DECLARE @copy nvarchar(max) = CONCAT(N'SELECT * INTO [billing].', QUOTENAME(@archive), N' FROM [billing].[Charges];');
                EXEC sp_executesql @copy;
                UPDATE [billing].[BillingBases] SET [Status] = N'Failed' WHERE [Status] = N'ReconciliationRequired';
                UPDATE [billing].[BillingExportAttempts] SET [Result] = N'Failed' WHERE LEN([Result]) > 16;
                """);

            migrationBuilder.DropTable(
                name: "Charges",
                schema: "billing");

            migrationBuilder.DropColumn(
                name: "Reason",
                schema: "billing",
                table: "PendingCharges");

            migrationBuilder.DropColumn(
                name: "Kind",
                schema: "billing",
                table: "BillingRuns");

            migrationBuilder.DropColumn(
                name: "SendStartedAt",
                schema: "billing",
                table: "BillingBases");

            migrationBuilder.AlterColumn<string>(
                name: "Result",
                schema: "billing",
                table: "BillingExportAttempts",
                type: "nvarchar(16)",
                maxLength: 16,
                nullable: false,
                oldClrType: typeof(string),
                oldType: "nvarchar(32)",
                oldMaxLength: 32);

            migrationBuilder.AlterColumn<string>(
                name: "Status",
                schema: "billing",
                table: "BillingBases",
                type: "nvarchar(16)",
                maxLength: 16,
                nullable: false,
                oldClrType: typeof(string),
                oldType: "nvarchar(32)",
                oldMaxLength: 32);
        }
    }
}
