-- Stage 2 S2-B repair RC3: finite directory retry budget (docs/stage2/03_CONNECTOR_SYNC.md §6, implemented per the
-- approved corrective policy docs/stage2/reviews/S2B_RETRY_REPAIR_PLAN_RC2.md). Additive; earlier migrations unchanged.
-- Database-local only: the runtime UPDATE grant of the new column lives in prisma/roles.sql (the runtime self-check refuses
-- to start until it is applied); the cleanup definer gains nothing.
--   attemptsUsed: directory claims charged since the latest successful publication or explicit reset, at most 8. Every
--   claim charges one before secrets or I/O (including claims that later crash or are superseded); a publication of the
--   newest claim and an explicit, audited reset return it to zero. Sign-in capability rows always carry zero.
-- No now()-dependent rule here: retry time and lease expiry are decided by the service under its locks.

ALTER TABLE "M365ResourceState" ADD COLUMN "attemptsUsed" INTEGER NOT NULL DEFAULT 0;

-- Backfill BEFORE the transition guard exists: before this migration failures and crashes advanced only latestStartedSeq,
-- so the charges since the last publication are started − published; an over-tried chain becomes exhausted, never fresh.
UPDATE "M365ResourceState" SET "attemptsUsed" = LEAST(8, "latestStartedSeq" - "latestPublishedSeq")
 WHERE "resourceType" IN ('m365_user','m365_device') AND "latestStartedSeq" > "latestPublishedSeq";

ALTER TABLE "M365ResourceState" ADD CONSTRAINT "M365ResourceState_attempts_check"
  CHECK ("attemptsUsed" BETWEEN 0 AND 8 AND ("resourceType" IN ('m365_user','m365_device') OR "attemptsUsed" = 0));

-- Transition classes of latestStartedSeq and attemptsUsed (every other column keeps its existing guards):
--   INSERT       zero budget;
--   claim        started +1, budget +1 from below 8, recorded and published sequences unchanged;
--   publication  started unchanged, pointer moves to a generation of a higher published sequence, newest outcome
--                recorded, budget becomes 0 (also 0 → 0); any pointer move requires the zero budget;
--   reset        positive old budget, started +1, recorded = started, budget 0, retryAt NULL, pointer/published unchanged,
--                only for an exhausted chain, a recorded ERROR/MISSING or an outstanding unrecorded claim;
--   otherwise    neither started nor budget changes.
-- Fires after "M365ResourceState_order" and "_retry" (trigger name order), so their messages come first.
CREATE FUNCTION atlas_m365_resource_budget() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_d INTEGER;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."attemptsUsed" <> 0 THEN RAISE EXCEPTION 'a new resource state starts with an unused retry budget'; END IF;
    RETURN NEW;
  END IF;
  v_d := NEW."latestStartedSeq" - OLD."latestStartedSeq";
  IF NEW."activeGenerationId" IS NOT NULL AND NEW."activeGenerationId" IS DISTINCT FROM OLD."activeGenerationId" THEN
    IF v_d = 0 AND NEW."attemptsUsed" = 0 AND NEW."latestPublishedSeq" > OLD."latestPublishedSeq"
       AND NEW."latestRecordedSeq" = NEW."latestStartedSeq" THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'directory publication resets the retry budget of the newest started attempt';
  END IF;
  IF v_d = 0 AND NEW."attemptsUsed" = OLD."attemptsUsed" THEN RETURN NEW; END IF;
  IF v_d = 1 AND NEW."attemptsUsed" = OLD."attemptsUsed" + 1 AND OLD."attemptsUsed" < 8
     AND NEW."latestRecordedSeq" = OLD."latestRecordedSeq" AND NEW."latestPublishedSeq" = OLD."latestPublishedSeq" THEN
    RETURN NEW;
  END IF;
  IF v_d = 1 AND OLD."attemptsUsed" > 0 AND NEW."attemptsUsed" = 0 AND NEW."latestRecordedSeq" = NEW."latestStartedSeq"
     AND NEW."retryAt" IS NULL AND NEW."latestPublishedSeq" = OLD."latestPublishedSeq"
     AND NEW."activeGenerationId" IS NOT DISTINCT FROM OLD."activeGenerationId"
     AND (OLD."attemptsUsed" >= 8 OR OLD.status IN ('ERROR','MISSING') OR OLD."latestRecordedSeq" < OLD."latestStartedSeq") THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'directory retry budget: only a charged claim, a publication or an explicit reset changes the started sequence or budget';
END $$;
CREATE TRIGGER "M365ResourceState_sequence_budget" BEFORE INSERT OR UPDATE ON "M365ResourceState"
  FOR EACH ROW EXECUTE FUNCTION atlas_m365_resource_budget();
