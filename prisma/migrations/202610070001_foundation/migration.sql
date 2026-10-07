-- CreateTable
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Client" (
    "workspaceId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "Client_pkey" PRIMARY KEY ("workspaceId","id")
);

-- CreateTable
CREATE TABLE "Entity" (
    "workspaceId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,

    CONSTRAINT "Entity_pkey" PRIMARY KEY ("workspaceId","clientId","id")
);

-- CreateTable
CREATE TABLE "Person" (
    "workspaceId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "email" TEXT,

    CONSTRAINT "Person_pkey" PRIMARY KEY ("workspaceId","clientId","id")
);

-- CreateTable
CREATE TABLE "Device" (
    "workspaceId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "personId" TEXT,

    CONSTRAINT "Device_pkey" PRIMARY KEY ("workspaceId","clientId","id")
);

-- CreateTable
CREATE TABLE "Connection" (
    "workspaceId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "system" TEXT NOT NULL,
    "externalTenantId" TEXT NOT NULL,
    "secretRef" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DISABLED',

    CONSTRAINT "Connection_pkey" PRIMARY KEY ("workspaceId","clientId","id")
);

-- CreateTable
CREATE TABLE "ExternalEntity" (
    "workspaceId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "attributes" JSONB NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExternalEntity_pkey" PRIMARY KEY ("workspaceId","clientId","id")
);

-- CreateTable
CREATE TABLE "EntityLink" (
    "workspaceId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "externalEntityId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CANDIDATE',
    "method" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION,
    "confirmedBy" TEXT,
    "confirmedAt" TIMESTAMP(3),

    CONSTRAINT "EntityLink_pkey" PRIMARY KEY ("workspaceId","clientId","id")
);

-- CreateTable
CREATE TABLE "RawEvent" (
    "workspaceId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "externalEventId" TEXT NOT NULL,
    "revision" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "normalized" JSONB NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',

    CONSTRAINT "RawEvent_pkey" PRIMARY KEY ("workspaceId","clientId","id")
);

-- CreateTable
CREATE TABLE "DecisionRun" (
    "workspaceId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT,
    "promptVersion" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "result" JSONB,
    "latencyMs" INTEGER,
    "inputTokens" INTEGER,
    "safeErrorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DecisionRun_pkey" PRIMARY KEY ("workspaceId","clientId","id")
);

-- CreateTable
CREATE TABLE "Observation" (
    "workspaceId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Observation_pkey" PRIMARY KEY ("workspaceId","clientId","id")
);

-- CreateTable
CREATE TABLE "SyncState" (
    "workspaceId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "cursor" TEXT,
    "lastSyncAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "status" TEXT NOT NULL,
    "safeErrorCode" TEXT,

    CONSTRAINT "SyncState_pkey" PRIMARY KEY ("workspaceId","clientId","connectionId","resourceType")
);

-- CreateTable
CREATE TABLE "ToolExecution" (
    "workspaceId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "riskLevel" INTEGER NOT NULL,
    "sideEffect" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ToolExecution_pkey" PRIMARY KEY ("workspaceId","clientId","id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "workspaceId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "metadata" JSONB NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("workspaceId","clientId","id")
);

-- CreateTable
CREATE TABLE "Approval" (
    "workspaceId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "toolVersion" TEXT NOT NULL,
    "canonicalInput" JSONB NOT NULL,
    "inputHash" TEXT NOT NULL,
    "riskLevel" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "Approval_pkey" PRIMARY KEY ("workspaceId","clientId","id")
);

-- CreateIndex
CREATE INDEX "Person_workspaceId_clientId_email_idx" ON "Person"("workspaceId", "clientId", "email");

-- CreateIndex
CREATE INDEX "Device_workspaceId_clientId_hostname_idx" ON "Device"("workspaceId", "clientId", "hostname");

-- CreateIndex
CREATE UNIQUE INDEX "Connection_workspaceId_system_externalTenantId_key" ON "Connection"("workspaceId", "system", "externalTenantId");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalEntity_workspaceId_clientId_connectionId_resourceTy_key" ON "ExternalEntity"("workspaceId", "clientId", "connectionId", "resourceType", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "EntityLink_workspaceId_clientId_externalEntityId_entityId_key" ON "EntityLink"("workspaceId", "clientId", "externalEntityId", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "RawEvent_eventKey_key" ON "RawEvent"("eventKey");

-- CreateIndex
CREATE INDEX "RawEvent_workspaceId_clientId_status_receivedAt_idx" ON "RawEvent"("workspaceId", "clientId", "status", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RawEvent_workspaceId_clientId_connectionId_externalEventId__key" ON "RawEvent"("workspaceId", "clientId", "connectionId", "externalEventId", "revision");

-- CreateIndex
CREATE INDEX "DecisionRun_workspaceId_clientId_eventId_idx" ON "DecisionRun"("workspaceId", "clientId", "eventId");

-- CreateIndex
CREATE INDEX "Observation_workspaceId_clientId_status_severity_idx" ON "Observation"("workspaceId", "clientId", "status", "severity");

-- CreateIndex
CREATE UNIQUE INDEX "Observation_workspaceId_clientId_eventId_key" ON "Observation"("workspaceId", "clientId", "eventId");

-- CreateIndex
CREATE INDEX "AuditEvent_workspaceId_clientId_recordedAt_idx" ON "AuditEvent"("workspaceId", "clientId", "recordedAt");

-- AddForeignKey
ALTER TABLE "Client" ADD CONSTRAINT "Client_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Entity" ADD CONSTRAINT "Entity_workspaceId_clientId_fkey" FOREIGN KEY ("workspaceId", "clientId") REFERENCES "Client"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Person" ADD CONSTRAINT "Person_workspaceId_clientId_id_fkey" FOREIGN KEY ("workspaceId", "clientId", "id") REFERENCES "Entity"("workspaceId", "clientId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_workspaceId_clientId_id_fkey" FOREIGN KEY ("workspaceId", "clientId", "id") REFERENCES "Entity"("workspaceId", "clientId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_workspaceId_clientId_personId_fkey" FOREIGN KEY ("workspaceId", "clientId", "personId") REFERENCES "Person"("workspaceId", "clientId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Connection" ADD CONSTRAINT "Connection_workspaceId_clientId_fkey" FOREIGN KEY ("workspaceId", "clientId") REFERENCES "Client"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalEntity" ADD CONSTRAINT "ExternalEntity_workspaceId_clientId_connectionId_fkey" FOREIGN KEY ("workspaceId", "clientId", "connectionId") REFERENCES "Connection"("workspaceId", "clientId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EntityLink" ADD CONSTRAINT "EntityLink_workspaceId_clientId_entityId_fkey" FOREIGN KEY ("workspaceId", "clientId", "entityId") REFERENCES "Entity"("workspaceId", "clientId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EntityLink" ADD CONSTRAINT "EntityLink_workspaceId_clientId_externalEntityId_fkey" FOREIGN KEY ("workspaceId", "clientId", "externalEntityId") REFERENCES "ExternalEntity"("workspaceId", "clientId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RawEvent" ADD CONSTRAINT "RawEvent_workspaceId_clientId_connectionId_fkey" FOREIGN KEY ("workspaceId", "clientId", "connectionId") REFERENCES "Connection"("workspaceId", "clientId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DecisionRun" ADD CONSTRAINT "DecisionRun_workspaceId_clientId_eventId_fkey" FOREIGN KEY ("workspaceId", "clientId", "eventId") REFERENCES "RawEvent"("workspaceId", "clientId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Observation" ADD CONSTRAINT "Observation_workspaceId_clientId_eventId_fkey" FOREIGN KEY ("workspaceId", "clientId", "eventId") REFERENCES "RawEvent"("workspaceId", "clientId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncState" ADD CONSTRAINT "SyncState_workspaceId_clientId_connectionId_fkey" FOREIGN KEY ("workspaceId", "clientId", "connectionId") REFERENCES "Connection"("workspaceId", "clientId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToolExecution" ADD CONSTRAINT "ToolExecution_workspaceId_clientId_fkey" FOREIGN KEY ("workspaceId", "clientId") REFERENCES "Client"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_workspaceId_clientId_fkey" FOREIGN KEY ("workspaceId", "clientId") REFERENCES "Client"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_workspaceId_clientId_fkey" FOREIGN KEY ("workspaceId", "clientId") REFERENCES "Client"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

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
