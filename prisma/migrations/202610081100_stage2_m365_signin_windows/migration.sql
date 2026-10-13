-- Stage 2 task 2.2, part 2 of 3 (docs/stage2/02_CONTRACTS.md §3, 03_CONNECTOR_SYNC.md §5): sign-in windows. Additive;
-- database-local objects only (grants in prisma/roles.sql). Sign-ins are separate evidence, not RawEvent rows.
--   * M365SyncRequest / M365SyncRootJob: the operator request (≤24h, ≤25 roots) with durable request-wide caps and the
--     per-root retry budget; no raw payload.
--   * M365SignInWindow: one canonical UTC hour per connection (rootFrom aligned, rootTo = rootFrom + 1h) with exactly one
--     published attempt pointer; only a COMPLETE attempt of this root may be published.
--   * M365WindowAttempt / M365WindowLeaf: immutable attempts with fixed bounds inside the root and a leaf partition that
--     COMPLETE requires to cover the bounds exactly (no gap, no overlap); publication is fenced by the newest started
--     sequence, the ACTIVE connection and its lifecycleVersion.
--   * M365SignInEvidence / M365WindowEvidence: immutable allowlisted DTO versions (same ID + hash deduplicates) and
--     attempt/leaf memberships that never change after publication. Rows are deleted only after expiry.

-- ---------------------------------------------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE "M365SyncRequest" (
    "workspaceId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "requestedFrom" TIMESTAMP(3) NOT NULL,
    "requestedTo" TIMESTAMP(3) NOT NULL,
    "retrievalFrom" TIMESTAMP(3),
    "retrievalTo" TIMESTAMP(3),
    "configVersion" TEXT NOT NULL,
    "rootCount" INTEGER NOT NULL,
    "totalLeaves" INTEGER NOT NULL DEFAULT 0,
    "totalStagedRows" INTEGER NOT NULL DEFAULT 0,
    "state" TEXT NOT NULL DEFAULT 'OPEN',
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "M365SyncRequest_pkey" PRIMARY KEY ("workspaceId","clientId","connectionId","id")
);
CREATE TABLE "M365SignInWindow" (
    "workspaceId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "rootFrom" TIMESTAMP(3) NOT NULL,
    "rootTo" TIMESTAMP(3) NOT NULL,
    "latestStartedSeq" INTEGER NOT NULL DEFAULT 0,
    "latestRecordedSeq" INTEGER NOT NULL DEFAULT 0,
    "latestPublishedSeq" INTEGER NOT NULL DEFAULT 0,
    "publishedAttemptId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "safeErrorCode" TEXT,
    "lastAttemptAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),

    CONSTRAINT "M365SignInWindow_pkey" PRIMARY KEY ("workspaceId","clientId","connectionId","id")
);
CREATE TABLE "M365SyncRootJob" (
    "workspaceId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "windowId" TEXT NOT NULL,
    "attemptsUsed" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL,
    "retryAt" TIMESTAMP(3),
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "safeErrorCode" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "M365SyncRootJob_pkey" PRIMARY KEY ("workspaceId","clientId","connectionId","requestId","windowId")
);
CREATE TABLE "M365WindowAttempt" (
    "workspaceId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "windowId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "rootFrom" TIMESTAMP(3) NOT NULL,
    "requestId" TEXT NOT NULL,
    "attemptSeq" INTEGER NOT NULL,
    "lifecycleVersion" INTEGER NOT NULL,
    "coveredFrom" TIMESTAMP(3) NOT NULL,
    "coveredTo" TIMESTAMP(3) NOT NULL,
    "configVersion" TEXT NOT NULL,
    "claimToken" UUID,
    "leaseExpiresAt" TIMESTAMP(3),
    "deadlineAt" TIMESTAMP(3) NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'RUNNING',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "safeErrorCode" TEXT,
    "evidenceCount" INTEGER NOT NULL DEFAULT 0,
    "leafCount" INTEGER NOT NULL DEFAULT 0,
    "stagedRows" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "M365WindowAttempt_pkey" PRIMARY KEY ("workspaceId","clientId","connectionId","windowId","id")
);
CREATE TABLE "M365WindowLeaf" (
    "workspaceId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "windowId" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "parentLeafId" TEXT,
    "fromInclusive" TIMESTAMP(3) NOT NULL,
    "toExclusive" TIMESTAMP(3) NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "pagesRead" INTEGER NOT NULL DEFAULT 0,
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "safeErrorCode" TEXT,

    CONSTRAINT "M365WindowLeaf_pkey" PRIMARY KEY ("workspaceId","clientId","connectionId","windowId","attemptId","id")
);
CREATE TABLE "M365SignInEvidence" (
    "workspaceId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "dtoVersion" TEXT NOT NULL DEFAULT 'm365-signin-v1',
    "dto" JSONB NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT,
    "deviceId" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "M365SignInEvidence_pkey" PRIMARY KEY ("workspaceId","clientId","connectionId","id")
);
CREATE TABLE "M365WindowEvidence" (
    "workspaceId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "windowId" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "leafId" TEXT NOT NULL,
    "evidenceId" TEXT NOT NULL,

    CONSTRAINT "M365WindowEvidence_pkey" PRIMARY KEY ("workspaceId","clientId","connectionId","windowId","attemptId","evidenceId")
);

CREATE UNIQUE INDEX "M365SignInWindow_rootFrom_key" ON "M365SignInWindow"("workspaceId", "clientId", "connectionId", "rootFrom");
CREATE UNIQUE INDEX "M365SignInWindow_root_key" ON "M365SignInWindow"("workspaceId", "clientId", "connectionId", "id", "rootFrom");
CREATE INDEX "M365SyncRootJob_window_idx" ON "M365SyncRootJob"("workspaceId", "clientId", "connectionId", "windowId");
CREATE UNIQUE INDEX "M365WindowAttempt_seq_key" ON "M365WindowAttempt"("workspaceId", "clientId", "connectionId", "windowId", "attemptSeq");
CREATE INDEX "M365WindowAttempt_rootJob_idx" ON "M365WindowAttempt"("workspaceId", "clientId", "connectionId", "requestId", "windowId");
CREATE INDEX "M365WindowLeaf_parent_idx" ON "M365WindowLeaf"("workspaceId", "clientId", "connectionId", "windowId", "attemptId", "parentLeafId");
CREATE UNIQUE INDEX "M365SignInEvidence_version_key" ON "M365SignInEvidence"("workspaceId", "clientId", "connectionId", "sourceId", "contentHash");
CREATE INDEX "M365SignInEvidence_occurredAt_idx" ON "M365SignInEvidence"("workspaceId", "clientId", "connectionId", "occurredAt");
CREATE INDEX "M365SignInEvidence_deviceId_idx" ON "M365SignInEvidence"("workspaceId", "clientId", "connectionId", "deviceId");
CREATE INDEX "M365SignInEvidence_userId_idx" ON "M365SignInEvidence"("workspaceId", "clientId", "connectionId", "userId");
CREATE INDEX "M365WindowEvidence_leaf_idx" ON "M365WindowEvidence"("workspaceId", "clientId", "connectionId", "windowId", "attemptId", "leafId");
CREATE INDEX "M365WindowEvidence_evidence_idx" ON "M365WindowEvidence"("workspaceId", "clientId", "connectionId", "evidenceId");

-- ---------------------------------------------------------------------------------------------------------------
-- 2. Composite foreign keys: every reference carries workspace, client and connection
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE "M365SyncRequest" ADD CONSTRAINT "M365SyncRequest_connection_fkey"
  FOREIGN KEY ("workspaceId", "clientId", "connectionId") REFERENCES "Connection"("workspaceId", "clientId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "M365SignInWindow" ADD CONSTRAINT "M365SignInWindow_connection_fkey"
  FOREIGN KEY ("workspaceId", "clientId", "connectionId") REFERENCES "Connection"("workspaceId", "clientId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "M365SignInWindow" ADD CONSTRAINT "M365SignInWindow_publishedAttempt_fkey"
  FOREIGN KEY ("workspaceId", "clientId", "connectionId", "id", "publishedAttemptId")
  REFERENCES "M365WindowAttempt"("workspaceId", "clientId", "connectionId", "windowId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "M365SyncRootJob" ADD CONSTRAINT "M365SyncRootJob_request_fkey"
  FOREIGN KEY ("workspaceId", "clientId", "connectionId", "requestId") REFERENCES "M365SyncRequest"("workspaceId", "clientId", "connectionId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "M365SyncRootJob" ADD CONSTRAINT "M365SyncRootJob_window_fkey"
  FOREIGN KEY ("workspaceId", "clientId", "connectionId", "windowId") REFERENCES "M365SignInWindow"("workspaceId", "clientId", "connectionId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
-- The attempt names its root and the root's start, so its fixed bounds are checked against the root without a lookup.
ALTER TABLE "M365WindowAttempt" ADD CONSTRAINT "M365WindowAttempt_window_fkey"
  FOREIGN KEY ("workspaceId", "clientId", "connectionId", "windowId", "rootFrom")
  REFERENCES "M365SignInWindow"("workspaceId", "clientId", "connectionId", "id", "rootFrom") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "M365WindowAttempt" ADD CONSTRAINT "M365WindowAttempt_rootJob_fkey"
  FOREIGN KEY ("workspaceId", "clientId", "connectionId", "requestId", "windowId")
  REFERENCES "M365SyncRootJob"("workspaceId", "clientId", "connectionId", "requestId", "windowId") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "M365WindowLeaf" ADD CONSTRAINT "M365WindowLeaf_attempt_fkey"
  FOREIGN KEY ("workspaceId", "clientId", "connectionId", "windowId", "attemptId")
  REFERENCES "M365WindowAttempt"("workspaceId", "clientId", "connectionId", "windowId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
-- Parent within the same attempt. NO ACTION (checked at statement end) lets expiry delete a whole attempt tree at once.
ALTER TABLE "M365WindowLeaf" ADD CONSTRAINT "M365WindowLeaf_parent_fkey"
  FOREIGN KEY ("workspaceId", "clientId", "connectionId", "windowId", "attemptId", "parentLeafId")
  REFERENCES "M365WindowLeaf"("workspaceId", "clientId", "connectionId", "windowId", "attemptId", "id") ON DELETE NO ACTION ON UPDATE RESTRICT;
ALTER TABLE "M365SignInEvidence" ADD CONSTRAINT "M365SignInEvidence_connection_fkey"
  FOREIGN KEY ("workspaceId", "clientId", "connectionId") REFERENCES "Connection"("workspaceId", "clientId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "M365WindowEvidence" ADD CONSTRAINT "M365WindowEvidence_leaf_fkey"
  FOREIGN KEY ("workspaceId", "clientId", "connectionId", "windowId", "attemptId", "leafId")
  REFERENCES "M365WindowLeaf"("workspaceId", "clientId", "connectionId", "windowId", "attemptId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "M365WindowEvidence" ADD CONSTRAINT "M365WindowEvidence_evidence_fkey"
  FOREIGN KEY ("workspaceId", "clientId", "connectionId", "evidenceId")
  REFERENCES "M365SignInEvidence"("workspaceId", "clientId", "connectionId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ---------------------------------------------------------------------------------------------------------------
-- 3. Row constraints
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE "M365SyncRequest" ADD CONSTRAINT "M365SyncRequest_interval_check"
  CHECK ("requestedFrom" < "requestedTo" AND "requestedTo" <= "requestedFrom" + interval '24 hours'
         AND ("retrievalFrom" IS NULL) = ("retrievalTo" IS NULL) AND ("retrievalFrom" IS NULL OR "retrievalFrom" < "retrievalTo"));
ALTER TABLE "M365SyncRequest" ADD CONSTRAINT "M365SyncRequest_caps_check"
  CHECK ("rootCount" BETWEEN 1 AND 25 AND "totalLeaves" BETWEEN 0 AND 1500 AND "totalStagedRows" BETWEEN 0 AND 250000);
ALTER TABLE "M365SyncRequest" ADD CONSTRAINT "M365SyncRequest_state_check"
  CHECK (state IN ('OPEN','COMPLETE','PARTIAL','FAILED') AND (state = 'OPEN') = ("finishedAt" IS NULL));
ALTER TABLE "M365SyncRequest" ADD CONSTRAINT "M365SyncRequest_identity_check"
  CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$' AND "configVersion" ~ '^[a-z0-9][a-z0-9._-]{0,63}$'
         AND "createdBy" ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$');

ALTER TABLE "M365SignInWindow" ADD CONSTRAINT "M365SignInWindow_root_check"
  CHECK ("rootFrom" = date_trunc('hour', "rootFrom") AND "rootTo" = "rootFrom" + interval '1 hour');
ALTER TABLE "M365SignInWindow" ADD CONSTRAINT "M365SignInWindow_status_check" CHECK (status IN ('PENDING','OK','ERROR','MISSING'));
ALTER TABLE "M365SignInWindow" ADD CONSTRAINT "M365SignInWindow_seq_check"
  CHECK ("latestPublishedSeq" >= 0 AND "latestPublishedSeq" <= "latestRecordedSeq" AND "latestRecordedSeq" <= "latestStartedSeq");
ALTER TABLE "M365SignInWindow" ADD CONSTRAINT "M365SignInWindow_code_check"
  CHECK ((status IN ('PENDING','OK')) = ("safeErrorCode" IS NULL) AND ("safeErrorCode" IS NULL OR "safeErrorCode" ~ '^[A-Z][A-Z0-9_]{0,63}$'));
ALTER TABLE "M365SignInWindow" ADD CONSTRAINT "M365SignInWindow_pointer_check"
  CHECK (("publishedAttemptId" IS NULL OR ("latestPublishedSeq" > 0 AND status IN ('OK','ERROR')))
         AND (status <> 'OK' OR "publishedAttemptId" IS NOT NULL)
         AND (status <> 'PENDING' OR ("latestRecordedSeq" = 0 AND "lastSuccessAt" IS NULL)));
ALTER TABLE "M365SignInWindow" ADD CONSTRAINT "M365SignInWindow_time_check"
  CHECK ("lastSuccessAt" IS NULL OR ("lastAttemptAt" IS NOT NULL AND "lastSuccessAt" <= "lastAttemptAt"));

ALTER TABLE "M365SyncRootJob" ADD CONSTRAINT "M365SyncRootJob_state_check"
  CHECK (state IN ('PENDING','RUNNING','RETRY','COMPLETE','FAILED') AND (state = 'RETRY') = ("retryAt" IS NOT NULL)
         AND (state IN ('RETRY','FAILED')) = ("safeErrorCode" IS NOT NULL)
         AND ("safeErrorCode" IS NULL OR "safeErrorCode" ~ '^[A-Z][A-Z0-9_]{0,63}$'));
ALTER TABLE "M365SyncRootJob" ADD CONSTRAINT "M365SyncRootJob_budget_check"
  CHECK ("maxAttempts" BETWEEN 1 AND 10 AND "attemptsUsed" BETWEEN 0 AND "maxAttempts");

ALTER TABLE "M365WindowAttempt" ADD CONSTRAINT "M365WindowAttempt_bounds_check"
  CHECK ("coveredFrom" < "coveredTo" AND "coveredFrom" >= "rootFrom" AND "coveredTo" <= "rootFrom" + interval '1 hour'
         AND "deadlineAt" > "startedAt" AND "deadlineAt" <= "startedAt" + interval '10 minutes');
ALTER TABLE "M365WindowAttempt" ADD CONSTRAINT "M365WindowAttempt_identity_check"
  CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$' AND "attemptSeq" >= 1 AND "lifecycleVersion" >= 0
         AND "configVersion" ~ '^[a-z0-9][a-z0-9._-]{0,63}$');
ALTER TABLE "M365WindowAttempt" ADD CONSTRAINT "M365WindowAttempt_state_check" CHECK (state IN ('RUNNING','COMPLETE','FAILED','SUPERSEDED'));
ALTER TABLE "M365WindowAttempt" ADD CONSTRAINT "M365WindowAttempt_claim_check"
  CHECK (("claimToken" IS NULL) = ("leaseExpiresAt" IS NULL) AND (state = 'RUNNING') = ("claimToken" IS NOT NULL));
-- COMPLETE exists only through publication; a failure says why; a published (later superseded) attempt keeps publishedAt.
ALTER TABLE "M365WindowAttempt" ADD CONSTRAINT "M365WindowAttempt_outcome_check"
  CHECK ((state = 'RUNNING') = ("completedAt" IS NULL) AND (state = 'FAILED') = ("safeErrorCode" IS NOT NULL)
         AND (state <> 'COMPLETE' OR "publishedAt" IS NOT NULL) AND ("publishedAt" IS NULL OR state IN ('COMPLETE','SUPERSEDED'))
         AND ("completedAt" IS NULL OR "completedAt" >= "startedAt")
         AND ("safeErrorCode" IS NULL OR "safeErrorCode" ~ '^[A-Z][A-Z0-9_]{0,63}$'));
ALTER TABLE "M365WindowAttempt" ADD CONSTRAINT "M365WindowAttempt_caps_check"
  CHECK ("leafCount" BETWEEN 0 AND 60 AND "stagedRows" BETWEEN 0 AND 100000 AND "evidenceCount" BETWEEN 0 AND "stagedRows");
-- Retention bound fixed by the row: unpublished 24h from start; published until its covered interval expires (7 days).
ALTER TABLE "M365WindowAttempt" ADD CONSTRAINT "M365WindowAttempt_retention_check"
  CHECK ("expiresAt" > "startedAt" AND "expiresAt" <= CASE WHEN "publishedAt" IS NULL THEN "startedAt" + interval '24 hours'
                                                          ELSE "coveredTo" + interval '7 days' END);

ALTER TABLE "M365WindowLeaf" ADD CONSTRAINT "M365WindowLeaf_bounds_check"
  CHECK ("fromInclusive" < "toExclusive" AND ("parentLeafId" IS NULL OR ("parentLeafId" <> id AND "toExclusive" - "fromInclusive" >= interval '1 minute')));
ALTER TABLE "M365WindowLeaf" ADD CONSTRAINT "M365WindowLeaf_state_check"
  CHECK (state IN ('PENDING','RUNNING','COMPLETE','FAILED','SPLIT') AND (state = 'FAILED') = ("safeErrorCode" IS NOT NULL)
         AND ("safeErrorCode" IS NULL OR "safeErrorCode" ~ '^[A-Z][A-Z0-9_]{0,63}$'));
ALTER TABLE "M365WindowLeaf" ADD CONSTRAINT "M365WindowLeaf_caps_check"
  CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$' AND "pagesRead" BETWEEN 0 AND 20 AND "rowCount" BETWEEN 0 AND 10000);
CREATE UNIQUE INDEX "M365WindowLeaf_one_root" ON "M365WindowLeaf"("workspaceId", "clientId", "connectionId", "windowId", "attemptId") WHERE "parentLeafId" IS NULL;

-- Allowlisted M365SignInV1 (connectors/microsoft365/signin-dto.ts); no IP, location, names, UPN, risk or free text. Every
-- key present (optional values as explicit JSON null); TRUE only, so `{}` or an incomplete shape never passes as SQL NULL.
-- Aggregate byte cap over every parser output (jsonb text, raw UTF-8): the opaque id is <= 256 UTF-16 units without
-- controls or lone surrogates, so at most 3 bytes per unit (an escaped `"`/`\` 2). Largest DTO: braces 2 + separators 6*2
-- + keys (58 chars + 7*4) 86 + id 256*3+2 + createdDateTime (7 fraction digits) 30 + three GUIDs 3*38 + errorCode
-- 9007199254740991 16 + isInteractive false 5 = 1035 bytes. 2048 leaves margin; it also bounds the only fields without
-- their own length check here (createdDateTime string, errorCode number).
CREATE FUNCTION atlas_m365_signin_dto(dto JSONB) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(jsonb_typeof(dto) = 'object' AND octet_length(dto::text) <= 2048
    AND (SELECT array_agg(k ORDER BY k COLLATE "C") FROM jsonb_object_keys(dto) k)
        = ARRAY['appId','createdDateTime','deviceId','errorCode','id','isInteractive','userId']
    AND jsonb_typeof(dto->'id') = 'string' AND char_length(dto->>'id') BETWEEN 1 AND 256
    AND jsonb_typeof(dto->'createdDateTime') = 'string' AND jsonb_typeof(dto->'isInteractive') IN ('boolean','null')
    AND jsonb_typeof(dto->'errorCode') IN ('number','null')
    AND (SELECT bool_and(jsonb_typeof(dto->f) = 'null' OR (jsonb_typeof(dto->f) = 'string'
           AND (dto->>f) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')) FROM unnest(ARRAY['userId','deviceId','appId']) f), false)
$$;
ALTER TABLE "M365SignInEvidence" ADD CONSTRAINT "M365SignInEvidence_dto_check"
  CHECK (("dtoVersion" = 'm365-signin-v1' AND "contentHash" ~ '^[0-9a-f]{64}$' AND char_length("sourceId") BETWEEN 1 AND 256
          AND id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$' AND atlas_m365_signin_dto(dto) AND dto->>'id' = "sourceId"
          AND "userId" IS NOT DISTINCT FROM dto->>'userId' AND "deviceId" IS NOT DISTINCT FROM dto->>'deviceId') IS TRUE);
ALTER TABLE "M365SignInEvidence" ADD CONSTRAINT "M365SignInEvidence_retention_check"
  CHECK ("firstSeenAt" <= "lastSeenAt" AND "expiresAt" <= "occurredAt" + interval '7 days');

-- ---------------------------------------------------------------------------------------------------------------
-- 4. Ordering, immutability and retention of requests, root jobs and evidence (triggers apply to every role, including the
--    owner). Window, attempt, leaf and membership triggers with the publication fence: 202610081150_stage2_m365_signin_triggers.
-- ---------------------------------------------------------------------------------------------------------------
CREATE FUNCTION atlas_m365_sync_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."workspaceId", NEW."clientId", NEW."connectionId", NEW.id, NEW."requestedFrom", NEW."requestedTo", NEW."retrievalFrom",
         NEW."retrievalTo", NEW."configVersion", NEW."rootCount", NEW."createdBy", NEW."createdAt")
     IS DISTINCT FROM ROW(OLD."workspaceId", OLD."clientId", OLD."connectionId", OLD.id, OLD."requestedFrom", OLD."requestedTo", OLD."retrievalFrom",
         OLD."retrievalTo", OLD."configVersion", OLD."rootCount", OLD."createdBy", OLD."createdAt") THEN
    RAISE EXCEPTION 'M365SyncRequest bounds are fixed at creation';
  END IF;
  IF NEW."totalLeaves" < OLD."totalLeaves" OR NEW."totalStagedRows" < OLD."totalStagedRows" THEN
    RAISE EXCEPTION 'request-wide caps are consumed, never refunded';
  END IF;
  IF OLD.state <> 'OPEN' AND ROW(NEW.state, NEW."finishedAt") IS DISTINCT FROM ROW(OLD.state, OLD."finishedAt") THEN
    RAISE EXCEPTION 'a finished sync request keeps its outcome';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "M365SyncRequest_fixed" BEFORE UPDATE ON "M365SyncRequest" FOR EACH ROW EXECUTE FUNCTION atlas_m365_sync_request();

-- The retry budget only grows, except an explicit requeue of a FAILED root job back to PENDING with a fresh budget.
CREATE FUNCTION atlas_m365_root_job() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."workspaceId", NEW."clientId", NEW."connectionId", NEW."requestId", NEW."windowId", NEW."maxAttempts")
     IS DISTINCT FROM ROW(OLD."workspaceId", OLD."clientId", OLD."connectionId", OLD."requestId", OLD."windowId", OLD."maxAttempts") THEN
    RAISE EXCEPTION 'M365SyncRootJob identity and budget size are immutable';
  END IF;
  IF NEW."attemptsUsed" < OLD."attemptsUsed" AND NOT (OLD.state = 'FAILED' AND NEW.state = 'PENDING' AND NEW."attemptsUsed" = 0) THEN
    RAISE EXCEPTION 'root job attempts are consumed; only an explicit requeue resets the budget';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "M365SyncRootJob_budget" BEFORE UPDATE ON "M365SyncRootJob" FOR EACH ROW EXECUTE FUNCTION atlas_m365_root_job();

-- Evidence versions: DTO, hash and source identity never change; lastSeenAt only increases; expiry is never extended.
CREATE FUNCTION atlas_m365_signin_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."expiresAt" > now() THEN RAISE EXCEPTION 'sign-in evidence is retained until its expiresAt'; END IF;
    RETURN OLD;
  END IF;
  IF ROW(NEW."workspaceId", NEW."clientId", NEW."connectionId", NEW.id, NEW."sourceId", NEW."contentHash", NEW."dtoVersion", NEW.dto,
         NEW."occurredAt", NEW."userId", NEW."deviceId", NEW."firstSeenAt")
     IS DISTINCT FROM ROW(OLD."workspaceId", OLD."clientId", OLD."connectionId", OLD.id, OLD."sourceId", OLD."contentHash", OLD."dtoVersion", OLD.dto,
         OLD."occurredAt", OLD."userId", OLD."deviceId", OLD."firstSeenAt") THEN
    RAISE EXCEPTION 'sign-in evidence is immutable: changed content is a new version';
  END IF;
  IF NEW."lastSeenAt" < OLD."lastSeenAt" OR NEW."expiresAt" > OLD."expiresAt" THEN
    RAISE EXCEPTION 'lastSeenAt only increases and expiresAt is never extended';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "M365SignInEvidence_immutable" BEFORE UPDATE OR DELETE ON "M365SignInEvidence" FOR EACH ROW EXECUTE FUNCTION atlas_m365_signin_evidence();

CREATE TRIGGER "M365WindowAttempt_no_truncate" BEFORE TRUNCATE ON "M365WindowAttempt" FOR EACH STATEMENT EXECUTE FUNCTION atlas_m365_reject_truncate();
CREATE TRIGGER "M365WindowLeaf_no_truncate" BEFORE TRUNCATE ON "M365WindowLeaf" FOR EACH STATEMENT EXECUTE FUNCTION atlas_m365_reject_truncate();
CREATE TRIGGER "M365SignInEvidence_no_truncate" BEFORE TRUNCATE ON "M365SignInEvidence" FOR EACH STATEMENT EXECUTE FUNCTION atlas_m365_reject_truncate();
CREATE TRIGGER "M365WindowEvidence_no_truncate" BEFORE TRUNCATE ON "M365WindowEvidence" FOR EACH STATEMENT EXECUTE FUNCTION atlas_m365_reject_truncate();

-- ---------------------------------------------------------------------------------------------------------------
-- 5. Row-level security
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE "M365SyncRequest" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "M365SyncRequest_scope" ON "M365SyncRequest" FOR ALL
  USING ("workspaceId" = atlas_app_workspace() AND "clientId" = ANY(atlas_app_clients()))
  WITH CHECK ("workspaceId" = atlas_app_workspace() AND "clientId" = ANY(atlas_app_clients()));
ALTER TABLE "M365SignInWindow" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "M365SignInWindow_scope" ON "M365SignInWindow" FOR ALL
  USING ("workspaceId" = atlas_app_workspace() AND "clientId" = ANY(atlas_app_clients()))
  WITH CHECK ("workspaceId" = atlas_app_workspace() AND "clientId" = ANY(atlas_app_clients()));
ALTER TABLE "M365SyncRootJob" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "M365SyncRootJob_scope" ON "M365SyncRootJob" FOR ALL
  USING ("workspaceId" = atlas_app_workspace() AND "clientId" = ANY(atlas_app_clients()))
  WITH CHECK ("workspaceId" = atlas_app_workspace() AND "clientId" = ANY(atlas_app_clients()));
ALTER TABLE "M365WindowAttempt" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "M365WindowAttempt_scope" ON "M365WindowAttempt" FOR ALL
  USING ("workspaceId" = atlas_app_workspace() AND "clientId" = ANY(atlas_app_clients()))
  WITH CHECK ("workspaceId" = atlas_app_workspace() AND "clientId" = ANY(atlas_app_clients()));
ALTER TABLE "M365WindowLeaf" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "M365WindowLeaf_scope" ON "M365WindowLeaf" FOR ALL
  USING ("workspaceId" = atlas_app_workspace() AND "clientId" = ANY(atlas_app_clients()))
  WITH CHECK ("workspaceId" = atlas_app_workspace() AND "clientId" = ANY(atlas_app_clients()));
ALTER TABLE "M365SignInEvidence" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "M365SignInEvidence_scope" ON "M365SignInEvidence" FOR ALL
  USING ("workspaceId" = atlas_app_workspace() AND "clientId" = ANY(atlas_app_clients()))
  WITH CHECK ("workspaceId" = atlas_app_workspace() AND "clientId" = ANY(atlas_app_clients()));
ALTER TABLE "M365WindowEvidence" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "M365WindowEvidence_scope" ON "M365WindowEvidence" FOR ALL
  USING ("workspaceId" = atlas_app_workspace() AND "clientId" = ANY(atlas_app_clients()))
  WITH CHECK ("workspaceId" = atlas_app_workspace() AND "clientId" = ANY(atlas_app_clients()));
