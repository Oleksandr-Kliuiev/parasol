SET NOCOUNT ON;
-- Run as the login named in $(who); every statement reports its outcome instead of stopping the script.
DECLARE @results TABLE (Step nvarchar(80), Outcome nvarchar(200));
DECLARE @steps TABLE (Ord int IDENTITY, Step nvarchar(80), Sql nvarchar(max));
INSERT INTO @steps (Step, Sql) VALUES
 (N'draft basis total (open run R5)', N'UPDATE billing.BillingBases SET TotalExVat = TotalExVat + 1 WHERE IdempotencyKey = N''k5'''),
 (N'exported basis total (R3)', N'UPDATE billing.BillingBases SET TotalExVat = 1 WHERE IdempotencyKey = N''k3'''),
 (N'exported basis order number (R3)', N'UPDATE billing.BillingBases SET OrderNo = N''X'' WHERE IdempotencyKey = N''k3'''),
 (N'approved basis back to draft (R4)', N'UPDATE billing.BillingBases SET Status = N''Draft'' WHERE IdempotencyKey = N''k4'''),
 (N'line of approved basis (R4)', N'UPDATE l SET UnitPrice = 1 FROM billing.BillingLines l JOIN billing.BillingBases b ON b.Id = l.BasisId WHERE b.IdempotencyKey = N''k4'''),
 (N'delete line of exported basis', N'DELETE l FROM billing.BillingLines l JOIN billing.BillingBases b ON b.Id = l.BasisId WHERE b.IdempotencyKey = N''k3'''),
 (N'closed run notes (R1)', N'UPDATE billing.BillingRuns SET Notes = N''changed'' WHERE Notes = N''R1'''),
 (N'failed basis to approved for a retry (R6)', N'UPDATE billing.BillingBases SET Status = N''Approved'' WHERE IdempotencyKey = N''k6'''),
 (N'legacy charge decided billed', N'UPDATE TOP (1) billing.Charges SET Status = N''ExportConfirmed'' WHERE Status = N''LegacyUnresolved'''),
 (N'committed charge amount', N'UPDATE TOP (1) billing.Charges SET Amount = Amount + 1 WHERE Status IN (N''Committed'', N''ExportConfirmed'')'),
 (N'audit insert', N'INSERT INTO audit.AuditEntries ([At], [Action], [Module], [EntityType], [EntityId], [CorrelationId]) VALUES (SYSDATETIMEOFFSET(), N''Create'', N''customers'', N''Probe'', NEWID(), N''mig-dev04'')'),
 (N'audit update', N'UPDATE audit.AuditEntries SET [Action] = N''X'' WHERE CorrelationId = N''mig-dev04'''),
 (N'audit delete', N'DELETE FROM audit.AuditEntries WHERE CorrelationId = N''mig-dev04'''),
 (N'outbox claim', N'UPDATE billing.OutboxMessages SET LockedUntil = LockedUntil WHERE 1 = 0'),
 (N'create table', N'CREATE TABLE billing.Probe (Id int)'),
 (N'retention dry run', N'EXEC audit.ApplyRetention @Module = N''customers'', @Before = ''2025-01-01'', @DryRun = 1'),
 (N'retention of billing', N'EXEC audit.ApplyRetention @Module = N''billing'', @Before = ''2025-01-01'', @DryRun = 1');
DECLARE @i int = 1, @n int = (SELECT COUNT(*) FROM @steps), @step nvarchar(80), @sql nvarchar(max), @rows int;
WHILE @i <= @n
BEGIN
    SELECT @step = Step, @sql = Sql FROM @steps WHERE Ord = @i;
    BEGIN TRY
        BEGIN TRANSACTION;
        EXEC sp_executesql @sql;
        SET @rows = @@ROWCOUNT;
        ROLLBACK;  -- probe only: nothing a probe does is kept
        INSERT INTO @results VALUES (@step, CONCAT(N'allowed (', @rows, N' rows)'));
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK;
        INSERT INTO @results VALUES (@step, CONCAT(N'refused ', ERROR_NUMBER(), N': ', LEFT(ERROR_MESSAGE(), 90)));
    END CATCH
    SET @i += 1;
END
SELECT CAST(SUSER_NAME() AS nvarchar(20)) AS [Login], Step, Outcome FROM @results;
