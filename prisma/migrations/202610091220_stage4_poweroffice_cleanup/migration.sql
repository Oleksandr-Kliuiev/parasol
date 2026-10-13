-- Stage 4 S4-A (docs/stage4/03_DATA_AND_CONCURRENCY.md "Exact roles and scope", "Explicit bounded maintenance"): the
-- confined PowerOffice retention routine. Additive. The migration defines the routine and revokes EXECUTE from PUBLIC at
-- once; it references no role. prisma/roles.sql (after deploy) transfers ownership to the NOLOGIN PowerOffice cleanup
-- definer (no table ownership, no BYPASSRLS, no auth/member/credential access) and grants EXECUTE to its runner only.
--
-- Contract (the trusted runner transaction is S4-C; this routine is its SQL foundation):
--   * The runner transaction has set app.workspace_id, app.client_ids (one client), app.actor_id and
--     app.poweroffice_connection_id transaction-locally from its admitted private context BEFORE the call. Arguments are
--     exactly workspace, client and connection plus a generated local correlation ID: no clock, SQL, path or data. Every
--     argument must equal its setting before any lock, else a fixed failure with zero effects.
--   * RLS applies: the definer sees the new tables only through the usual workspace/client policy intersected with its
--     RESTRICTIVE three-ID policy (prisma/roles.sql); the fence through its existing PUBLIC scope policy.
--   * Lock order: workspace fence FOR UPDATE, plain scoped Connection read (system + immutable synthetic binding), State
--     FOR UPDATE when present. No Attempt/Snapshot row lock: their DELETEs take implicit locks after fence/State.
--   * Missing State: no-op. Any ACTIVE attempt (even expired): BUSY with zero effects (recover first).
--   * Expired snapshots first (clearing the current pointer in the same transaction, lastSuccessAt kept), then terminal
--     attempts completed more than 30 days ago and referenced by no snapshot/pointer. Combined at most 1000 rows per call;
--     bounded indexed candidate selection before materialization; morePending is recomputed on eligible rows.
--   * One safe client audit row (connectionId, outcome, cleared snapshotId only; never counts/amounts/dates); counts return
--     only to the trusted caller. The commit invariants are checked inside the call, as the definer.
--   * DB clock only (clock_timestamp after the locks); the delete guards repeat expiry/reference/30-day rules.
--   * Binding: system poweroffice, FIXTURE or DISABLED, provenance, lifecycleVersion > 0 and the synthetic tenant shape; the
--     paired fixture secretRef is guaranteed by Connection_poweroffice_binding_check (validated, checked here before locks).
-- Fixed SQLSTATE PO010 (POWEROFFICE_CLEANUP_FAILED) for scope/argument/fence/binding refusals.
CREATE FUNCTION public.atlas_poweroffice_cleanup(p_workspace TEXT, p_client TEXT, p_connection TEXT, p_correlation UUID) RETURNS JSONB
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE
  v_id constant text := '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$';
  v_binding_def constant text := 'CHECK (COALESCE(((system <> ''poweroffice''::text) OR ("externalTenantId" !~ '
    || '''^synthetic-po-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$''::text) OR ("secretRef" = '
    || '(''fixture://poweroffice/''::text || substr("externalTenantId", 14)))), false))';
  v_actor text := NULLIF(pg_catalog.current_setting('app.actor_id', true), '');
  v_now timestamp(3);
  c record; s record;
  v_snapshots uuid[]; v_attempts uuid[];
  v_cleared boolean := false; v_deleted_snapshots integer := 0; v_deleted_attempts integer := 0; v_more boolean;
BEGIN
  IF p_workspace IS NULL OR p_client IS NULL OR p_connection IS NULL OR p_correlation IS NULL
     OR p_workspace !~ v_id OR p_client !~ v_id OR p_connection !~ v_id OR v_actor IS NULL OR v_actor !~ v_id
     OR pg_catalog.current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace
     OR pg_catalog.current_setting('app.client_ids', true) IS DISTINCT FROM p_client
     OR pg_catalog.current_setting('app.poweroffice_connection_id', true) IS DISTINCT FROM p_connection THEN
    RAISE EXCEPTION 'POWEROFFICE_CLEANUP_FAILED' USING ERRCODE = 'PO010';
  END IF;

  -- The full synthetic pair (secretRef included, which the definer never reads) rests on the binding CHECK of migration
  -- 202610091200: without it installed, validated AND with exactly its definition (the same rendering readiness and
  -- prisma/roles.sql require), refuse before any lock. Catalog metadata only; no Connection column or secret is read.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.conrelid = 'public."Connection"'::pg_catalog.regclass
                   AND k.conname = 'Connection_poweroffice_binding_check' AND k.contype = 'c' AND k.convalidated
                   AND pg_catalog.pg_get_constraintdef(k.oid) = v_binding_def) THEN
    RAISE EXCEPTION 'POWEROFFICE_CLEANUP_FAILED' USING ERRCODE = 'PO010';
  END IF;

  PERFORM 1 FROM public."ActionAuthorityFence" f WHERE f."workspaceId" = p_workspace FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'POWEROFFICE_CLEANUP_FAILED' USING ERRCODE = 'PO010';
  END IF;
  SELECT x.system, x."externalTenantId", x.status, x."boundBy", x."boundAt", x."lifecycleVersion" INTO c FROM public."Connection" x
   WHERE x."workspaceId" = p_workspace AND x."clientId" = p_client AND x.id = p_connection;
  IF NOT FOUND OR c.system IS DISTINCT FROM 'poweroffice' OR c.status NOT IN ('FIXTURE', 'DISABLED')
     OR c."externalTenantId" !~ '^synthetic-po-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR c."boundBy" IS NULL OR c."boundAt" IS NULL OR c."lifecycleVersion" < 1 THEN
    RAISE EXCEPTION 'POWEROFFICE_CLEANUP_FAILED' USING ERRCODE = 'PO010';
  END IF;
  SELECT x."activeAttemptId", x."snapshotId", x."lastAttemptId", x."lastCompletedAttemptId" INTO s FROM public."PowerOfficeState" x
   WHERE x."workspaceId" = p_workspace AND x."clientId" = p_client AND x."connectionId" = p_connection FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('outcome', 'NO_STATE', 'clearedPointer', false, 'deletedSnapshots', 0, 'deletedAttempts', 0, 'morePending', false);
  END IF;
  IF s."activeAttemptId" IS NOT NULL OR EXISTS (SELECT 1 FROM public."PowerOfficeAttempt" a
       WHERE a."workspaceId" = p_workspace AND a."clientId" = p_client AND a."connectionId" = p_connection AND a.state = 'ACTIVE') THEN
    RETURN pg_catalog.jsonb_build_object('outcome', 'BUSY', 'clearedPointer', false, 'deletedSnapshots', 0, 'deletedAttempts', 0, 'morePending', false);
  END IF;
  v_now := pg_catalog.clock_timestamp() AT TIME ZONE 'UTC';

  -- Expired snapshots, oldest first (expiry index), at most 1000.
  SELECT array_agg(x.id) INTO v_snapshots FROM (
    SELECT n.id FROM public."PowerOfficeSnapshot" n
     WHERE n."workspaceId" = p_workspace AND n."clientId" = p_client AND n."connectionId" = p_connection AND n."expiresAt" <= v_now
     ORDER BY n."expiresAt", n.id LIMIT 1000) x;
  IF s."snapshotId" IS NOT NULL AND s."snapshotId" = ANY (coalesce(v_snapshots, ARRAY[]::uuid[])) THEN
    UPDATE public."PowerOfficeState" x SET "snapshotId" = NULL, "snapshotVersion" = NULL, "updatedAt" = v_now
     WHERE x."workspaceId" = p_workspace AND x."clientId" = p_client AND x."connectionId" = p_connection;
    v_cleared := true;
  END IF;
  IF v_snapshots IS NOT NULL THEN
    DELETE FROM public."PowerOfficeSnapshot" n
     WHERE n."workspaceId" = p_workspace AND n."clientId" = p_client AND n."connectionId" = p_connection AND n.id = ANY (v_snapshots);
    GET DIAGNOSTICS v_deleted_snapshots = ROW_COUNT;
  END IF;

  -- Then terminal attempts completed more than 30 days ago, unreferenced, oldest first (retention index), within the budget.
  IF v_deleted_snapshots < 1000 THEN
    SELECT array_agg(x.id) INTO v_attempts FROM (
      SELECT a.id FROM public."PowerOfficeAttempt" a
       WHERE a."workspaceId" = p_workspace AND a."clientId" = p_client AND a."connectionId" = p_connection
         AND a.state <> 'ACTIVE' AND a."completedAt" < v_now - interval '30 days'
         AND a.id IS DISTINCT FROM s."lastAttemptId" AND a.id IS DISTINCT FROM s."lastCompletedAttemptId"
         AND NOT EXISTS (SELECT 1 FROM public."PowerOfficeSnapshot" n WHERE n."workspaceId" = a."workspaceId" AND n."clientId" = a."clientId"
                           AND n."connectionId" = a."connectionId" AND n."attemptId" = a.id)
       ORDER BY a."completedAt", a.id LIMIT (1000 - v_deleted_snapshots)) x;
    IF v_attempts IS NOT NULL THEN
      DELETE FROM public."PowerOfficeAttempt" a
       WHERE a."workspaceId" = p_workspace AND a."clientId" = p_client AND a."connectionId" = p_connection AND a.id = ANY (v_attempts);
      GET DIAGNOSTICS v_deleted_attempts = ROW_COUNT;
    END IF;
  END IF;

  v_more := EXISTS (SELECT 1 FROM public."PowerOfficeSnapshot" n
                     WHERE n."workspaceId" = p_workspace AND n."clientId" = p_client AND n."connectionId" = p_connection AND n."expiresAt" <= v_now)
         OR EXISTS (SELECT 1 FROM public."PowerOfficeAttempt" a
                     WHERE a."workspaceId" = p_workspace AND a."clientId" = p_client AND a."connectionId" = p_connection
                       AND a.state <> 'ACTIVE' AND a."completedAt" < v_now - interval '30 days'
                       AND a.id IS DISTINCT FROM s."lastAttemptId" AND a.id IS DISTINCT FROM s."lastCompletedAttemptId"
                       AND NOT EXISTS (SELECT 1 FROM public."PowerOfficeSnapshot" n WHERE n."workspaceId" = a."workspaceId"
                                         AND n."clientId" = a."clientId" AND n."connectionId" = a."connectionId" AND n."attemptId" = a.id));

  INSERT INTO public."AuditEvent" ("workspaceId", "clientId", id, "actorId", "eventType", "correlationId", metadata)
  VALUES (p_workspace, p_client, pg_catalog.gen_random_uuid()::text, v_actor, 'poweroffice.cleanup', p_correlation::text,
          pg_catalog.jsonb_build_object('connectionId', p_connection, 'outcome', 'COMPLETED')
          || CASE WHEN v_cleared THEN pg_catalog.jsonb_build_object('snapshotId', s."snapshotId"::text) ELSE '{}'::jsonb END);
  -- The deferred commit invariants fire here, as the definer (at COMMIT the runner could not read these tables).
  SET CONSTRAINTS public."PowerOfficeState_commit" IMMEDIATE;
  RETURN pg_catalog.jsonb_build_object('outcome', 'COMPLETED', 'clearedPointer', v_cleared, 'deletedSnapshots', v_deleted_snapshots,
    'deletedAttempts', v_deleted_attempts, 'morePending', v_more);
END $fn$;
REVOKE ALL ON FUNCTION public.atlas_poweroffice_cleanup(TEXT, TEXT, TEXT, UUID) FROM PUBLIC;
