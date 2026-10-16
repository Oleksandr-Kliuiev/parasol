-- Append to the generated initial migration. Runtime role must not own tables or functions.
ALTER TABLE "Entity" ADD CONSTRAINT "Entity_kind_check" CHECK (kind IN ('PERSON','DEVICE'));
ALTER TABLE "Connection" ADD CONSTRAINT "Connection_system_check" CHECK (system IN ('atera','huntress','microsoft365','poweroffice'));
ALTER TABLE "EntityLink" ADD CONSTRAINT "EntityLink_status_check" CHECK (status IN ('CANDIDATE','CONFIRMED','REJECTED'));
ALTER TABLE "EntityLink" ADD CONSTRAINT "EntityLink_confidence_check" CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1));
ALTER TABLE "EntityLink" ADD CONSTRAINT "EntityLink_confirmation_check" CHECK (status <> 'CONFIRMED' OR ("confirmedBy" IS NOT NULL AND "confirmedAt" IS NOT NULL));
CREATE UNIQUE INDEX "EntityLink_one_confirmed_external" ON "EntityLink" ("workspaceId", "clientId", "externalEntityId") WHERE status = 'CONFIRMED';
ALTER TABLE "Observation" ADD CONSTRAINT "Observation_confidence_check" CHECK (confidence >= 0 AND confidence <= 1);
ALTER TABLE "Observation" ADD CONSTRAINT "Observation_severity_check" CHECK (severity IN ('INFO','LOW','MEDIUM','HIGH','CRITICAL'));
ALTER TABLE "Observation" ADD CONSTRAINT "Observation_route_check" CHECK (route IN ('MONITOR','INVESTIGATE','HUMAN_REVIEW'));
ALTER TABLE "ToolExecution" ADD CONSTRAINT "ToolExecution_risk_check" CHECK ("riskLevel" BETWEEN 0 AND 4);
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_risk_check" CHECK ("riskLevel" BETWEEN 0 AND 4);
CREATE FUNCTION atlas_reject_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'AuditEvent is append-only'; END;
$$;
CREATE TRIGGER "AuditEvent_no_update_delete" BEFORE UPDATE OR DELETE ON "AuditEvent" FOR EACH ROW EXECUTE FUNCTION atlas_reject_audit_mutation();
CREATE TRIGGER "AuditEvent_no_truncate" BEFORE TRUNCATE ON "AuditEvent" FOR EACH STATEMENT EXECUTE FUNCTION atlas_reject_audit_mutation();
CREATE FUNCTION atlas_reject_approval_input_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(OLD."workspaceId", OLD."clientId", OLD."toolName", OLD."toolVersion", OLD."canonicalInput", OLD."inputHash", OLD."riskLevel", OLD."requestedBy", OLD."expiresAt")
    IS DISTINCT FROM ROW(NEW."workspaceId", NEW."clientId", NEW."toolName", NEW."toolVersion", NEW."canonicalInput", NEW."inputHash", NEW."riskLevel", NEW."requestedBy", NEW."expiresAt") THEN
    RAISE EXCEPTION 'Approval scope and input are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Approval_immutable_input" BEFORE UPDATE ON "Approval" FOR EACH ROW EXECUTE FUNCTION atlas_reject_approval_input_mutation();
