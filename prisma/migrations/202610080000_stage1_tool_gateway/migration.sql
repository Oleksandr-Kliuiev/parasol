-- Stage 1, task 1.9 Tool Gateway. A new migration; earlier ones are unchanged.
--   ToolExecution is the ledger of executed read tools: written together with its client audit row in one transaction —
--   STARTED, then SUCCEEDED or FAILED with a safe code — with the tool name and version, the authoritative risk and side
--   effect from the registry, the hash of the canonical validated input and the request correlation. Denied and rejected
--   calls are audit rows, not executions. Stage 1 executes read tools only (ADR-003): the ledger cannot record anything
--   else, and a recorded execution changes only from STARTED to its outcome (trigger).

-- 0. Preflight: rows the new rules cannot interpret stop the migration; a person decides.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "ToolExecution" WHERE status NOT IN ('STARTED','SUCCEEDED','FAILED') OR "riskLevel" <> 0 OR "sideEffect" <> 'NONE'
             OR "inputHash" !~ '^[0-9a-f]{64}$') THEN
    RAISE EXCEPTION 'v1.9 preflight: ToolExecution has rows outside the Stage 1 read-only ledger rules; map them explicitly before applying';
  END IF;
END $$;

-- 1. Columns: tool version, outcome code and time
ALTER TABLE "ToolExecution" ADD COLUMN "toolVersion" TEXT NOT NULL DEFAULT '1';
ALTER TABLE "ToolExecution" ALTER COLUMN "toolVersion" DROP DEFAULT;
ALTER TABLE "ToolExecution" ADD COLUMN "safeErrorCode" TEXT;
ALTER TABLE "ToolExecution" ADD COLUMN "finishedAt" TIMESTAMP(3);

-- 2. Vocabulary and consistency
ALTER TABLE "ToolExecution" ADD CONSTRAINT "ToolExecution_status_check" CHECK (status IN ('STARTED','SUCCEEDED','FAILED'));
ALTER TABLE "ToolExecution" ADD CONSTRAINT "ToolExecution_outcome_check"
  CHECK ((status = 'STARTED') = ("finishedAt" IS NULL) AND (status = 'FAILED') = ("safeErrorCode" IS NOT NULL));
ALTER TABLE "ToolExecution" ADD CONSTRAINT "ToolExecution_side_effect_check" CHECK ("sideEffect" IN ('NONE','CREATE','UPDATE','SECURITY','DESTRUCTIVE'));
-- Stage 1 is read-only: risk 0 and no side effect, whatever a caller sends (the registry is authoritative)
ALTER TABLE "ToolExecution" ADD CONSTRAINT "ToolExecution_read_only_check" CHECK ("riskLevel" = 0 AND "sideEffect" = 'NONE');
ALTER TABLE "ToolExecution" ADD CONSTRAINT "ToolExecution_identity_check"
  CHECK ("toolName" ~ '^[a-z][a-z0-9_]{0,31}(\.[a-z][a-z0-9_]{0,31}){1,3}$' AND "toolVersion" ~ '^[0-9]{1,4}$'
     AND "inputHash" ~ '^[0-9a-f]{64}$' AND "correlationId" ~ '^[A-Za-z0-9._:-]{8,64}$');
CREATE INDEX "ToolExecution_workspaceId_clientId_createdAt_idx" ON "ToolExecution"("workspaceId", "clientId", "createdAt");

-- 3. A recorded execution only moves from STARTED to its outcome; nothing else of it changes
CREATE FUNCTION atlas_tool_execution_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."workspaceId", NEW."clientId", NEW.id, NEW."actorId", NEW."toolName", NEW."toolVersion", NEW."riskLevel", NEW."sideEffect",
      NEW."inputHash", NEW."correlationId", NEW."createdAt")
     IS DISTINCT FROM
     (OLD."workspaceId", OLD."clientId", OLD.id, OLD."actorId", OLD."toolName", OLD."toolVersion", OLD."riskLevel", OLD."sideEffect",
      OLD."inputHash", OLD."correlationId", OLD."createdAt")
     OR OLD.status <> 'STARTED' THEN
    RAISE EXCEPTION 'ToolExecution is a ledger: only a STARTED execution records its outcome';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "ToolExecution_ledger" BEFORE UPDATE ON "ToolExecution" FOR EACH ROW EXECUTE FUNCTION atlas_tool_execution_ledger();
