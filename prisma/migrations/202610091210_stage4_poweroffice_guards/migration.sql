-- Stage 4 S4-A (docs/stage4/03_DATA_AND_CONCURRENCY.md, IMPLEMENTATION_HANDOFF.md): lifecycle/history guards, the strict
-- aggregate validation and the deferred commit invariants of the three PowerOffice tables. Additive.
--
-- Every function is a SECURITY INVOKER trigger function with a fixed search_path and schema-qualified relations; it runs
-- with the privileges and row-level security of the role whose statement fired it, so it reveals nothing that role cannot
-- see. Triggers fire without EXECUTE, so EXECUTE is revoked from PUBLIC here, before any role provisioning: no new
-- callable routine (the Stage 3 fence definer's routine set and the shared invoker list stay exactly as accepted).
-- Times are TIMESTAMP(3) holding UTC; the DB clock is clock_timestamp() AT TIME ZONE 'UTC', never a caller value.
-- Fixed SQLSTATEs: PO001 identity/history immutable, PO002 lifecycle refused, PO003 retention/delete refused,
-- PO004 commit invariant, PO005 aggregate invalid, PO006 retained-attempt limit, PO007 claim deadline (POWEROFFICE_DEADLINE).
-- Deadlines: a new publication (snapshot INSERT, ACTIVE -> SUCCEEDED) and a private failure (ACTIVE -> FAILED) need the ACTUAL
-- DB clock (clock_timestamp, unrounded) strictly before the claim's original deadlineAt — at the statement AND again at COMMIT —
-- whatever recent timestamp was supplied; recovery (ACTIVE -> ABANDONED) only at/after it. The deadline is never renewed.
-- An unchanged terminal row (a receipt-only no-op) is not a transition and is not deadline-bound.

-- ---------------------------------------------------------------------------------------------------------------
-- 1. State: initialization only empty, sequence never rewinds, no claim replacement or revival, pointer moves only on
--    success publication or (expired) purge, lastSuccessAt never cleared or decreased. Never deleted or truncated.
-- ---------------------------------------------------------------------------------------------------------------
CREATE FUNCTION public.atlas_poweroffice_state_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  v_claim boolean; v_terminal boolean;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'POWEROFFICE_STATE_RETAINED: PowerOffice state is never deleted' USING ERRCODE = 'PO003';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."nextSequence" IS DISTINCT FROM 1 OR NEW."activeAttemptId" IS NOT NULL OR NEW."snapshotId" IS NOT NULL
       OR NEW."snapshotVersion" IS NOT NULL OR NEW."lastAttemptId" IS NOT NULL OR NEW."lastCompletedAttemptId" IS NOT NULL
       OR NEW."lastSuccessAt" IS NOT NULL THEN
      RAISE EXCEPTION 'POWEROFFICE_LIFECYCLE_INVALID: state starts empty' USING ERRCODE = 'PO002';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW."workspaceId", NEW."clientId", NEW."connectionId") IS DISTINCT FROM ROW(OLD."workspaceId", OLD."clientId", OLD."connectionId") THEN
    RAISE EXCEPTION 'POWEROFFICE_HISTORY_IMMUTABLE: state scope is immutable' USING ERRCODE = 'PO001';
  END IF;
  v_claim := NEW."nextSequence" = OLD."nextSequence" + 1;
  v_terminal := OLD."activeAttemptId" IS NOT NULL AND NEW."activeAttemptId" IS NULL;
  IF NOT coalesce(v_claim OR NEW."nextSequence" = OLD."nextSequence", false) THEN
    RAISE EXCEPTION 'POWEROFFICE_LIFECYCLE_INVALID: the sequence only advances by one claim' USING ERRCODE = 'PO002';
  END IF;
  IF v_claim THEN
    -- A new claim: no other ACTIVE, the new pointer names it; outcome history and the published pointer are untouched.
    IF OLD."activeAttemptId" IS NOT NULL OR NEW."activeAttemptId" IS NULL
       OR ROW(NEW."lastCompletedAttemptId", NEW."lastCompletedState", NEW."lastCompletedErrorCode")
          IS DISTINCT FROM ROW(OLD."lastCompletedAttemptId", OLD."lastCompletedState", OLD."lastCompletedErrorCode")
       OR ROW(NEW."snapshotId", NEW."snapshotVersion", NEW."lastSuccessAt") IS DISTINCT FROM ROW(OLD."snapshotId", OLD."snapshotVersion", OLD."lastSuccessAt") THEN
      RAISE EXCEPTION 'POWEROFFICE_LIFECYCLE_INVALID: a claim starts from no ACTIVE attempt and changes no outcome' USING ERRCODE = 'PO002';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."lastAttemptId" IS DISTINCT FROM OLD."lastAttemptId"
     OR (NEW."activeAttemptId" IS DISTINCT FROM OLD."activeAttemptId" AND NOT v_terminal) THEN
    RAISE EXCEPTION 'POWEROFFICE_LIFECYCLE_INVALID: no claim replacement or revival' USING ERRCODE = 'PO002';
  END IF;
  IF v_terminal THEN
    IF NEW."lastAttemptState" = 'SUCCEEDED' THEN
      -- Publication: a new pointer and a recorded success that never goes back in time.
      IF NEW."snapshotId" IS NULL OR NEW."snapshotId" IS NOT DISTINCT FROM OLD."snapshotId" OR NEW."lastSuccessAt" IS NULL
         OR NEW."lastSuccessAt" < OLD."lastSuccessAt" THEN
        RAISE EXCEPTION 'POWEROFFICE_LIFECYCLE_INVALID: success publishes a new pointer' USING ERRCODE = 'PO002';
      END IF;
    ELSIF ROW(NEW."snapshotId", NEW."snapshotVersion", NEW."lastSuccessAt") IS DISTINCT FROM ROW(OLD."snapshotId", OLD."snapshotVersion", OLD."lastSuccessAt") THEN
      RAISE EXCEPTION 'POWEROFFICE_LIFECYCLE_INVALID: a failure preserves the snapshot and last success' USING ERRCODE = 'PO002';
    END IF;
    RETURN NEW;
  END IF;
  -- No claim and no terminal transition: outcome history is fixed; only an expired pointer may be cleared (purge).
  IF ROW(NEW."lastAttemptState", NEW."lastAttemptErrorCode", NEW."lastCompletedAttemptId", NEW."lastCompletedState", NEW."lastCompletedErrorCode", NEW."lastSuccessAt")
     IS DISTINCT FROM ROW(OLD."lastAttemptState", OLD."lastAttemptErrorCode", OLD."lastCompletedAttemptId", OLD."lastCompletedState", OLD."lastCompletedErrorCode", OLD."lastSuccessAt") THEN
    RAISE EXCEPTION 'POWEROFFICE_HISTORY_IMMUTABLE: outcome history changes only with a terminal commit' USING ERRCODE = 'PO001';
  END IF;
  IF ROW(NEW."snapshotId", NEW."snapshotVersion") IS DISTINCT FROM ROW(OLD."snapshotId", OLD."snapshotVersion") THEN
    IF NEW."snapshotId" IS NOT NULL OR OLD."snapshotId" IS NULL OR NOT EXISTS (
         SELECT 1 FROM public."PowerOfficeSnapshot" s
          WHERE s."workspaceId" = OLD."workspaceId" AND s."clientId" = OLD."clientId" AND s."connectionId" = OLD."connectionId"
            AND s.id = OLD."snapshotId" AND s."expiresAt" <= (pg_catalog.clock_timestamp() AT TIME ZONE 'UTC')) THEN
      RAISE EXCEPTION 'POWEROFFICE_LIFECYCLE_INVALID: only an expired pointer is cleared' USING ERRCODE = 'PO002';
    END IF;
  END IF;
  RETURN NEW;
END $fn$;

-- ---------------------------------------------------------------------------------------------------------------
-- 2. Attempt: inserted ACTIVE at the allocated sequence with a current DB start time, under the retention cap; only
--    ACTIVE -> SUCCEEDED/FAILED/ABANDONED at a current DB time; terminal rows and identities are immutable. DELETE only
--    terminal rows completed more than 30 days ago and referenced by no snapshot or State pointer (every deleting role).
-- ---------------------------------------------------------------------------------------------------------------
CREATE FUNCTION public.atlas_poweroffice_attempt_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  v_now timestamp(3) := pg_catalog.clock_timestamp() AT TIME ZONE 'UTC';
  v_next integer; v_active uuid; v_retained bigint; v_clock timestamp;
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'POWEROFFICE_RETENTION_REFUSED: attempts are never truncated' USING ERRCODE = 'PO003';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state IS DISTINCT FROM 'ACTIVE' OR NEW."startedAt" > v_now OR NEW."startedAt" <= v_now - interval '10 seconds' THEN
      RAISE EXCEPTION 'POWEROFFICE_LIFECYCLE_INVALID: a claim starts ACTIVE at the current DB time' USING ERRCODE = 'PO002';
    END IF;
    SELECT s."nextSequence", s."activeAttemptId" INTO v_next, v_active FROM public."PowerOfficeState" s
     WHERE s."workspaceId" = NEW."workspaceId" AND s."clientId" = NEW."clientId" AND s."connectionId" = NEW."connectionId";
    IF NOT FOUND OR NEW.sequence IS DISTINCT FROM v_next OR v_active IS NOT NULL THEN
      RAISE EXCEPTION 'POWEROFFICE_LIFECYCLE_INVALID: a claim takes the next sequence of an idle state' USING ERRCODE = 'PO002';
    END IF;
    SELECT count(*) INTO v_retained FROM public."PowerOfficeAttempt" a
     WHERE a."workspaceId" = NEW."workspaceId" AND a."clientId" = NEW."clientId" AND a."connectionId" = NEW."connectionId";
    IF v_retained >= 1000 THEN
      RAISE EXCEPTION 'POWEROFFICE_SYNC_LIMIT: 1000 retained attempts' USING ERRCODE = 'PO006';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (pg_catalog.to_jsonb(NEW) - ARRAY['state', 'completedAt', 'safeErrorCode']) IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - ARRAY['state', 'completedAt', 'safeErrorCode']) THEN
      RAISE EXCEPTION 'POWEROFFICE_HISTORY_IMMUTABLE: attempt identity is immutable' USING ERRCODE = 'PO001';
    END IF;
    IF OLD.state IS DISTINCT FROM 'ACTIVE' OR NEW.state = 'ACTIVE' THEN
      IF ROW(NEW.state, NEW."completedAt", NEW."safeErrorCode") IS DISTINCT FROM ROW(OLD.state, OLD."completedAt", OLD."safeErrorCode") THEN
        RAISE EXCEPTION 'POWEROFFICE_LIFECYCLE_INVALID: a terminal attempt is final' USING ERRCODE = 'PO002';
      END IF;
      RETURN NEW;
    END IF;
    v_clock := pg_catalog.clock_timestamp() AT TIME ZONE 'UTC';
    IF NEW.state IN ('SUCCEEDED', 'FAILED') AND v_clock >= OLD."deadlineAt" THEN
      RAISE EXCEPTION 'POWEROFFICE_DEADLINE: the claim deadline has passed; only recovery may close it' USING ERRCODE = 'PO007';
    END IF;
    IF NEW.state = 'ABANDONED' AND v_clock < OLD."deadlineAt" THEN
      RAISE EXCEPTION 'POWEROFFICE_DEADLINE: recovery is not due before the claim deadline' USING ERRCODE = 'PO007';
    END IF;
    IF NEW."completedAt" > v_now OR NEW."completedAt" <= v_now - interval '10 seconds' THEN
      RAISE EXCEPTION 'POWEROFFICE_LIFECYCLE_INVALID: an attempt completes at the current DB time' USING ERRCODE = 'PO002';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.state = 'ACTIVE' OR OLD."completedAt" IS NULL OR OLD."completedAt" >= v_now - interval '30 days'
     OR EXISTS (SELECT 1 FROM public."PowerOfficeSnapshot" s
                 WHERE s."workspaceId" = OLD."workspaceId" AND s."clientId" = OLD."clientId" AND s."connectionId" = OLD."connectionId" AND s."attemptId" = OLD.id)
     OR EXISTS (SELECT 1 FROM public."PowerOfficeState" s
                 WHERE s."workspaceId" = OLD."workspaceId" AND s."clientId" = OLD."clientId" AND s."connectionId" = OLD."connectionId"
                   AND OLD.id IN (s."activeAttemptId", s."lastAttemptId", s."lastCompletedAttemptId")) THEN
    RAISE EXCEPTION 'POWEROFFICE_RETENTION_REFUSED: only old unreferenced terminal attempts are deleted' USING ERRCODE = 'PO003';
  END IF;
  RETURN OLD;
END $fn$;

-- ---------------------------------------------------------------------------------------------------------------
-- 3. Snapshot: inserted only for the ACTIVE claim of its state, before its deadline, at a current DB time, with the
--    exact aggregate of docs/stage4/02_CONTRACTS.md (same shape/order/bounds as packages/poweroffice/aggregate.ts);
--    immutable; DELETE only when expired and no longer the State pointer.
-- ---------------------------------------------------------------------------------------------------------------
CREATE FUNCTION public.atlas_poweroffice_snapshot_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  v_now timestamp(3) := pg_catalog.clock_timestamp() AT TIME ZONE 'UTC';
  v_count_pattern constant text := '^(0|[1-9][0-9]{0,4})$';
  v_amount_pattern constant text := '^(0|[1-9][0-9]{0,18})\.[0-9]{2}$';
  v_keys constant text[] := ARRAY['count','creditNoteCount','currency','openInvoiceCount','outstandingCreditAmount','outstandingInvoiceAmount','overdueInvoiceCount'];
  v_summary jsonb; v_group jsonb; v_previous text; v_currency text; v_total integer; v_sum integer := 0;
  v_n integer; v_open integer; v_overdue integer; v_credit integer; v_state text; v_deadline timestamp(3); v_active uuid;
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'POWEROFFICE_RETENTION_REFUSED: snapshots are never truncated' USING ERRCODE = 'PO003';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'POWEROFFICE_HISTORY_IMMUTABLE: snapshots are immutable' USING ERRCODE = 'PO001';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD."expiresAt" > v_now OR EXISTS (SELECT 1 FROM public."PowerOfficeState" s
         WHERE s."workspaceId" = OLD."workspaceId" AND s."clientId" = OLD."clientId" AND s."connectionId" = OLD."connectionId" AND s."snapshotId" = OLD.id) THEN
      RAISE EXCEPTION 'POWEROFFICE_RETENTION_REFUSED: only expired unreferenced snapshots are deleted' USING ERRCODE = 'PO003';
    END IF;
    RETURN OLD;
  END IF;
  SELECT a.state, a."deadlineAt" INTO v_state, v_deadline FROM public."PowerOfficeAttempt" a
   WHERE a."workspaceId" = NEW."workspaceId" AND a."clientId" = NEW."clientId" AND a."connectionId" = NEW."connectionId" AND a.id = NEW."attemptId";
  SELECT s."activeAttemptId" INTO v_active FROM public."PowerOfficeState" s
   WHERE s."workspaceId" = NEW."workspaceId" AND s."clientId" = NEW."clientId" AND s."connectionId" = NEW."connectionId";
  IF v_state = 'ACTIVE' AND (pg_catalog.clock_timestamp() AT TIME ZONE 'UTC') >= v_deadline THEN
    RAISE EXCEPTION 'POWEROFFICE_DEADLINE: the claim deadline has passed; no new publication' USING ERRCODE = 'PO007';
  END IF;
  IF v_state IS DISTINCT FROM 'ACTIVE' OR v_active IS DISTINCT FROM NEW."attemptId" OR NEW."publishedAt" >= v_deadline
     OR NEW."publishedAt" > v_now OR NEW."publishedAt" <= v_now - interval '10 seconds' THEN
    RAISE EXCEPTION 'POWEROFFICE_LIFECYCLE_INVALID: only the ACTIVE claim publishes, before its deadline, at the current DB time' USING ERRCODE = 'PO002';
  END IF;
  v_summary := NEW.summary;
  IF jsonb_typeof(v_summary) IS DISTINCT FROM 'object'
     OR (SELECT array_agg(k ORDER BY k COLLATE "C") FROM jsonb_object_keys(v_summary) k) IS DISTINCT FROM ARRAY['currencies', 'totalCount']
     OR jsonb_typeof(v_summary -> 'totalCount') IS DISTINCT FROM 'number' OR (v_summary ->> 'totalCount') !~ v_count_pattern
     OR jsonb_typeof(v_summary -> 'currencies') IS DISTINCT FROM 'array' OR jsonb_array_length(v_summary -> 'currencies') > 6 THEN
    RAISE EXCEPTION 'POWEROFFICE_AGGREGATE_INVALID' USING ERRCODE = 'PO005';
  END IF;
  v_total := (v_summary ->> 'totalCount')::integer;
  FOR v_group IN SELECT e.value FROM jsonb_array_elements(v_summary -> 'currencies') WITH ORDINALITY AS e(value, n) ORDER BY e.n LOOP
    IF jsonb_typeof(v_group) IS DISTINCT FROM 'object'
       OR (SELECT array_agg(k ORDER BY k COLLATE "C") FROM jsonb_object_keys(v_group) k) IS DISTINCT FROM v_keys
       OR jsonb_typeof(v_group -> 'currency') IS DISTINCT FROM 'string'
       OR (v_group ->> 'currency') NOT IN ('DKK', 'EUR', 'GBP', 'NOK', 'SEK', 'USD')
       OR EXISTS (SELECT 1 FROM unnest(ARRAY['count', 'openInvoiceCount', 'overdueInvoiceCount', 'creditNoteCount']) c
                   WHERE jsonb_typeof(v_group -> c) IS DISTINCT FROM 'number' OR (v_group ->> c) !~ v_count_pattern)
       OR EXISTS (SELECT 1 FROM unnest(ARRAY['outstandingInvoiceAmount', 'outstandingCreditAmount']) c
                   WHERE jsonb_typeof(v_group -> c) IS DISTINCT FROM 'string' OR (v_group ->> c) !~ v_amount_pattern) THEN
      RAISE EXCEPTION 'POWEROFFICE_AGGREGATE_INVALID' USING ERRCODE = 'PO005';
    END IF;
    v_currency := v_group ->> 'currency';
    v_n := (v_group ->> 'count')::integer; v_open := (v_group ->> 'openInvoiceCount')::integer;
    v_overdue := (v_group ->> 'overdueInvoiceCount')::integer; v_credit := (v_group ->> 'creditNoteCount')::integer;
    -- Sorted unique currencies; nonempty groups; counts nested; open count and outstanding invoice sum are zero together;
    -- a group without credit notes has no outstanding credit.
    IF (v_previous IS NOT NULL AND v_currency COLLATE "C" <= v_previous COLLATE "C") OR v_n < 1 OR v_n > 10000
       OR v_credit > v_n OR v_open > v_n - v_credit OR v_overdue > v_open
       OR (v_open = 0) <> ((v_group ->> 'outstandingInvoiceAmount') = '0.00')
       OR (v_credit = 0 AND (v_group ->> 'outstandingCreditAmount') <> '0.00') THEN
      RAISE EXCEPTION 'POWEROFFICE_AGGREGATE_INVALID' USING ERRCODE = 'PO005';
    END IF;
    v_previous := v_currency; v_sum := v_sum + v_n;
  END LOOP;
  IF v_total > 10000 OR v_sum <> v_total THEN
    RAISE EXCEPTION 'POWEROFFICE_AGGREGATE_INVALID' USING ERRCODE = 'PO005';
  END IF;
  RETURN NEW;
END $fn$;

-- ---------------------------------------------------------------------------------------------------------------
-- 4. Commit invariants (CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY DEFERRED), checked for the affected connection in
--    BOTH directions at COMMIT (or at SET CONSTRAINTS ... IMMEDIATE inside the cleanup routine):
--      every ACTIVE attempt is State.activeAttemptId and vice versa; the lastAttempt tuple is the latest allocated
--      sequence (nextSequence - 1); the lastCompleted tuple is the latest terminal attempt; the pointer names the newest
--      snapshot, owned by a SUCCEEDED attempt, with lastSuccessAt = its publishedAt; without a pointer every remaining
--      snapshot is expired (purged state keeps lastSuccessAt); every snapshot belongs to a SUCCEEDED attempt and an
--      attempt that became SUCCEEDED has its allocated snapshot; no success without lastSuccessAt.
-- ---------------------------------------------------------------------------------------------------------------
CREATE FUNCTION public.atlas_poweroffice_commit_check() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  v_now timestamp(3) := pg_catalog.clock_timestamp() AT TIME ZONE 'UTC';
  s record; a record; c record; p record; v_active uuid[];
BEGIN
  SELECT * INTO s FROM public."PowerOfficeState" x
   WHERE x."workspaceId" = NEW."workspaceId" AND x."clientId" = NEW."clientId" AND x."connectionId" = NEW."connectionId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'POWEROFFICE_COMMIT_INVARIANT: state missing' USING ERRCODE = 'PO004';
  END IF;
  SELECT array_agg(x.id) INTO v_active FROM public."PowerOfficeAttempt" x
   WHERE x."workspaceId" = s."workspaceId" AND x."clientId" = s."clientId" AND x."connectionId" = s."connectionId" AND x.state = 'ACTIVE';
  IF (v_active IS NULL) <> (s."activeAttemptId" IS NULL) OR (v_active IS NOT NULL AND (cardinality(v_active) <> 1 OR v_active[1] IS DISTINCT FROM s."activeAttemptId")) THEN
    RAISE EXCEPTION 'POWEROFFICE_COMMIT_INVARIANT: ACTIVE attempt and pointer disagree' USING ERRCODE = 'PO004';
  END IF;
  SELECT x.id, x.sequence, x.state, x."safeErrorCode" INTO a FROM public."PowerOfficeAttempt" x
   WHERE x."workspaceId" = s."workspaceId" AND x."clientId" = s."clientId" AND x."connectionId" = s."connectionId"
   ORDER BY x.sequence DESC LIMIT 1;
  IF (NOT FOUND) <> (s."nextSequence" = 1) OR (FOUND AND (a.sequence IS DISTINCT FROM s."nextSequence" - 1 OR a.id IS DISTINCT FROM s."lastAttemptId"
       OR a.state IS DISTINCT FROM s."lastAttemptState" OR a."safeErrorCode" IS DISTINCT FROM s."lastAttemptErrorCode")) THEN
    RAISE EXCEPTION 'POWEROFFICE_COMMIT_INVARIANT: lastAttempt is not the latest allocated sequence' USING ERRCODE = 'PO004';
  END IF;
  SELECT x.id, x.state, x."safeErrorCode" INTO c FROM public."PowerOfficeAttempt" x
   WHERE x."workspaceId" = s."workspaceId" AND x."clientId" = s."clientId" AND x."connectionId" = s."connectionId" AND x.state <> 'ACTIVE'
   ORDER BY x.sequence DESC LIMIT 1;
  IF (NOT FOUND) <> (s."lastCompletedAttemptId" IS NULL) OR (FOUND AND (c.id IS DISTINCT FROM s."lastCompletedAttemptId" OR c.state IS DISTINCT FROM s."lastCompletedState"
       OR c."safeErrorCode" IS DISTINCT FROM s."lastCompletedErrorCode")) THEN
    RAISE EXCEPTION 'POWEROFFICE_COMMIT_INVARIANT: lastCompleted is not the latest terminal attempt' USING ERRCODE = 'PO004';
  END IF;
  IF EXISTS (SELECT 1 FROM public."PowerOfficeSnapshot" x JOIN public."PowerOfficeAttempt" y
               ON y."workspaceId" = x."workspaceId" AND y."clientId" = x."clientId" AND y."connectionId" = x."connectionId" AND y.id = x."attemptId"
              WHERE x."workspaceId" = s."workspaceId" AND x."clientId" = s."clientId" AND x."connectionId" = s."connectionId"
                AND (y.state <> 'SUCCEEDED' OR s."lastSuccessAt" IS NULL OR x."publishedAt" > s."lastSuccessAt")) THEN
    RAISE EXCEPTION 'POWEROFFICE_COMMIT_INVARIANT: a snapshot without its SUCCEEDED attempt or recorded success' USING ERRCODE = 'PO004';
  END IF;
  IF s."lastSuccessAt" IS NULL AND EXISTS (SELECT 1 FROM public."PowerOfficeAttempt" x
       WHERE x."workspaceId" = s."workspaceId" AND x."clientId" = s."clientId" AND x."connectionId" = s."connectionId" AND x.state = 'SUCCEEDED') THEN
    RAISE EXCEPTION 'POWEROFFICE_COMMIT_INVARIANT: success without lastSuccessAt' USING ERRCODE = 'PO004';
  END IF;
  SELECT x.id, x."publishedAt", x."expiresAt" INTO p FROM public."PowerOfficeSnapshot" x JOIN public."PowerOfficeAttempt" y
      ON y."workspaceId" = x."workspaceId" AND y."clientId" = x."clientId" AND y."connectionId" = x."connectionId" AND y.id = x."attemptId"
   WHERE x."workspaceId" = s."workspaceId" AND x."clientId" = s."clientId" AND x."connectionId" = s."connectionId"
   ORDER BY y.sequence DESC LIMIT 1;
  IF s."snapshotId" IS NOT NULL THEN
    IF NOT FOUND OR p.id IS DISTINCT FROM s."snapshotId" OR p."publishedAt" IS DISTINCT FROM s."lastSuccessAt" THEN
      RAISE EXCEPTION 'POWEROFFICE_COMMIT_INVARIANT: pointer is not the newest published snapshot' USING ERRCODE = 'PO004';
    END IF;
  ELSIF FOUND AND p."expiresAt" > v_now THEN
    RAISE EXCEPTION 'POWEROFFICE_COMMIT_INVARIANT: unexpired snapshot without pointer' USING ERRCODE = 'PO004';
  END IF;
  -- Nested: only an Attempt event has state/allocatedSnapshotId (PL/pgSQL does not short-circuit record field access).
  IF TG_TABLE_NAME = 'PowerOfficeAttempt' AND TG_OP = 'UPDATE' THEN
    -- The original deadline holds at COMMIT too: a publication or private failure committing at/after it rolls back.
    IF OLD.state = 'ACTIVE' AND NEW.state IN ('SUCCEEDED', 'FAILED') AND (pg_catalog.clock_timestamp() AT TIME ZONE 'UTC') >= NEW."deadlineAt" THEN
      RAISE EXCEPTION 'POWEROFFICE_DEADLINE: the claim deadline passed before COMMIT' USING ERRCODE = 'PO007';
    END IF;
    IF OLD.state = 'ACTIVE' AND NEW.state = 'SUCCEEDED' AND NOT EXISTS (SELECT 1 FROM public."PowerOfficeSnapshot" x
         WHERE x."workspaceId" = NEW."workspaceId" AND x."clientId" = NEW."clientId" AND x."connectionId" = NEW."connectionId"
           AND x.id = NEW."allocatedSnapshotId" AND x."attemptId" = NEW.id) THEN
      RAISE EXCEPTION 'POWEROFFICE_COMMIT_INVARIANT: success without its allocated snapshot' USING ERRCODE = 'PO004';
    END IF;
  END IF;
  RETURN NULL;
END $fn$;

-- Trigger-only: firing needs no EXECUTE, so nobody (PUBLIC included) holds it.
REVOKE ALL ON FUNCTION public.atlas_poweroffice_state_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.atlas_poweroffice_attempt_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.atlas_poweroffice_snapshot_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.atlas_poweroffice_commit_check() FROM PUBLIC;

CREATE TRIGGER "PowerOfficeState_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PowerOfficeState"
  FOR EACH ROW EXECUTE FUNCTION public.atlas_poweroffice_state_guard();
CREATE TRIGGER "PowerOfficeState_truncate" BEFORE TRUNCATE ON "PowerOfficeState"
  FOR EACH STATEMENT EXECUTE FUNCTION public.atlas_poweroffice_state_guard();
CREATE TRIGGER "PowerOfficeAttempt_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PowerOfficeAttempt"
  FOR EACH ROW EXECUTE FUNCTION public.atlas_poweroffice_attempt_guard();
CREATE TRIGGER "PowerOfficeAttempt_truncate" BEFORE TRUNCATE ON "PowerOfficeAttempt"
  FOR EACH STATEMENT EXECUTE FUNCTION public.atlas_poweroffice_attempt_guard();
CREATE TRIGGER "PowerOfficeSnapshot_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PowerOfficeSnapshot"
  FOR EACH ROW EXECUTE FUNCTION public.atlas_poweroffice_snapshot_guard();
CREATE TRIGGER "PowerOfficeSnapshot_truncate" BEFORE TRUNCATE ON "PowerOfficeSnapshot"
  FOR EACH STATEMENT EXECUTE FUNCTION public.atlas_poweroffice_snapshot_guard();
CREATE CONSTRAINT TRIGGER "PowerOfficeState_commit" AFTER INSERT OR UPDATE ON "PowerOfficeState"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.atlas_poweroffice_commit_check();
CREATE CONSTRAINT TRIGGER "PowerOfficeAttempt_commit" AFTER INSERT OR UPDATE ON "PowerOfficeAttempt"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.atlas_poweroffice_commit_check();
CREATE CONSTRAINT TRIGGER "PowerOfficeSnapshot_commit" AFTER INSERT ON "PowerOfficeSnapshot"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.atlas_poweroffice_commit_check();
