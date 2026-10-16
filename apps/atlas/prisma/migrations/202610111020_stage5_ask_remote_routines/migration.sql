-- Stage 5 ASK-REMOTE R-A (docs/stage5/ask/remote/04_AUTHORITY_AND_BILLING.md): the confined remote routines. Additive.
-- Each is SECURITY DEFINER with a fixed search_path, schema-qualified objects, validated arguments and no dynamic SQL;
-- EXECUTE is revoked from PUBLIC at once and the migration references no role. prisma/roles.sql (after deploy) transfers
-- every atlas_ask_remote_* routine to the NOLOGIN remote definer and grants EXECUTE on exactly:
--   runtime: atlas_ask_remote_reserve, atlas_ask_remote_settle, atlas_ask_remote_pause (never activate/provision/revise);
--   migration owner (trusted provisioning): atlas_ask_remote_policy_create, _policy_revise, _client_set.
-- RLS applies to the definer: the caller sets app.workspace_id (and, for reserve/settle, app.client_ids = the one client)
-- transaction-locally; every scope argument must equal its setting before any lock. Nothing here sends anything anywhere.
--
-- Lock order (all routines, no cycle): ActionAuthorityFence → RemoteAskPolicy → MONTH counter → DAY counter → attempt.
--   revisions/allowlist/pause: fence FOR UPDATE (+1, existing semantics) → policy FOR UPDATE (policyVersion +1).
--   reserve: fence FOR SHARE (the caller's egress transaction normally holds it already) → policy FOR SHARE → missing
--            counters created unique-key-safely (MONTH, DAY) → MONTH FOR UPDATE → DAY FOR UPDATE → attempt INSERT.
--   settle:  immutable period keys read without a lock → MONTH FOR UPDATE → DAY FOR UPDATE → attempt FOR UPDATE; never
--            the fence or the policy.
-- Money: fixed reserve 300000 micro-USD; settlement ceil((prompt*275 + completion*825)/1000) from VALIDATED token counts;
-- every outcome other than USAGE_VERIFIED/NO_DISPATCH keeps the whole reserve. The routine TRUSTS the runtime caller's
-- outcome: it cannot see the network or the process. NO_DISPATCH (0) is refused more than 10 s after the attempt, which only
-- bounds how late a zero refund can be claimed; it proves neither process continuity nor that nothing was dispatched (a
-- fresh connection inside the window is accepted). The private, non-reconstructible in-process dispatch/refund ownership
-- proof is an R-B obligation, not something these SQL routines establish. Exactly once: EGRESS_COMMITTED → SETTLED | UNKNOWN. UTC periods from now() AT TIME ZONE
-- 'UTC' (independent of the session TimeZone); late settlement adjusts the ORIGINAL periods.
-- SQLSTATEs (packages/ask/remote/ledger-sql.ts): AR001 NOT_ADMITTED, AR002 POLICY_CHANGED, AR003 BUDGET, AR004 SCOPE,
-- AR005 AUTHORITY_CHANGED, AR006 SETTLEMENT_REFUSED, AR008 VERSION_EXHAUSTED, AR009 REVISION_REFUSED.

-- ---------------------------------------------------------------------------------------------------------------
-- 1. Runtime: reserve one attempt (the last step of the egress admission transaction).
-- ---------------------------------------------------------------------------------------------------------------
CREATE FUNCTION public.atlas_ask_remote_reserve(p_workspace TEXT, p_client TEXT, p_actor TEXT, p_admission UUID, p_policy_version BIGINT,
  p_fence_version INTEGER, p_profile TEXT, p_price_revision TEXT, p_correlation UUID) RETURNS UUID
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  v_id constant text := '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$';
  v_reserve constant bigint := 300000;
  v_fence integer;
  v_policy public."RemoteAskPolicy"%ROWTYPE;
  v_client_state text;
  v_day date;
  v_month date;
  v_month_charged bigint;
  v_day_charged bigint;
  v_attempt uuid;
BEGIN
  IF p_workspace IS NULL OR p_client IS NULL OR p_actor IS NULL OR p_admission IS NULL OR p_policy_version IS NULL
     OR p_fence_version IS NULL OR p_profile IS NULL OR p_price_revision IS NULL OR p_correlation IS NULL
     OR p_workspace !~ v_id OR p_client !~ v_id OR p_actor !~ v_id
     OR pg_catalog.current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace
     OR pg_catalog.current_setting('app.client_ids', true) IS DISTINCT FROM p_client THEN
    RAISE EXCEPTION 'ASK_REMOTE_SCOPE' USING ERRCODE = 'AR004';
  END IF;
  SELECT f.version INTO v_fence FROM public."ActionAuthorityFence" f WHERE f."workspaceId" = p_workspace FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ASK_REMOTE_SCOPE' USING ERRCODE = 'AR004';
  END IF;
  IF v_fence IS DISTINCT FROM p_fence_version THEN
    RAISE EXCEPTION 'ASK_REMOTE_AUTHORITY_CHANGED' USING ERRCODE = 'AR005';
  END IF;
  -- The admission predicates are re-evaluated here, at the routine boundary: consent tuple first (a stale tuple is a
  -- changed policy even when the caller captured a newer fence epoch), then active/expiry/profile/price/client, then caps.
  SELECT x.* INTO v_policy FROM public."RemoteAskPolicy" x WHERE x."workspaceId" = p_workspace FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ASK_REMOTE_NOT_ADMITTED' USING ERRCODE = 'AR001';
  END IF;
  IF v_policy."admissionId" IS DISTINCT FROM p_admission OR v_policy."policyVersion" IS DISTINCT FROM p_policy_version THEN
    RAISE EXCEPTION 'ASK_REMOTE_POLICY_CHANGED' USING ERRCODE = 'AR002';
  END IF;
  IF v_policy."state" IS DISTINCT FROM 'ACTIVE' OR pg_catalog.clock_timestamp() >= v_policy."expiresAt"
     OR v_policy."profile" IS DISTINCT FROM p_profile OR v_policy."priceRevision" IS DISTINCT FROM p_price_revision
     OR v_policy."reserveMicroUsd" IS DISTINCT FROM v_reserve THEN
    RAISE EXCEPTION 'ASK_REMOTE_NOT_ADMITTED' USING ERRCODE = 'AR001';
  END IF;
  SELECT a."state" INTO v_client_state FROM public."RemoteAskClientAdmission" a
   WHERE a."workspaceId" = p_workspace AND a."admissionId" = p_admission AND a."clientId" = p_client;
  IF v_client_state IS DISTINCT FROM 'ADMITTED' THEN
    RAISE EXCEPTION 'ASK_REMOTE_NOT_ADMITTED' USING ERRCODE = 'AR001';
  END IF;

  v_day := (pg_catalog.now() AT TIME ZONE 'UTC')::date;
  v_month := pg_catalog.date_trunc('month', v_day::timestamp)::date;
  INSERT INTO public."RemoteAskPeriodCounter" ("workspaceId", "projectIdentity", "kind", "periodStart")
  VALUES (p_workspace, v_policy."projectIdentity", 'MONTH', v_month) ON CONFLICT DO NOTHING;
  INSERT INTO public."RemoteAskPeriodCounter" ("workspaceId", "projectIdentity", "kind", "periodStart")
  VALUES (p_workspace, v_policy."projectIdentity", 'DAY', v_day) ON CONFLICT DO NOTHING;
  SELECT c."chargedMicroUsd" INTO v_month_charged FROM public."RemoteAskPeriodCounter" c
   WHERE c."workspaceId" = p_workspace AND c."projectIdentity" = v_policy."projectIdentity" AND c."kind" = 'MONTH' AND c."periodStart" = v_month
   FOR UPDATE;
  SELECT c."chargedMicroUsd" INTO v_day_charged FROM public."RemoteAskPeriodCounter" c
   WHERE c."workspaceId" = p_workspace AND c."projectIdentity" = v_policy."projectIdentity" AND c."kind" = 'DAY' AND c."periodStart" = v_day
   FOR UPDATE;
  IF v_month_charged IS NULL OR v_day_charged IS NULL THEN
    RAISE EXCEPTION 'ASK_REMOTE_SCOPE' USING ERRCODE = 'AR004';
  END IF;
  -- The counter locks may have waited: the policy (held FOR SHARE, so unchanged) must still be unexpired on the DB clock.
  IF pg_catalog.clock_timestamp() >= v_policy."expiresAt" THEN
    RAISE EXCEPTION 'ASK_REMOTE_NOT_ADMITTED' USING ERRCODE = 'AR001';
  END IF;
  -- A lowered cap below the existing spend refuses every new reservation; it never rewrites a counter.
  IF v_month_charged + v_reserve > v_policy."monthCapMicroUsd" OR v_day_charged + v_reserve > v_policy."dayCapMicroUsd" THEN
    RAISE EXCEPTION 'ASK_REMOTE_BUDGET' USING ERRCODE = 'AR003';
  END IF;

  v_attempt := pg_catalog.gen_random_uuid();
  BEGIN
    INSERT INTO public."RemoteAskAttempt" ("workspaceId", id, "clientId", "actorId", "admissionId", "projectIdentity", "policyVersion",
      "profile", "priceRevision", "correlationId", "dayStart", "monthStart", "reservedMicroUsd", "promptRate", "completionRate",
      "accountedMicroUsd", "state", "createdAt")
    VALUES (p_workspace, v_attempt, p_client, p_actor, p_admission, v_policy."projectIdentity", v_policy."policyVersion",
      v_policy."profile", v_policy."priceRevision", p_correlation, v_day, v_month, v_reserve, 275, 825,
      v_reserve, 'EGRESS_COMMITTED', pg_catalog.now());
  EXCEPTION WHEN foreign_key_violation OR unique_violation THEN
    -- An actor of another workspace (scoped FK) or a reused correlation ID: fixed refusal, nothing reserved.
    RAISE EXCEPTION 'ASK_REMOTE_SCOPE' USING ERRCODE = 'AR004';
  END;
  UPDATE public."RemoteAskPeriodCounter" c SET "chargedMicroUsd" = c."chargedMicroUsd" + v_reserve, "updatedAt" = pg_catalog.clock_timestamp()
   WHERE c."workspaceId" = p_workspace AND c."projectIdentity" = v_policy."projectIdentity" AND c."kind" = 'MONTH' AND c."periodStart" = v_month;
  UPDATE public."RemoteAskPeriodCounter" c SET "chargedMicroUsd" = c."chargedMicroUsd" + v_reserve, "updatedAt" = pg_catalog.clock_timestamp()
   WHERE c."workspaceId" = p_workspace AND c."projectIdentity" = v_policy."projectIdentity" AND c."kind" = 'DAY' AND c."periodStart" = v_day;
  -- Immediately before returning: still unexpired after the INSERT and counter updates; otherwise the whole statement (attempt
  -- and both counter increments) is undone by this fixed refusal.
  IF pg_catalog.clock_timestamp() >= v_policy."expiresAt" THEN
    RAISE EXCEPTION 'ASK_REMOTE_NOT_ADMITTED' USING ERRCODE = 'AR001';
  END IF;
  RETURN v_attempt;
END $fn$;
REVOKE ALL ON FUNCTION public.atlas_ask_remote_reserve(TEXT, TEXT, TEXT, UUID, BIGINT, INTEGER, TEXT, TEXT, UUID) FROM PUBLIC;

-- ---------------------------------------------------------------------------------------------------------------
-- 2. Runtime: settle one attempt exactly once (separate bounded financial-only transaction; also during drain).
-- ---------------------------------------------------------------------------------------------------------------
CREATE FUNCTION public.atlas_ask_remote_settle(p_workspace TEXT, p_client TEXT, p_attempt UUID, p_correlation UUID, p_outcome TEXT,
  p_prompt_tokens INTEGER, p_completion_tokens INTEGER) RETURNS BIGINT
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  v_id constant text := '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$';
  v_project text;
  v_day date;
  v_month date;
  v_attempt public."RemoteAskAttempt"%ROWTYPE;
  v_accounted bigint;
  v_refund bigint;
BEGIN
  IF p_workspace IS NULL OR p_client IS NULL OR p_attempt IS NULL OR p_correlation IS NULL OR p_outcome IS NULL
     OR p_workspace !~ v_id OR p_client !~ v_id
     OR pg_catalog.current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace
     OR pg_catalog.current_setting('app.client_ids', true) IS DISTINCT FROM p_client THEN
    RAISE EXCEPTION 'ASK_REMOTE_SCOPE' USING ERRCODE = 'AR004';
  END IF;
  -- (Parenthesized: PL/pgSQL ends an IF condition at the first THEN outside parentheses.)
  IF NOT (CASE WHEN p_outcome = 'USAGE_VERIFIED'
                 THEN coalesce(p_prompt_tokens BETWEEN 0 AND 32768 AND p_completion_tokens BETWEEN 0 AND 512, false)
               WHEN p_outcome IN ('NO_DISPATCH', 'DELIVERY_UNKNOWN', 'USAGE_INVALID', 'MODEL_MISMATCH', 'UPSTREAM_REJECTED')
                 THEN p_prompt_tokens IS NULL AND p_completion_tokens IS NULL
               ELSE false END) THEN
    RAISE EXCEPTION 'ASK_REMOTE_SETTLEMENT_REFUSED' USING ERRCODE = 'AR006';
  END IF;
  SELECT a."projectIdentity", a."dayStart", a."monthStart" INTO v_project, v_day, v_month FROM public."RemoteAskAttempt" a
   WHERE a."workspaceId" = p_workspace AND a.id = p_attempt;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ASK_REMOTE_SETTLEMENT_REFUSED' USING ERRCODE = 'AR006';
  END IF;
  PERFORM 1 FROM public."RemoteAskPeriodCounter" c
   WHERE c."workspaceId" = p_workspace AND c."projectIdentity" = v_project AND c."kind" = 'MONTH' AND c."periodStart" = v_month FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ASK_REMOTE_SETTLEMENT_REFUSED' USING ERRCODE = 'AR006';
  END IF;
  PERFORM 1 FROM public."RemoteAskPeriodCounter" c
   WHERE c."workspaceId" = p_workspace AND c."projectIdentity" = v_project AND c."kind" = 'DAY' AND c."periodStart" = v_day FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ASK_REMOTE_SETTLEMENT_REFUSED' USING ERRCODE = 'AR006';
  END IF;
  SELECT a.* INTO v_attempt FROM public."RemoteAskAttempt" a WHERE a."workspaceId" = p_workspace AND a.id = p_attempt FOR UPDATE;
  IF NOT FOUND OR v_attempt."clientId" IS DISTINCT FROM p_client OR v_attempt."correlationId" IS DISTINCT FROM p_correlation
     OR v_attempt."state" IS DISTINCT FROM 'EGRESS_COMMITTED' OR v_attempt."projectIdentity" IS DISTINCT FROM v_project
     OR v_attempt."dayStart" IS DISTINCT FROM v_day OR v_attempt."monthStart" IS DISTINCT FROM v_month THEN
    RAISE EXCEPTION 'ASK_REMOTE_SETTLEMENT_REFUSED' USING ERRCODE = 'AR006';
  END IF;
  IF p_outcome = 'NO_DISPATCH' AND pg_catalog.clock_timestamp() > v_attempt."createdAt" + interval '10 seconds' THEN
    RAISE EXCEPTION 'ASK_REMOTE_SETTLEMENT_REFUSED' USING ERRCODE = 'AR006';
  END IF;
  v_accounted := CASE p_outcome
    WHEN 'USAGE_VERIFIED' THEN (p_prompt_tokens::bigint * v_attempt."promptRate" + p_completion_tokens::bigint * v_attempt."completionRate" + 999) / 1000
    WHEN 'NO_DISPATCH' THEN 0
    ELSE v_attempt."reservedMicroUsd" END;
  IF v_accounted < 0 OR v_accounted > v_attempt."reservedMicroUsd" THEN
    RAISE EXCEPTION 'ASK_REMOTE_SETTLEMENT_REFUSED' USING ERRCODE = 'AR006';
  END IF;
  UPDATE public."RemoteAskAttempt" a SET "state" = CASE WHEN p_outcome IN ('USAGE_VERIFIED', 'NO_DISPATCH') THEN 'SETTLED' ELSE 'UNKNOWN' END,
         "outcome" = p_outcome, "promptTokens" = p_prompt_tokens, "completionTokens" = p_completion_tokens,
         "accountedMicroUsd" = v_accounted, "settledAt" = pg_catalog.clock_timestamp()
   WHERE a."workspaceId" = p_workspace AND a.id = p_attempt;
  v_refund := v_attempt."reservedMicroUsd" - v_accounted;
  IF v_refund > 0 THEN
    UPDATE public."RemoteAskPeriodCounter" c SET "chargedMicroUsd" = c."chargedMicroUsd" - v_refund, "updatedAt" = pg_catalog.clock_timestamp()
     WHERE c."workspaceId" = p_workspace AND c."projectIdentity" = v_project AND c."kind" = 'MONTH' AND c."periodStart" = v_month;
    UPDATE public."RemoteAskPeriodCounter" c SET "chargedMicroUsd" = c."chargedMicroUsd" - v_refund, "updatedAt" = pg_catalog.clock_timestamp()
     WHERE c."workspaceId" = p_workspace AND c."projectIdentity" = v_project AND c."kind" = 'DAY' AND c."periodStart" = v_day;
  END IF;
  RETURN v_accounted;
END $fn$;
REVOKE ALL ON FUNCTION public.atlas_ask_remote_settle(TEXT, TEXT, UUID, UUID, TEXT, INTEGER, INTEGER) FROM PUBLIC;

-- ---------------------------------------------------------------------------------------------------------------
-- 3. Runtime: narrow durable pause of an ACTIVE policy (configuration-fault circuit). Never activates. A non-active
--    policy is a no-op (no version change). Separate bounded transaction holding no financial lock or shared fence.
-- ---------------------------------------------------------------------------------------------------------------
CREATE FUNCTION public.atlas_ask_remote_pause(p_workspace TEXT, p_admission UUID, p_reason TEXT) RETURNS BIGINT
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  v_id constant text := '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$';
  v_max constant bigint := 9223372036854775807;
  v_policy public."RemoteAskPolicy"%ROWTYPE;
  v_new bigint;
BEGIN
  IF p_workspace IS NULL OR p_admission IS NULL OR p_workspace !~ v_id
     OR p_reason IS NULL OR p_reason NOT IN ('MODEL_MISMATCH', 'USAGE_INVALID', 'UPSTREAM_AUTH')
     OR pg_catalog.current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace THEN
    RAISE EXCEPTION 'ASK_REMOTE_SCOPE' USING ERRCODE = 'AR004';
  END IF;
  PERFORM 1 FROM public."ActionAuthorityFence" f WHERE f."workspaceId" = p_workspace FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ASK_REMOTE_SCOPE' USING ERRCODE = 'AR004';
  END IF;
  SELECT x.* INTO v_policy FROM public."RemoteAskPolicy" x WHERE x."workspaceId" = p_workspace FOR UPDATE;
  IF NOT FOUND OR v_policy."admissionId" IS DISTINCT FROM p_admission THEN
    RAISE EXCEPTION 'ASK_REMOTE_SCOPE' USING ERRCODE = 'AR004';
  END IF;
  IF v_policy."state" IS DISTINCT FROM 'ACTIVE' THEN
    RETURN v_policy."policyVersion";
  END IF;
  UPDATE public."ActionAuthorityFence" f SET version = f.version + 1 WHERE f."workspaceId" = p_workspace;
  v_new := v_policy."policyVersion" + 1;
  UPDATE public."RemoteAskPolicy" x SET "policyVersion" = v_new,
         "state" = CASE WHEN v_new = v_max THEN 'TOMBSTONE' ELSE 'PAUSED' END,
         "stateReason" = CASE WHEN v_new = v_max THEN 'VERSION_EXHAUSTED' ELSE p_reason END,
         "revisedAt" = GREATEST(x."revisedAt", pg_catalog.clock_timestamp())
   WHERE x."workspaceId" = p_workspace;
  RETURN v_new;
END $fn$;
REVOKE ALL ON FUNCTION public.atlas_ask_remote_pause(TEXT, UUID, TEXT) FROM PUBLIC;

-- ---------------------------------------------------------------------------------------------------------------
-- 4. Trusted owner provisioning (EXECUTE: migration owner only). Fence FIRST FOR UPDATE, then the policy. Creation is
--    INACTIVE at version 1 and happens once per workspace (no delete/recreate). A revision names the version it read
--    (p_expected_version) and states EVERY material field; an identical revision is a no-op without any version change.
--    A revision may lower the day/month caps but never raise either above its current value (no budget-increase path).
-- ---------------------------------------------------------------------------------------------------------------
CREATE FUNCTION public.atlas_ask_remote_policy_create(p_workspace TEXT, p_admission UUID, p_project TEXT, p_secret_ref TEXT,
  p_owner_approval_ref TEXT, p_retention_ref TEXT, p_price_revision TEXT, p_prompt_sha256 TEXT, p_schema_sha256 TEXT,
  p_package_sha256 TEXT, p_day_cap BIGINT, p_month_cap BIGINT, p_expires_at TIMESTAMPTZ) RETURNS BIGINT
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  v_id constant text := '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$';
  v_now timestamptz;
BEGIN
  IF p_workspace IS NULL OR p_workspace !~ v_id OR pg_catalog.current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace THEN
    RAISE EXCEPTION 'ASK_REMOTE_SCOPE' USING ERRCODE = 'AR004';
  END IF;
  PERFORM 1 FROM public."ActionAuthorityFence" f WHERE f."workspaceId" = p_workspace FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ASK_REMOTE_SCOPE' USING ERRCODE = 'AR004';
  END IF;
  IF p_admission IS NULL OR p_expires_at IS NULL OR EXISTS (SELECT 1 FROM public."RemoteAskPolicy" x WHERE x."workspaceId" = p_workspace) THEN
    RAISE EXCEPTION 'ASK_REMOTE_REVISION_REFUSED' USING ERRCODE = 'AR009';
  END IF;
  UPDATE public."ActionAuthorityFence" f SET version = f.version + 1 WHERE f."workspaceId" = p_workspace;
  v_now := pg_catalog.clock_timestamp();
  BEGIN
    INSERT INTO public."RemoteAskPolicy" ("workspaceId", "admissionId", "projectIdentity", "policyVersion", "state", "profile",
      "endpointRegion", "dataClass", "promptSha256", "schemaSha256", "packageSha256", "secretRef", "ownerApprovalRef",
      "retentionAttestationRef", "priceRevision", "reserveMicroUsd", "dayCapMicroUsd", "monthCapMicroUsd", "expiresAt", "revisedAt", "createdAt")
    VALUES (p_workspace, p_admission, p_project, 1, 'INACTIVE', 'ask-remote-openai-luna-v1', 'EU', 'SYNTHETIC', p_prompt_sha256,
      p_schema_sha256, p_package_sha256, p_secret_ref, p_owner_approval_ref, p_retention_ref, p_price_revision, 300000,
      p_day_cap, p_month_cap, p_expires_at, v_now, v_now);
  EXCEPTION WHEN check_violation OR unique_violation OR not_null_violation OR foreign_key_violation THEN
    RAISE EXCEPTION 'ASK_REMOTE_REVISION_REFUSED' USING ERRCODE = 'AR009';
  END;
  RETURN 1;
END $fn$;
REVOKE ALL ON FUNCTION public.atlas_ask_remote_policy_create(TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, BIGINT, TIMESTAMPTZ) FROM PUBLIC;

CREATE FUNCTION public.atlas_ask_remote_policy_revise(p_workspace TEXT, p_admission UUID, p_expected_version BIGINT, p_state TEXT,
  p_secret_ref TEXT, p_owner_approval_ref TEXT, p_retention_ref TEXT, p_price_revision TEXT, p_prompt_sha256 TEXT, p_schema_sha256 TEXT,
  p_package_sha256 TEXT, p_day_cap BIGINT, p_month_cap BIGINT, p_expires_at TIMESTAMPTZ) RETURNS BIGINT
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  v_id constant text := '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$';
  v_max constant bigint := 9223372036854775807;
  v_policy public."RemoteAskPolicy"%ROWTYPE;
  v_new bigint;
  v_now timestamptz;
BEGIN
  IF p_workspace IS NULL OR p_workspace !~ v_id OR pg_catalog.current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace THEN
    RAISE EXCEPTION 'ASK_REMOTE_SCOPE' USING ERRCODE = 'AR004';
  END IF;
  PERFORM 1 FROM public."ActionAuthorityFence" f WHERE f."workspaceId" = p_workspace FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ASK_REMOTE_SCOPE' USING ERRCODE = 'AR004';
  END IF;
  SELECT x.* INTO v_policy FROM public."RemoteAskPolicy" x WHERE x."workspaceId" = p_workspace FOR UPDATE;
  IF NOT FOUND OR v_policy."admissionId" IS DISTINCT FROM p_admission THEN
    RAISE EXCEPTION 'ASK_REMOTE_REVISION_REFUSED' USING ERRCODE = 'AR009';
  END IF;
  IF v_policy."state" = 'TOMBSTONE' THEN
    RAISE EXCEPTION 'ASK_REMOTE_VERSION_EXHAUSTED' USING ERRCODE = 'AR008';
  END IF;
  IF p_expected_version IS DISTINCT FROM v_policy."policyVersion" OR p_state IS NULL
     OR p_state NOT IN ('INACTIVE', 'ACTIVE', 'PAUSED', 'REVOKED') OR p_expires_at IS NULL THEN
    RAISE EXCEPTION 'ASK_REMOTE_REVISION_REFUSED' USING ERRCODE = 'AR009';
  END IF;
  -- Budget caps only go down in an ordinary revision (04: lower-only admission). Neither cap may exceed its CURRENT value,
  -- whatever the approval reference, expiry or state change says; an increase needs a separately reviewed amendment and
  -- has no path here. Refused before any fence/version change, so nothing is modified.
  IF p_day_cap IS NULL OR p_month_cap IS NULL OR p_day_cap > v_policy."dayCapMicroUsd" OR p_month_cap > v_policy."monthCapMicroUsd" THEN
    RAISE EXCEPTION 'ASK_REMOTE_REVISION_REFUSED' USING ERRCODE = 'AR009';
  END IF;
  IF (p_state, p_secret_ref, p_owner_approval_ref, p_retention_ref, p_price_revision, p_prompt_sha256, p_schema_sha256, p_package_sha256,
      p_day_cap, p_month_cap, p_expires_at) IS NOT DISTINCT FROM
     (v_policy."state", v_policy."secretRef", v_policy."ownerApprovalRef", v_policy."retentionAttestationRef", v_policy."priceRevision",
      v_policy."promptSha256", v_policy."schemaSha256", v_policy."packageSha256", v_policy."dayCapMicroUsd", v_policy."monthCapMicroUsd",
      v_policy."expiresAt") THEN
    RETURN v_policy."policyVersion";
  END IF;
  v_now := pg_catalog.clock_timestamp();
  IF p_expires_at > v_now + interval '168 hours' OR (p_state = 'ACTIVE' AND p_expires_at <= v_now) THEN
    RAISE EXCEPTION 'ASK_REMOTE_REVISION_REFUSED' USING ERRCODE = 'AR009';
  END IF;
  UPDATE public."ActionAuthorityFence" f SET version = f.version + 1 WHERE f."workspaceId" = p_workspace;
  v_new := v_policy."policyVersion" + 1;
  BEGIN
    UPDATE public."RemoteAskPolicy" x SET "policyVersion" = v_new,
           "state" = CASE WHEN v_new = v_max THEN 'TOMBSTONE' ELSE p_state END,
           "stateReason" = CASE WHEN v_new = v_max THEN 'VERSION_EXHAUSTED' WHEN p_state IN ('PAUSED', 'REVOKED') THEN 'OWNER' END,
           "secretRef" = p_secret_ref, "ownerApprovalRef" = p_owner_approval_ref, "retentionAttestationRef" = p_retention_ref,
           "priceRevision" = p_price_revision, "promptSha256" = p_prompt_sha256, "schemaSha256" = p_schema_sha256,
           "packageSha256" = p_package_sha256, "dayCapMicroUsd" = p_day_cap, "monthCapMicroUsd" = p_month_cap, "expiresAt" = p_expires_at,
           "revisedAt" = GREATEST(x."revisedAt", v_now)
     WHERE x."workspaceId" = p_workspace;
  EXCEPTION WHEN check_violation OR not_null_violation THEN
    RAISE EXCEPTION 'ASK_REMOTE_REVISION_REFUSED' USING ERRCODE = 'AR009';
  END;
  RETURN v_new;
END $fn$;
REVOKE ALL ON FUNCTION public.atlas_ask_remote_policy_revise(TEXT, UUID, BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, BIGINT, TIMESTAMPTZ) FROM PUBLIC;

-- Exact client allowlist change: admit (insert or re-admit) or remove (never delete). Advances the fence and policyVersion.
CREATE FUNCTION public.atlas_ask_remote_client_set(p_workspace TEXT, p_admission UUID, p_client TEXT, p_expected_version BIGINT,
  p_admitted BOOLEAN) RETURNS BIGINT
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  v_id constant text := '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$';
  v_max constant bigint := 9223372036854775807;
  v_policy public."RemoteAskPolicy"%ROWTYPE;
  v_current text;
  v_desired text;
  v_new bigint;
  v_now timestamptz;
BEGIN
  IF p_workspace IS NULL OR p_workspace !~ v_id OR pg_catalog.current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace THEN
    RAISE EXCEPTION 'ASK_REMOTE_SCOPE' USING ERRCODE = 'AR004';
  END IF;
  PERFORM 1 FROM public."ActionAuthorityFence" f WHERE f."workspaceId" = p_workspace FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ASK_REMOTE_SCOPE' USING ERRCODE = 'AR004';
  END IF;
  SELECT x.* INTO v_policy FROM public."RemoteAskPolicy" x WHERE x."workspaceId" = p_workspace FOR UPDATE;
  IF NOT FOUND OR v_policy."admissionId" IS DISTINCT FROM p_admission THEN
    RAISE EXCEPTION 'ASK_REMOTE_REVISION_REFUSED' USING ERRCODE = 'AR009';
  END IF;
  IF v_policy."state" = 'TOMBSTONE' THEN
    RAISE EXCEPTION 'ASK_REMOTE_VERSION_EXHAUSTED' USING ERRCODE = 'AR008';
  END IF;
  IF p_expected_version IS DISTINCT FROM v_policy."policyVersion" OR p_admitted IS NULL OR p_client IS NULL OR p_client !~ v_id THEN
    RAISE EXCEPTION 'ASK_REMOTE_REVISION_REFUSED' USING ERRCODE = 'AR009';
  END IF;
  SELECT a."state" INTO v_current FROM public."RemoteAskClientAdmission" a
   WHERE a."workspaceId" = p_workspace AND a."admissionId" = p_admission AND a."clientId" = p_client FOR UPDATE;
  v_desired := CASE WHEN p_admitted THEN 'ADMITTED' ELSE 'REMOVED' END;
  IF v_current IS NOT DISTINCT FROM v_desired OR (v_current IS NULL AND NOT p_admitted) THEN
    RETURN v_policy."policyVersion";
  END IF;
  UPDATE public."ActionAuthorityFence" f SET version = f.version + 1 WHERE f."workspaceId" = p_workspace;
  v_new := v_policy."policyVersion" + 1;
  v_now := pg_catalog.clock_timestamp();
  UPDATE public."RemoteAskPolicy" x SET "policyVersion" = v_new,
         "state" = CASE WHEN v_new = v_max THEN 'TOMBSTONE' ELSE x."state" END,
         "stateReason" = CASE WHEN v_new = v_max THEN 'VERSION_EXHAUSTED' ELSE x."stateReason" END,
         "revisedAt" = GREATEST(x."revisedAt", v_now)
   WHERE x."workspaceId" = p_workspace;
  BEGIN
    IF v_current IS NULL THEN
      INSERT INTO public."RemoteAskClientAdmission" ("workspaceId", "admissionId", "clientId", "state", "changedAtPolicyVersion", "createdAt", "updatedAt")
      VALUES (p_workspace, p_admission, p_client, 'ADMITTED', v_new, v_now, v_now);
    ELSE
      UPDATE public."RemoteAskClientAdmission" a SET "state" = v_desired, "changedAtPolicyVersion" = v_new, "updatedAt" = GREATEST(a."updatedAt", v_now)
       WHERE a."workspaceId" = p_workspace AND a."admissionId" = p_admission AND a."clientId" = p_client;
    END IF;
  EXCEPTION WHEN foreign_key_violation OR check_violation THEN
    RAISE EXCEPTION 'ASK_REMOTE_REVISION_REFUSED' USING ERRCODE = 'AR009';
  END;
  RETURN v_new;
END $fn$;
REVOKE ALL ON FUNCTION public.atlas_ask_remote_client_set(TEXT, UUID, TEXT, BIGINT, BOOLEAN) FROM PUBLIC;
