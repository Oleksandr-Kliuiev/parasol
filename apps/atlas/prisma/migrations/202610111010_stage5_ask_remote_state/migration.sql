-- Stage 5 ASK-REMOTE R-A (docs/stage5/ask/remote/04_AUTHORITY_AND_BILLING.md): the inactive durable policy, its client
-- allowlist, the project period counters and the financial attempt ledger. Additive; every earlier migration is frozen.
-- Nothing is seeded or activated. The confined routines are 202610111020; prisma/roles.sql (after this deploy) creates the
-- NOLOGIN remote definer, transfers every atlas_ask_remote_* routine to it and leaves the runtime SELECT only; until then
-- the runtime startup check refuses (the default privileges give the runtime INSERT/UPDATE on these tables).
--
-- Every row carries workspaceId; every cross-row reference includes it (scoped composite FKs, ON DELETE RESTRICT: a
-- workspace, client, actor or policy delete never cascades away financial history). FORCE RLS with the workspace policy.
-- No question, request ID, request/response body, hash or length of a question, provider response ID or URL is stored:
-- only fixed identities, references, fixed codes and integer accounting metadata (validated token counts included).
-- Money is integer micro-USD (BIGINT). Times are TIMESTAMPTZ(6); UTC period keys never depend on the session TimeZone.

-- ---------------------------------------------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------------------------------------------
-- Exactly one persistent policy row per workspace. workspaceId, admissionId (assigned once at creation), projectIdentity,
-- createdAt and the fixed profile/region/data-class/reserve are immutable; every other change is a revision in place that
-- advances policyVersion by exactly one. At max bigint the row is a terminal TOMBSTONE.
CREATE TABLE "RemoteAskPolicy" (
    "workspaceId" TEXT NOT NULL,
    "admissionId" UUID NOT NULL,
    "projectIdentity" TEXT NOT NULL,
    "policyVersion" BIGINT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'INACTIVE',
    "stateReason" TEXT,
    "profile" TEXT NOT NULL,
    "endpointRegion" TEXT NOT NULL,
    "dataClass" TEXT NOT NULL,
    "promptSha256" TEXT NOT NULL,
    "schemaSha256" TEXT NOT NULL,
    "packageSha256" TEXT NOT NULL,
    "secretRef" TEXT NOT NULL,
    "ownerApprovalRef" TEXT NOT NULL,
    "retentionAttestationRef" TEXT NOT NULL,
    "priceRevision" TEXT NOT NULL,
    "reserveMicroUsd" BIGINT NOT NULL,
    "dayCapMicroUsd" BIGINT NOT NULL,
    "monthCapMicroUsd" BIGINT NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "revisedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RemoteAskPolicy_pkey" PRIMARY KEY ("workspaceId")
);
CREATE UNIQUE INDEX "RemoteAskPolicy_admissionId_key" ON "RemoteAskPolicy"("admissionId");
CREATE UNIQUE INDEX "RemoteAskPolicy_projectIdentity_key" ON "RemoteAskPolicy"("projectIdentity");
CREATE UNIQUE INDEX "RemoteAskPolicy_admission_key" ON "RemoteAskPolicy"("workspaceId", "admissionId");
CREATE UNIQUE INDEX "RemoteAskPolicy_project_key" ON "RemoteAskPolicy"("workspaceId", "projectIdentity");
CREATE UNIQUE INDEX "RemoteAskPolicy_binding_key" ON "RemoteAskPolicy"("workspaceId", "admissionId", "projectIdentity");

-- The exact client allowlist of the admission. Never deleted: removal is state REMOVED, re-admission ADMITTED again, each
-- stamped with the policyVersion its transaction advanced to (changedAtPolicyVersion).
CREATE TABLE "RemoteAskClientAdmission" (
    "workspaceId" TEXT NOT NULL,
    "admissionId" UUID NOT NULL,
    "clientId" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "changedAtPolicyVersion" BIGINT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RemoteAskClientAdmission_pkey" PRIMARY KEY ("workspaceId", "admissionId", "clientId")
);
CREATE INDEX "RemoteAskClientAdmission_client_idx" ON "RemoteAskClientAdmission"("workspaceId", "clientId");

-- Durable UTC DAY/MONTH spend of the pinned project (never of an admission revision). chargedMicroUsd is always the sum of
-- accountedMicroUsd of the attempts of that period (deferred ledger check).
CREATE TABLE "RemoteAskPeriodCounter" (
    "workspaceId" TEXT NOT NULL,
    "projectIdentity" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "periodStart" DATE NOT NULL,
    "chargedMicroUsd" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RemoteAskPeriodCounter_pkey" PRIMARY KEY ("workspaceId", "projectIdentity", "kind", "periodStart")
);

-- One admitted egress attempt: accounting only (never a queue, idempotency grant, answer cache or resumable job). Server
-- attempt ID and correlation; captured admission/policyVersion/profile/price/rates and the ORIGINAL UTC periods.
CREATE TABLE "RemoteAskAttempt" (
    "workspaceId" TEXT NOT NULL,
    "id" UUID NOT NULL,
    "clientId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "admissionId" UUID NOT NULL,
    "projectIdentity" TEXT NOT NULL,
    "policyVersion" BIGINT NOT NULL,
    "profile" TEXT NOT NULL,
    "priceRevision" TEXT NOT NULL,
    "correlationId" UUID NOT NULL,
    "dayStart" DATE NOT NULL,
    "monthStart" DATE NOT NULL,
    "reservedMicroUsd" BIGINT NOT NULL,
    "promptRate" INTEGER NOT NULL,
    "completionRate" INTEGER NOT NULL,
    "accountedMicroUsd" BIGINT NOT NULL,
    "state" TEXT NOT NULL,
    "outcome" TEXT,
    "promptTokens" INTEGER,
    "completionTokens" INTEGER,
    "createdAt" TIMESTAMPTZ(6) NOT NULL,
    "settledAt" TIMESTAMPTZ(6),

    CONSTRAINT "RemoteAskAttempt_pkey" PRIMARY KEY ("workspaceId", "id")
);
CREATE UNIQUE INDEX "RemoteAskAttempt_correlation_key" ON "RemoteAskAttempt"("workspaceId", "correlationId");
CREATE INDEX "RemoteAskAttempt_day_idx" ON "RemoteAskAttempt"("workspaceId", "projectIdentity", "dayStart");
CREATE INDEX "RemoteAskAttempt_month_idx" ON "RemoteAskAttempt"("workspaceId", "projectIdentity", "monthStart");
CREATE INDEX "RemoteAskAttempt_client_idx" ON "RemoteAskAttempt"("workspaceId", "clientId");
CREATE INDEX "RemoteAskAttempt_actor_idx" ON "RemoteAskAttempt"("workspaceId", "actorId");

-- ---------------------------------------------------------------------------------------------------------------
-- 2. Scoped foreign keys (same workspace in every reference)
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE "RemoteAskPolicy" ADD CONSTRAINT "RemoteAskPolicy_workspace_fkey" FOREIGN KEY ("workspaceId")
  REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "RemoteAskClientAdmission" ADD CONSTRAINT "RemoteAskClientAdmission_client_fkey" FOREIGN KEY ("workspaceId", "clientId")
  REFERENCES "Client"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "RemoteAskClientAdmission" ADD CONSTRAINT "RemoteAskClientAdmission_policy_fkey" FOREIGN KEY ("workspaceId", "admissionId")
  REFERENCES "RemoteAskPolicy"("workspaceId", "admissionId") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "RemoteAskPeriodCounter" ADD CONSTRAINT "RemoteAskPeriodCounter_policy_fkey" FOREIGN KEY ("workspaceId", "projectIdentity")
  REFERENCES "RemoteAskPolicy"("workspaceId", "projectIdentity") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "RemoteAskAttempt" ADD CONSTRAINT "RemoteAskAttempt_client_fkey" FOREIGN KEY ("workspaceId", "clientId")
  REFERENCES "Client"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "RemoteAskAttempt" ADD CONSTRAINT "RemoteAskAttempt_actor_fkey" FOREIGN KEY ("workspaceId", "actorId")
  REFERENCES "Actor"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "RemoteAskAttempt" ADD CONSTRAINT "RemoteAskAttempt_admission_fkey" FOREIGN KEY ("workspaceId", "admissionId", "clientId")
  REFERENCES "RemoteAskClientAdmission"("workspaceId", "admissionId", "clientId") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "RemoteAskAttempt" ADD CONSTRAINT "RemoteAskAttempt_policy_fkey" FOREIGN KEY ("workspaceId", "admissionId", "projectIdentity")
  REFERENCES "RemoteAskPolicy"("workspaceId", "admissionId", "projectIdentity") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ---------------------------------------------------------------------------------------------------------------
-- 3. Row CHECKs (coalesced to false: SQL UNKNOWN never passes). Fixed profile ask-remote-openai-luna-v1, region EU,
--    data class SYNTHETIC, reserve 300000, rates 275/825 micro-USD per 1000 prompt/completion tokens; proposed caps are
--    upper bounds (2 USD/UTC day, 10 USD/UTC month): an admission may only lower them, and a revision never raises the
--    current caps (guard below + policy_revise). Expiry at most 168 h after the
--    latest revision. Token counts: prompt 0..32768, completion 0..512 (anomaly gate of the profile).
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE "RemoteAskPolicy" ADD CONSTRAINT "RemoteAskPolicy_contract_check" CHECK (coalesce(
  "policyVersion" >= 1
  AND "state" IN ('INACTIVE','ACTIVE','PAUSED','REVOKED','TOMBSTONE')
  AND ("state" = 'TOMBSTONE') = ("policyVersion" = 9223372036854775807)
  AND CASE "state" WHEN 'INACTIVE' THEN "stateReason" IS NULL WHEN 'ACTIVE' THEN "stateReason" IS NULL
        WHEN 'PAUSED' THEN "stateReason" IN ('OWNER','MODEL_MISMATCH','USAGE_INVALID','UPSTREAM_AUTH')
        WHEN 'REVOKED' THEN "stateReason" = 'OWNER' ELSE "stateReason" = 'VERSION_EXHAUSTED' END
  AND "profile" = 'ask-remote-openai-luna-v1' AND "endpointRegion" = 'EU' AND "dataClass" = 'SYNTHETIC'
  AND "promptSha256" ~ '^[0-9a-f]{64}$' AND "schemaSha256" ~ '^[0-9a-f]{64}$' AND "packageSha256" ~ '^[0-9a-f]{64}$'
  AND "workspaceId" ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'
  AND "projectIdentity" ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{2,127}$'
  AND "secretRef" ~ '^(vault|env|fixture)://[A-Za-z0-9][A-Za-z0-9_./-]{0,199}$'
  AND "ownerApprovalRef" ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{2,127}$'
  AND "retentionAttestationRef" ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{2,127}$'
  AND "priceRevision" ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{2,127}$'
  AND "reserveMicroUsd" = 300000
  AND "dayCapMicroUsd" BETWEEN 0 AND 2000000 AND "monthCapMicroUsd" BETWEEN 0 AND 10000000
  AND "revisedAt" >= "createdAt" AND "expiresAt" <= "revisedAt" + interval '168 hours', false));

ALTER TABLE "RemoteAskClientAdmission" ADD CONSTRAINT "RemoteAskClientAdmission_contract_check" CHECK (coalesce(
  "state" IN ('ADMITTED','REMOVED') AND "changedAtPolicyVersion" >= 1 AND "clientId" ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'
  AND "updatedAt" >= "createdAt", false));

ALTER TABLE "RemoteAskPeriodCounter" ADD CONSTRAINT "RemoteAskPeriodCounter_contract_check" CHECK (coalesce(
  ("kind" = 'DAY' AND "chargedMicroUsd" BETWEEN 0 AND 2000000)
  OR ("kind" = 'MONTH' AND "chargedMicroUsd" BETWEEN 0 AND 10000000
      AND "periodStart" = date_trunc('month', "periodStart"::timestamp)::date), false));

ALTER TABLE "RemoteAskAttempt" ADD CONSTRAINT "RemoteAskAttempt_contract_check" CHECK (coalesce(
  "policyVersion" >= 1 AND "profile" = 'ask-remote-openai-luna-v1'
  AND "priceRevision" ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{2,127}$'
  AND "reservedMicroUsd" = 300000 AND "promptRate" = 275 AND "completionRate" = 825
  AND "dayStart" = ("createdAt" AT TIME ZONE 'UTC')::date
  AND "monthStart" = date_trunc('month', "dayStart"::timestamp)::date
  AND CASE "state"
    WHEN 'EGRESS_COMMITTED' THEN "outcome" IS NULL AND "promptTokens" IS NULL AND "completionTokens" IS NULL
      AND "settledAt" IS NULL AND "accountedMicroUsd" = "reservedMicroUsd"
    WHEN 'SETTLED' THEN "settledAt" >= "createdAt" AND (
      ("outcome" = 'USAGE_VERIFIED' AND "promptTokens" BETWEEN 0 AND 32768 AND "completionTokens" BETWEEN 0 AND 512
        AND "accountedMicroUsd" = ("promptTokens"::bigint * "promptRate" + "completionTokens"::bigint * "completionRate" + 999) / 1000)
      OR ("outcome" = 'NO_DISPATCH' AND "promptTokens" IS NULL AND "completionTokens" IS NULL AND "accountedMicroUsd" = 0
        AND "settledAt" <= "createdAt" + interval '10 seconds'))
    WHEN 'UNKNOWN' THEN "settledAt" >= "createdAt" AND "promptTokens" IS NULL AND "completionTokens" IS NULL
      AND "accountedMicroUsd" = "reservedMicroUsd"
      AND "outcome" IN ('DELIVERY_UNKNOWN','USAGE_INVALID','MODEL_MISMATCH','UPSTREAM_REJECTED')
    ELSE false END, false));

-- ---------------------------------------------------------------------------------------------------------------
-- 4. Guard (plain invoker trigger function; prisma/roles.sql transfers it to the remote definer). Only that owner — i.e.
--    the confined SECURITY DEFINER routines of 202610111020 — may write; the runtime has no DML and the migration owner
--    provisions only through the fence-first routines. No DELETE/TRUNCATE ever. Identities immutable; policy revisions
--    advance policyVersion by exactly one (a whole-row no-op is allowed); TOMBSTONE is terminal; allowlist changes carry
--    the policyVersion their transaction advanced to; attempts leave EGRESS_COMMITTED at most once.
--    SQLSTATE AR007 ASK_REMOTE_GUARD, AR008 ASK_REMOTE_VERSION_EXHAUSTED.
-- ---------------------------------------------------------------------------------------------------------------
CREATE FUNCTION public.atlas_ask_remote_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  v_version bigint;
BEGIN
  IF TG_TABLE_SCHEMA <> 'public' OR TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'ASK_REMOTE_GUARD: % rows are never deleted', TG_TABLE_NAME USING ERRCODE = 'AR007';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = 'atlas_ask_remote_guard'
                    AND p.proowner = (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = current_user)) THEN
    RAISE EXCEPTION 'ASK_REMOTE_GUARD: % is written only by the confined remote routines', TG_TABLE_NAME USING ERRCODE = 'AR007';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'RemoteAskPolicy' THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW."policyVersion" IS DISTINCT FROM 1 OR NEW."state" IS DISTINCT FROM 'INACTIVE' THEN
        RAISE EXCEPTION 'ASK_REMOTE_GUARD: a policy starts INACTIVE at version 1' USING ERRCODE = 'AR007';
      END IF;
      RETURN NEW;
    END IF;
    IF OLD."state" = 'TOMBSTONE' OR OLD."policyVersion" >= 9223372036854775807 THEN
      RAISE EXCEPTION 'ASK_REMOTE_VERSION_EXHAUSTED' USING ERRCODE = 'AR008';
    END IF;
    IF NEW."workspaceId" IS DISTINCT FROM OLD."workspaceId" OR NEW."admissionId" IS DISTINCT FROM OLD."admissionId"
       OR NEW."projectIdentity" IS DISTINCT FROM OLD."projectIdentity" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
       OR NEW."profile" IS DISTINCT FROM OLD."profile" OR NEW."endpointRegion" IS DISTINCT FROM OLD."endpointRegion"
       OR NEW."dataClass" IS DISTINCT FROM OLD."dataClass" OR NEW."reserveMicroUsd" IS DISTINCT FROM OLD."reserveMicroUsd"
       OR NEW."policyVersion" IS DISTINCT FROM OLD."policyVersion" + 1 OR NEW."revisedAt" < OLD."revisedAt" THEN
      RAISE EXCEPTION 'ASK_REMOTE_GUARD: policy identity is immutable and every revision advances policyVersion by one'
        USING ERRCODE = 'AR007';
    END IF;
    -- Lower-only budget: no write path (routine or direct) may raise a day or month cap above its current value.
    IF NEW."dayCapMicroUsd" > OLD."dayCapMicroUsd" OR NEW."monthCapMicroUsd" > OLD."monthCapMicroUsd" THEN
      RAISE EXCEPTION 'ASK_REMOTE_GUARD: budget caps are never raised by a revision' USING ERRCODE = 'AR007';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'RemoteAskClientAdmission' THEN
    SELECT p."policyVersion" INTO v_version FROM public."RemoteAskPolicy" p
     WHERE p."workspaceId" = NEW."workspaceId" AND p."admissionId" = NEW."admissionId";
    IF v_version IS NULL OR NEW."changedAtPolicyVersion" IS DISTINCT FROM v_version
       OR (TG_OP = 'INSERT' AND NEW."state" IS DISTINCT FROM 'ADMITTED')
       OR (TG_OP = 'UPDATE' AND (NEW."workspaceId" IS DISTINCT FROM OLD."workspaceId" OR NEW."admissionId" IS DISTINCT FROM OLD."admissionId"
            OR NEW."clientId" IS DISTINCT FROM OLD."clientId" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
            OR NEW."state" IS NOT DISTINCT FROM OLD."state" OR NEW."changedAtPolicyVersion" <= OLD."changedAtPolicyVersion")) THEN
      RAISE EXCEPTION 'ASK_REMOTE_GUARD: an allowlist change is immutable in identity and carries the advanced policyVersion'
        USING ERRCODE = 'AR007';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'RemoteAskPeriodCounter' THEN
    IF (TG_OP = 'INSERT' AND NEW."chargedMicroUsd" IS DISTINCT FROM 0)
       OR (TG_OP = 'UPDATE' AND (NEW."workspaceId" IS DISTINCT FROM OLD."workspaceId" OR NEW."projectIdentity" IS DISTINCT FROM OLD."projectIdentity"
            OR NEW."kind" IS DISTINCT FROM OLD."kind" OR NEW."periodStart" IS DISTINCT FROM OLD."periodStart"
            OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt")) THEN
      RAISE EXCEPTION 'ASK_REMOTE_GUARD: a counter starts at zero and its period identity is immutable' USING ERRCODE = 'AR007';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'RemoteAskAttempt' THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW."state" IS DISTINCT FROM 'EGRESS_COMMITTED' THEN
        RAISE EXCEPTION 'ASK_REMOTE_GUARD: an attempt starts EGRESS_COMMITTED' USING ERRCODE = 'AR007';
      END IF;
      RETURN NEW;
    END IF;
    IF OLD."state" IS DISTINCT FROM 'EGRESS_COMMITTED' OR NEW."state" NOT IN ('SETTLED', 'UNKNOWN')
       OR NEW."workspaceId" IS DISTINCT FROM OLD."workspaceId" OR NEW.id IS DISTINCT FROM OLD.id
       OR NEW."clientId" IS DISTINCT FROM OLD."clientId" OR NEW."actorId" IS DISTINCT FROM OLD."actorId"
       OR NEW."admissionId" IS DISTINCT FROM OLD."admissionId" OR NEW."projectIdentity" IS DISTINCT FROM OLD."projectIdentity"
       OR NEW."policyVersion" IS DISTINCT FROM OLD."policyVersion" OR NEW."profile" IS DISTINCT FROM OLD."profile"
       OR NEW."priceRevision" IS DISTINCT FROM OLD."priceRevision" OR NEW."correlationId" IS DISTINCT FROM OLD."correlationId"
       OR NEW."dayStart" IS DISTINCT FROM OLD."dayStart" OR NEW."monthStart" IS DISTINCT FROM OLD."monthStart"
       OR NEW."reservedMicroUsd" IS DISTINCT FROM OLD."reservedMicroUsd" OR NEW."promptRate" IS DISTINCT FROM OLD."promptRate"
       OR NEW."completionRate" IS DISTINCT FROM OLD."completionRate" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
      RAISE EXCEPTION 'ASK_REMOTE_GUARD: an attempt is settled at most once and its captured identity is immutable'
        USING ERRCODE = 'AR007';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ASK_REMOTE_GUARD: unexpected trigger use' USING ERRCODE = 'AR007';
END $fn$;
REVOKE ALL ON FUNCTION public.atlas_ask_remote_guard() FROM PUBLIC;

-- Deferred ledger invariant (checked at COMMIT, as the committing role, which only reads): every touched counter equals
-- the sum of accountedMicroUsd of its project's attempts in that ORIGINAL UTC period, and every touched attempt has both
-- of its period counters, each equal to that sum. A double refund, a lost reservation or a counter edit cannot commit.
-- SQLSTATE AR010 ASK_REMOTE_LEDGER_INVARIANT.
CREATE FUNCTION public.atlas_ask_remote_ledger_check() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  v_kinds text[];
  v_starts date[];
  v_kind text;
  v_start date;
  v_charged bigint;
  v_sum numeric;
BEGIN
  -- Each table's fields are referenced only in its own branch (PL/pgSQL resolves NEW fields when an expression is planned).
  IF TG_TABLE_NAME = 'RemoteAskPeriodCounter' THEN
    v_kinds := ARRAY[NEW."kind"]; v_starts := ARRAY[NEW."periodStart"];
  ELSE
    v_kinds := ARRAY['MONTH', 'DAY']; v_starts := ARRAY[NEW."monthStart", NEW."dayStart"];
  END IF;
  FOR i IN 1 .. pg_catalog.array_length(v_kinds, 1) LOOP
    v_kind := v_kinds[i]; v_start := v_starts[i];
    v_charged := NULL;
    SELECT c."chargedMicroUsd" INTO v_charged FROM public."RemoteAskPeriodCounter" c
     WHERE c."workspaceId" = NEW."workspaceId" AND c."projectIdentity" = NEW."projectIdentity" AND c."kind" = v_kind AND c."periodStart" = v_start;
    SELECT coalesce(sum(a."accountedMicroUsd"), 0) INTO v_sum FROM public."RemoteAskAttempt" a
     WHERE a."workspaceId" = NEW."workspaceId" AND a."projectIdentity" = NEW."projectIdentity"
       AND (CASE WHEN v_kind = 'DAY' THEN a."dayStart" ELSE a."monthStart" END) = v_start;
    IF v_charged IS NULL OR v_charged <> v_sum THEN
      RAISE EXCEPTION 'ASK_REMOTE_LEDGER_INVARIANT' USING ERRCODE = 'AR010';
    END IF;
  END LOOP;
  RETURN NULL;
END $fn$;
REVOKE ALL ON FUNCTION public.atlas_ask_remote_ledger_check() FROM PUBLIC;

CREATE TRIGGER "RemoteAskPolicy_guard" BEFORE INSERT OR UPDATE OR DELETE ON "RemoteAskPolicy"
  FOR EACH ROW EXECUTE FUNCTION public.atlas_ask_remote_guard();
CREATE TRIGGER "RemoteAskPolicy_truncate" BEFORE TRUNCATE ON "RemoteAskPolicy"
  FOR EACH STATEMENT EXECUTE FUNCTION public.atlas_ask_remote_guard();
CREATE TRIGGER "RemoteAskClientAdmission_guard" BEFORE INSERT OR UPDATE OR DELETE ON "RemoteAskClientAdmission"
  FOR EACH ROW EXECUTE FUNCTION public.atlas_ask_remote_guard();
CREATE TRIGGER "RemoteAskClientAdmission_truncate" BEFORE TRUNCATE ON "RemoteAskClientAdmission"
  FOR EACH STATEMENT EXECUTE FUNCTION public.atlas_ask_remote_guard();
CREATE TRIGGER "RemoteAskPeriodCounter_guard" BEFORE INSERT OR UPDATE OR DELETE ON "RemoteAskPeriodCounter"
  FOR EACH ROW EXECUTE FUNCTION public.atlas_ask_remote_guard();
CREATE TRIGGER "RemoteAskPeriodCounter_truncate" BEFORE TRUNCATE ON "RemoteAskPeriodCounter"
  FOR EACH STATEMENT EXECUTE FUNCTION public.atlas_ask_remote_guard();
CREATE TRIGGER "RemoteAskAttempt_guard" BEFORE INSERT OR UPDATE OR DELETE ON "RemoteAskAttempt"
  FOR EACH ROW EXECUTE FUNCTION public.atlas_ask_remote_guard();
CREATE TRIGGER "RemoteAskAttempt_truncate" BEFORE TRUNCATE ON "RemoteAskAttempt"
  FOR EACH STATEMENT EXECUTE FUNCTION public.atlas_ask_remote_guard();
CREATE CONSTRAINT TRIGGER "RemoteAskPeriodCounter_ledger" AFTER INSERT OR UPDATE ON "RemoteAskPeriodCounter"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.atlas_ask_remote_ledger_check();
CREATE CONSTRAINT TRIGGER "RemoteAskAttempt_ledger" AFTER INSERT OR UPDATE ON "RemoteAskAttempt"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.atlas_ask_remote_ledger_check();
-- ENABLE ALWAYS: also under session_replication_role = replica.
ALTER TABLE "RemoteAskPolicy" ENABLE ALWAYS TRIGGER "RemoteAskPolicy_guard", ENABLE ALWAYS TRIGGER "RemoteAskPolicy_truncate";
ALTER TABLE "RemoteAskClientAdmission" ENABLE ALWAYS TRIGGER "RemoteAskClientAdmission_guard",
  ENABLE ALWAYS TRIGGER "RemoteAskClientAdmission_truncate";
ALTER TABLE "RemoteAskPeriodCounter" ENABLE ALWAYS TRIGGER "RemoteAskPeriodCounter_guard", ENABLE ALWAYS TRIGGER "RemoteAskPeriodCounter_truncate",
  ENABLE ALWAYS TRIGGER "RemoteAskPeriodCounter_ledger";
ALTER TABLE "RemoteAskAttempt" ENABLE ALWAYS TRIGGER "RemoteAskAttempt_guard", ENABLE ALWAYS TRIGGER "RemoteAskAttempt_truncate",
  ENABLE ALWAYS TRIGGER "RemoteAskAttempt_ledger";

-- ---------------------------------------------------------------------------------------------------------------
-- 5. Row-level security: FORCE (the table owner too), exactly one PUBLIC workspace policy per table.
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE "RemoteAskPolicy" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RemoteAskPolicy" FORCE ROW LEVEL SECURITY;
CREATE POLICY "RemoteAskPolicy_scope" ON "RemoteAskPolicy" FOR ALL
  USING ("workspaceId" = atlas_app_workspace()) WITH CHECK ("workspaceId" = atlas_app_workspace());
ALTER TABLE "RemoteAskClientAdmission" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RemoteAskClientAdmission" FORCE ROW LEVEL SECURITY;
CREATE POLICY "RemoteAskClientAdmission_scope" ON "RemoteAskClientAdmission" FOR ALL
  USING ("workspaceId" = atlas_app_workspace()) WITH CHECK ("workspaceId" = atlas_app_workspace());
ALTER TABLE "RemoteAskPeriodCounter" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RemoteAskPeriodCounter" FORCE ROW LEVEL SECURITY;
CREATE POLICY "RemoteAskPeriodCounter_scope" ON "RemoteAskPeriodCounter" FOR ALL
  USING ("workspaceId" = atlas_app_workspace()) WITH CHECK ("workspaceId" = atlas_app_workspace());
ALTER TABLE "RemoteAskAttempt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RemoteAskAttempt" FORCE ROW LEVEL SECURITY;
CREATE POLICY "RemoteAskAttempt_scope" ON "RemoteAskAttempt" FOR ALL
  USING ("workspaceId" = atlas_app_workspace()) WITH CHECK ("workspaceId" = atlas_app_workspace());
