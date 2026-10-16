SET NOCOUNT ON;
-- The previous version keeps running on the expanded schema: its own column lists, its own statuses.
INSERT INTO billing.BillingRuns (Id, PeriodStart, PeriodEnd, Status, RequiresSecondApproval, ContentRevision, Notes, CreatedAt, IsDeleted)
VALUES ('10000000-0000-0000-0000-000000000099', '2026-09-01', '2026-09-30', 'Draft', 0, 0, 'inserted by the previous version', SYSDATETIMEOFFSET(), 0);
INSERT INTO billing.BillingBases (Id, RunId, OrganizationId, IdempotencyKey, TotalExVat, PreviousPeriodTotal, Status, Revision, CreatedAt, IsDeleted)
VALUES ('20000000-0000-0000-0000-000000000099', '10000000-0000-0000-0000-000000000099', '0a000000-0000-0000-0000-000000000001', 'k99', 0, 0, 'Draft', 0, SYSDATETIMEOFFSET(), 0);
INSERT INTO billing.BillingExportAttempts (Id, BasisId, At, Result, Message, CreatedAt, IsDeleted)
VALUES (NEWID(), '20000000-0000-0000-0000-000000000099', SYSDATETIMEOFFSET(), 'Exported', 'Order 1', SYSDATETIMEOFFSET(), 0);
SELECT CAST(Notes AS nvarchar(40)) AS Notes, Kind, Status FROM billing.BillingRuns WHERE Id = '10000000-0000-0000-0000-000000000099';
-- A basis waits for reconciliation when the schema is rolled back; its attempt result is longer than the old column.
UPDATE billing.BillingBases SET Status = 'ReconciliationRequired', SendStartedAt = SYSDATETIMEOFFSET() WHERE Id = '20000000-0000-0000-0000-000000000006';
INSERT INTO billing.BillingExportAttempts (Id, BasisId, At, Result, Message, CreatedAt, IsDeleted)
VALUES (NEWID(), '20000000-0000-0000-0000-000000000006', SYSDATETIMEOFFSET(), 'ReconciliationRequired', 'No answer', SYSDATETIMEOFFSET(), 0);
