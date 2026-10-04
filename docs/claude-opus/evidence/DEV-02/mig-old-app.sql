SET NOCOUNT ON;
-- The previous version keeps running during the rollback window: it inserts and approves runs with its own column list.
INSERT INTO billing.BillingRuns (Id, PeriodStart, PeriodEnd, Status, CollectedAt, ApprovedBy, SecondApprovedBy, ApprovedAt, RequiresSecondApproval, ExportedAt, ClosedAt, Notes, CreatedAt, ModifiedAt, IsDeleted)
VALUES ('10000000-0000-0000-0000-000000000010', '2026-10-01', '2026-10-31', 'Collected', SYSDATETIMEOFFSET(), NULL, NULL, NULL, 0, NULL, NULL, 'inserted by the previous version', SYSDATETIMEOFFSET(), NULL, 0);
UPDATE billing.BillingRuns SET Status = 'Approved', ApprovedBy = 'aaaaaaaa-0000-0000-0000-00000000000a', ApprovedAt = SYSDATETIMEOFFSET()
WHERE Id = '10000000-0000-0000-0000-000000000010';
SELECT CAST(Notes AS nvarchar(40)) AS Notes, Status, ContentRevision, ISNULL(CAST(ApprovedRevision AS nvarchar(8)), 'null') AS ApprovedRevision
FROM billing.BillingRuns WHERE Id = '10000000-0000-0000-0000-000000000010';
