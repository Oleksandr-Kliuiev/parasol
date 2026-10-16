-- Stage 5 ASK-REMOTE R-B (docs/stage5/ask/remote/04 "Egress is a separate current authority boundary"): the original-deadline
-- floor INSIDE the reservation. Additive: one new confined routine; the accepted R-A routines, tables, guards, policies and
-- grants are unchanged. EXECUTE is revoked from PUBLIC here; prisma/roles.sql transfers the routine to the remote definer
-- and grants EXECUTE to the runtime only (exactly as the R-A reserve/settle/pause routines).
--
-- Why: the R-A reserve routine waits for the MONTH and DAY counter locks before its attempt INSERT. A floor check made by the
-- application before calling it, or only after it returns, cannot prove that at least 4500 ms of the ORIGINAL request budget
-- were left when the INSERT ran. The application converts its floor instant to the database clock conservatively (a
-- clock_timestamp() sample taken in the same transaction and read back BEFORE the application measures its remaining
-- budget) and passes it as p_floor. This routine takes every lock of the reservation in the SAME fixed order as reserve
-- (fence FOR SHARE → policy FOR SHARE → missing counters created unique-key-safely → MONTH FOR UPDATE → DAY FOR UPDATE),
-- so all those waits are behind it, then requires clock_timestamp() <= p_floor (the exact floor instant still leaves 4500 ms),
-- then calls the UNCHANGED reserve routine (every admission, budget, exactly-once and expiry rule; its own relocks are
-- already held and do not wait), and requires clock_timestamp() <= p_floor again immediately before returning. Any failure
-- raises AR011 (or the reserve SQLSTATE), so the whole statement — attempt INSERT and both counter increments, and any
-- counter row it created — is undone.
-- SQLSTATE AR011 ASK_REMOTE_FLOOR (packages/ask/remote/ledger-sql.ts).
CREATE FUNCTION public.atlas_ask_remote_reserve_floor(p_workspace TEXT, p_client TEXT, p_actor TEXT, p_admission UUID, p_policy_version BIGINT,
  p_fence_version INTEGER, p_profile TEXT, p_price_revision TEXT, p_correlation UUID, p_floor TIMESTAMPTZ) RETURNS UUID
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  v_id constant text := '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$';
  v_project text;
  v_day date;
  v_month date;
  v_attempt uuid;
BEGIN
  IF p_workspace IS NULL OR p_client IS NULL OR p_floor IS NULL OR p_workspace !~ v_id OR p_client !~ v_id
     OR pg_catalog.current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace
     OR pg_catalog.current_setting('app.client_ids', true) IS DISTINCT FROM p_client THEN
    RAISE EXCEPTION 'ASK_REMOTE_SCOPE' USING ERRCODE = 'AR004';
  END IF;
  IF pg_catalog.clock_timestamp() > p_floor THEN
    RAISE EXCEPTION 'ASK_REMOTE_FLOOR' USING ERRCODE = 'AR011';
  END IF;
  PERFORM 1 FROM public."ActionAuthorityFence" f WHERE f."workspaceId" = p_workspace FOR SHARE;
  SELECT x."projectIdentity" INTO v_project FROM public."RemoteAskPolicy" x WHERE x."workspaceId" = p_workspace FOR SHARE;
  IF v_project IS NOT NULL THEN
    -- The same UTC period keys as reserve (now() is the transaction start, identical inside this statement).
    v_day := (pg_catalog.now() AT TIME ZONE 'UTC')::date;
    v_month := pg_catalog.date_trunc('month', v_day::timestamp)::date;
    INSERT INTO public."RemoteAskPeriodCounter" ("workspaceId", "projectIdentity", "kind", "periodStart")
    VALUES (p_workspace, v_project, 'MONTH', v_month) ON CONFLICT DO NOTHING;
    INSERT INTO public."RemoteAskPeriodCounter" ("workspaceId", "projectIdentity", "kind", "periodStart")
    VALUES (p_workspace, v_project, 'DAY', v_day) ON CONFLICT DO NOTHING;
    PERFORM 1 FROM public."RemoteAskPeriodCounter" c
     WHERE c."workspaceId" = p_workspace AND c."projectIdentity" = v_project AND c."kind" = 'MONTH' AND c."periodStart" = v_month FOR UPDATE;
    PERFORM 1 FROM public."RemoteAskPeriodCounter" c
     WHERE c."workspaceId" = p_workspace AND c."projectIdentity" = v_project AND c."kind" = 'DAY' AND c."periodStart" = v_day FOR UPDATE;
  END IF;
  -- Every lock wait of the reservation is behind us: the ORIGINAL floor must still hold BEFORE the attempt INSERT.
  IF pg_catalog.clock_timestamp() > p_floor THEN
    RAISE EXCEPTION 'ASK_REMOTE_FLOOR' USING ERRCODE = 'AR011';
  END IF;
  v_attempt := public.atlas_ask_remote_reserve(p_workspace, p_client, p_actor, p_admission, p_policy_version, p_fence_version, p_profile,
    p_price_revision, p_correlation);
  -- Immediately before returning: still above the floor after the INSERT and both counter increments.
  IF pg_catalog.clock_timestamp() > p_floor THEN
    RAISE EXCEPTION 'ASK_REMOTE_FLOOR' USING ERRCODE = 'AR011';
  END IF;
  RETURN v_attempt;
END $fn$;
REVOKE ALL ON FUNCTION public.atlas_ask_remote_reserve_floor(TEXT, TEXT, TEXT, UUID, BIGINT, INTEGER, TEXT, TEXT, UUID, TIMESTAMPTZ) FROM PUBLIC;
