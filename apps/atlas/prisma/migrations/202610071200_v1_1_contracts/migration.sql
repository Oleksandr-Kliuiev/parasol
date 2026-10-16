-- v1.1 contract corrections. Additive to 202610070001_foundation, which is never edited once applied.
-- Written by hand for Prisma 6.19 conventions (TEXT ids, TIMESTAMP(3), JSONB, Prisma-style constraint names).
-- Revision 1.1.1 (same migration name, revised before any known deployment; databases that applied the 1.1.0 text use
-- prisma/upgrades/v1_1_0_to_v1_1_1.sql instead). Sections: 0 preflight  1 RawEvent identity  2 DecisionRun provenance
-- 3 Observation explainability  4 SecurityAuditEvent  5 Row-level security. CHECKs, partial indexes, triggers and RLS
-- cannot be expressed in schema.prisma.

-- ---------------------------------------------------------------------------------------------------------------
-- 0. Preflight on a populated v1.0 database. Unknown status values are a decision for a person, not for a migration.
-- ---------------------------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Observation" WHERE status NOT IN ('OPEN','ACKNOWLEDGED','RESOLVED','SUPPRESSED')) THEN
    RAISE EXCEPTION 'v1.1 preflight: Observation.status has values outside OPEN/ACKNOWLEDGED/RESOLVED/SUPPRESSED; map them explicitly before applying (docs/06, upgrade section)';
  END IF;
  IF EXISTS (SELECT 1 FROM "RawEvent" WHERE status NOT IN ('RECEIVED','PROCESSED','RETRY','DEAD_LETTER')) THEN
    RAISE EXCEPTION 'v1.1 preflight: RawEvent.status has values outside RECEIVED/PROCESSED/RETRY/DEAD_LETTER; map them explicitly before applying (docs/06, upgrade section)';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- 1. RawEvent: resource type is part of identity; key rule is versioned; inbox state is persisted
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE "RawEvent" ADD COLUMN "resourceType" TEXT;
UPDATE "RawEvent" SET "resourceType" = 'legacy-unknown' WHERE "resourceType" IS NULL;
ALTER TABLE "RawEvent" ALTER COLUMN "resourceType" SET NOT NULL;
ALTER TABLE "RawEvent" ADD COLUMN "eventKeyVersion" TEXT NOT NULL DEFAULT 'v2';
UPDATE "RawEvent" SET "eventKeyVersion" = 'v1' WHERE "resourceType" = 'legacy-unknown';
ALTER TABLE "RawEvent" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "RawEvent" ADD COLUMN "lastErrorCode" TEXT;
-- A redelivery with the same identity but different content is stored as its own evidence row that points at the
-- canonical row; the canonical row is never overwritten. Exactly one canonical row per identity; identical content is
-- a duplicate (unique including payloadHash).
ALTER TABLE "RawEvent" ADD COLUMN "conflictOfEventKey" TEXT;
ALTER TABLE "RawEvent" ADD CONSTRAINT "RawEvent_conflictOfEventKey_fkey"
  FOREIGN KEY ("conflictOfEventKey") REFERENCES "RawEvent"("eventKey") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RawEvent" ADD CONSTRAINT "RawEvent_conflict_self_check" CHECK ("conflictOfEventKey" IS NULL OR "conflictOfEventKey" <> "eventKey");
DROP INDEX "RawEvent_workspaceId_clientId_connectionId_externalEventId__key";
CREATE UNIQUE INDEX "RawEvent_canonical_identity_key"
  ON "RawEvent"("workspaceId", "clientId", "connectionId", "resourceType", "externalEventId", "revision") WHERE "conflictOfEventKey" IS NULL;
CREATE UNIQUE INDEX "RawEvent_workspaceId_clientId_connectionId_resourceType_ext_key"
  ON "RawEvent"("workspaceId", "clientId", "connectionId", "resourceType", "externalEventId", "revision", "payloadHash");
ALTER TABLE "RawEvent" ADD CONSTRAINT "RawEvent_status_check" CHECK (status IN ('RECEIVED','PROCESSED','RETRY','DEAD_LETTER'));
ALTER TABLE "RawEvent" ADD CONSTRAINT "RawEvent_attempts_check" CHECK (attempts >= 0);

-- ---------------------------------------------------------------------------------------------------------------
-- 2. DecisionRun: mode, applied flag, requested vs returned model. One applied run per event.
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE "DecisionRun" ADD COLUMN "mode" TEXT NOT NULL DEFAULT 'fixture';
ALTER TABLE "DecisionRun" ADD COLUMN "applied" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "DecisionRun" ADD COLUMN "requestedModel" TEXT;
ALTER TABLE "DecisionRun" ADD COLUMN "responseModel" TEXT;
UPDATE "DecisionRun" SET "requestedModel" = "model" WHERE "model" IS NOT NULL;
ALTER TABLE "DecisionRun" DROP COLUMN "model";
ALTER TABLE "DecisionRun" ADD CONSTRAINT "DecisionRun_mode_check" CHECK (mode IN ('fixture','rules','shadow','advisory'));
-- Target of the Observation foreign key: it includes eventId AND applied, so an observation can only reference the
-- applied run of its own event, and that run cannot be un-applied while referenced (ON UPDATE RESTRICT below).
CREATE UNIQUE INDEX "DecisionRun_workspaceId_clientId_id_eventId_applied_key" ON "DecisionRun"("workspaceId", "clientId", "id", "eventId", "applied");
CREATE UNIQUE INDEX "DecisionRun_one_applied_per_event" ON "DecisionRun"("workspaceId", "clientId", "eventId") WHERE applied;

-- ---------------------------------------------------------------------------------------------------------------
-- 3. Observation: resolved entity, applied decision, priority, severity rank, reason list, lifecycle timestamps
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE "Observation" ADD COLUMN "entityId" TEXT;
ALTER TABLE "Observation" ADD COLUMN "decisionRunId" TEXT;
ALTER TABLE "Observation" ADD COLUMN "severityRank" INTEGER;
UPDATE "Observation" SET "severityRank" = CASE severity WHEN 'INFO' THEN 0 WHEN 'LOW' THEN 1 WHEN 'MEDIUM' THEN 2 WHEN 'HIGH' THEN 3 WHEN 'CRITICAL' THEN 4 END;
ALTER TABLE "Observation" ALTER COLUMN "severityRank" SET NOT NULL;
ALTER TABLE "Observation" ADD COLUMN "priority" TEXT NOT NULL DEFAULT 'NORMAL';
UPDATE "Observation" SET "priority" = 'URGENT' WHERE "severityRank" >= 3;
ALTER TABLE "Observation" ADD COLUMN "provider" TEXT;
UPDATE "Observation" SET "provider" = 'unknown' WHERE "provider" IS NULL;
ALTER TABLE "Observation" ALTER COLUMN "provider" SET NOT NULL;
ALTER TABLE "Observation" ADD COLUMN "promptVersion" TEXT;
UPDATE "Observation" SET "promptVersion" = 'unknown' WHERE "promptVersion" IS NULL;
ALTER TABLE "Observation" ALTER COLUMN "promptVersion" SET NOT NULL;
ALTER TABLE "Observation" ADD COLUMN "reasonCodes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
UPDATE "Observation" SET "reasonCodes" = ARRAY["reasonCode"];
ALTER TABLE "Observation" DROP COLUMN "reasonCode";
ALTER TABLE "Observation" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "Observation" ADD COLUMN "resolvedAt" TIMESTAMP(3);
ALTER TABLE "Observation" ADD COLUMN "resolvedBy" TEXT;
-- Rows closed before v1.1 have no recorded author/time. They are marked, not invented: legacyClosure = true is set
-- only by this migration; the application never writes it.
ALTER TABLE "Observation" ADD COLUMN "legacyClosure" BOOLEAN NOT NULL DEFAULT false;
UPDATE "Observation" SET "legacyClosure" = true WHERE status IN ('RESOLVED','SUPPRESSED') AND ("resolvedAt" IS NULL OR "resolvedBy" IS NULL);
-- Constant column that makes `applied = true` part of the foreign key to DecisionRun.
ALTER TABLE "Observation" ADD COLUMN "decisionApplied" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Observation" ADD CONSTRAINT "Observation_decisionApplied_check" CHECK ("decisionApplied");
-- severityRank can never disagree with severity, and the urgency floor holds in the database as well as in code.
ALTER TABLE "Observation" ADD CONSTRAINT "Observation_severity_rank_check"
  CHECK ((severity, "severityRank") IN (('INFO',0),('LOW',1),('MEDIUM',2),('HIGH',3),('CRITICAL',4)));
ALTER TABLE "Observation" ADD CONSTRAINT "Observation_priority_check" CHECK (priority IN ('NORMAL','URGENT'));
ALTER TABLE "Observation" ADD CONSTRAINT "Observation_priority_floor_check" CHECK ("severityRank" < 3 OR priority = 'URGENT');
ALTER TABLE "Observation" ADD CONSTRAINT "Observation_domain_check" CHECK (domain IN ('OPERATIONS','SECURITY'));
ALTER TABLE "Observation" ADD CONSTRAINT "Observation_status_check" CHECK (status IN ('OPEN','ACKNOWLEDGED','RESOLVED','SUPPRESSED'));
ALTER TABLE "Observation" ADD CONSTRAINT "Observation_resolution_check"
  CHECK ((status IN ('OPEN','ACKNOWLEDGED') AND "resolvedAt" IS NULL AND "resolvedBy" IS NULL AND NOT "legacyClosure")
      OR (status IN ('RESOLVED','SUPPRESSED') AND ("legacyClosure" OR ("resolvedAt" IS NOT NULL AND "resolvedBy" IS NOT NULL))));
-- The resolved entity must belong to the same workspace and client.
ALTER TABLE "Observation" ADD CONSTRAINT "Observation_workspaceId_clientId_entityId_fkey"
  FOREIGN KEY ("workspaceId", "clientId", "entityId") REFERENCES "Entity"("workspaceId", "clientId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- The applied decision must belong to the same workspace, client AND event, and must be the applied one
-- (decisionApplied is constant true). ON UPDATE RESTRICT: a referenced run cannot be flipped back to applied = false.
ALTER TABLE "Observation" ADD CONSTRAINT "Observation_decisionRun_fkey"
  FOREIGN KEY ("workspaceId", "clientId", "decisionRunId", "eventId", "decisionApplied")
  REFERENCES "DecisionRun"("workspaceId", "clientId", "id", "eventId", "applied") ON DELETE RESTRICT ON UPDATE RESTRICT;
-- Priority ordering for context: urgent first, newest first, stable tiebreak on id.
CREATE INDEX "Observation_workspaceId_clientId_status_severityRank_create_idx"
  ON "Observation"("workspaceId", "clientId", "status", "severityRank" DESC, "createdAt" DESC, "id");

-- ---------------------------------------------------------------------------------------------------------------
-- 4. SecurityAuditEvent: workspace-level denial log, append-only
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE "SecurityAuditEvent" (
    "workspaceId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "outcome" TEXT NOT NULL DEFAULT 'DENIED',
    "requestedClientId" TEXT,
    "reasonCode" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "metadata" JSONB NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SecurityAuditEvent_pkey" PRIMARY KEY ("workspaceId","id")
);
CREATE INDEX "SecurityAuditEvent_workspaceId_recordedAt_idx" ON "SecurityAuditEvent"("workspaceId", "recordedAt");
ALTER TABLE "SecurityAuditEvent" ADD CONSTRAINT "SecurityAuditEvent_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SecurityAuditEvent" ADD CONSTRAINT "SecurityAuditEvent_outcome_check" CHECK (outcome IN ('DENIED'));
CREATE TRIGGER "SecurityAuditEvent_no_update_delete" BEFORE UPDATE OR DELETE ON "SecurityAuditEvent" FOR EACH ROW EXECUTE FUNCTION atlas_reject_audit_mutation();
CREATE TRIGGER "SecurityAuditEvent_no_truncate" BEFORE TRUNCATE ON "SecurityAuditEvent" FOR EACH STATEMENT EXECUTE FUNCTION atlas_reject_audit_mutation();

-- ---------------------------------------------------------------------------------------------------------------
-- 5. Row-level security. Defense in depth behind the application's scoped repositories.
--    Context is set per transaction with set_config(name, value, true) (= SET LOCAL). Missing or empty context
--    yields NULL / {} and therefore denies every row. Policies are not FORCEd: the migration/seed owner bypasses
--    them, the runtime role (prisma/roles.sql: NOBYPASSRLS, not the owner) does not. Every client of one workspace
--    is isolated by "clientId" = ANY(app.client_ids), not by workspace alone.
-- ---------------------------------------------------------------------------------------------------------------
CREATE FUNCTION atlas_app_workspace() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.workspace_id', true), '')
$$;
CREATE FUNCTION atlas_app_clients() RETURNS text[] LANGUAGE sql STABLE AS $$
  SELECT string_to_array(NULLIF(current_setting('app.client_ids', true), ''), ',')
$$;

ALTER TABLE "Workspace" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Workspace_scope" ON "Workspace" FOR ALL
  USING (id = atlas_app_workspace()) WITH CHECK (id = atlas_app_workspace());
ALTER TABLE "SecurityAuditEvent" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "SecurityAuditEvent_scope" ON "SecurityAuditEvent" FOR ALL
  USING ("workspaceId" = atlas_app_workspace()) WITH CHECK ("workspaceId" = atlas_app_workspace());
ALTER TABLE "Client" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Client_scope" ON "Client" FOR ALL
  USING ("workspaceId" = atlas_app_workspace() AND id = ANY(atlas_app_clients()))
  WITH CHECK ("workspaceId" = atlas_app_workspace() AND id = ANY(atlas_app_clients()));

ALTER TABLE "Entity" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Entity_scope" ON "Entity" FOR ALL
  USING ("workspaceId" = atlas_app_workspace() AND "clientId" = ANY(atlas_app_clients()))
  WITH CHECK ("workspaceId" = atlas_app_workspace() AND "clientId" = ANY(atlas_app_clients()));
ALTER TABLE "Person" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Person_scope" ON "Person" FOR ALL
  USING ("workspaceId" = atlas_app_workspace() AND "clientId" = ANY(atlas_app_clients()))
  WITH CHECK ("workspaceId" = atlas_app_workspace() AND "clientId" = ANY(atlas_app_clients()));
ALTER TABLE "Device" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Device_scope" ON "Device" FOR ALL
  USING ("workspaceId" = atlas_app_workspace() AND "clientId" = ANY(atlas_app_clients()))
  WITH CHECK ("workspaceId" = atlas_app_workspace() AND "clientId" = ANY(atlas_app_clients()));
ALTER TABLE "Connection" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Connection_scope" ON "Connection" FOR ALL
  USING ("workspaceId" = atlas_app_workspace() AND "clientId" = ANY(atlas_app_clients()))
  WITH CHECK ("workspaceId" = atlas_app_workspace() AND "clientId" = ANY(atlas_app_clients()));
ALTER TABLE "ExternalEntity" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ExternalEntity_scope" ON "ExternalEntity" FOR ALL
  USING ("workspaceId" = atlas_app_workspace() AND "clientId" = ANY(atlas_app_clients()))
  WITH CHECK ("workspaceId" = atlas_app_workspace() AND "clientId" = ANY(atlas_app_clients()));
ALTER TABLE "EntityLink" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "EntityLink_scope" ON "EntityLink" FOR ALL
  USING ("workspaceId" = atlas_app_workspace() AND "clientId" = ANY(atlas_app_clients()))
  WITH CHECK ("workspaceId" = atlas_app_workspace() AND "clientId" = ANY(atlas_app_clients()));
ALTER TABLE "RawEvent" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "RawEvent_scope" ON "RawEvent" FOR ALL
  USING ("workspaceId" = atlas_app_workspace() AND "clientId" = ANY(atlas_app_clients()))
  WITH CHECK ("workspaceId" = atlas_app_workspace() AND "clientId" = ANY(atlas_app_clients()));
ALTER TABLE "DecisionRun" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "DecisionRun_scope" ON "DecisionRun" FOR ALL
  USING ("workspaceId" = atlas_app_workspace() AND "clientId" = ANY(atlas_app_clients()))
  WITH CHECK ("workspaceId" = atlas_app_workspace() AND "clientId" = ANY(atlas_app_clients()));
ALTER TABLE "Observation" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Observation_scope" ON "Observation" FOR ALL
  USING ("workspaceId" = atlas_app_workspace() AND "clientId" = ANY(atlas_app_clients()))
  WITH CHECK ("workspaceId" = atlas_app_workspace() AND "clientId" = ANY(atlas_app_clients()));
ALTER TABLE "SyncState" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "SyncState_scope" ON "SyncState" FOR ALL
  USING ("workspaceId" = atlas_app_workspace() AND "clientId" = ANY(atlas_app_clients()))
  WITH CHECK ("workspaceId" = atlas_app_workspace() AND "clientId" = ANY(atlas_app_clients()));
ALTER TABLE "ToolExecution" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ToolExecution_scope" ON "ToolExecution" FOR ALL
  USING ("workspaceId" = atlas_app_workspace() AND "clientId" = ANY(atlas_app_clients()))
  WITH CHECK ("workspaceId" = atlas_app_workspace() AND "clientId" = ANY(atlas_app_clients()));
ALTER TABLE "AuditEvent" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "AuditEvent_scope" ON "AuditEvent" FOR ALL
  USING ("workspaceId" = atlas_app_workspace() AND "clientId" = ANY(atlas_app_clients()))
  WITH CHECK ("workspaceId" = atlas_app_workspace() AND "clientId" = ANY(atlas_app_clients()));
ALTER TABLE "Approval" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Approval_scope" ON "Approval" FOR ALL
  USING ("workspaceId" = atlas_app_workspace() AND "clientId" = ANY(atlas_app_clients()))
  WITH CHECK ("workspaceId" = atlas_app_workspace() AND "clientId" = ANY(atlas_app_clients()));
