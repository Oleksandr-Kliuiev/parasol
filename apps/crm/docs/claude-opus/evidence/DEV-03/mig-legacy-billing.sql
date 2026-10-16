SET NOCOUNT ON;
-- Bases and lines exactly as the application wrote them before DEV-03 (schema after RevisionBoundApprovals).
DECLARE @p1 uniqueidentifier = '0a000000-0000-0000-0000-000000000001', @p2 uniqueidentifier = '0a000000-0000-0000-0000-0000000000a2';
DECLARE @S1 nvarchar(32) = N'51000000000000000000000000000001', @S2 nvarchar(32) = N'52000000000000000000000000000002',
        @S3 nvarchar(32) = N'53000000000000000000000000000003', @S4 nvarchar(32) = N'54000000000000000000000000000004',
        @S5 nvarchar(32) = N'55000000000000000000000000000005';
DECLARE @t datetimeoffset = '2026-08-01T10:00:00+00:00';

-- Runs: two closed runs of January (the audited A03 case), February exported, March approved, April open, May approved, June/July exported.
INSERT INTO billing.BillingRuns (Id, PeriodStart, PeriodEnd, Status, RequiresSecondApproval, ContentRevision, Notes, CreatedAt, IsDeleted) VALUES
 ('10000000-0000-0000-0000-000000000001', '2026-01-01', '2026-01-31', 'Closed',    0, 0, 'R1', @t, 0),
 ('10000000-0000-0000-0000-000000000002', '2026-01-01', '2026-01-31', 'Closed',    0, 0, 'R2 second run of January', @t, 0),
 ('10000000-0000-0000-0000-000000000003', '2026-02-01', '2026-02-28', 'Exported',  0, 0, 'R3', @t, 0),
 ('10000000-0000-0000-0000-000000000004', '2026-03-01', '2026-03-31', 'Approved',  0, 1, 'R4', @t, 0),
 ('10000000-0000-0000-0000-000000000005', '2026-04-01', '2026-04-30', 'Collected', 0, 1, 'R5', @t, 0),
 ('10000000-0000-0000-0000-000000000006', '2026-05-01', '2026-05-31', 'ExportedWithErrors', 0, 1, 'R6', @t, 0),
 ('10000000-0000-0000-0000-000000000007', '2026-06-01', '2026-06-30', 'Exported',  0, 1, 'R7', @t, 0),
 ('10000000-0000-0000-0000-000000000008', '2026-07-01', '2026-07-31', 'Exported',  0, 1, 'R8', @t, 0);

INSERT INTO billing.BillingBases (Id, RunId, OrganizationId, IdempotencyKey, TotalExVat, PreviousPeriodTotal, Status, ExportedAt, Revision, CreatedAt, IsDeleted) VALUES
 ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', @p1, 'k1', 0, 0, 'Exported', '2026-02-02T10:00:00+00:00', 0, @t, 0),
 ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', @p1, 'k2', 0, 0, 'Exported', '2026-02-20T10:00:00+00:00', 0, @t, 0),
 ('20000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000003', @p1, 'k3', 0, 0, 'Exported', '2026-03-02T10:00:00+00:00', 0, @t, 0),
 ('20000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000004', @p1, 'k4', 0, 0, 'Approved', NULL, 0, @t, 0),
 ('20000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000005', @p1, 'k5', 0, 0, 'Draft',    NULL, 0, @t, 0),
 ('20000000-0000-0000-0000-000000000006', '10000000-0000-0000-0000-000000000006', @p2, 'k6', 0, 0, 'Failed',   NULL, 0, @t, 0),
 ('20000000-0000-0000-0000-000000000007', '10000000-0000-0000-0000-000000000007', @p1, 'k7', 0, 0, 'Exported', '2026-06-02T10:00:00+00:00', 0, @t, 0),
 ('20000000-0000-0000-0000-000000000008', '10000000-0000-0000-0000-000000000008', @p1, 'k8', 0, 0, 'Exported', '2026-07-02T10:00:00+00:00', 0, @t, 0),
 ('20000000-0000-0000-0000-000000000009', '10000000-0000-0000-0000-000000000006', @p1, 'k9', 0, 0, 'Cancelled', NULL, 0, @t, 0);

INSERT INTO billing.BillingLines (Id, BasisId, [Group], Description, Quantity, UnitPrice, DiscountPct, VatRate, LineTotal, SourceRefs, SourceKey, ManuallyAdjusted, Origin, Decision, Conflict, CreatedAt, IsDeleted) VALUES
 -- January, first run: the obligations of the month.
 ('30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'Subscription', 'a contract Jan', 1, 1000, 0, 25, 1000, '{"contractLineId":"4c000000-0000-0000-0000-000000000001"}', CONCAT(N'contract:', @S1, N':2026-01-01:2026-01-31'), 0, 'Collected', 'None', 'None', @t, 0),
 ('30000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', 'HourlyWork', 'b hours detailed', 1, 500, 0, 25, 500, '{"timeEntryIds":["e1000000-0000-0000-0000-000000000001"],"allocationIds":["a1000000-0000-0000-0000-000000000001"]}', N'time:a1000000000000000000000000000001', 0, 'Collected', 'None', 'None', @t, 0),
 ('30000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000001', 'HourlyWork', 'c hours summarised', 2, 1000, 0, 25, 2000, '{"timeEntryIds":["e2000000-0000-0000-0000-000000000002"],"allocationIds":["a2000000-0000-0000-0000-000000000002","a3000000-0000-0000-0000-000000000003"]}', N'time:Remote:1000', 0, 'Collected', 'None', 'None', @t, 0),
 ('30000000-0000-0000-0000-000000000004', '20000000-0000-0000-0000-000000000001', 'Info', 'd covered hours', 3, 0, 0, 0, 0, '{"timeEntryIds":["e4000000-0000-0000-0000-000000000004"]}', N'info:Covered', 0, 'Collected', 'None', 'None', @t, 0),
 ('30000000-0000-0000-0000-000000000005', '20000000-0000-0000-0000-000000000001', 'HourBank', 'e package', 3, 1000, 0, 25, 3000, '{"hourBankEntryId":"b1000000-0000-0000-0000-000000000001"}', N'hourbank:b1000000000000000000000000000001', 0, 'Collected', 'None', 'None', @t, 0),
 ('30000000-0000-0000-0000-000000000006', '20000000-0000-0000-0000-000000000001', 'OneOff', 'f quote item', 1, 4000, 0, 25, 4000, '{"pendingChargeIds":["c1000000-0000-0000-0000-000000000001"]}', N'pending:c1000000000000000000000000000001', 0, 'Collected', 'None', 'None', @t, 0),
 ('30000000-0000-0000-0000-000000000007', '20000000-0000-0000-0000-000000000001', 'OneOff', 'g manual', 1, 250, 0, 25, 250, NULL, NULL, 1, 'Manual', 'None', 'None', @t, 0),
 ('30000000-0000-0000-0000-000000000008', '20000000-0000-0000-0000-000000000001', 'Subscription', 'h excluded', 1, 700, 0, 25, 700, '{"contractLineId":"4c000000-0000-0000-0000-000000000002"}', CONCAT(N'contract:', @S2, N':2026-01-01:2026-01-31'), 0, 'Collected', 'Exclusion', 'None', @t, 0),
 -- January, second run (A03): the same contract month and package again.
 ('30000000-0000-0000-0000-000000000009', '20000000-0000-0000-0000-000000000002', 'Subscription', 'a2 contract Jan again', 1, 1000, 0, 25, 1000, '{"contractLineId":"4c000000-0000-0000-0000-000000000001"}', CONCAT(N'contract:', @S1, N':2026-01-01:2026-01-31'), 0, 'Collected', 'None', 'None', @t, 0),
 ('30000000-0000-0000-0000-000000000010', '20000000-0000-0000-0000-000000000002', 'HourBank', 'e2 package again', 3, 1000, 0, 25, 3000, '{"hourBankEntryId":"b1000000-0000-0000-0000-000000000001"}', N'hourbank:b1000000000000000000000000000001', 0, 'Collected', 'None', 'None', @t, 0),
 -- February: lines from before charge keys.
 ('30000000-0000-0000-0000-000000000011', '20000000-0000-0000-0000-000000000003', 'Subscription', 'k contract Feb, no key', 1, 1000, 0, 25, 1000, '{"contractId":"cc000000-0000-0000-0000-000000000001","contractLineId":"4c000000-0000-0000-0000-000000000001"}', NULL, 0, 'Collected', 'None', 'None', @t, 0),
 ('30000000-0000-0000-0000-000000000012', '20000000-0000-0000-0000-000000000003', 'HourlyWork', 'm hours without allocations', 1, 900, 0, 25, 900, '{"timeEntryIds":["e9000000-0000-0000-0000-000000000009"]}', NULL, 0, 'Collected', 'None', 'None', @t, 0),
 ('30000000-0000-0000-0000-000000000013', '20000000-0000-0000-0000-000000000003', 'HourBank', 'n package, no key', 2, 1000, 0, 25, 2000, '{"hourBankEntryId":"b2000000-0000-0000-0000-000000000002"}', NULL, 0, 'Collected', 'None', 'None', @t, 0),
 ('30000000-0000-0000-0000-000000000014', '20000000-0000-0000-0000-000000000003', 'OneOff', 'o two quote items, no key', 1, 3000, 0, 25, 3000, '{"pendingChargeIds":["c2000000-0000-0000-0000-000000000002","c3000000-0000-0000-0000-000000000003"]}', NULL, 0, 'Collected', 'None', 'None', @t, 0),
 -- March approved: a quarter in advance.
 ('30000000-0000-0000-0000-000000000015', '20000000-0000-0000-0000-000000000004', 'Subscription', 'q quarter Mar-May', 1, 3000, 0, 25, 3000, '{"contractLineId":"4c000000-0000-0000-0000-000000000003"}', CONCAT(N'contract:', @S3, N':2026-03-01:2026-05-31'), 0, 'Collected', 'None', 'None', @t, 0),
 -- April open: the same series for April (overlap), a new pending item, and the quote item January already billed.
 ('30000000-0000-0000-0000-000000000016', '20000000-0000-0000-0000-000000000005', 'Subscription', 'r April overlapping', 1, 1000, 0, 25, 1000, '{"contractLineId":"4c000000-0000-0000-0000-000000000003"}', CONCAT(N'contract:', @S3, N':2026-04-01:2026-04-30'), 0, 'Collected', 'None', 'None', @t, 0),
 ('30000000-0000-0000-0000-000000000017', '20000000-0000-0000-0000-000000000005', 'OneOff', 's new pending', 1, 800, 0, 25, 800, '{"pendingChargeIds":["c4000000-0000-0000-0000-000000000004"]}', N'pending:c4000000000000000000000000000004', 0, 'Collected', 'None', 'None', @t, 0),
 ('30000000-0000-0000-0000-000000000018', '20000000-0000-0000-0000-000000000005', 'OneOff', 't quote item billed in January', 1, 4000, 0, 25, 4000, '{"pendingChargeIds":["c1000000-0000-0000-0000-000000000001"]}', N'pending:c1000000000000000000000000000001', 0, 'Collected', 'None', 'None', @t, 0),
 -- May: a failed basis; a cancelled basis bills nothing.
 ('30000000-0000-0000-0000-000000000019', '20000000-0000-0000-0000-000000000006', 'Subscription', 'u failed basis', 1, 600, 0, 25, 600, '{"contractLineId":"4c000000-0000-0000-0000-000000000004"}', CONCAT(N'contract:', @S4, N':2026-05-01:2026-05-31'), 0, 'Collected', 'None', 'None', @t, 0),
 ('30000000-0000-0000-0000-000000000020', '20000000-0000-0000-0000-000000000009', 'Subscription', 'x cancelled basis', 1, 600, 0, 25, 600, '{"contractLineId":"4c000000-0000-0000-0000-000000000004"}', CONCAT(N'contract:', @S4, N':2026-05-01:2026-05-31'), 0, 'Collected', 'None', 'None', @t, 0),
 -- June quarter exported, then July billed the same series again (overlap between exported runs).
 ('30000000-0000-0000-0000-000000000021', '20000000-0000-0000-0000-000000000007', 'Subscription', 'v quarter Jun-Aug', 1, 3000, 0, 25, 3000, '{"contractLineId":"4c000000-0000-0000-0000-000000000005"}', CONCAT(N'contract:', @S5, N':2026-06-01:2026-08-31'), 0, 'Collected', 'None', 'None', @t, 0),
 ('30000000-0000-0000-0000-000000000022', '20000000-0000-0000-0000-000000000008', 'Subscription', 'w July again', 1, 1000, 0, 25, 1000, '{"contractLineId":"4c000000-0000-0000-0000-000000000005"}', CONCAT(N'contract:', @S5, N':2026-07-01:2026-07-31'), 0, 'Collected', 'None', 'None', @t, 0),
 -- A deleted line bills nothing.
 ('30000000-0000-0000-0000-000000000023', '20000000-0000-0000-0000-000000000003', 'Subscription', 'y deleted', 1, 999, 0, 25, 999, '{"contractLineId":"4c000000-0000-0000-0000-000000000009"}', N'contract:59000000000000000000000000000009:2026-02-01:2026-02-28', 0, 'Collected', 'None', 'None', @t, 1);
