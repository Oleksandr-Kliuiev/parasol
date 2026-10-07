-- Stage 1, task 1.7 Decision Layer. A new migration; earlier ones are unchanged.
--   * DecisionRun.configVersion: the version of the decision configuration (config/decisions.json) a run was made under,
--     so the model, the response-model allowlist, the deadline and the confidence threshold behind a route are traceable.
--   * ShadowJob: the AI call of shadow mode is a separate durable job. It is created in the final transaction of the
--     baseline (the baseline, CRITICAL included, never waits for the experiment) and processed by its own claims (lease
--     and claim token, as in the inbox). Every provider call is a DecisionRun with applied = false; the job records how
--     the experiment ended: DONE, FAILED (a reason), or SKIPPED (circuit open or budget spent; no call made).

-- 0. Preflight: measurements the new checks cannot accept stop the migration; a person decides.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "DecisionRun" WHERE "latencyMs" < 0 OR "inputTokens" < 0) THEN
    RAISE EXCEPTION 'v1.7 preflight: DecisionRun has a negative latencyMs or inputTokens; correct them explicitly before applying';
  END IF;
END $$;

-- 1. DecisionRun: configuration version and sane measurements
ALTER TABLE "DecisionRun" ADD COLUMN "configVersion" TEXT;
ALTER TABLE "DecisionRun" ADD CONSTRAINT "DecisionRun_config_version_check"
  CHECK ("configVersion" IS NULL OR "configVersion" ~ '^[a-z0-9][a-z0-9._-]{0,63}$');
ALTER TABLE "DecisionRun" ADD CONSTRAINT "DecisionRun_measures_check"
  CHECK (("latencyMs" IS NULL OR "latencyMs" >= 0) AND ("inputTokens" IS NULL OR "inputTokens" >= 0));

-- 2. ShadowJob: one per event whose baseline was applied in shadow mode
CREATE TABLE "ShadowJob" (
    "workspaceId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "configVersion" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseOwner" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "claimToken" UUID,
    "lastErrorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "ShadowJob_pkey" PRIMARY KEY ("workspaceId","clientId","eventId")
);
-- The job belongs to the event of the same scope (the composite key carries the scope).
ALTER TABLE "ShadowJob" ADD CONSTRAINT "ShadowJob_event_fkey" FOREIGN KEY ("workspaceId", "clientId", "eventId")
  REFERENCES "RawEvent"("workspaceId", "clientId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShadowJob" ADD CONSTRAINT "ShadowJob_status_check" CHECK (status IN ('PENDING','RETRY','DONE','FAILED','SKIPPED'));
ALTER TABLE "ShadowJob" ADD CONSTRAINT "ShadowJob_config_version_check" CHECK ("configVersion" ~ '^[a-z0-9][a-z0-9._-]{0,63}$');
ALTER TABLE "ShadowJob" ADD CONSTRAINT "ShadowJob_attempts_check" CHECK (attempts >= 0);
ALTER TABLE "ShadowJob" ADD CONSTRAINT "ShadowJob_lease_check"
  CHECK (("leaseOwner" IS NULL) = ("leaseExpiresAt" IS NULL) AND ("leaseOwner" IS NULL) = ("claimToken" IS NULL));
-- A finished job holds no lease and says when it finished; RETRY, FAILED and SKIPPED say why
ALTER TABLE "ShadowJob" ADD CONSTRAINT "ShadowJob_finished_check"
  CHECK ((status IN ('DONE','FAILED','SKIPPED')) = ("finishedAt" IS NOT NULL) AND (status NOT IN ('DONE','FAILED','SKIPPED') OR "leaseOwner" IS NULL));
ALTER TABLE "ShadowJob" ADD CONSTRAINT "ShadowJob_error_code_check" CHECK (status NOT IN ('RETRY','FAILED','SKIPPED') OR "lastErrorCode" IS NOT NULL);
CREATE INDEX "ShadowJob_pending_idx" ON "ShadowJob"("workspaceId", "clientId", "nextAttemptAt") WHERE status IN ('PENDING','RETRY');

ALTER TABLE "ShadowJob" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ShadowJob_scope" ON "ShadowJob" FOR ALL
  USING ("workspaceId" = atlas_app_workspace() AND "clientId" = ANY(atlas_app_clients()))
  WITH CHECK ("workspaceId" = atlas_app_workspace() AND "clientId" = ANY(atlas_app_clients()));
