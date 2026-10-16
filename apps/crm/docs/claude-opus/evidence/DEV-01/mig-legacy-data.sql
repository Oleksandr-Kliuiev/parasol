SET NOCOUNT ON;
DECLARE @run uniqueidentifier = '11111111-0000-0000-0000-000000000001';
DECLARE @open uniqueidentifier = '22222222-0000-0000-0000-000000000001';
DECLARE @approved uniqueidentifier = '22222222-0000-0000-0000-000000000002';
DECLARE @org1 uniqueidentifier = '33333333-0000-0000-0000-000000000001';
DECLARE @org2 uniqueidentifier = '33333333-0000-0000-0000-000000000002';
DECLARE @now datetimeoffset = '2026-10-01T08:00:00+00:00';
INSERT INTO billing.BillingRuns (Id, PeriodStart, PeriodEnd, Status, RequiresSecondApproval, CreatedAt, IsDeleted)
VALUES (@run, '2026-09-01', '2026-09-30', 'InReview', 0, @now, 0);
INSERT INTO billing.BillingBases (Id, RunId, OrganizationId, IdempotencyKey, TotalExVat, PreviousPeriodTotal, Status, CreatedAt, IsDeleted)
VALUES (@open, @run, @org1, CONCAT('2026-09-', REPLACE(CAST(@org1 AS nvarchar(36)), '-', ''), '-', REPLACE(CAST(@run AS nvarchar(36)), '-', '')), 3400, 0, 'Draft', @now, 0),
       (@approved, @run, @org2, CONCAT('2026-09-', REPLACE(CAST(@org2 AS nvarchar(36)), '-', ''), '-', REPLACE(CAST(@run AS nvarchar(36)), '-', '')), 1500, 0, 'Approved', @now, 0);
-- Exactly what the application wrote before DEV-01: no Origin, no key; a correction and a manual line both carry ManuallyAdjusted = 1.
INSERT INTO billing.BillingLines (Id, BasisId, [Group], ProductId, Description, Quantity, UnitPrice, DiscountPct, VatRate, LineTotal, SourceRefs, ManuallyAdjusted, CreatedAt, IsDeleted)
VALUES (NEWID(), @open, 'Subscription', NEWID(), 'Plain collected', 1, 1000, 0, 25, 1000, '{"contractId":"a","contractLineId":"b"}', 0, @now, 0),
       (NEWID(), @open, 'Subscription', NEWID(), 'Collected and corrected', 1, 900, 0, 25, 900, '{"contractId":"c","contractLineId":"d"}', 1, @now, 0),
       (NEWID(), @open, 'OneOff', NULL, 'Added by hand', 1, 1500, 0, 25, 1500, NULL, 1, @now, 0),
       (NEWID(), @open, 'Subscription', NEWID(), 'Deleted earlier', 1, 700, 0, 25, 700, '{"contractId":"e"}', 0, @now, 1),
       (NEWID(), @approved, 'Subscription', NEWID(), 'Approved collected', 1, 1000, 0, 25, 1000, '{"contractId":"f"}', 0, @now, 0),
       (NEWID(), @approved, 'OneOff', NULL, 'Approved manual', 1, 500, 0, 25, 500, NULL, 1, @now, 0);
