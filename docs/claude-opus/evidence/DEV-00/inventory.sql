SET NOCOUNT ON;
PRINT '== billing.BillingRuns by status';
SELECT Status, COUNT(*) AS runs, SUM(CASE WHEN IsDeleted = 1 THEN 1 ELSE 0 END) AS deleted,
       SUM(CASE WHEN RequiresSecondApproval = 1 THEN 1 ELSE 0 END) AS needs_second,
       SUM(CASE WHEN ApprovedBy IS NOT NULL AND ApprovedBy = SecondApprovedBy THEN 1 ELSE 0 END) AS same_approver,
       MIN(PeriodStart) AS first_period, MAX(PeriodStart) AS last_period
FROM billing.BillingRuns GROUP BY Status ORDER BY Status;
PRINT '== periods with more than one run (any status, not deleted)';
SELECT COUNT(*) AS periods_with_several_runs FROM (SELECT PeriodStart FROM billing.BillingRuns WHERE IsDeleted = 0 GROUP BY PeriodStart HAVING COUNT(*) > 1) x;
PRINT '== billing.BillingBases by status';
SELECT Status, COUNT(*) AS bases, SUM(CASE WHEN IsDeleted = 1 THEN 1 ELSE 0 END) AS deleted,
       SUM(CASE WHEN OrderNo IS NOT NULL THEN 1 ELSE 0 END) AS with_order_no,
       SUM(CASE WHEN TotalExVat > 200000 THEN 1 ELSE 0 END) AS above_200k
FROM billing.BillingBases GROUP BY Status ORDER BY Status;
PRINT '== billing.BillingLines';
SELECT [Group], COUNT(*) AS lines, SUM(CASE WHEN IsDeleted = 1 THEN 1 ELSE 0 END) AS deleted,
       SUM(CASE WHEN ManuallyAdjusted = 1 THEN 1 ELSE 0 END) AS manual_or_adjusted,
       SUM(CASE WHEN SourceRefs IS NULL THEN 1 ELSE 0 END) AS without_source_refs
FROM billing.BillingLines GROUP BY [Group] ORDER BY [Group];
PRINT '== same contract line source billed in more than one non-cancelled basis of the same period';
SELECT COUNT(*) AS duplicated_sources FROM (
  SELECT r.PeriodStart, JSON_VALUE(l.SourceRefs, '$.contractLineId') AS contract_line
  FROM billing.BillingLines l JOIN billing.BillingBases b ON b.Id = l.BasisId JOIN billing.BillingRuns r ON r.Id = b.RunId
  WHERE l.IsDeleted = 0 AND b.IsDeleted = 0 AND b.Status <> 'Cancelled' AND JSON_VALUE(l.SourceRefs, '$.contractLineId') IS NOT NULL
  GROUP BY r.PeriodStart, JSON_VALUE(l.SourceRefs, '$.contractLineId') HAVING COUNT(DISTINCT b.Id) > 1) d;
PRINT '== billing.PendingCharges';
SELECT SourceType, COUNT(*) AS charges, SUM(CASE WHEN InvoicedBasisId IS NULL THEN 1 ELSE 0 END) AS waiting FROM billing.PendingCharges GROUP BY SourceType;
PRINT '== billing.Invoices';
SELECT Status, COUNT(*) AS invoices, SUM(CASE WHEN BasisId IS NULL THEN 1 ELSE 0 END) AS without_basis FROM billing.Invoices GROUP BY Status;
PRINT '== outbox per schema (processed / waiting / given up after 10 attempts)';
DECLARE @sql nvarchar(max) = N'';
SELECT @sql = @sql + CASE WHEN @sql = N'' THEN N'' ELSE N' UNION ALL ' END +
  N'SELECT ''' + s.name + N''' AS module, COUNT(*) AS total, SUM(CASE WHEN ProcessedAt IS NOT NULL THEN 1 ELSE 0 END) AS processed, ' +
  N'SUM(CASE WHEN ProcessedAt IS NULL AND Attempts < 10 THEN 1 ELSE 0 END) AS waiting, SUM(CASE WHEN ProcessedAt IS NULL AND Attempts >= 10 THEN 1 ELSE 0 END) AS stuck FROM ' +
  QUOTENAME(s.name) + N'.OutboxMessages'
FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id WHERE t.name = 'OutboxMessages';
SET @sql = N'SELECT * FROM (' + @sql + N') x ORDER BY module';
EXEC sp_executesql @sql;
PRINT '== integration.OutboundOperations by system/operation/status';
SELECT [System], Operation, Status, COUNT(*) AS operations FROM integration.OutboundOperations GROUP BY [System], Operation, Status ORDER BY [System], Operation, Status;
PRINT '== sales.Quotes by status (PDF is rendered on download; no stored artifacts)';
SELECT Status, COUNT(*) AS quote_versions FROM sales.Quotes GROUP BY Status ORDER BY Status;
PRINT '== identity.Users';
SELECT IsActive, COUNT(*) AS users FROM [identity].Users GROUP BY IsActive;
PRINT '== audit.AuditEntries';
SELECT COUNT(*) AS audit_entries FROM audit.AuditEntries;
