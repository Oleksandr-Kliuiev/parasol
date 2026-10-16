SET NOCOUNT ON;
IF OBJECT_ID('billing.Charges') IS NULL
BEGIN
    PRINT '== charges: table absent';
END
ELSE
BEGIN
    PRINT '== charges per line (description of the line, kind, status, amount, key or reason)';
    EXEC sp_executesql N'
        SELECT CAST(l.Description AS nvarchar(34)) AS Line, c.Kind, c.Status, c.Amount,
               CASE WHEN c.Status = N''LegacyUnresolved'' THEN CAST(LEFT(c.Reason, 60) AS nvarchar(60)) ELSE CAST(LEFT(c.[Key], 60) AS nvarchar(60)) END AS KeyOrReason,
               CASE WHEN c.SeriesId IS NULL THEN N''-'' ELSE LEFT(CONVERT(nvarchar(36), c.SeriesId), 2) END AS Series,
               ISNULL(CONVERT(nvarchar(10), c.ServiceFrom, 23), N''-'') AS [From], ISNULL(CONVERT(nvarchar(10), c.ServiceTo, 23), N''-'') AS [To]
        FROM billing.Charges c LEFT JOIN billing.BillingLines l ON l.Id = c.LineId
        ORDER BY l.Id, c.[Key]';
    PRINT '== lines without a charge';
    EXEC sp_executesql N'
        SELECT CAST(l.Description AS nvarchar(40)) AS Line, l.Origin, l.Decision, b.Status AS BasisStatus, l.IsDeleted
        FROM billing.BillingLines l JOIN billing.BillingBases b ON b.Id = l.BasisId
        WHERE NOT EXISTS (SELECT 1 FROM billing.Charges c WHERE c.LineId = l.Id) ORDER BY l.Id';
    PRINT '== legacy report (what GET /api/v1/billing/charges/legacy sums)';
    EXEC sp_executesql N'
        SELECT LEFT(Reason, CHARINDEX(N'':'', Reason) - 1) AS Reason, COUNT(*) AS Lines, SUM(Amount) AS Amount
        FROM billing.Charges WHERE Status = N''LegacyUnresolved'' GROUP BY LEFT(Reason, CHARINDEX(N'':'', Reason) - 1) ORDER BY 1';
    PRINT '== active keys are unique';
    EXEC sp_executesql N'SELECT COUNT(*) AS DuplicateActiveKeys FROM (SELECT [Key] FROM billing.Charges WHERE Status <> N''Released'' AND IsDeleted = 0 GROUP BY [Key] HAVING COUNT(*) > 1) d';
    PRINT '== unique filtered index';
    SELECT i.name, i.is_unique, i.filter_definition FROM sys.indexes i WHERE i.object_id = OBJECT_ID('billing.Charges') AND i.name = 'IX_Charges_Key';
END
PRINT '== column sizes and run kinds';
SELECT c.name AS [Column], c.max_length / 2 AS Chars FROM sys.columns c
WHERE (c.object_id = OBJECT_ID('billing.BillingBases') AND c.name = 'Status') OR (c.object_id = OBJECT_ID('billing.BillingExportAttempts') AND c.name = 'Result');
IF COL_LENGTH('billing.BillingRuns', 'Kind') IS NOT NULL
    EXEC sp_executesql N'SELECT Kind, COUNT(*) AS Runs FROM billing.BillingRuns GROUP BY Kind';
PRINT '== archives';
SELECT name AS ArchiveTable FROM sys.tables WHERE SCHEMA_NAME(schema_id) = 'billing' AND name LIKE 'Charges[_]rollback[_]%';
PRINT '== migrations';
SELECT MigrationId FROM billing.__EFMigrationsHistory ORDER BY MigrationId;
