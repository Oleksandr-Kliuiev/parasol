-- Stage 2 S2-B repair (docs/stage2/03_CONNECTOR_SYNC.md §6): a directory 429 delay is persisted and respected, also above
-- the ordinary backoff cap, so a new process cannot call Graph again before the source allows it. Additive; earlier
-- migrations are unchanged. Database-local only: the runtime UPDATE grant of the new column lives in prisma/roles.sql
-- (reapplied after deploy; the runtime self-check refuses to start while it is missing).
--   retryAt: earliest time the next directory attempt of this connection × resource may start; NULL when not throttled.
--   Written only when the newest started attempt records its outcome (failure: its retry time; publication: NULL), so an
--   older, superseded or expired claim can never overwrite the throttle state of a newer one. Never on sign-in capability rows.
ALTER TABLE "M365ResourceState" ADD COLUMN "retryAt" TIMESTAMP(3);
ALTER TABLE "M365ResourceState" ADD CONSTRAINT "M365ResourceState_retry_check" CHECK ("retryAt" IS NULL OR "resourceType" IN ('m365_user','m365_device'));

CREATE FUNCTION atlas_m365_resource_retry() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."retryAt" IS NOT NULL THEN RAISE EXCEPTION 'a new resource state carries no retry time'; END IF;
    RETURN NEW;
  END IF;
  IF NEW."retryAt" IS DISTINCT FROM OLD."retryAt"
     AND (NEW."latestRecordedSeq" <> NEW."latestStartedSeq" OR NEW."latestRecordedSeq" <= OLD."latestRecordedSeq") THEN
    RAISE EXCEPTION 'retryAt changes only when the newest started attempt records its outcome';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "M365ResourceState_retry" BEFORE INSERT OR UPDATE ON "M365ResourceState" FOR EACH ROW EXECUTE FUNCTION atlas_m365_resource_retry();
