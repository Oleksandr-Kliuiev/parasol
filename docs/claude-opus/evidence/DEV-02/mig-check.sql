SET NOCOUNT ON;
PRINT '== runs';
SELECT CAST(Notes AS nvarchar(40)) AS Notes, Status,
       CASE WHEN ApprovedBy IS NULL THEN '-' ELSE LEFT(CAST(ApprovedBy AS nvarchar(36)), 1) END AS First,
       CASE WHEN SecondApprovedBy IS NULL THEN '-' ELSE LEFT(CAST(SecondApprovedBy AS nvarchar(36)), 1) END AS Second
       , CASE WHEN COL_LENGTH('billing.BillingRuns', 'ContentRevision') IS NULL THEN 'n/a' ELSE 'see below' END AS NewColumns
FROM billing.BillingRuns ORDER BY PeriodStart;
IF COL_LENGTH('billing.BillingRuns', 'ContentRevision') IS NOT NULL
BEGIN
    PRINT '== revision columns';
    EXEC sp_executesql N'SELECT CAST(Notes AS nvarchar(40)) AS Notes, ContentRevision, ISNULL(CAST(ApprovedRevision AS nvarchar(8)), ''null'') AS ApprovedRevision, ISNULL(ApprovedDigest, ''null'') AS ApprovedDigest FROM billing.BillingRuns ORDER BY PeriodStart';
END
IF OBJECT_ID('billing.BillingApprovals') IS NOT NULL
BEGIN
    PRINT '== approval acts';
    EXEC sp_executesql N'SELECT CAST(r.Notes AS nvarchar(40)) AS Notes, a.Kind, LEFT(CAST(a.ApprovedBy AS nvarchar(36)), 1) AS ApprovedBy, a.ContentRevision, a.ContentDigest, a.Policy, a.RequiredSecond,
           CASE WHEN a.InvalidatedAt IS NULL THEN ''valid'' ELSE ''set aside'' END AS State, ISNULL(a.InvalidationReason, ''-'') AS Reason,
           CASE WHEN a.ApprovedAt = r.ApprovedAt THEN ''run.ApprovedAt'' WHEN a.ApprovedAt = r.ModifiedAt THEN ''run.ModifiedAt'' ELSE ''other'' END AS ApprovedAtFrom
         FROM billing.BillingApprovals a JOIN billing.BillingRuns r ON r.Id = a.RunId ORDER BY r.PeriodStart, a.Kind';
END
ELSE PRINT '== approval acts: table absent';
PRINT '== archives';
SELECT name AS ArchiveTable FROM sys.tables WHERE SCHEMA_NAME(schema_id) = 'billing' AND name LIKE 'BillingApprovals[_]rollback[_]%';
PRINT '== migrations';
SELECT MigrationId FROM billing.__EFMigrationsHistory ORDER BY MigrationId;
