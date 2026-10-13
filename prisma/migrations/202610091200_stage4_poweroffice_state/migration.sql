-- Stage 4 S4-A (docs/stage4/03_DATA_AND_CONCURRENCY.md): PowerOffice permissions and the three scoped tables. Additive;
-- every earlier migration is frozen. The approved later-checkpoint columns are defined now; S4-A adds no service that
-- writes them. Guards and commit invariants: 202610091210; the bounded cleanup routine: 202610091220. prisma/roles.sql
-- (after this deploy) grants the runtime its exact privileges, creates the two PowerOffice maintenance roles and installs
-- their restrictive three-ID policies; until then the runtime startup check refuses (default privileges are too broad).
--
-- Every row carries workspaceId/clientId/connectionId with a scoped Connection FK; every cross-row reference includes that
-- scope. Mandatory fields are NOT NULL and every multi-column CHECK is coalesced to false, so SQL UNKNOWN never passes.

-- ---------------------------------------------------------------------------------------------------------------
-- 0. Paired synthetic binding integrity (first statement: a deployment holding a PowerOffice row that violates it stops
--    here with nothing applied — no accepted row is rewritten or deleted; the operator repairs the row and resolves the
--    failed migration). A PowerOffice Connection whose externalTenantId has the synthetic shape synthetic-po-<lower-case
--    UUID> must carry exactly secretRef fixture://poweroffice/<the same UUID>, for every role and every later UPDATE. The
--    cleanup definer never reads secretRef: its tenant-shape check plus this validated CHECK prove the full pair. Other
--    systems and non-synthetic PowerOffice rows (unusable: every PowerOffice path refuses them) are not constrained.
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE "Connection" ADD CONSTRAINT "Connection_poweroffice_binding_check" CHECK (coalesce(
  system <> 'poweroffice'
  OR "externalTenantId" !~ '^synthetic-po-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  OR "secretRef" = ('fixture://poweroffice/' || substr("externalTenantId", 14)), false));

-- ---------------------------------------------------------------------------------------------------------------
-- 1. Permission vocabulary: the existing list plus the three PowerOffice permissions. Existing memberships are unchanged;
--    nothing is assigned automatically.
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE "ClientMembership" DROP CONSTRAINT "ClientMembership_permissions_check";
ALTER TABLE "ClientMembership" ADD CONSTRAINT "ClientMembership_permissions_check"
  CHECK (array_position(permissions, NULL) IS NULL
         AND permissions <@ ARRAY['context:read','events:ingest','mapping:review','connections:manage','observations:triage','m365:read',
                                  'actions:read','actions:request','actions:approve','actions:execute',
                                  'poweroffice:read','poweroffice:sync','poweroffice:maintain']::TEXT[]);

-- ---------------------------------------------------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE "PowerOfficeState" (
    "workspaceId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "nextSequence" INTEGER NOT NULL DEFAULT 1,
    "activeAttemptId" UUID,
    "snapshotId" UUID,
    "snapshotVersion" INTEGER,
    "lastAttemptId" UUID,
    "lastAttemptState" TEXT,
    "lastAttemptErrorCode" TEXT,
    "lastCompletedAttemptId" UUID,
    "lastCompletedState" TEXT,
    "lastCompletedErrorCode" TEXT,
    "lastSuccessAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PowerOfficeState_pkey" PRIMARY KEY ("workspaceId", "clientId", "connectionId")
);
CREATE TABLE "PowerOfficeAttempt" (
    "workspaceId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "claimToken" UUID NOT NULL,
    "allocatedSnapshotId" UUID NOT NULL,
    "lifecycleVersion" INTEGER NOT NULL,
    "actorId" TEXT NOT NULL,
    "correlationId" UUID NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "readDeadlineAt" TIMESTAMP(3) NOT NULL,
    "deadlineAt" TIMESTAMP(3) NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'ACTIVE',
    "completedAt" TIMESTAMP(3),
    "safeErrorCode" TEXT,

    CONSTRAINT "PowerOfficeAttempt_pkey" PRIMARY KEY ("workspaceId", "clientId", "connectionId", "id")
);
CREATE TABLE "PowerOfficeSnapshot" (
    "workspaceId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "id" UUID NOT NULL,
    "attemptId" UUID NOT NULL,
    "lifecycleVersion" INTEGER NOT NULL,
    "asOf" TIMESTAMP(3) NOT NULL,
    "businessDate" DATE NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "summary" JSONB NOT NULL,
    "synthetic" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "PowerOfficeSnapshot_pkey" PRIMARY KEY ("workspaceId", "clientId", "connectionId", "id")
);

-- ---------------------------------------------------------------------------------------------------------------
-- 3. Keys and scoped foreign keys. One sequence and one allocated snapshot ID per attempt; one snapshot per attempt;
--    one ACTIVE attempt per connection (partial unique index). The snapshot names its attempt together with the
--    allocated ID, lifecycle version and asOf = startedAt (matching attempt UNIQUE); the State pointer names the snapshot
--    with its lifecycle version.
-- ---------------------------------------------------------------------------------------------------------------
CREATE UNIQUE INDEX "PowerOfficeAttempt_sequence_key" ON "PowerOfficeAttempt"("workspaceId", "clientId", "connectionId", "sequence");
CREATE UNIQUE INDEX "PowerOfficeAttempt_snapshot_key" ON "PowerOfficeAttempt"("workspaceId", "clientId", "connectionId", "allocatedSnapshotId");
CREATE UNIQUE INDEX "PowerOfficeAttempt_publication_key" ON "PowerOfficeAttempt"("workspaceId", "clientId", "connectionId", "id",
  "allocatedSnapshotId", "lifecycleVersion", "startedAt");
CREATE UNIQUE INDEX "PowerOfficeAttempt_one_active" ON "PowerOfficeAttempt"("workspaceId", "clientId", "connectionId") WHERE "state" = 'ACTIVE';
CREATE INDEX "PowerOfficeAttempt_retention_idx" ON "PowerOfficeAttempt"("workspaceId", "clientId", "connectionId", "completedAt");
CREATE INDEX "PowerOfficeAttempt_actor_idx" ON "PowerOfficeAttempt"("workspaceId", "actorId");
CREATE UNIQUE INDEX "PowerOfficeSnapshot_attempt_key" ON "PowerOfficeSnapshot"("workspaceId", "clientId", "connectionId", "attemptId");
CREATE UNIQUE INDEX "PowerOfficeSnapshot_version_key" ON "PowerOfficeSnapshot"("workspaceId", "clientId", "connectionId", "id", "lifecycleVersion");
CREATE INDEX "PowerOfficeSnapshot_expiry_idx" ON "PowerOfficeSnapshot"("workspaceId", "clientId", "connectionId", "expiresAt", "id");

ALTER TABLE "PowerOfficeState" ADD CONSTRAINT "PowerOfficeState_connection_fkey" FOREIGN KEY ("workspaceId", "clientId", "connectionId")
  REFERENCES "Connection"("workspaceId", "clientId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "PowerOfficeAttempt" ADD CONSTRAINT "PowerOfficeAttempt_connection_fkey" FOREIGN KEY ("workspaceId", "clientId", "connectionId")
  REFERENCES "Connection"("workspaceId", "clientId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "PowerOfficeAttempt" ADD CONSTRAINT "PowerOfficeAttempt_state_fkey" FOREIGN KEY ("workspaceId", "clientId", "connectionId")
  REFERENCES "PowerOfficeState"("workspaceId", "clientId", "connectionId") ON DELETE RESTRICT ON UPDATE RESTRICT;
-- Retained attempt metadata can prevent Actor deletion (RESTRICT), by design.
ALTER TABLE "PowerOfficeAttempt" ADD CONSTRAINT "PowerOfficeAttempt_actor_fkey" FOREIGN KEY ("workspaceId", "actorId")
  REFERENCES "Actor"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "PowerOfficeSnapshot" ADD CONSTRAINT "PowerOfficeSnapshot_connection_fkey" FOREIGN KEY ("workspaceId", "clientId", "connectionId")
  REFERENCES "Connection"("workspaceId", "clientId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "PowerOfficeSnapshot" ADD CONSTRAINT "PowerOfficeSnapshot_attempt_fkey"
  FOREIGN KEY ("workspaceId", "clientId", "connectionId", "attemptId", "id", "lifecycleVersion", "asOf")
  REFERENCES "PowerOfficeAttempt"("workspaceId", "clientId", "connectionId", "id", "allocatedSnapshotId", "lifecycleVersion", "startedAt")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "PowerOfficeState" ADD CONSTRAINT "PowerOfficeState_active_fkey" FOREIGN KEY ("workspaceId", "clientId", "connectionId", "activeAttemptId")
  REFERENCES "PowerOfficeAttempt"("workspaceId", "clientId", "connectionId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "PowerOfficeState" ADD CONSTRAINT "PowerOfficeState_lastAttempt_fkey" FOREIGN KEY ("workspaceId", "clientId", "connectionId", "lastAttemptId")
  REFERENCES "PowerOfficeAttempt"("workspaceId", "clientId", "connectionId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "PowerOfficeState" ADD CONSTRAINT "PowerOfficeState_lastCompleted_fkey"
  FOREIGN KEY ("workspaceId", "clientId", "connectionId", "lastCompletedAttemptId")
  REFERENCES "PowerOfficeAttempt"("workspaceId", "clientId", "connectionId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "PowerOfficeState" ADD CONSTRAINT "PowerOfficeState_snapshot_fkey"
  FOREIGN KEY ("workspaceId", "clientId", "connectionId", "snapshotId", "snapshotVersion")
  REFERENCES "PowerOfficeSnapshot"("workspaceId", "clientId", "connectionId", "id", "lifecycleVersion") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ---------------------------------------------------------------------------------------------------------------
-- 4. Row-local CHECKs. Fixed attempt outcome codes (packages/poweroffice/contracts.ts POWEROFFICE_ATTEMPT_CODES).
--    Partial-null pairs/tuples are refused; the ACTIVE pointer and the lastAttempt/lastCompleted tuples agree.
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE "PowerOfficeState" ADD CONSTRAINT "PowerOfficeState_contract_check" CHECK (coalesce(
  "nextSequence" >= 1
  AND (("snapshotId" IS NULL AND "snapshotVersion" IS NULL) OR ("snapshotId" IS NOT NULL AND "snapshotVersion" IS NOT NULL AND "snapshotVersion" >= 1))
  AND (("lastAttemptId" IS NULL AND "lastAttemptState" IS NULL AND "lastAttemptErrorCode" IS NULL AND "nextSequence" = 1)
    OR ("lastAttemptId" IS NOT NULL AND "lastAttemptState" IS NOT NULL AND "nextSequence" > 1 AND (
          ("lastAttemptState" IN ('ACTIVE','SUCCEEDED') AND "lastAttemptErrorCode" IS NULL)
       OR ("lastAttemptState" IN ('FAILED','ABANDONED') AND "lastAttemptErrorCode" IS NOT NULL AND "lastAttemptErrorCode" IN (
            'POWEROFFICE_AUTHENTICATION_FAILED','SCOPE_DENIED','PERMISSION_DENIED','POWEROFFICE_DISABLED','POWEROFFICE_MODE_UNSUPPORTED',
            'POWEROFFICE_CONNECTION_UNAVAILABLE','POWEROFFICE_BINDING_CHANGED','POWEROFFICE_DTO_INVALID','POWEROFFICE_EXPORT_INCOMPLETE',
            'POWEROFFICE_SOURCE_FAILED','POWEROFFICE_DEADLINE','POWEROFFICE_CLAIM_STALE','POWEROFFICE_PUBLICATION_CONFLICT','UNEXPECTED_ERROR')))))
  AND (("lastCompletedAttemptId" IS NULL AND "lastCompletedState" IS NULL AND "lastCompletedErrorCode" IS NULL)
    OR ("lastCompletedAttemptId" IS NOT NULL AND "lastCompletedState" IS NOT NULL AND "lastAttemptId" IS NOT NULL AND (
          ("lastCompletedState" = 'SUCCEEDED' AND "lastCompletedErrorCode" IS NULL)
       OR ("lastCompletedState" IN ('FAILED','ABANDONED') AND "lastCompletedErrorCode" IS NOT NULL AND "lastCompletedErrorCode" IN (
            'POWEROFFICE_AUTHENTICATION_FAILED','SCOPE_DENIED','PERMISSION_DENIED','POWEROFFICE_DISABLED','POWEROFFICE_MODE_UNSUPPORTED',
            'POWEROFFICE_CONNECTION_UNAVAILABLE','POWEROFFICE_BINDING_CHANGED','POWEROFFICE_DTO_INVALID','POWEROFFICE_EXPORT_INCOMPLETE',
            'POWEROFFICE_SOURCE_FAILED','POWEROFFICE_DEADLINE','POWEROFFICE_CLAIM_STALE','POWEROFFICE_PUBLICATION_CONFLICT','UNEXPECTED_ERROR')))))
  -- ACTIVE pointer ⇔ the latest claim is ACTIVE; a terminal latest claim is also the last completed one.
  AND (("activeAttemptId" IS NULL AND "lastAttemptState" IS DISTINCT FROM 'ACTIVE')
    OR ("activeAttemptId" IS NOT NULL AND "lastAttemptState" = 'ACTIVE' AND "lastAttemptId" = "activeAttemptId"))
  AND ("lastAttemptState" IS NULL OR "lastAttemptState" = 'ACTIVE'
    OR ("lastCompletedAttemptId" = "lastAttemptId" AND "lastCompletedState" = "lastAttemptState"
        AND "lastCompletedErrorCode" IS NOT DISTINCT FROM "lastAttemptErrorCode"))
  -- A pointer implies a recorded success; a recorded success implies a completed claim. A purged pointer keeps lastSuccessAt.
  AND ("snapshotId" IS NULL OR "lastSuccessAt" IS NOT NULL)
  AND ("lastSuccessAt" IS NULL OR "lastCompletedAttemptId" IS NOT NULL), false));

ALTER TABLE "PowerOfficeAttempt" ADD CONSTRAINT "PowerOfficeAttempt_contract_check" CHECK (coalesce(
  "sequence" >= 1 AND "lifecycleVersion" >= 1 AND "actorId" ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'
  AND "readDeadlineAt" = "startedAt" + interval '60 seconds' AND "deadlineAt" = "startedAt" + interval '80 seconds'
  AND (("state" = 'ACTIVE' AND "completedAt" IS NULL AND "safeErrorCode" IS NULL)
    OR ("state" = 'SUCCEEDED' AND "completedAt" IS NOT NULL AND "safeErrorCode" IS NULL
        AND "completedAt" >= "startedAt" AND "completedAt" < "deadlineAt")
    OR ("state" IN ('FAILED','ABANDONED') AND "completedAt" IS NOT NULL AND "safeErrorCode" IS NOT NULL AND "safeErrorCode" IN (
          'POWEROFFICE_AUTHENTICATION_FAILED','SCOPE_DENIED','PERMISSION_DENIED','POWEROFFICE_DISABLED','POWEROFFICE_MODE_UNSUPPORTED',
          'POWEROFFICE_CONNECTION_UNAVAILABLE','POWEROFFICE_BINDING_CHANGED','POWEROFFICE_DTO_INVALID','POWEROFFICE_EXPORT_INCOMPLETE',
          'POWEROFFICE_SOURCE_FAILED','POWEROFFICE_DEADLINE','POWEROFFICE_CLAIM_STALE','POWEROFFICE_PUBLICATION_CONFLICT','UNEXPECTED_ERROR')
        AND "completedAt" >= "startedAt"
        -- A private failure closes its claim only before the deadline; recovery abandons it only at/after the deadline.
        AND (("state" = 'FAILED' AND "completedAt" < "deadlineAt") OR ("state" = 'ABANDONED' AND "completedAt" >= "deadlineAt")))), false));

-- businessDate is the Europe/Oslo calendar date of the claim's DB asOf (IANA tzdata of the server, never the session zone).
ALTER TABLE "PowerOfficeSnapshot" ADD CONSTRAINT "PowerOfficeSnapshot_contract_check" CHECK (coalesce(
  "synthetic" = true AND "lifecycleVersion" >= 1
  AND "publishedAt" >= "asOf" AND "publishedAt" < "asOf" + interval '80 seconds'
  AND "expiresAt" = "publishedAt" + interval '24 hours'
  AND "businessDate" = ((("asOf" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Oslo')::date)
  AND jsonb_typeof("summary") = 'object', false));

-- ---------------------------------------------------------------------------------------------------------------
-- 5. Row-level security: ENABLE + FORCE, workspace and client scope for every role (the owner too, except a superuser).
--    prisma/roles.sql adds one RESTRICTIVE policy per table for the PowerOffice cleanup definer (three IDs).
-- ---------------------------------------------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['PowerOfficeState','PowerOfficeAttempt','PowerOfficeSnapshot'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL USING ("workspaceId" = atlas_app_workspace() AND "clientId" = ANY(atlas_app_clients()))
      WITH CHECK ("workspaceId" = atlas_app_workspace() AND "clientId" = ANY(atlas_app_clients()))', t || '_scope', t);
  END LOOP;
END
$$;
