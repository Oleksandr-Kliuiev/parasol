-- Stage 3 S3-A (docs/stage3/03_DATA_AND_CONCURRENCY.md): governed action tables. Additive. The approved later-stage
-- columns and invariants are defined now; S3-A services only create requests. Runtime grants (prisma/roles.sql) expose
-- SELECT on every table and INSERT on ActionRequest only; approvals, attempts, verifications and synthetic tickets stay
-- inaccessible to the runtime until their reviewed checkpoint. All rows carry workspace/client scope, ENABLE + FORCE RLS.
-- History is never deleted or truncated (any role); identity, intent, epoch, nonce and synthetic content are immutable
-- by trigger for every role, including the owner.

-- Signed token identity: a token row names exactly one actor of one workspace (scoped composite foreign keys below).
CREATE UNIQUE INDEX "ApiToken_actor_token_key" ON "ApiToken"("workspaceId", "actorId", "id");

-- ---------------------------------------------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE "ActionRequest" (
    "workspaceId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "id" UUID NOT NULL,
    "connectionId" TEXT NOT NULL,
    "requesterActorId" TEXT NOT NULL,
    "requesterTokenId" TEXT NOT NULL,
    "requesterTokenExpiresAt" TIMESTAMP(3),
    "idempotencyKey" UUID NOT NULL,
    "intentHash" TEXT NOT NULL,
    "dtoVersion" TEXT NOT NULL,
    "actionType" TEXT NOT NULL,
    "actionVersion" TEXT NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "portVersion" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "connectionSystem" TEXT NOT NULL,
    "customerKey" TEXT NOT NULL,
    "connectionLifecycleVersion" INTEGER NOT NULL,
    "secretRefDigest" TEXT NOT NULL,
    "authorityEpoch" INTEGER NOT NULL,
    "markedTitle" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "marker" TEXT NOT NULL,
    "canonicalInput" JSONB NOT NULL,
    "inputHash" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'AWAITING_APPROVAL',
    "safeErrorCode" TEXT,
    "resultTicketId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "terminalAt" TIMESTAMP(3),

    CONSTRAINT "ActionRequest_pkey" PRIMARY KEY ("workspaceId", "clientId", "id")
);
CREATE TABLE "ActionApproval" (
    "workspaceId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "id" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "requesterActorId" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "authorityEpoch" INTEGER NOT NULL,
    "actionVersion" TEXT NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "portVersion" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "signerActorId" TEXT NOT NULL,
    "signerTokenId" TEXT NOT NULL,
    "approverTokenExpiresAt" TIMESTAMP(3),
    "decision" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL,
    "approvedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "consumedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "safeErrorCode" TEXT,

    CONSTRAINT "ActionApproval_pkey" PRIMARY KEY ("workspaceId", "clientId", "id")
);
CREATE TABLE "ActionAttempt" (
    "workspaceId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "id" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "approvalId" UUID NOT NULL,
    "attemptToken" UUID NOT NULL,
    "createNonce" UUID NOT NULL,
    "reservedAt" TIMESTAMP(3) NOT NULL,
    "startDeadlineAt" TIMESTAMP(3) NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'RESERVED',
    "originalTicketId" TEXT,
    "verifiedTicketId" TEXT,
    "safeErrorCode" TEXT,
    "outcomeAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verificationCount" INTEGER NOT NULL DEFAULT 0,
    "verificationSeq" INTEGER NOT NULL DEFAULT 0,
    "verificationState" TEXT NOT NULL DEFAULT 'IDLE',
    "activeVerificationToken" UUID,
    "activeVerificationOrdinal" INTEGER,
    "activeStartedAt" TIMESTAMP(3),
    "activeDeadlineAt" TIMESTAMP(3),
    "activeCandidateId" TEXT,

    CONSTRAINT "ActionAttempt_pkey" PRIMARY KEY ("workspaceId", "clientId", "id")
);
CREATE TABLE "ActionVerification" (
    "workspaceId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "attemptId" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "targetKind" TEXT NOT NULL,
    "nonce" UUID NOT NULL,
    "targetTicketId" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "createNonce" UUID NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "deadlineAt" TIMESTAMP(3) NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'ACTIVE',
    "completedAt" TIMESTAMP(3),
    "safeErrorCode" TEXT,

    CONSTRAINT "ActionVerification_pkey" PRIMARY KEY ("workspaceId", "clientId", "attemptId", "ordinal")
);
CREATE TABLE "ActionMockTicket" (
    "workspaceId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "id" UUID NOT NULL,
    "synthetic" TEXT NOT NULL DEFAULT 'S3_SYNTHETIC',
    "customerKey" TEXT NOT NULL,
    "markedTitle" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActionMockTicket_pkey" PRIMARY KEY ("workspaceId", "clientId", "connectionId", "id")
);

-- ---------------------------------------------------------------------------------------------------------------
-- 2. Keys and scoped foreign keys (every link carries workspace and client; signer identities carry workspace+actor)
-- ---------------------------------------------------------------------------------------------------------------
CREATE UNIQUE INDEX "ActionRequest_idempotency_key" ON "ActionRequest"("workspaceId", "clientId", "requesterActorId", "idempotencyKey");
CREATE UNIQUE INDEX "ActionRequest_binding_key" ON "ActionRequest"("workspaceId", "clientId", "id", "requesterActorId", "inputHash", "authorityEpoch");
CREATE INDEX "ActionRequest_list_idx" ON "ActionRequest"("workspaceId", "clientId", "createdAt", "id");
CREATE UNIQUE INDEX "ActionApproval_request_key" ON "ActionApproval"("workspaceId", "clientId", "requestId");
CREATE UNIQUE INDEX "ActionApproval_attempt_key" ON "ActionApproval"("workspaceId", "clientId", "id", "requestId");
CREATE UNIQUE INDEX "ActionAttempt_request_key" ON "ActionAttempt"("workspaceId", "clientId", "requestId");
CREATE UNIQUE INDEX "ActionAttempt_approval_key" ON "ActionAttempt"("workspaceId", "clientId", "approvalId");
CREATE UNIQUE INDEX "ActionAttempt_nonce_key" ON "ActionAttempt"("workspaceId", "clientId", "id", "createNonce");
CREATE UNIQUE INDEX "ActionVerification_one_active" ON "ActionVerification"("workspaceId", "clientId", "attemptId") WHERE "state" = 'ACTIVE';

ALTER TABLE "ActionRequest" ADD CONSTRAINT "ActionRequest_connection_fkey" FOREIGN KEY ("workspaceId", "clientId", "connectionId")
  REFERENCES "Connection"("workspaceId", "clientId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ActionRequest" ADD CONSTRAINT "ActionRequest_requesterToken_fkey" FOREIGN KEY ("workspaceId", "requesterActorId", "requesterTokenId")
  REFERENCES "ApiToken"("workspaceId", "actorId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ActionApproval" ADD CONSTRAINT "ActionApproval_request_fkey"
  FOREIGN KEY ("workspaceId", "clientId", "requestId", "requesterActorId", "requestHash", "authorityEpoch")
  REFERENCES "ActionRequest"("workspaceId", "clientId", "id", "requesterActorId", "inputHash", "authorityEpoch") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ActionApproval" ADD CONSTRAINT "ActionApproval_signerToken_fkey" FOREIGN KEY ("workspaceId", "signerActorId", "signerTokenId")
  REFERENCES "ApiToken"("workspaceId", "actorId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ActionAttempt" ADD CONSTRAINT "ActionAttempt_request_fkey" FOREIGN KEY ("workspaceId", "clientId", "requestId")
  REFERENCES "ActionRequest"("workspaceId", "clientId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ActionAttempt" ADD CONSTRAINT "ActionAttempt_approval_fkey" FOREIGN KEY ("workspaceId", "clientId", "approvalId", "requestId")
  REFERENCES "ActionApproval"("workspaceId", "clientId", "id", "requestId") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ActionVerification" ADD CONSTRAINT "ActionVerification_attempt_fkey" FOREIGN KEY ("workspaceId", "clientId", "attemptId", "createNonce")
  REFERENCES "ActionAttempt"("workspaceId", "clientId", "id", "createNonce") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ActionMockTicket" ADD CONSTRAINT "ActionMockTicket_connection_fkey" FOREIGN KEY ("workspaceId", "clientId", "connectionId")
  REFERENCES "Connection"("workspaceId", "clientId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ---------------------------------------------------------------------------------------------------------------
-- 3. CHECKs: fixed vocabularies, bounded content, exact marker, digests only, consistent lifecycle columns
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE "ActionRequest" ADD CONSTRAINT "ActionRequest_contract_check" CHECK (
  "dtoVersion" = 'atlas-action-request/1' AND "actionType" = 'atera.create_ticket' AND "mode" = 'MOCK' AND "connectionSystem" = 'atera'
  AND "intentHash" ~ '^[0-9a-f]{64}$' AND "inputHash" ~ '^[0-9a-f]{64}$' AND "secretRefDigest" ~ '^[0-9a-f]{64}$'
  AND "authorityEpoch" >= 0 AND "connectionLifecycleVersion" >= 0
  AND "actionVersion" ~ '^[a-z0-9][a-z0-9./-]{0,63}$' AND "policyVersion" ~ '^[a-z0-9][a-z0-9./-]{0,63}$' AND "portVersion" ~ '^[a-z0-9][a-z0-9./-]{0,63}$'
  AND char_length("customerKey") BETWEEN 1 AND 200);
ALTER TABLE "ActionRequest" ADD CONSTRAINT "ActionRequest_content_check" CHECK (
  "marker" = '[Atlas:' || "id"::text || ']'
  AND char_length("markedTitle") <= 240 AND char_length("markedTitle") > char_length("marker") + 1
  AND right("markedTitle", char_length("marker") + 1) = ' ' || "marker"
  AND char_length("description") BETWEEN 1 AND 2000);
-- The stored canonical input names the same request, scope, signer, binding, epoch, versions and content as the columns.
ALTER TABLE "ActionRequest" ADD CONSTRAINT "ActionRequest_canonical_check" CHECK (
  jsonb_typeof("canonicalInput") = 'object' AND "canonicalInput" @> jsonb_build_object(
    'dto', "dtoVersion", 'requestId', "id"::text, 'workspaceId', "workspaceId", 'clientId', "clientId", 'connectionId', "connectionId",
    'requesterActorId', "requesterActorId", 'requesterTokenId', "requesterTokenId", 'actionType', "actionType", 'actionVersion', "actionVersion",
    'policyVersion', "policyVersion", 'portVersion', "portVersion", 'mode', "mode", 'connectionSystem', "connectionSystem",
    'customerKey', "customerKey", 'lifecycleVersion', "connectionLifecycleVersion", 'secretRefDigest', "secretRefDigest",
    'authorityEpoch', "authorityEpoch", 'title', "markedTitle", 'description', "description"));
ALTER TABLE "ActionRequest" ADD CONSTRAINT "ActionRequest_state_check" CHECK (
  "state" IN ('AWAITING_APPROVAL','APPROVED','REJECTED','CANCELLED','REVOKED','INVALIDATED','EXPIRED','DISPATCH_RESERVED',
              'NOT_DISPATCHED','OUTCOME_UNKNOWN','CREATED_UNVERIFIED','VERIFICATION_MISMATCH','VERIFIED')
  AND ("state" = 'VERIFIED') = ("resultTicketId" IS NOT NULL)
  AND ("resultTicketId" IS NULL OR "resultTicketId" ~ '^[A-Za-z0-9._:-]{1,128}$')
  AND ("safeErrorCode" IS NULL OR "safeErrorCode" ~ '^[A-Z][A-Z0-9_]{0,63}$'));

ALTER TABLE "ActionApproval" ADD CONSTRAINT "ActionApproval_contract_check" CHECK (
  "signerActorId" <> "requesterActorId" AND "mode" = 'MOCK' AND "requestHash" ~ '^[0-9a-f]{64}$' AND "authorityEpoch" >= 0
  AND "decision" IN ('APPROVED','REJECTED','REVOKED','CONSUMED')
  AND ("safeErrorCode" IS NULL OR "safeErrorCode" ~ '^[A-Z][A-Z0-9_]{0,63}$'));
-- Approval lifetime: 15 minutes from the decision, never beyond the approver's token expiry (the requester's cap is
-- applied by the approval service from the immutable request snapshot). A rejection carries no lifetime.
ALTER TABLE "ActionApproval" ADD CONSTRAINT "ActionApproval_lifetime_check" CHECK (coalesce(
  ("approvedAt" IS NULL) = ("expiresAt" IS NULL)
  AND ("approvedAt" IS NULL OR ("approvedAt" IS NOT NULL AND "expiresAt" IS NOT NULL AND "approvedAt" = "decidedAt" AND "expiresAt" > "approvedAt"
       AND "expiresAt" <= "approvedAt" + interval '15 minutes' AND ("approverTokenExpiresAt" IS NULL OR "expiresAt" <= "approverTokenExpiresAt")))
  AND (("decision" = 'REJECTED') = ("approvedAt" IS NULL))
  AND (("decision" = 'CONSUMED') = ("consumedAt" IS NOT NULL))
  AND (("decision" = 'REVOKED') = ("revokedAt" IS NOT NULL)), false));

ALTER TABLE "ActionAttempt" ADD CONSTRAINT "ActionAttempt_contract_check" CHECK (
  "state" IN ('RESERVED','NOT_DISPATCHED','UNKNOWN','CREATED','VERIFIED','MISMATCH')
  AND "verificationState" IN ('IDLE','ACTIVE','FAILED','ABANDONED','VERIFIED','MISMATCH')
  AND "startDeadlineAt" > "reservedAt" AND "startDeadlineAt" <= "reservedAt" + interval '5 seconds'
  AND "verificationCount" BETWEEN 0 AND 3 AND "verificationSeq" >= "verificationCount"
  AND ("originalTicketId" IS NULL OR "originalTicketId" ~ '^[A-Za-z0-9._:-]{1,128}$')
  AND ("verifiedTicketId" IS NULL OR "verifiedTicketId" ~ '^[A-Za-z0-9._:-]{1,128}$')
  AND ("state" = 'VERIFIED') = ("verifiedTicketId" IS NOT NULL)
  AND ("safeErrorCode" IS NULL OR "safeErrorCode" ~ '^[A-Z][A-Z0-9_]{0,63}$'));
-- One active claim is either fully present (ACTIVE) or fully absent; its deadline is startedAt + 35 seconds. Every
-- mandatory claim field is required non-null BEFORE its range/equality test, and the whole expression is coalesced to
-- false: a CHECK that evaluates to SQL NULL (UNKNOWN) would otherwise accept a claim without ordinal or deadline.
ALTER TABLE "ActionAttempt" ADD CONSTRAINT "ActionAttempt_claim_check" CHECK (coalesce(
  ("verificationState" = 'ACTIVE') = ("activeVerificationToken" IS NOT NULL)
  AND (("activeVerificationToken" IS NULL AND "activeVerificationOrdinal" IS NULL AND "activeStartedAt" IS NULL AND "activeDeadlineAt" IS NULL
        AND "activeCandidateId" IS NULL)
    OR ("activeVerificationToken" IS NOT NULL AND "activeVerificationOrdinal" IS NOT NULL AND "activeStartedAt" IS NOT NULL
        AND "activeDeadlineAt" IS NOT NULL
        AND "activeVerificationOrdinal" BETWEEN 1 AND 3 AND "activeVerificationOrdinal" <= "verificationCount"
        AND "activeDeadlineAt" = "activeStartedAt" + interval '35 seconds'
        AND ("activeCandidateId" IS NULL OR "activeCandidateId" ~ '^[A-Za-z0-9._:-]{1,128}$'))), false));

ALTER TABLE "ActionVerification" ADD CONSTRAINT "ActionVerification_contract_check" CHECK (
  "ordinal" BETWEEN 1 AND 3 AND "targetKind" IN ('ORIGINAL','CANDIDATE')
  AND "state" IN ('ACTIVE','FAILED','ABANDONED','VERIFIED','MISMATCH')
  AND "targetTicketId" ~ '^[A-Za-z0-9._:-]{1,128}$' AND "requestHash" ~ '^[0-9a-f]{64}$'
  AND "deadlineAt" = "startedAt" + interval '35 seconds'
  AND ("state" = 'ACTIVE') = ("completedAt" IS NULL)
  AND ("safeErrorCode" IS NULL OR "safeErrorCode" ~ '^[A-Z][A-Z0-9_]{0,63}$'));

ALTER TABLE "ActionMockTicket" ADD CONSTRAINT "ActionMockTicket_content_check" CHECK (
  "synthetic" = 'S3_SYNTHETIC' AND char_length("customerKey") BETWEEN 1 AND 200
  AND char_length("markedTitle") BETWEEN 1 AND 240 AND char_length("description") BETWEEN 1 AND 2000);

-- ---------------------------------------------------------------------------------------------------------------
-- 4. History guard: no DELETE/TRUNCATE for any role; UPDATE may change only the listed columns. An argument with a
--    leading '=' names a set-once column (NULL -> value, never changed afterwards). Lifecycle rules per table follow.
-- ---------------------------------------------------------------------------------------------------------------
CREATE FUNCTION atlas_action_history_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  v_arg text; v_mutable text[] := ARRAY[]::text[]; v_column text;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'ACTION_HISTORY_IMMUTABLE: % rows are never deleted', TG_TABLE_NAME USING ERRCODE = 'AT004';
  END IF;
  FOREACH v_arg IN ARRAY coalesce(TG_ARGV, ARRAY[]::text[]) LOOP
    v_column := ltrim(v_arg, '=');
    v_mutable := v_mutable || v_column;
    IF left(v_arg, 1) = '=' AND (to_jsonb(OLD) -> v_column) <> 'null'::jsonb
       AND (to_jsonb(NEW) -> v_column) IS DISTINCT FROM (to_jsonb(OLD) -> v_column) THEN
      RAISE EXCEPTION 'ACTION_HISTORY_IMMUTABLE: %.% is set once', TG_TABLE_NAME, v_column USING ERRCODE = 'AT004';
    END IF;
  END LOOP;
  IF (to_jsonb(NEW) - v_mutable) IS DISTINCT FROM (to_jsonb(OLD) - v_mutable) THEN
    RAISE EXCEPTION 'ACTION_HISTORY_IMMUTABLE: % identity and content are immutable', TG_TABLE_NAME USING ERRCODE = 'AT004';
  END IF;
  RETURN NEW;
END $fn$;

CREATE FUNCTION atlas_action_lifecycle_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  v_ok boolean := true;
BEGIN
  IF TG_TABLE_NAME = 'ActionRequest' THEN
    IF TG_OP = 'INSERT' THEN
      v_ok := NEW.state = 'AWAITING_APPROVAL' AND NEW."terminalAt" IS NULL AND NEW."safeErrorCode" IS NULL;
    ELSIF NEW.state IS DISTINCT FROM OLD.state THEN
      -- Pre-reservation outcomes are permanent; no outcome returns to approval or permits a second create.
      v_ok := (OLD.state, NEW.state) IN (
        ('AWAITING_APPROVAL','APPROVED'), ('AWAITING_APPROVAL','REJECTED'), ('AWAITING_APPROVAL','CANCELLED'),
        ('AWAITING_APPROVAL','INVALIDATED'), ('AWAITING_APPROVAL','EXPIRED'),
        ('APPROVED','REVOKED'), ('APPROVED','CANCELLED'), ('APPROVED','INVALIDATED'), ('APPROVED','EXPIRED'), ('APPROVED','DISPATCH_RESERVED'),
        ('DISPATCH_RESERVED','NOT_DISPATCHED'), ('DISPATCH_RESERVED','OUTCOME_UNKNOWN'), ('DISPATCH_RESERVED','CREATED_UNVERIFIED'),
        ('OUTCOME_UNKNOWN','CREATED_UNVERIFIED'), ('OUTCOME_UNKNOWN','VERIFIED'),
        ('CREATED_UNVERIFIED','VERIFICATION_MISMATCH'), ('CREATED_UNVERIFIED','VERIFIED'), ('VERIFICATION_MISMATCH','VERIFIED'));
    END IF;
  ELSIF TG_TABLE_NAME = 'ActionApproval' THEN
    IF TG_OP = 'INSERT' THEN
      v_ok := NEW.decision IN ('APPROVED','REJECTED');
    ELSIF NEW.decision IS DISTINCT FROM OLD.decision THEN
      v_ok := (OLD.decision, NEW.decision) IN (('APPROVED','REVOKED'), ('APPROVED','CONSUMED'));
    END IF;
  ELSIF TG_TABLE_NAME = 'ActionAttempt' THEN
    IF TG_OP = 'INSERT' THEN
      v_ok := NEW.state = 'RESERVED' AND NEW."verificationCount" = 0 AND NEW."verificationSeq" = 0 AND NEW."verificationState" = 'IDLE'
        AND NEW."originalTicketId" IS NULL AND NEW."verifiedTicketId" IS NULL;
    ELSE
      v_ok := NEW."verificationCount" IN (OLD."verificationCount", OLD."verificationCount" + 1)
        AND NEW."verificationSeq" >= OLD."verificationSeq" AND NEW."verificationSeq" - OLD."verificationSeq" = NEW."verificationCount" - OLD."verificationCount"
        AND (NEW.state = OLD.state OR (OLD.state, NEW.state) IN (
          ('RESERVED','NOT_DISPATCHED'), ('RESERVED','UNKNOWN'), ('RESERVED','CREATED'),
          ('UNKNOWN','CREATED'), ('UNKNOWN','VERIFIED'), ('CREATED','MISMATCH'), ('CREATED','VERIFIED'), ('MISMATCH','VERIFIED')));
    END IF;
  ELSIF TG_TABLE_NAME = 'ActionVerification' THEN
    IF TG_OP = 'INSERT' THEN
      v_ok := NEW.state = 'ACTIVE';
    ELSIF NEW.state IS DISTINCT FROM OLD.state THEN
      v_ok := OLD.state = 'ACTIVE';
    END IF;
  ELSE
    v_ok := false;
  END IF;
  IF NOT coalesce(v_ok, false) THEN
    RAISE EXCEPTION 'ACTION_LIFECYCLE_INVALID: % transition refused', TG_TABLE_NAME USING ERRCODE = 'AT005';
  END IF;
  RETURN NEW;
END $fn$;

-- Trigger-only: firing needs no EXECUTE, so nobody else (PUBLIC included) holds it (keeps the fence definer's routine set exact).
REVOKE ALL ON FUNCTION atlas_action_history_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION atlas_action_lifecycle_guard() FROM PUBLIC;

CREATE TRIGGER "ActionRequest_history" BEFORE UPDATE OR DELETE ON "ActionRequest" FOR EACH ROW
  EXECUTE FUNCTION atlas_action_history_guard('state', 'safeErrorCode', '=resultTicketId', 'updatedAt', '=terminalAt');
CREATE TRIGGER "ActionApproval_history" BEFORE UPDATE OR DELETE ON "ActionApproval" FOR EACH ROW
  EXECUTE FUNCTION atlas_action_history_guard('decision', '=consumedAt', '=revokedAt', 'safeErrorCode');
CREATE TRIGGER "ActionAttempt_history" BEFORE UPDATE OR DELETE ON "ActionAttempt" FOR EACH ROW
  EXECUTE FUNCTION atlas_action_history_guard('state', '=originalTicketId', '=verifiedTicketId', 'safeErrorCode', '=outcomeAt', 'updatedAt',
    'verificationCount', 'verificationSeq', 'verificationState', 'activeVerificationToken', 'activeVerificationOrdinal', 'activeStartedAt',
    'activeDeadlineAt', 'activeCandidateId');
CREATE TRIGGER "ActionVerification_history" BEFORE UPDATE OR DELETE ON "ActionVerification" FOR EACH ROW
  EXECUTE FUNCTION atlas_action_history_guard('state', '=completedAt', '=safeErrorCode');
CREATE TRIGGER "ActionMockTicket_history" BEFORE UPDATE OR DELETE ON "ActionMockTicket" FOR EACH ROW
  EXECUTE FUNCTION atlas_action_history_guard();
CREATE TRIGGER "ActionRequest_lifecycle" BEFORE INSERT OR UPDATE ON "ActionRequest" FOR EACH ROW EXECUTE FUNCTION atlas_action_lifecycle_guard();
CREATE TRIGGER "ActionApproval_lifecycle" BEFORE INSERT OR UPDATE ON "ActionApproval" FOR EACH ROW EXECUTE FUNCTION atlas_action_lifecycle_guard();
CREATE TRIGGER "ActionAttempt_lifecycle" BEFORE INSERT OR UPDATE ON "ActionAttempt" FOR EACH ROW EXECUTE FUNCTION atlas_action_lifecycle_guard();
CREATE TRIGGER "ActionVerification_lifecycle" BEFORE INSERT OR UPDATE ON "ActionVerification" FOR EACH ROW EXECUTE FUNCTION atlas_action_lifecycle_guard();
CREATE TRIGGER "ActionRequest_truncate" BEFORE TRUNCATE ON "ActionRequest" FOR EACH STATEMENT EXECUTE FUNCTION atlas_action_history_guard();
CREATE TRIGGER "ActionApproval_truncate" BEFORE TRUNCATE ON "ActionApproval" FOR EACH STATEMENT EXECUTE FUNCTION atlas_action_history_guard();
CREATE TRIGGER "ActionAttempt_truncate" BEFORE TRUNCATE ON "ActionAttempt" FOR EACH STATEMENT EXECUTE FUNCTION atlas_action_history_guard();
CREATE TRIGGER "ActionVerification_truncate" BEFORE TRUNCATE ON "ActionVerification" FOR EACH STATEMENT EXECUTE FUNCTION atlas_action_history_guard();
CREATE TRIGGER "ActionMockTicket_truncate" BEFORE TRUNCATE ON "ActionMockTicket" FOR EACH STATEMENT EXECUTE FUNCTION atlas_action_history_guard();

-- ---------------------------------------------------------------------------------------------------------------
-- 5. Row-level security: ENABLE + FORCE, workspace and client scope (the owner is confined too, except a superuser)
-- ---------------------------------------------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ActionRequest','ActionApproval','ActionAttempt','ActionVerification','ActionMockTicket'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL USING ("workspaceId" = atlas_app_workspace() AND "clientId" = ANY(atlas_app_clients()))
      WITH CHECK ("workspaceId" = atlas_app_workspace() AND "clientId" = ANY(atlas_app_clients()))', t || '_scope', t);
  END LOOP;
END
$$;
