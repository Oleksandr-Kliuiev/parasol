-- Upgrade for databases that already applied the 1.1.0 text of migration 202610071200_v1_1_contracts.
-- Fresh databases do not need this file: the revised migration already contains these changes.
-- Run as the owner inside one transaction:  psql "$DATABASE_URL" -1 -f prisma/upgrades/v1_1_0_to_v1_1_1.sql
-- Afterwards the schema is identical to a fresh v1.1.1 install (verified by tests/database.test.ts, upgrade-path test).

-- Preflight: 1.1.0 allowed an observation to reference a non-applied run; 1.1.1 does not.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Observation" o JOIN "DecisionRun" d
             ON d."workspaceId" = o."workspaceId" AND d."clientId" = o."clientId" AND d.id = o."decisionRunId" AND d."eventId" = o."eventId"
             WHERE NOT d.applied) THEN
    RAISE EXCEPTION 'v1.1.1 preflight: an Observation references a DecisionRun with applied = false; set applied = true on the referenced run (one per event) before upgrading';
  END IF;
END
$$;

-- RawEvent: conflicting redeliveries become separate evidence rows
ALTER TABLE "RawEvent" ADD COLUMN "conflictOfEventKey" TEXT;
ALTER TABLE "RawEvent" ADD CONSTRAINT "RawEvent_conflictOfEventKey_fkey"
  FOREIGN KEY ("conflictOfEventKey") REFERENCES "RawEvent"("eventKey") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RawEvent" ADD CONSTRAINT "RawEvent_conflict_self_check" CHECK ("conflictOfEventKey" IS NULL OR "conflictOfEventKey" <> "eventKey");
DROP INDEX "RawEvent_workspaceId_clientId_connectionId_resourceType_ext_key";
CREATE UNIQUE INDEX "RawEvent_canonical_identity_key"
  ON "RawEvent"("workspaceId", "clientId", "connectionId", "resourceType", "externalEventId", "revision") WHERE "conflictOfEventKey" IS NULL;
CREATE UNIQUE INDEX "RawEvent_workspaceId_clientId_connectionId_resourceType_ext_key"
  ON "RawEvent"("workspaceId", "clientId", "connectionId", "resourceType", "externalEventId", "revision", "payloadHash");

-- DecisionRun / Observation: the foreign key now includes `applied`
ALTER TABLE "Observation" DROP CONSTRAINT "Observation_workspaceId_clientId_decisionRunId_eventId_fkey";
DROP INDEX "DecisionRun_workspaceId_clientId_id_eventId_key";
CREATE UNIQUE INDEX "DecisionRun_workspaceId_clientId_id_eventId_applied_key" ON "DecisionRun"("workspaceId", "clientId", "id", "eventId", "applied");
ALTER TABLE "Observation" ADD COLUMN "decisionApplied" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Observation" ADD CONSTRAINT "Observation_decisionApplied_check" CHECK ("decisionApplied");
ALTER TABLE "Observation" ADD CONSTRAINT "Observation_decisionRun_fkey"
  FOREIGN KEY ("workspaceId", "clientId", "decisionRunId", "eventId", "decisionApplied")
  REFERENCES "DecisionRun"("workspaceId", "clientId", "id", "eventId", "applied") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Observation: legacy closures (none can exist after 1.1.0's stricter CHECK, but the column and the relaxed CHECK must match 1.1.1)
ALTER TABLE "Observation" DROP CONSTRAINT "Observation_resolution_check";
ALTER TABLE "Observation" ADD COLUMN "legacyClosure" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Observation" ADD CONSTRAINT "Observation_resolution_check"
  CHECK ((status IN ('OPEN','ACKNOWLEDGED') AND "resolvedAt" IS NULL AND "resolvedBy" IS NULL AND NOT "legacyClosure")
      OR (status IN ('RESOLVED','SUPPRESSED') AND ("legacyClosure" OR ("resolvedAt" IS NOT NULL AND "resolvedBy" IS NOT NULL))));
