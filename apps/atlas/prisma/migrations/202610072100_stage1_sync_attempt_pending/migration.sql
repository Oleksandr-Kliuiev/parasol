-- Stage 1, re-review of Checkpoint B (REVIEW_REPORT.md revision 2, B3 for first reads). A new migration; earlier ones
-- are unchanged. A read attempt takes its number atomically before any vendor I/O, also when the resource has no state
-- yet: the first attempt creates the state row as PENDING (an attempt began, no outcome is recorded). Overlapping first
-- reads are then ordered like any other: the outcome of the attempt that began later is the current state.

ALTER TABLE "SyncState" DROP CONSTRAINT "SyncState_status_check";
ALTER TABLE "SyncState" ADD CONSTRAINT "SyncState_status_check" CHECK (status IN ('PENDING','OK','ERROR','UNAVAILABLE'));
ALTER TABLE "SyncState" DROP CONSTRAINT "SyncState_error_code_check";
ALTER TABLE "SyncState" ADD CONSTRAINT "SyncState_error_code_check" CHECK (status IN ('PENDING','OK') OR "safeErrorCode" IS NOT NULL);
-- PENDING carries no outcome: nothing recorded, no attempt or success time, no error code
ALTER TABLE "SyncState" ADD CONSTRAINT "SyncState_pending_check" CHECK (status <> 'PENDING'
  OR ("recordedSeq" = 0 AND "lastSyncAt" IS NULL AND "lastSuccessAt" IS NULL AND "safeErrorCode" IS NULL));
