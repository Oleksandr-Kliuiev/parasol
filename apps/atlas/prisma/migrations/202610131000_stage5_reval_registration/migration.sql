-- Stage 5 R-EVAL server RS-A (docs/stage5/ask/remote/reval-server/rs-a/IMPLEMENTATION_BRIEF.md §5/§7): the immutable
-- synthetic sandbox registration, its single current fixture binding, their owner-only guard and the evidence reader's
-- atomic metadata snapshot. Additive; every earlier migration is frozen. Nothing is registered or populated here (RS-B).
-- prisma/roles.sql (roles/reval.sql) afterwards creates the NOLOGIN evidence definer and the evidence-reader LOGIN,
-- transfers atlas_reval_snapshot() to the definer and leaves the runtime with NO privilege on these tables. Until then the
-- guard refuses every write that is not the table owner's (default privileges give the runtime INSERT/UPDATE).

-- ---------------------------------------------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE "RevalSandboxRegistration" (
    "registrationId" UUID NOT NULL,
    "databaseInstanceId" UUID NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "admissionId" UUID NOT NULL,
    "evidenceReaderRoleOid" BIGINT NOT NULL,
    "datasetManifestSha256" TEXT NOT NULL,
    "buildManifestSha256" TEXT NOT NULL,
    "syntheticOnly" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RevalSandboxRegistration_pkey" PRIMARY KEY ("registrationId")
);
CREATE UNIQUE INDEX "RevalSandboxRegistration_databaseInstanceId_key" ON "RevalSandboxRegistration"("databaseInstanceId");
CREATE UNIQUE INDEX "RevalSandboxRegistration_workspaceId_key" ON "RevalSandboxRegistration"("workspaceId");
CREATE UNIQUE INDEX "RevalSandboxRegistration_evidenceReaderRoleOid_key" ON "RevalSandboxRegistration"("evidenceReaderRoleOid");
CREATE UNIQUE INDEX "RevalSandboxRegistration_binding_key"
  ON "RevalSandboxRegistration"("registrationId", "workspaceId", "clientId", "datasetManifestSha256");

CREATE TABLE "RevalFixtureBinding" (
    "registrationId" UUID NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "fixtureId" TEXT NOT NULL,
    "generation" BIGINT NOT NULL,
    "syntheticFreshnessAt" TIMESTAMPTZ(6) NOT NULL,
    "datasetManifestSha256" TEXT NOT NULL,
    "installedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RevalFixtureBinding_pkey" PRIMARY KEY ("registrationId")
);

-- ---------------------------------------------------------------------------------------------------------------
-- 2. Scoped foreign keys (RESTRICT) and contract CHECKs (coalesced: SQL UNKNOWN never passes)
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE "RevalSandboxRegistration" ADD CONSTRAINT "RevalSandboxRegistration_client_fkey" FOREIGN KEY ("workspaceId", "clientId")
  REFERENCES "Client"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "RevalSandboxRegistration" ADD CONSTRAINT "RevalSandboxRegistration_actor_fkey" FOREIGN KEY ("workspaceId", "actorId")
  REFERENCES "Actor"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "RevalSandboxRegistration" ADD CONSTRAINT "RevalSandboxRegistration_policy_fkey" FOREIGN KEY ("workspaceId", "admissionId")
  REFERENCES "RemoteAskPolicy"("workspaceId", "admissionId") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "RevalSandboxRegistration" ADD CONSTRAINT "RevalSandboxRegistration_admission_fkey" FOREIGN KEY ("workspaceId", "admissionId", "clientId")
  REFERENCES "RemoteAskClientAdmission"("workspaceId", "admissionId", "clientId") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "RevalFixtureBinding" ADD CONSTRAINT "RevalFixtureBinding_registration_fkey"
  FOREIGN KEY ("registrationId", "workspaceId", "clientId", "datasetManifestSha256")
  REFERENCES "RevalSandboxRegistration"("registrationId", "workspaceId", "clientId", "datasetManifestSha256") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "RevalSandboxRegistration" ADD CONSTRAINT "RevalSandboxRegistration_contract_check" CHECK (coalesce(
  "workspaceId" ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$' AND "clientId" ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'
  AND "actorId" ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$' AND "evidenceReaderRoleOid" > 0
  AND "datasetManifestSha256" ~ '^[0-9a-f]{64}$' AND "buildManifestSha256" ~ '^[0-9a-f]{64}$' AND "syntheticOnly", false));
ALTER TABLE "RevalFixtureBinding" ADD CONSTRAINT "RevalFixtureBinding_contract_check" CHECK (coalesce(
  "fixtureId" ~ '^FX(0[1-9]|1[01])$' AND "generation" > 0 AND "datasetManifestSha256" ~ '^[0-9a-f]{64}$', false));

-- ---------------------------------------------------------------------------------------------------------------
-- 3. Guard (plain invoker trigger function; stays owned by the table owner, no EXECUTE for anyone). SQLSTATE RV010.
--    (a) Writer identity: INSERT/UPDATE only by the role that owns this function AND the target table (the migration
--        owner) — runtime DML through inherited/default grants before roles.sql reruns is refused.
--    (b) A registration is immutable: UPDATE/DELETE/TRUNCATE always refused, also for the owner.
--    (c) A binding: installedAt is real DB time (ms), generation strictly increases, identity is immutable, never deleted.
--    (d) Every INSERT re-checks its referenced rows (scoped client/actor/policy/admission; the exact registration/dataset of
--        a binding). The FKs below stay, but PostgreSQL enforces FKs with ORIGIN-mode internal triggers that do NOT fire
--        under session_replication_role = replica; this ALWAYS guard keeps the same refusals there (FORCE RLS: the lookup
--        sees exactly the row's own workspace, which the insert's WITH CHECK already requires).
-- ---------------------------------------------------------------------------------------------------------------
CREATE FUNCTION public.atlas_reval_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  v_me oid := (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = current_user);
BEGIN
  IF TG_TABLE_SCHEMA <> 'public' OR TG_TABLE_NAME NOT IN ('RevalSandboxRegistration', 'RevalFixtureBinding') THEN
    RAISE EXCEPTION 'REVAL_GUARD: unexpected table' USING ERRCODE = 'RV010';
  END IF;
  IF TG_OP IN ('DELETE', 'TRUNCATE') OR (TG_TABLE_NAME = 'RevalSandboxRegistration' AND TG_OP = 'UPDATE') THEN
    RAISE EXCEPTION 'REVAL_GUARD: % rows are immutable and never deleted', TG_TABLE_NAME USING ERRCODE = 'RV010';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = 'atlas_reval_guard' AND p.proowner = v_me)
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid = TG_RELID AND c.relowner = v_me) THEN
    RAISE EXCEPTION 'REVAL_GUARD: % is written only by its table owner', TG_TABLE_NAME USING ERRCODE = 'RV010';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF TG_TABLE_NAME = 'RevalSandboxRegistration' THEN
      IF NOT EXISTS (SELECT 1 FROM public."Client" c WHERE c."workspaceId" = NEW."workspaceId" AND c.id = NEW."clientId")
         OR NOT EXISTS (SELECT 1 FROM public."Actor" a WHERE a."workspaceId" = NEW."workspaceId" AND a.id = NEW."actorId")
         OR NOT EXISTS (SELECT 1 FROM public."RemoteAskPolicy" p WHERE p."workspaceId" = NEW."workspaceId" AND p."admissionId" = NEW."admissionId")
         OR NOT EXISTS (SELECT 1 FROM public."RemoteAskClientAdmission" m WHERE m."workspaceId" = NEW."workspaceId"
                          AND m."admissionId" = NEW."admissionId" AND m."clientId" = NEW."clientId") THEN
        RAISE EXCEPTION 'REVAL_GUARD: a registration references only rows of its own workspace' USING ERRCODE = 'RV010';
      END IF;
    ELSIF NOT EXISTS (SELECT 1 FROM public."RevalSandboxRegistration" r WHERE r."registrationId" = NEW."registrationId"
          AND r."workspaceId" = NEW."workspaceId" AND r."clientId" = NEW."clientId" AND r."datasetManifestSha256" = NEW."datasetManifestSha256") THEN
      RAISE EXCEPTION 'REVAL_GUARD: a binding references exactly its registration and dataset' USING ERRCODE = 'RV010';
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'RevalFixtureBinding' THEN
    IF TG_OP = 'UPDATE' AND (NEW."registrationId" IS DISTINCT FROM OLD."registrationId" OR NEW."workspaceId" IS DISTINCT FROM OLD."workspaceId"
        OR NEW."clientId" IS DISTINCT FROM OLD."clientId" OR NEW."datasetManifestSha256" IS DISTINCT FROM OLD."datasetManifestSha256"
        OR NEW."generation" IS NULL OR NEW."generation" <= OLD."generation") THEN
      RAISE EXCEPTION 'REVAL_GUARD: a binding keeps its identity and strictly advances its generation' USING ERRCODE = 'RV010';
    END IF;
    NEW."installedAt" := pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp());
  END IF;
  RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION public.atlas_reval_guard() FROM PUBLIC;

CREATE TRIGGER "RevalSandboxRegistration_guard" BEFORE INSERT OR UPDATE OR DELETE ON "RevalSandboxRegistration"
  FOR EACH ROW EXECUTE FUNCTION public.atlas_reval_guard();
CREATE TRIGGER "RevalSandboxRegistration_truncate" BEFORE TRUNCATE ON "RevalSandboxRegistration"
  FOR EACH STATEMENT EXECUTE FUNCTION public.atlas_reval_guard();
CREATE TRIGGER "RevalFixtureBinding_guard" BEFORE INSERT OR UPDATE OR DELETE ON "RevalFixtureBinding"
  FOR EACH ROW EXECUTE FUNCTION public.atlas_reval_guard();
CREATE TRIGGER "RevalFixtureBinding_truncate" BEFORE TRUNCATE ON "RevalFixtureBinding"
  FOR EACH STATEMENT EXECUTE FUNCTION public.atlas_reval_guard();
-- ENABLE ALWAYS: also under session_replication_role = replica.
ALTER TABLE "RevalSandboxRegistration" ENABLE ALWAYS TRIGGER "RevalSandboxRegistration_guard",
  ENABLE ALWAYS TRIGGER "RevalSandboxRegistration_truncate";
ALTER TABLE "RevalFixtureBinding" ENABLE ALWAYS TRIGGER "RevalFixtureBinding_guard", ENABLE ALWAYS TRIGGER "RevalFixtureBinding_truncate";

-- ---------------------------------------------------------------------------------------------------------------
-- 4. Row-level security: FORCE (the table owner too), one PUBLIC workspace policy per table. roles.sql adds the evidence
--    definer's role-specific SELECT policy on the registration (lookup by login OID before the workspace is known).
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE "RevalSandboxRegistration" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RevalSandboxRegistration" FORCE ROW LEVEL SECURITY;
CREATE POLICY "RevalSandboxRegistration_scope" ON "RevalSandboxRegistration" FOR ALL
  USING ("workspaceId" = public.atlas_app_workspace()) WITH CHECK ("workspaceId" = public.atlas_app_workspace());
ALTER TABLE "RevalFixtureBinding" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RevalFixtureBinding" FORCE ROW LEVEL SECURITY;
CREATE POLICY "RevalFixtureBinding_scope" ON "RevalFixtureBinding" FOR ALL
  USING ("workspaceId" = public.atlas_app_workspace()) WITH CHECK ("workspaceId" = public.atlas_app_workspace());
REVOKE ALL ON "RevalSandboxRegistration", "RevalFixtureBinding" FROM PUBLIC;

-- ---------------------------------------------------------------------------------------------------------------
-- 5. The evidence reader's atomic metadata snapshot (brief §7). No argument: the scope is the registration of the
--    calling login (session_user OID), never a caller hint. Caller establishes REPEATABLE READ READ ONLY first. No write,
--    no row lock. SQLSTATEs: RV001 registration/scope, RV002 isolation/SET ROLE, RV003 census limit, RV004 pricing tuples,
--    RV005 binding missing, RV006 missing counter of a referenced period. Returns the internal wrapper (C exports only
--    the exact 02 SNAPSHOT keys; pricing and physical facts never leave the controller).
-- ---------------------------------------------------------------------------------------------------------------
CREATE FUNCTION public.atlas_reval_snapshot() RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_fmt constant text := 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"';
  v_login bigint;
  v_n bigint;
  v_reg public."RevalSandboxRegistration"%ROWTYPE;
  v_again public."RevalSandboxRegistration"%ROWTYPE;
  v_pol record;
  v_bind record;
  v_fence integer;
  v_day date;
  v_month date;
  v_pricing jsonb;
  v_periods jsonb;
  v_attempts jsonb;
  v_project bigint;
  v_foreign bigint;
  v_consistent boolean;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <> 'repeatable read'
     OR pg_catalog.current_setting('transaction_read_only') <> 'on' OR pg_catalog.current_setting('role') <> 'none' THEN
    RAISE EXCEPTION 'REVAL_ISOLATION' USING ERRCODE = 'RV002';
  END IF;
  -- Caller-set scope settings never widen what the OR-ed permissive policies show.
  PERFORM pg_catalog.set_config('app.workspace_id', '', true), pg_catalog.set_config('app.client_ids', '', true),
          pg_catalog.set_config('app.actor_id', '', true), pg_catalog.set_config('app.token_hash', '', true),
          pg_catalog.set_config('app.poweroffice_connection_id', '', true);
  SELECT r.oid::bigint INTO v_login FROM pg_catalog.pg_roles r WHERE r.rolname = session_user;
  SELECT pg_catalog.count(*) INTO v_n FROM public."RevalSandboxRegistration" x WHERE x."evidenceReaderRoleOid" = v_login;
  IF v_login IS NULL OR v_n <> 1 THEN RAISE EXCEPTION 'REVAL_REGISTRATION' USING ERRCODE = 'RV001'; END IF;
  SELECT x.* INTO v_reg FROM public."RevalSandboxRegistration" x WHERE x."evidenceReaderRoleOid" = v_login;
  PERFORM pg_catalog.set_config('app.workspace_id', v_reg."workspaceId", true);
  SELECT x.* INTO v_again FROM public."RevalSandboxRegistration" x
   WHERE x."registrationId" = v_reg."registrationId" AND x."evidenceReaderRoleOid" = v_login;
  IF NOT FOUND OR v_again IS DISTINCT FROM v_reg THEN RAISE EXCEPTION 'REVAL_REGISTRATION' USING ERRCODE = 'RV001'; END IF;

  SELECT p."admissionId", p."projectIdentity", p."policyVersion", p."state", p."profile", p."priceRevision", p."reserveMicroUsd",
         p."dayCapMicroUsd", p."monthCapMicroUsd", p."expiresAt" INTO v_pol
    FROM public."RemoteAskPolicy" p WHERE p."workspaceId" = v_reg."workspaceId" AND p."admissionId" = v_reg."admissionId";
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM public."RemoteAskClientAdmission" a WHERE a."workspaceId" = v_reg."workspaceId"
                                AND a."admissionId" = v_reg."admissionId" AND a."clientId" = v_reg."clientId") THEN
    RAISE EXCEPTION 'REVAL_REGISTRATION' USING ERRCODE = 'RV001';
  END IF;
  SELECT f."version" INTO v_fence FROM public."ActionAuthorityFence" f WHERE f."workspaceId" = v_reg."workspaceId";
  IF NOT FOUND THEN RAISE EXCEPTION 'REVAL_REGISTRATION' USING ERRCODE = 'RV001'; END IF;

  -- Pricing tuples (internal only): the policy, and every DISTINCT tuple over ALL project attempts.
  SELECT pg_catalog.count(*) INTO v_n FROM (SELECT DISTINCT t."profile", t."priceRevision", t."reservedMicroUsd", t."promptRate", t."completionRate"
     FROM public."RemoteAskAttempt" t WHERE t."workspaceId" = v_reg."workspaceId" AND t."projectIdentity" = v_pol."projectIdentity") d;
  IF v_n > 8 THEN RAISE EXCEPTION 'REVAL_PRICING' USING ERRCODE = 'RV004'; END IF;
  SELECT pg_catalog.jsonb_build_object('policy', pg_catalog.jsonb_build_object('profile', v_pol."profile", 'priceRevision', v_pol."priceRevision",
           'reserveMicroUsd', v_pol."reserveMicroUsd"::text),
         'attempts', coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('profile', d."profile", 'priceRevision', d."priceRevision",
             'reservedMicroUsd', d."reservedMicroUsd"::text, 'promptRate', d."promptRate"::text, 'completionRate', d."completionRate"::text)
             ORDER BY d."profile", d."priceRevision", d."reservedMicroUsd", d."promptRate", d."completionRate")
           FROM (SELECT DISTINCT t."profile", t."priceRevision", t."reservedMicroUsd", t."promptRate", t."completionRate"
                   FROM public."RemoteAskAttempt" t WHERE t."workspaceId" = v_reg."workspaceId" AND t."projectIdentity" = v_pol."projectIdentity") d),
           '[]'::jsonb)) INTO v_pricing;

  SELECT b."fixtureId", b."generation" INTO v_bind FROM public."RevalFixtureBinding" b WHERE b."registrationId" = v_reg."registrationId";
  IF NOT FOUND THEN RAISE EXCEPTION 'REVAL_BINDING' USING ERRCODE = 'RV005'; END IF;

  v_day := (v_now AT TIME ZONE 'UTC')::date;
  v_month := pg_catalog.date_trunc('month', v_day::timestamp)::date;
  SELECT pg_catalog.count(*) INTO v_project FROM public."RemoteAskAttempt" t
   WHERE t."workspaceId" = v_reg."workspaceId" AND t."projectIdentity" = v_pol."projectIdentity";
  IF v_project > 1000 THEN RAISE EXCEPTION 'REVAL_CENSUS_LIMIT' USING ERRCODE = 'RV003'; END IF;
  -- Every project counter row (referenced, current AND orphan) plus synthesized current periods count toward the bound.
  SELECT pg_catalog.count(*) + (CASE WHEN EXISTS (SELECT 1 FROM public."RemoteAskPeriodCounter" c WHERE c."workspaceId" = v_reg."workspaceId"
             AND c."projectIdentity" = v_pol."projectIdentity" AND c."kind" = 'DAY' AND c."periodStart" = v_day) THEN 0 ELSE 1 END)
         + (CASE WHEN EXISTS (SELECT 1 FROM public."RemoteAskPeriodCounter" c WHERE c."workspaceId" = v_reg."workspaceId"
             AND c."projectIdentity" = v_pol."projectIdentity" AND c."kind" = 'MONTH' AND c."periodStart" = v_month) THEN 0 ELSE 1 END)
    INTO v_n FROM public."RemoteAskPeriodCounter" c WHERE c."workspaceId" = v_reg."workspaceId" AND c."projectIdentity" = v_pol."projectIdentity";
  IF v_n > 2000 THEN RAISE EXCEPTION 'REVAL_CENSUS_LIMIT' USING ERRCODE = 'RV003'; END IF;

  -- Referenced periods (DAY by dayStart, MONTH by monthStart) of ALL project attempts must each have a counter row.
  IF EXISTS (SELECT 1 FROM (SELECT 'DAY'::text AS kind, t."dayStart" AS ps FROM public."RemoteAskAttempt" t
                             WHERE t."workspaceId" = v_reg."workspaceId" AND t."projectIdentity" = v_pol."projectIdentity"
                            UNION SELECT 'MONTH', t."monthStart" FROM public."RemoteAskAttempt" t
                             WHERE t."workspaceId" = v_reg."workspaceId" AND t."projectIdentity" = v_pol."projectIdentity") rp
              WHERE NOT EXISTS (SELECT 1 FROM public."RemoteAskPeriodCounter" c WHERE c."workspaceId" = v_reg."workspaceId"
                                  AND c."projectIdentity" = v_pol."projectIdentity" AND c."kind" = rp.kind AND c."periodStart" = rp.ps)) THEN
    RAISE EXCEPTION 'REVAL_MISSING_COUNTER' USING ERRCODE = 'RV006';
  END IF;
  -- Integrity over EVERY project counter row, orphans included (an orphan must be zero).
  SELECT NOT EXISTS (SELECT 1 FROM public."RemoteAskPeriodCounter" c
          WHERE c."workspaceId" = v_reg."workspaceId" AND c."projectIdentity" = v_pol."projectIdentity"
            AND c."chargedMicroUsd"::numeric IS DISTINCT FROM coalesce((SELECT pg_catalog.sum(t."accountedMicroUsd") FROM public."RemoteAskAttempt" t
                  WHERE t."workspaceId" = c."workspaceId" AND t."projectIdentity" = c."projectIdentity"
                    AND CASE c."kind" WHEN 'DAY' THEN t."dayStart" = c."periodStart" WHEN 'MONTH' THEN t."monthStart" = c."periodStart" ELSE false END), 0))
    INTO v_consistent;

  WITH rp(kind, ps) AS (
         SELECT 'DAY'::text, t."dayStart" FROM public."RemoteAskAttempt" t WHERE t."workspaceId" = v_reg."workspaceId" AND t."projectIdentity" = v_pol."projectIdentity"
         UNION SELECT 'MONTH', t."monthStart" FROM public."RemoteAskAttempt" t WHERE t."workspaceId" = v_reg."workspaceId" AND t."projectIdentity" = v_pol."projectIdentity"
         UNION SELECT 'DAY', v_day UNION SELECT 'MONTH', v_month),
       pr AS (SELECT rp.kind, rp.ps,
                     coalesce((SELECT c."chargedMicroUsd" FROM public."RemoteAskPeriodCounter" c WHERE c."workspaceId" = v_reg."workspaceId"
                                AND c."projectIdentity" = v_pol."projectIdentity" AND c."kind" = rp.kind AND c."periodStart" = rp.ps), 0) AS charged,
                     (SELECT pg_catalog.count(*) FROM public."RemoteAskAttempt" t WHERE t."workspaceId" = v_reg."workspaceId"
                        AND t."projectIdentity" = v_pol."projectIdentity"
                        AND CASE rp.kind WHEN 'DAY' THEN t."dayStart" = rp.ps ELSE t."monthStart" = rp.ps END) AS n
                FROM rp)
  SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('kind', pr.kind, 'periodStart', pg_catalog.to_char(pr.ps, 'YYYY-MM-DD'),
           'chargedMicroUsd', pr.charged::text, 'attemptCount', pr.n::text) ORDER BY (pr.kind = 'DAY'), pr.ps), '[]'::jsonb)
    INTO v_periods FROM pr;

  SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'attemptId', t."id"::text, 'correlationId', t."correlationId"::text, 'admissionId', t."admissionId"::text,
           'policyVersion', t."policyVersion"::text,
           'createdAt', pg_catalog.to_char(pg_catalog.date_trunc('milliseconds', t."createdAt") AT TIME ZONE 'UTC', v_fmt),
           'dayStart', pg_catalog.to_char(t."dayStart", 'YYYY-MM-DD'), 'monthStart', pg_catalog.to_char(t."monthStart", 'YYYY-MM-DD'),
           'reservedMicroUsd', t."reservedMicroUsd"::text, 'accountedMicroUsd', t."accountedMicroUsd"::text,
           'state', t."state", 'outcome', t."outcome",
           'settledAt', CASE WHEN t."settledAt" IS NULL THEN NULL
                        ELSE pg_catalog.to_char(pg_catalog.date_trunc('milliseconds', t."settledAt") AT TIME ZONE 'UTC', v_fmt) END)
           ORDER BY pg_catalog.date_trunc('milliseconds', t."createdAt"), t."id"), '[]'::jsonb)
    INTO v_attempts FROM public."RemoteAskAttempt" t
   WHERE t."workspaceId" = v_reg."workspaceId" AND t."projectIdentity" = v_pol."projectIdentity"
     AND t."clientId" = v_reg."clientId" AND t."actorId" = v_reg."actorId";
  SELECT pg_catalog.count(*) INTO v_foreign FROM public."RemoteAskAttempt" t
   WHERE t."workspaceId" = v_reg."workspaceId" AND t."projectIdentity" = v_pol."projectIdentity"
     AND (t."clientId" <> v_reg."clientId" OR t."actorId" <> v_reg."actorId");

  RETURN pg_catalog.jsonb_build_object(
    'registrationId', v_reg."registrationId"::text, 'databaseInstanceId', v_reg."databaseInstanceId"::text,
    'buildManifestSha256', v_reg."buildManifestSha256",
    'systemIdentifier', (pg_catalog.pg_control_system()).system_identifier::text,
    'databaseOid', (SELECT d.oid::text FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database()),
    'postmasterStartTime', pg_catalog.floor(pg_catalog.date_part('epoch', pg_catalog.pg_postmaster_start_time()))::bigint::text,
    'pricing', v_pricing,
    'snapshot', pg_catalog.jsonb_build_object(
      'dbObservedAt', pg_catalog.to_char(pg_catalog.date_trunc('milliseconds', v_now) AT TIME ZONE 'UTC', v_fmt),
      'admissionId', v_pol."admissionId"::text, 'policyVersion', v_pol."policyVersion"::text, 'fenceEpoch', v_fence::text,
      'policyState', v_pol."state", 'reserveMicroUsd', v_pol."reserveMicroUsd"::text,
      'dayCapMicroUsd', v_pol."dayCapMicroUsd"::text, 'monthCapMicroUsd', v_pol."monthCapMicroUsd"::text,
      'expiresAt', pg_catalog.to_char(pg_catalog.date_trunc('milliseconds', v_pol."expiresAt") AT TIME ZONE 'UTC', v_fmt),
      'currentDay', pg_catalog.to_char(v_day, 'YYYY-MM-DD'), 'currentMonth', pg_catalog.to_char(v_month, 'YYYY-MM-DD'),
      'fixtureGeneration', v_bind."generation"::text, 'fixtureId', v_bind."fixtureId",
      'projectAttemptCount', v_project::text, 'foreignScopeAttemptCount', v_foreign::text,
      'periods', v_periods, 'attempts', v_attempts, 'consistent', v_consistent));
END $fn$;
REVOKE ALL ON FUNCTION public.atlas_reval_snapshot() FROM PUBLIC;
