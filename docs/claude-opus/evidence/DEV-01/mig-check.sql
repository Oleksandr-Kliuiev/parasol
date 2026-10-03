SET NOCOUNT ON;
PRINT '== lines by basis (count, sum of LineTotal, current only)';
SELECT b.Status AS basis, COUNT(*) AS lines, SUM(l.LineTotal) AS total FROM billing.BillingLines l JOIN billing.BillingBases b ON b.Id = l.BasisId WHERE l.IsDeleted = 0 GROUP BY b.Status ORDER BY b.Status;
PRINT '== basis totals';
SELECT Status, TotalExVat FROM billing.BillingBases ORDER BY Status;
IF COL_LENGTH('billing.BillingLines', 'Origin') IS NOT NULL
BEGIN
  PRINT '== new columns per line';
  EXEC('SELECT Description, ManuallyAdjusted, Origin, Decision, Conflict, CASE WHEN SourceKey IS NULL THEN ''null'' ELSE SourceKey END AS SourceKey FROM billing.BillingLines ORDER BY Description');
  PRINT '== revision of bases';
  EXEC('SELECT Status, Revision FROM billing.BillingBases ORDER BY Status');
  PRINT '== filtered unique index';
  SELECT name, is_unique, filter_definition FROM sys.indexes WHERE name = 'IX_BillingLines_BasisId_SourceKey';
END
ELSE PRINT '== new columns: absent';
PRINT '== migrations';
SELECT MigrationId FROM billing.__EFMigrationsHistory ORDER BY MigrationId;
