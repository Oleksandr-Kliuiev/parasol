-- Stage 1, independent review of Checkpoint B (REVIEW_REPORT.md, B1 and B3). A new migration; earlier ones are unchanged.
--   * B1: every claim of an inbox event carries its own token. A worker changes the event (phase 1, the final commit,
--     RETRY or DEAD_LETTER) only while its token is the current one: a worker whose lease was taken over changes nothing.
--     The lease is the triple owner, expiry and token, all set or all empty.
--   * B3: SyncState keeps the order of read attempts per connection and resource. An attempt takes the next number before
--     it reads; its outcome (state and snapshot) is recorded only if no attempt that began later has been recorded.

-- 1. Claim token of an inbox event
ALTER TABLE "RawEvent" ADD COLUMN "claimToken" UUID;
-- An event leased while this migration runs keeps its lease under a new token; a worker without tokens loses the claim.
UPDATE "RawEvent" SET "claimToken" = gen_random_uuid() WHERE "leaseOwner" IS NOT NULL;
ALTER TABLE "RawEvent" DROP CONSTRAINT "RawEvent_lease_pair_check";
ALTER TABLE "RawEvent" ADD CONSTRAINT "RawEvent_lease_check"
  CHECK (("leaseOwner" IS NULL) = ("leaseExpiresAt" IS NULL) AND ("leaseOwner" IS NULL) = ("claimToken" IS NULL));

-- 2. Order of read attempts of one resource
ALTER TABLE "SyncState" ADD COLUMN "attemptSeq" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "SyncState" ADD COLUMN "recordedSeq" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "SyncState" ADD CONSTRAINT "SyncState_attempt_order_check" CHECK ("recordedSeq" >= 0 AND "recordedSeq" <= "attemptSeq");
