-- Stage 1 task 1.6: durable event inbox (docs/03 "Event inbox и worker"). Additive; earlier migrations are frozen.
--   * RawEvent is the inbox: claimed with a lease (leaseOwner, leaseExpiresAt) by FOR UPDATE SKIP LOCKED, retried no earlier
--     than nextAttemptAt, and it keeps the phase-1 decision (preparedDecision) so a retry of the final transaction reuses
--     it and never calls the provider again. A crashed worker's lease simply expires; the event is claimed again.
--   * DecisionRun gets the vocabularies the pipeline writes.

-- ---------------------------------------------------------------------------------------------------------------
-- 0. Preflight: DecisionRun values outside the vocabulary stop the migration; a person decides.
-- ---------------------------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "DecisionRun" WHERE status NOT IN ('OK','FAILED') OR provider NOT IN ('fixture','rules','openai')) THEN
    RAISE EXCEPTION 'v1.6 preflight: DecisionRun has a status outside OK/FAILED or a provider outside fixture/rules/openai; map them explicitly before applying';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- 1. RawEvent as the durable inbox
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE "RawEvent" ADD COLUMN "nextAttemptAt" TIMESTAMP(3);
UPDATE "RawEvent" SET "nextAttemptAt" = "receivedAt" WHERE "nextAttemptAt" IS NULL;
ALTER TABLE "RawEvent" ALTER COLUMN "nextAttemptAt" SET NOT NULL;
ALTER TABLE "RawEvent" ALTER COLUMN "nextAttemptAt" SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "RawEvent" ADD COLUMN "leaseOwner" TEXT;
ALTER TABLE "RawEvent" ADD COLUMN "leaseExpiresAt" TIMESTAMP(3);
-- Phase 1 result (resolved entity, final route, reasons, the run to apply). Written once, before the final transaction.
ALTER TABLE "RawEvent" ADD COLUMN "preparedDecision" JSONB;
ALTER TABLE "RawEvent" ADD CONSTRAINT "RawEvent_lease_pair_check" CHECK (("leaseOwner" IS NULL) = ("leaseExpiresAt" IS NULL));
ALTER TABLE "RawEvent" ADD CONSTRAINT "RawEvent_finished_without_lease_check" CHECK (status NOT IN ('PROCESSED','DEAD_LETTER') OR "leaseOwner" IS NULL);
ALTER TABLE "RawEvent" ADD CONSTRAINT "RawEvent_prepared_decision_check" CHECK ("preparedDecision" IS NULL OR jsonb_typeof("preparedDecision") = 'object');
ALTER TABLE "RawEvent" ADD CONSTRAINT "RawEvent_error_code_check" CHECK (status NOT IN ('RETRY','DEAD_LETTER') OR "lastErrorCode" IS NOT NULL);
-- Claim order: due first, then oldest. Only pending events are indexed.
CREATE INDEX "RawEvent_pending_idx" ON "RawEvent"("workspaceId", "clientId", "nextAttemptAt", "receivedAt", "id") WHERE status IN ('RECEIVED','RETRY');

-- ---------------------------------------------------------------------------------------------------------------
-- 2. DecisionRun vocabularies
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE "DecisionRun" ADD CONSTRAINT "DecisionRun_status_check" CHECK (status IN ('OK','FAILED'));
ALTER TABLE "DecisionRun" ADD CONSTRAINT "DecisionRun_provider_check" CHECK (provider IN ('fixture','rules','openai'));
ALTER TABLE "DecisionRun" ADD CONSTRAINT "DecisionRun_failure_code_check" CHECK (status = 'OK' OR "safeErrorCode" IS NOT NULL);
