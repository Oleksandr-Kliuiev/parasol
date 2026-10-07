-- Stage 1, task 1.8 Observations/context. A new migration; earlier ones are unchanged.
--   * Lifecycle OPEN → ACKNOWLEDGED → RESOLVED | SUPPRESSED, and reopen RESOLVED | SUPPRESSED → OPEN — the only status
--     changes, enforced by a trigger for every role. Acknowledgement records its author and time like a closure does.
--   * An observation is evidence: its event, applied decision, entity, severity, priority, route and reasons never
--     change after it is written (trigger), so source links are kept through every status change.
--   * A newer revision of the same source object supersedes the older one: SUPPRESSED with a pointer to the newer
--     observation of the same client (supersededById, composite FK). The system never closes urgent evidence in favour of
--     a non-urgent revision (packages/observations/lifecycle.ts).
--   * Per-client permission observations:triage for acknowledge / resolve / suppress / reopen.

-- 0. Preflight: an ACKNOWLEDGED observation from before this migration has no recorded author or time; it is not
--    invented. A person maps such rows explicitly (back to OPEN, or closed with author and time) before applying.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Observation" WHERE status = 'ACKNOWLEDGED') THEN
    RAISE EXCEPTION 'v1.8 preflight: Observation has ACKNOWLEDGED rows without a recorded author; map them explicitly before applying';
  END IF;
END $$;

-- 1. Permission vocabulary
ALTER TABLE "ClientMembership" DROP CONSTRAINT "ClientMembership_permissions_check";
ALTER TABLE "ClientMembership" ADD CONSTRAINT "ClientMembership_permissions_check"
  CHECK (array_position(permissions, NULL) IS NULL
         AND permissions <@ ARRAY['context:read','events:ingest','mapping:review','connections:manage','observations:triage']::TEXT[]);

-- 2. Acknowledgement and superseding
ALTER TABLE "Observation" ADD COLUMN "acknowledgedAt" TIMESTAMP(3);
ALTER TABLE "Observation" ADD COLUMN "acknowledgedBy" TEXT;
ALTER TABLE "Observation" ADD COLUMN "supersededById" TEXT;
ALTER TABLE "Observation" ADD CONSTRAINT "Observation_acknowledgement_check"
  CHECK (("acknowledgedAt" IS NULL) = ("acknowledgedBy" IS NULL)
     AND (status <> 'ACKNOWLEDGED' OR "acknowledgedAt" IS NOT NULL)
     AND (status <> 'OPEN' OR "acknowledgedAt" IS NULL));
ALTER TABLE "Observation" ADD CONSTRAINT "Observation_superseded_check"
  CHECK ("supersededById" IS NULL OR (status = 'SUPPRESSED' AND "supersededById" <> id));
-- The newer observation belongs to the same workspace and client (the composite key carries the scope)
ALTER TABLE "Observation" ADD CONSTRAINT "Observation_supersededBy_fkey" FOREIGN KEY ("workspaceId", "clientId", "supersededById")
  REFERENCES "Observation"("workspaceId", "clientId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- 3. Lifecycle and immutable evidence, for every role
CREATE FUNCTION atlas_observation_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."workspaceId", NEW."clientId", NEW.id, NEW."eventId", NEW."createdAt", NEW."decisionRunId", NEW."entityId", NEW.domain,
      NEW.severity, NEW."severityRank", NEW.priority, NEW.route, NEW.confidence, NEW.provider, NEW."promptVersion", NEW."reasonCodes")
     IS DISTINCT FROM
     (OLD."workspaceId", OLD."clientId", OLD.id, OLD."eventId", OLD."createdAt", OLD."decisionRunId", OLD."entityId", OLD.domain,
      OLD.severity, OLD."severityRank", OLD.priority, OLD.route, OLD.confidence, OLD.provider, OLD."promptVersion", OLD."reasonCodes") THEN
    RAISE EXCEPTION 'Observation evidence is immutable: only its lifecycle (status, acknowledgement, resolution, superseding) changes';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND (OLD.status, NEW.status) NOT IN (
      ('OPEN','ACKNOWLEDGED'), ('OPEN','RESOLVED'), ('OPEN','SUPPRESSED'), ('ACKNOWLEDGED','RESOLVED'), ('ACKNOWLEDGED','SUPPRESSED'),
      ('RESOLVED','OPEN'), ('SUPPRESSED','OPEN')) THEN
    RAISE EXCEPTION 'Observation lifecycle allows OPEN → ACKNOWLEDGED → RESOLVED | SUPPRESSED and reopen to OPEN; % → % is not allowed', OLD.status, NEW.status;
  END IF;
  IF NEW."supersededById" IS DISTINCT FROM OLD."supersededById" AND NEW."supersededById" IS NOT NULL AND OLD.status NOT IN ('OPEN','ACKNOWLEDGED') THEN
    RAISE EXCEPTION 'Only an active observation can be superseded';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "Observation_lifecycle" BEFORE UPDATE ON "Observation" FOR EACH ROW EXECUTE FUNCTION atlas_observation_lifecycle();
