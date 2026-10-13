-- Stage 2 task 2.2 (docs/stage2/02_CONTRACTS.md §3): publication fence, ordering and immutability of sign-in roots,
-- attempts, leaves and memberships. Split from 202610081100 (tables, constraints, RLS) so each file holds one concern.
-- Lock order and fence rules: see the concurrency note before atlas_m365_connection_fence in 202610081000:
--   Connection → window (root) → attempt → leaf → membership.
-- INSERT triggers lock parents in that order and wait; UPDATE triggers (own row already locked) take an earlier-ordered
-- parent only with NOWAIT. A publisher following the order — Connection FOR SHARE, window FOR UPDATE, attempt FOR UPDATE,
-- then leaves, attempt, window — already holds everything these triggers ask for.

-- Window: identity fixed, order monotonic; a pointer names the COMPLETE attempt of latestPublishedSeq (locked, so it cannot
-- be superseded concurrently) and is withdrawn only after that attempt expired.
CREATE FUNCTION atlas_m365_signin_window() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a RECORD;
BEGIN
  IF ROW(NEW."workspaceId", NEW."clientId", NEW."connectionId", NEW.id, NEW."rootFrom", NEW."rootTo")
     IS DISTINCT FROM ROW(OLD."workspaceId", OLD."clientId", OLD."connectionId", OLD.id, OLD."rootFrom", OLD."rootTo") THEN
    RAISE EXCEPTION 'M365SignInWindow identity is immutable';
  END IF;
  IF NEW."latestStartedSeq" < OLD."latestStartedSeq" OR NEW."latestRecordedSeq" < OLD."latestRecordedSeq"
     OR NEW."latestPublishedSeq" < OLD."latestPublishedSeq" OR NEW."lastSuccessAt" < OLD."lastSuccessAt"
     OR (OLD."lastSuccessAt" IS NOT NULL AND NEW."lastSuccessAt" IS NULL) OR NEW."lastAttemptAt" < OLD."lastAttemptAt" THEN
    RAISE EXCEPTION 'M365SignInWindow order is monotonic';
  END IF;
  IF NEW."publishedAttemptId" IS DISTINCT FROM OLD."publishedAttemptId" THEN
    IF NEW."publishedAttemptId" IS NULL THEN
      SELECT "expiresAt" INTO a FROM public."M365WindowAttempt"
       WHERE "workspaceId" = OLD."workspaceId" AND "clientId" = OLD."clientId" AND "connectionId" = OLD."connectionId"
         AND "windowId" = OLD.id AND id = OLD."publishedAttemptId";
      IF a."expiresAt" IS NULL OR a."expiresAt" > now() OR NEW.status <> 'MISSING' THEN
        RAISE EXCEPTION 'an unexpired published sign-in attempt cannot be withdrawn';
      END IF;
    ELSE
      SELECT state, "attemptSeq", "lifecycleVersion" INTO a FROM public."M365WindowAttempt"
       WHERE "workspaceId" = NEW."workspaceId" AND "clientId" = NEW."clientId" AND "connectionId" = NEW."connectionId"
         AND "windowId" = NEW.id AND id = NEW."publishedAttemptId" FOR SHARE;
      IF a.state IS DISTINCT FROM 'COMPLETE' OR a."attemptSeq" <> NEW."latestPublishedSeq" THEN
        RAISE EXCEPTION 'the window pointer names the COMPLETE attempt of latestPublishedSeq';
      END IF;
      -- Pointer linearization: only to the newest started attempt (this window row is locked; latestStartedSeq never
      -- decreases), only under the Connection fence at the attempt's lifecycleVersion. A retained pointer is not rechecked.
      IF a."attemptSeq" IS DISTINCT FROM NEW."latestStartedSeq" THEN
        RAISE EXCEPTION 'the window pointer moves only to the newest started attempt';
      END IF;
      PERFORM atlas_m365_connection_fence(NEW."workspaceId", NEW."clientId", NEW."connectionId", a."lifecycleVersion");
    END IF;
  ELSIF NEW."latestPublishedSeq" <> OLD."latestPublishedSeq" THEN
    RAISE EXCEPTION 'latestPublishedSeq advances only with a new published pointer';
  END IF;
  RETURN NEW;
END $$;
-- A new window cannot carry a pointer: its attempts reference it, so a pointer is set only by an UPDATE through this trigger.
CREATE TRIGGER "M365SignInWindow_order" BEFORE UPDATE ON "M365SignInWindow" FOR EACH ROW EXECUTE FUNCTION atlas_m365_signin_window();

CREATE FUNCTION atlas_m365_window_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE w RECORD; v_end TIMESTAMP(3); l RECORD; v_n INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."expiresAt" > now() THEN RAISE EXCEPTION 'a sign-in attempt is retained until its expiresAt'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    -- Initial state first and independently (never created COMPLETE: the deferred check covers only RUNNING -> COMPLETE);
    -- then the prerequisite window must already be visible — a later foreign key cannot stand in for these checks.
    IF NEW.state IS DISTINCT FROM 'RUNNING' THEN RAISE EXCEPTION 'a sign-in attempt starts RUNNING'; END IF;
    SELECT "latestStartedSeq" AS started INTO w FROM public."M365SignInWindow"
     WHERE "workspaceId" = NEW."workspaceId" AND "clientId" = NEW."clientId" AND "connectionId" = NEW."connectionId" AND id = NEW."windowId" FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'a sign-in attempt needs its window to exist first (committed or earlier in this transaction)'; END IF;
    IF w.started IS DISTINCT FROM NEW."attemptSeq" THEN
      RAISE EXCEPTION 'a sign-in attempt starts RUNNING with the newly allocated latestStartedSeq';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW."workspaceId", NEW."clientId", NEW."connectionId", NEW."windowId", NEW.id, NEW."rootFrom", NEW."requestId", NEW."attemptSeq",
         NEW."lifecycleVersion", NEW."coveredFrom", NEW."coveredTo", NEW."configVersion", NEW."startedAt", NEW."deadlineAt")
     IS DISTINCT FROM ROW(OLD."workspaceId", OLD."clientId", OLD."connectionId", OLD."windowId", OLD.id, OLD."rootFrom", OLD."requestId", OLD."attemptSeq",
         OLD."lifecycleVersion", OLD."coveredFrom", OLD."coveredTo", OLD."configVersion", OLD."startedAt", OLD."deadlineAt") THEN
    RAISE EXCEPTION 'a sign-in attempt keeps its identity and fixed bounds; a retry is a new attempt';
  END IF;
  IF NOT ((OLD.state = 'RUNNING' AND NEW.state IN ('RUNNING','COMPLETE','FAILED','SUPERSEDED')) OR (OLD.state = 'COMPLETE' AND NEW.state = 'SUPERSEDED')) THEN
    RAISE EXCEPTION 'sign-in attempt lifecycle allows RUNNING -> COMPLETE | FAILED | SUPERSEDED and COMPLETE -> SUPERSEDED only';
  END IF;
  IF OLD.state <> 'RUNNING' AND ROW(NEW."completedAt", NEW."publishedAt", NEW."evidenceCount", NEW."leafCount", NEW."stagedRows")
     IS DISTINCT FROM ROW(OLD."completedAt", OLD."publishedAt", OLD."evidenceCount", OLD."leafCount", OLD."stagedRows") THEN
    RAISE EXCEPTION 'a published sign-in attempt is immutable';
  END IF;
  IF NEW."expiresAt" > OLD."expiresAt" AND NOT (OLD.state = 'RUNNING' AND NEW.state = 'COMPLETE') THEN
    RAISE EXCEPTION 'sign-in retention is extended only by publication';
  END IF;
  IF (OLD.state = 'COMPLETE' AND NEW.state = 'SUPERSEDED') OR (OLD.state = 'RUNNING' AND NEW.state = 'COMPLETE') THEN
    BEGIN -- the window precedes the attempt in the lock order: never waited for here
      SELECT "latestStartedSeq" AS started, "publishedAttemptId" AS pointer INTO w FROM public."M365SignInWindow"
       WHERE "workspaceId" = NEW."workspaceId" AND "clientId" = NEW."clientId" AND "connectionId" = NEW."connectionId" AND id = NEW."windowId"
         FOR SHARE NOWAIT;
    EXCEPTION WHEN lock_not_available THEN
      RAISE EXCEPTION 'sign-in attempt: lock its window before the attempt; the window is being changed' USING ERRCODE = '55P03';
    END;
  END IF;
  IF OLD.state = 'COMPLETE' THEN -- (lifecycle above: NEW.state is SUPERSEDED, and w was read)
    IF w.pointer IS NOT DISTINCT FROM NEW.id THEN
      RAISE EXCEPTION 'the published attempt of a window is superseded only after the pointer moved';
    END IF;
  END IF;
  IF OLD.state = 'RUNNING' AND NEW.state = 'COMPLETE' THEN
    PERFORM atlas_m365_connection_fence(NEW."workspaceId", NEW."clientId", NEW."connectionId", NEW."lifecycleVersion");
    IF w.started IS DISTINCT FROM NEW."attemptSeq" THEN RAISE EXCEPTION 'only the newest started sign-in attempt publishes'; END IF;
    -- Leaf and membership writers hold this attempt in SHARE mode: this UPDATE waited for them; these reads see them.
    IF EXISTS (SELECT 1 FROM public."M365WindowLeaf" WHERE "workspaceId" = NEW."workspaceId" AND "clientId" = NEW."clientId"
                AND "connectionId" = NEW."connectionId" AND "windowId" = NEW."windowId" AND "attemptId" = NEW.id
                AND state NOT IN ('COMPLETE','SPLIT')) THEN
      RAISE EXCEPTION 'every leaf of a published attempt is COMPLETE or a SPLIT container';
    END IF;
    -- COMPLETE nonsplit leaves partition [coveredFrom, coveredTo) exactly.
    v_end := NEW."coveredFrom";
    FOR l IN SELECT "fromInclusive", "toExclusive" FROM public."M365WindowLeaf"
              WHERE "workspaceId" = NEW."workspaceId" AND "clientId" = NEW."clientId" AND "connectionId" = NEW."connectionId"
                AND "windowId" = NEW."windowId" AND "attemptId" = NEW.id AND state = 'COMPLETE' ORDER BY "fromInclusive", "toExclusive" LOOP
      IF l."fromInclusive" <> v_end THEN RAISE EXCEPTION 'published leaves leave a gap or overlap'; END IF;
      v_end := l."toExclusive";
    END LOOP;
    IF v_end <> NEW."coveredTo" OR v_end = NEW."coveredFrom" THEN RAISE EXCEPTION 'published leaves must cover the attempt bounds exactly'; END IF;
    -- The published counts are the published rows: a membership committed late cannot hide behind a stale count.
    SELECT count(*) INTO v_n FROM public."M365WindowEvidence" WHERE "workspaceId" = NEW."workspaceId" AND "clientId" = NEW."clientId"
       AND "connectionId" = NEW."connectionId" AND "windowId" = NEW."windowId" AND "attemptId" = NEW.id;
    IF v_n <> NEW."evidenceCount" THEN RAISE EXCEPTION 'published evidenceCount must equal the staged memberships'; END IF;
    SELECT count(*) INTO v_n FROM public."M365WindowLeaf" WHERE "workspaceId" = NEW."workspaceId" AND "clientId" = NEW."clientId"
       AND "connectionId" = NEW."connectionId" AND "windowId" = NEW."windowId" AND "attemptId" = NEW.id;
    IF v_n <> NEW."leafCount" THEN RAISE EXCEPTION 'published leafCount must equal the leaves'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "M365WindowAttempt_lifecycle" BEFORE INSERT OR UPDATE OR DELETE ON "M365WindowAttempt"
  FOR EACH ROW EXECUTE FUNCTION atlas_m365_window_attempt();

-- Commit atomicity: RUNNING -> COMPLETE commits only together with the window pointer naming this attempt (deferred
-- constraint trigger, same rules as atlas_m365_generation_published_with_pointer in 202610081000). An attempt superseded
-- later by a newer publication keeps its history; only the completing transaction is checked.
CREATE FUNCTION atlas_m365_attempt_completed_with_pointer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public."M365SignInWindow"
                  WHERE "workspaceId" = NEW."workspaceId" AND "clientId" = NEW."clientId" AND "connectionId" = NEW."connectionId"
                    AND id = NEW."windowId" AND "publishedAttemptId" = NEW.id) THEN
    RAISE EXCEPTION 'a sign-in attempt completes only together with its window pointer, in one transaction';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "M365WindowAttempt_completed_with_pointer" AFTER UPDATE ON "M365WindowAttempt"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (OLD.state = 'RUNNING' AND NEW.state = 'COMPLETE')
  EXECUTE FUNCTION atlas_m365_attempt_completed_with_pointer();

-- Leaves change only while their attempt runs. The root leaf has the attempt's bounds; a child lies inside its SPLIT parent.
-- A new leaf locks its attempt FOR NO KEY UPDATE: leaf insertions of one attempt are serialized, so the 60-leaf cap and the
-- sibling-overlap check see every committed sibling.
CREATE FUNCTION atlas_m365_window_leaf() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a RECORD; p RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT "expiresAt" INTO a FROM public."M365WindowAttempt" WHERE "workspaceId" = OLD."workspaceId" AND "clientId" = OLD."clientId"
       AND "connectionId" = OLD."connectionId" AND "windowId" = OLD."windowId" AND id = OLD."attemptId";
    IF a."expiresAt" IS NULL OR a."expiresAt" > now() THEN RAISE EXCEPTION 'leaves are retained until their attempt expires'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state IS DISTINCT FROM 'PENDING' THEN RAISE EXCEPTION 'a leaf starts PENDING'; END IF;
    SELECT state, "coveredFrom", "coveredTo" INTO a FROM public."M365WindowAttempt"
     WHERE "workspaceId" = NEW."workspaceId" AND "clientId" = NEW."clientId" AND "connectionId" = NEW."connectionId"
       AND "windowId" = NEW."windowId" AND id = NEW."attemptId" FOR NO KEY UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'a leaf needs its RUNNING attempt to exist first (committed or earlier in this transaction)'; END IF;
    IF a.state IS DISTINCT FROM 'RUNNING' THEN RAISE EXCEPTION 'leaves of a finished sign-in attempt are immutable'; END IF;
    IF (SELECT count(*) FROM public."M365WindowLeaf" WHERE "workspaceId" = NEW."workspaceId" AND "clientId" = NEW."clientId"
         AND "connectionId" = NEW."connectionId" AND "windowId" = NEW."windowId" AND "attemptId" = NEW."attemptId") >= 60 THEN
      RAISE EXCEPTION 'at most 60 leaves per root attempt';
    END IF;
    IF NEW."parentLeafId" IS NULL THEN
      IF NEW."fromInclusive" <> a."coveredFrom" OR NEW."toExclusive" <> a."coveredTo" THEN RAISE EXCEPTION 'the root leaf has the attempt bounds'; END IF;
    ELSE
      SELECT state, "fromInclusive", "toExclusive" INTO p FROM public."M365WindowLeaf" WHERE "workspaceId" = NEW."workspaceId"
        AND "clientId" = NEW."clientId" AND "connectionId" = NEW."connectionId" AND "windowId" = NEW."windowId" AND "attemptId" = NEW."attemptId"
        AND id = NEW."parentLeafId" FOR SHARE;
      IF p.state IS DISTINCT FROM 'SPLIT' OR NEW."fromInclusive" < p."fromInclusive" OR NEW."toExclusive" > p."toExclusive" THEN
        RAISE EXCEPTION 'a child leaf lies inside its SPLIT parent';
      END IF;
      IF EXISTS (SELECT 1 FROM public."M365WindowLeaf" WHERE "workspaceId" = NEW."workspaceId" AND "clientId" = NEW."clientId"
                  AND "connectionId" = NEW."connectionId" AND "windowId" = NEW."windowId" AND "attemptId" = NEW."attemptId"
                  AND "parentLeafId" = NEW."parentLeafId" AND "fromInclusive" < NEW."toExclusive" AND "toExclusive" > NEW."fromInclusive") THEN
        RAISE EXCEPTION 'sibling leaves never overlap';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  BEGIN -- the attempt precedes the leaf in the lock order: never waited for here
    SELECT state INTO a FROM public."M365WindowAttempt" WHERE "workspaceId" = NEW."workspaceId" AND "clientId" = NEW."clientId"
       AND "connectionId" = NEW."connectionId" AND "windowId" = NEW."windowId" AND id = NEW."attemptId" FOR SHARE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION 'sign-in leaf: lock its attempt before the leaf; the attempt is being changed' USING ERRCODE = '55P03';
  END;
  IF a.state IS DISTINCT FROM 'RUNNING' THEN RAISE EXCEPTION 'leaves of a finished sign-in attempt are immutable'; END IF;
  IF ROW(NEW."workspaceId", NEW."clientId", NEW."connectionId", NEW."windowId", NEW."attemptId", NEW.id, NEW."parentLeafId", NEW."fromInclusive", NEW."toExclusive")
     IS DISTINCT FROM ROW(OLD."workspaceId", OLD."clientId", OLD."connectionId", OLD."windowId", OLD."attemptId", OLD.id, OLD."parentLeafId", OLD."fromInclusive", OLD."toExclusive") THEN
    RAISE EXCEPTION 'leaf identity and bounds are immutable';
  END IF;
  IF NEW.state <> OLD.state AND NOT ((OLD.state = 'PENDING' AND NEW.state IN ('RUNNING','FAILED','SPLIT'))
                                     OR (OLD.state = 'RUNNING' AND NEW.state IN ('COMPLETE','FAILED','SPLIT'))) THEN
    RAISE EXCEPTION 'leaf lifecycle allows PENDING -> RUNNING -> COMPLETE | FAILED | SPLIT only';
  END IF;
  IF OLD.state IN ('COMPLETE','FAILED','SPLIT') AND ROW(NEW."pagesRead", NEW."rowCount", NEW."safeErrorCode") IS DISTINCT FROM ROW(OLD."pagesRead", OLD."rowCount", OLD."safeErrorCode") THEN
    RAISE EXCEPTION 'a finished leaf is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "M365WindowLeaf_lifecycle" BEFORE INSERT OR UPDATE OR DELETE ON "M365WindowLeaf" FOR EACH ROW EXECUTE FUNCTION atlas_m365_window_leaf();

-- Memberships are written only into a running leaf of a running attempt, inside its bounds, and never changed; expiry alone
-- removes them. The attempt, then the leaf, stay locked in SHARE mode until the writer commits, so completing the leaf or
-- publishing the attempt waits for the membership and then counts it.
CREATE FUNCTION atlas_m365_window_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE l RECORD; a RECORD; e RECORD;
BEGIN
  IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'sign-in window membership is immutable'; END IF;
  IF TG_OP = 'DELETE' THEN
    SELECT "expiresAt" INTO a FROM public."M365WindowAttempt" WHERE "workspaceId" = OLD."workspaceId" AND "clientId" = OLD."clientId"
      AND "connectionId" = OLD."connectionId" AND "windowId" = OLD."windowId" AND id = OLD."attemptId";
    SELECT "expiresAt" INTO e FROM public."M365SignInEvidence" WHERE "workspaceId" = OLD."workspaceId" AND "clientId" = OLD."clientId"
      AND "connectionId" = OLD."connectionId" AND id = OLD."evidenceId";
    IF NOT COALESCE(a."expiresAt" <= now() OR e."expiresAt" <= now(), false) THEN RAISE EXCEPTION 'unexpired sign-in membership is retained'; END IF;
    RETURN OLD;
  END IF;
  SELECT state INTO a FROM public."M365WindowAttempt" WHERE "workspaceId" = NEW."workspaceId" AND "clientId" = NEW."clientId"
     AND "connectionId" = NEW."connectionId" AND "windowId" = NEW."windowId" AND id = NEW."attemptId" FOR SHARE;
  -- Every prerequisite (attempt, leaf, evidence) must already be visible: none is left to a later foreign-key check.
  IF NOT FOUND THEN RAISE EXCEPTION 'a membership needs its RUNNING attempt to exist first (committed or earlier in this transaction)'; END IF;
  SELECT state, "fromInclusive", "toExclusive" INTO l FROM public."M365WindowLeaf" WHERE "workspaceId" = NEW."workspaceId"
     AND "clientId" = NEW."clientId" AND "connectionId" = NEW."connectionId" AND "windowId" = NEW."windowId" AND "attemptId" = NEW."attemptId"
     AND id = NEW."leafId" FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'a membership needs its RUNNING leaf to exist first (committed or earlier in this transaction)'; END IF;
  IF l.state IS DISTINCT FROM 'RUNNING' OR a.state IS DISTINCT FROM 'RUNNING' THEN
    RAISE EXCEPTION 'membership is staged only into a running leaf of a running attempt';
  END IF;
  SELECT "occurredAt" INTO e FROM public."M365SignInEvidence" WHERE "workspaceId" = NEW."workspaceId" AND "clientId" = NEW."clientId"
    AND "connectionId" = NEW."connectionId" AND id = NEW."evidenceId";
  IF NOT FOUND THEN RAISE EXCEPTION 'a membership needs its evidence version to exist first (committed or earlier in this transaction)'; END IF;
  IF e."occurredAt" < l."fromInclusive" OR e."occurredAt" >= l."toExclusive" THEN
    RAISE EXCEPTION 'evidence lies outside its leaf [from, to)';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "M365WindowEvidence_immutable" BEFORE INSERT OR UPDATE OR DELETE ON "M365WindowEvidence" FOR EACH ROW EXECUTE FUNCTION atlas_m365_window_evidence();
