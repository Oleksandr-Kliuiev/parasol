-- Stage 2 task 2.2, part 3 of 3 (docs/stage2/02_CONTRACTS.md §6): the confined M365 retention routine. Additive.
-- The migration only defines the routine and revokes EXECUTE from PUBLIC at once; it references no role. prisma/roles.sql
-- (after deploy) transfers ownership to the NOLOGIN, non-owner, NOBYPASSRLS definer role and grants EXECUTE to the cleanup
-- runner only. Until then only the migration owner can call it, and the runtime self-check refuses to start.
--
-- Contract of the routine:
--   * the scope and actor come from the verified transaction context (app.workspace_id, exactly one app.client_ids entry,
--     app.actor_id) that the service establishes after its permission checks; the only argument is a correlation ID;
--   * RLS applies (the definer owns no table and has no BYPASSRLS), so only rows of that one client are reachable;
--   * lock order is the publication order: Connection (FOR NO KEY UPDATE, by id), then resource states, then sign-in roots;
--   * expiry comes from database time and the bounded expiresAt of each row, never from the caller; the row triggers enforce
--     the same predicates for every role, so even a direct call deletes nothing unexpired;
--   * expired current pointers are cleared with MISSING/RETENTION_EXPIRED; memberships go before evidence, children before
--     parents; one allowlisted retention.completed audit row per M365 connection (counts and local IDs only);
--   * Connection rows are only locked, never changed; ExternalEntity, EntityLink, RawEvent and audit rows are never deleted.
CREATE FUNCTION public.atlas_m365_cleanup(p_correlation_id TEXT) RETURNS JSONB
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_ws TEXT := public.atlas_app_workspace();
  v_clients TEXT[] := public.atlas_app_clients();
  v_actor TEXT := public.atlas_app_actor();
  v_client TEXT;
  c RECORD;
  v_dir_pointers INTEGER; v_win_pointers INTEGER; v_objects INTEGER; v_generations INTEGER;
  v_memberships INTEGER; v_leaves INTEGER; v_attempts INTEGER; v_evidence INTEGER;
  v_result JSONB := '[]'::jsonb;
BEGIN
  IF v_ws IS NULL OR v_actor IS NULL OR cardinality(v_clients) IS DISTINCT FROM 1
     OR v_actor !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$' THEN
    RAISE EXCEPTION 'M365_CLEANUP_SCOPE_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF p_correlation_id IS NULL OR p_correlation_id !~ '^[A-Za-z0-9._:-]{8,64}$' THEN
    RAISE EXCEPTION 'M365_CLEANUP_INVALID_CORRELATION' USING ERRCODE = '22023';
  END IF;
  v_client := v_clients[1];

  FOR c IN SELECT id FROM public."Connection"
            WHERE "workspaceId" = v_ws AND "clientId" = v_client AND system = 'microsoft365'
            ORDER BY id FOR NO KEY UPDATE LOOP
    PERFORM 1 FROM public."M365ResourceState"
      WHERE "workspaceId" = v_ws AND "clientId" = v_client AND "connectionId" = c.id ORDER BY "resourceType" FOR UPDATE;
    PERFORM 1 FROM public."M365SignInWindow"
      WHERE "workspaceId" = v_ws AND "clientId" = v_client AND "connectionId" = c.id ORDER BY "rootFrom" FOR UPDATE;

    -- Directory: withdraw an expired active generation, then its objects, then expired generations themselves.
    UPDATE public."M365ResourceState" s SET "activeGenerationId" = NULL, status = 'MISSING', "safeErrorCode" = 'RETENTION_EXPIRED'
      FROM public."M365DirectoryGeneration" g
     WHERE s."workspaceId" = v_ws AND s."clientId" = v_client AND s."connectionId" = c.id
       AND g."workspaceId" = s."workspaceId" AND g."clientId" = s."clientId" AND g."connectionId" = s."connectionId"
       AND g."resourceType" = s."resourceType" AND g.id = s."activeGenerationId" AND g."expiresAt" <= now();
    GET DIAGNOSTICS v_dir_pointers = ROW_COUNT;
    DELETE FROM public."M365DirectoryObject" o USING public."M365DirectoryGeneration" g
     WHERE o."workspaceId" = v_ws AND o."clientId" = v_client AND o."connectionId" = c.id
       AND g."workspaceId" = o."workspaceId" AND g."clientId" = o."clientId" AND g."connectionId" = o."connectionId"
       AND g."resourceType" = o."resourceType" AND g.id = o."generationId" AND g."expiresAt" <= now();
    GET DIAGNOSTICS v_objects = ROW_COUNT;
    DELETE FROM public."M365DirectoryGeneration" g
     WHERE g."workspaceId" = v_ws AND g."clientId" = v_client AND g."connectionId" = c.id AND g."expiresAt" <= now()
       AND NOT EXISTS (SELECT 1 FROM public."M365ResourceState" s WHERE s."workspaceId" = g."workspaceId" AND s."clientId" = g."clientId"
                         AND s."connectionId" = g."connectionId" AND s."resourceType" = g."resourceType" AND s."activeGenerationId" = g.id);
    GET DIAGNOSTICS v_generations = ROW_COUNT;

    -- Sign-ins: withdraw an expired published attempt, then expired memberships, leaves, attempts and unreferenced evidence.
    UPDATE public."M365SignInWindow" w SET "publishedAttemptId" = NULL, status = 'MISSING', "safeErrorCode" = 'RETENTION_EXPIRED'
      FROM public."M365WindowAttempt" a
     WHERE w."workspaceId" = v_ws AND w."clientId" = v_client AND w."connectionId" = c.id
       AND a."workspaceId" = w."workspaceId" AND a."clientId" = w."clientId" AND a."connectionId" = w."connectionId"
       AND a."windowId" = w.id AND a.id = w."publishedAttemptId" AND a."expiresAt" <= now();
    GET DIAGNOSTICS v_win_pointers = ROW_COUNT;
    DELETE FROM public."M365WindowEvidence" m USING public."M365WindowAttempt" a, public."M365SignInEvidence" e
     WHERE m."workspaceId" = v_ws AND m."clientId" = v_client AND m."connectionId" = c.id
       AND a."workspaceId" = m."workspaceId" AND a."clientId" = m."clientId" AND a."connectionId" = m."connectionId"
       AND a."windowId" = m."windowId" AND a.id = m."attemptId"
       AND e."workspaceId" = m."workspaceId" AND e."clientId" = m."clientId" AND e."connectionId" = m."connectionId" AND e.id = m."evidenceId"
       AND (a."expiresAt" <= now() OR e."expiresAt" <= now());
    GET DIAGNOSTICS v_memberships = ROW_COUNT;
    DELETE FROM public."M365WindowLeaf" l USING public."M365WindowAttempt" a
     WHERE l."workspaceId" = v_ws AND l."clientId" = v_client AND l."connectionId" = c.id
       AND a."workspaceId" = l."workspaceId" AND a."clientId" = l."clientId" AND a."connectionId" = l."connectionId"
       AND a."windowId" = l."windowId" AND a.id = l."attemptId" AND a."expiresAt" <= now()
       AND NOT EXISTS (SELECT 1 FROM public."M365SignInWindow" w WHERE w."workspaceId" = a."workspaceId" AND w."clientId" = a."clientId"
                         AND w."connectionId" = a."connectionId" AND w.id = a."windowId" AND w."publishedAttemptId" = a.id);
    GET DIAGNOSTICS v_leaves = ROW_COUNT;
    DELETE FROM public."M365WindowAttempt" a
     WHERE a."workspaceId" = v_ws AND a."clientId" = v_client AND a."connectionId" = c.id AND a."expiresAt" <= now()
       AND NOT EXISTS (SELECT 1 FROM public."M365SignInWindow" w WHERE w."workspaceId" = a."workspaceId" AND w."clientId" = a."clientId"
                         AND w."connectionId" = a."connectionId" AND w.id = a."windowId" AND w."publishedAttemptId" = a.id);
    GET DIAGNOSTICS v_attempts = ROW_COUNT;
    DELETE FROM public."M365SignInEvidence" e
     WHERE e."workspaceId" = v_ws AND e."clientId" = v_client AND e."connectionId" = c.id AND e."expiresAt" <= now()
       AND NOT EXISTS (SELECT 1 FROM public."M365WindowEvidence" m WHERE m."workspaceId" = e."workspaceId" AND m."clientId" = e."clientId"
                         AND m."connectionId" = e."connectionId" AND m."evidenceId" = e.id);
    GET DIAGNOSTICS v_evidence = ROW_COUNT;

    INSERT INTO public."AuditEvent" ("workspaceId", "clientId", id, "actorId", "eventType", "correlationId", metadata)
    VALUES (v_ws, v_client, gen_random_uuid()::text, v_actor, 'retention.completed', p_correlation_id,
            jsonb_build_object('connectionId', c.id, 'system', 'microsoft365',
              'clearedPointers', (v_dir_pointers + v_win_pointers)::text, 'deletedDirectoryObjects', v_objects::text,
              'deletedGenerations', v_generations::text, 'deletedMemberships', v_memberships::text, 'deletedLeaves', v_leaves::text,
              'deletedAttempts', v_attempts::text, 'deletedEvidence', v_evidence::text));
    v_result := v_result || jsonb_build_array(jsonb_build_object('connectionId', c.id,
      'clearedPointers', v_dir_pointers + v_win_pointers, 'deletedDirectoryObjects', v_objects, 'deletedGenerations', v_generations,
      'deletedMemberships', v_memberships, 'deletedLeaves', v_leaves, 'deletedAttempts', v_attempts, 'deletedEvidence', v_evidence));
  END LOOP;
  RETURN jsonb_build_object('connections', v_result);
END $$;
REVOKE ALL ON FUNCTION public.atlas_m365_cleanup(TEXT) FROM PUBLIC;
