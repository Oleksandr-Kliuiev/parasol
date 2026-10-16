SET NOCOUNT ON;
-- Billing runs exactly as the application wrote them before DEV-02: approvals are two columns of the run.
DECLARE @a uniqueidentifier = 'aaaaaaaa-0000-0000-0000-00000000000a';   -- Finance
DECLARE @b uniqueidentifier = 'bbbbbbbb-0000-0000-0000-00000000000b';   -- Management (or Admin)
DECLARE @t datetimeoffset = '2026-09-30T10:00:00+00:00';
INSERT INTO billing.BillingRuns (Id, PeriodStart, PeriodEnd, Status, CollectedAt, ApprovedBy, SecondApprovedBy, ApprovedAt, RequiresSecondApproval, ExportedAt, ClosedAt, Notes, CreatedAt, ModifiedAt, IsDeleted)
VALUES
 ('10000000-0000-0000-0000-000000000001', '2026-01-01', '2026-01-31', 'Closed',             @t, @a, @b,   @t,   1, @t, @t, 'closed, two approvals', @t, @t, 0),
 ('10000000-0000-0000-0000-000000000002', '2026-02-01', '2026-02-28', 'Exported',           @t, @a, NULL, @t,   0, @t, NULL, 'exported, one approval', @t, @t, 0),
 ('10000000-0000-0000-0000-000000000003', '2026-03-01', '2026-03-31', 'ExportedWithErrors', @t, @a, @b,   @t,   1, @t, NULL, 'exported with errors', @t, @t, 0),
 ('10000000-0000-0000-0000-000000000004', '2026-04-01', '2026-04-30', 'Exporting',          @t, @a, NULL, @t,   0, NULL, NULL, 'exporting', @t, @t, 0),
 ('10000000-0000-0000-0000-000000000005', '2026-05-01', '2026-05-31', 'Approved',           @t, @a, @b,   NULL, 1, NULL, NULL, 'approved, ApprovedAt missing', @t, @t, 0),
 ('10000000-0000-0000-0000-000000000006', '2026-06-01', '2026-06-30', 'InReview',           @t, @a, NULL, NULL, 1, NULL, NULL, 'first approval, waiting for the second', @t, @t, 0),
 ('10000000-0000-0000-0000-000000000007', '2026-07-01', '2026-07-31', 'Collected',          @t, NULL, @b, NULL, 1, NULL, NULL, 'second approval given first (A02)', @t, @t, 0),
 ('10000000-0000-0000-0000-000000000008', '2026-08-01', '2026-08-31', 'Collected',          @t, NULL, NULL, NULL, 0, NULL, NULL, 'collected, no approval', @t, @t, 0),
 ('10000000-0000-0000-0000-000000000009', '2026-09-01', '2026-09-30', 'Draft',              NULL, NULL, NULL, NULL, 0, NULL, NULL, 'draft', @t, NULL, 0);
