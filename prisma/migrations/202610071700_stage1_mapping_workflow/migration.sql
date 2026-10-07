-- Stage 1 task 1.4: mapping workflow. Additive; earlier migrations are frozen. Written by hand for Prisma 6.19 conventions.
--   1. Connection: explicit tenant binding with provenance and a status vocabulary. A live (ACTIVE) connection carries who
--      bound it and when; the bound system/tenant never change (a re-binding is a new connection).
--   2. EntityLink carries resourceType and entityKind, pinned by composite foreign keys to the typed rows and by a
--      compatibility CHECK (agent <-> DEVICE, contact <-> PERSON). A link can no longer join an agent to a person.
--   3. Review workflow: a confirmation that conflicts with an existing confirmed link is kept as QUARANTINED (never lost),
--      with who/when/why and a pointer to the conflicting link of the SAME external entity (scoped, identity-bound FK).
--   4. Per-client permissions mapping:review and connections:manage.

-- ---------------------------------------------------------------------------------------------------------------
-- 0. Preflight on a populated database: what this migration cannot interpret stops it; a person decides.
-- ---------------------------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Connection" WHERE status NOT IN ('DISABLED','FIXTURE','ACTIVE')) THEN
    RAISE EXCEPTION 'v1.4 preflight: Connection.status has values outside DISABLED/FIXTURE/ACTIVE; map them explicitly before applying';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "EntityLink" l
    JOIN "ExternalEntity" x ON x."workspaceId" = l."workspaceId" AND x."clientId" = l."clientId" AND x.id = l."externalEntityId"
    JOIN "Entity" e ON e."workspaceId" = l."workspaceId" AND e."clientId" = l."clientId" AND e.id = l."entityId"
    WHERE (x."resourceType", e.kind) NOT IN (('agent','DEVICE'),('contact','PERSON'))
  ) THEN
    RAISE EXCEPTION 'v1.4 preflight: an EntityLink joins an incompatible resource type and entity kind (allowed: agent-DEVICE, contact-PERSON); reject or repair those links before applying';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- 1. Connection: explicit binding
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE "Connection" ADD COLUMN "boundBy" TEXT;
ALTER TABLE "Connection" ADD COLUMN "boundAt" TIMESTAMP(3);
ALTER TABLE "Connection" ADD CONSTRAINT "Connection_status_check" CHECK (status IN ('DISABLED','FIXTURE','ACTIVE'));
-- Synthetic FIXTURE rows and DISABLED bindings may predate the provenance columns; a live connection may not.
ALTER TABLE "Connection" ADD CONSTRAINT "Connection_live_binding_check"
  CHECK (status <> 'ACTIVE' OR ("boundBy" IS NOT NULL AND "boundAt" IS NOT NULL));
CREATE FUNCTION atlas_reject_connection_rebinding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."workspaceId", NEW."clientId", NEW.id, NEW.system, NEW."externalTenantId")
     IS DISTINCT FROM ROW(OLD."workspaceId", OLD."clientId", OLD.id, OLD.system, OLD."externalTenantId") THEN
    RAISE EXCEPTION 'Connection binding is immutable: bind the other tenant as a new connection and disable this one';
  END IF;
  IF OLD."boundBy" IS NOT NULL AND ROW(NEW."boundBy", NEW."boundAt") IS DISTINCT FROM ROW(OLD."boundBy", OLD."boundAt") THEN
    RAISE EXCEPTION 'Connection binding provenance is immutable once recorded';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Connection_binding_immutable" BEFORE UPDATE ON "Connection" FOR EACH ROW EXECUTE FUNCTION atlas_reject_connection_rebinding();

-- ---------------------------------------------------------------------------------------------------------------
-- 2. Typed links: resource type and entity kind travel with the link
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE "EntityLink" ADD COLUMN "resourceType" TEXT;
ALTER TABLE "EntityLink" ADD COLUMN "entityKind" TEXT;
UPDATE "EntityLink" l SET "resourceType" = x."resourceType" FROM "ExternalEntity" x
  WHERE x."workspaceId" = l."workspaceId" AND x."clientId" = l."clientId" AND x.id = l."externalEntityId";
UPDATE "EntityLink" l SET "entityKind" = e.kind FROM "Entity" e
  WHERE e."workspaceId" = l."workspaceId" AND e."clientId" = l."clientId" AND e.id = l."entityId";
ALTER TABLE "EntityLink" ALTER COLUMN "resourceType" SET NOT NULL;
ALTER TABLE "EntityLink" ALTER COLUMN "entityKind" SET NOT NULL;
CREATE UNIQUE INDEX "ExternalEntity_typed_key" ON "ExternalEntity"("workspaceId", "clientId", "id", "resourceType");
CREATE UNIQUE INDEX "Entity_typed_key" ON "Entity"("workspaceId", "clientId", "id", "kind");
-- The typed keys replace the untyped ones (they imply them). ON UPDATE RESTRICT: a linked entity cannot change its kind
-- and a linked external object cannot change its resource type underneath the link.
ALTER TABLE "EntityLink" DROP CONSTRAINT "EntityLink_workspaceId_clientId_externalEntityId_fkey";
ALTER TABLE "EntityLink" DROP CONSTRAINT "EntityLink_workspaceId_clientId_entityId_fkey";
ALTER TABLE "EntityLink" ADD CONSTRAINT "EntityLink_external_typed_fkey"
  FOREIGN KEY ("workspaceId", "clientId", "externalEntityId", "resourceType")
  REFERENCES "ExternalEntity"("workspaceId", "clientId", "id", "resourceType") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "EntityLink" ADD CONSTRAINT "EntityLink_entity_typed_fkey"
  FOREIGN KEY ("workspaceId", "clientId", "entityId", "entityKind")
  REFERENCES "Entity"("workspaceId", "clientId", "id", "kind") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "EntityLink" ADD CONSTRAINT "EntityLink_type_compat_check"
  CHECK (("resourceType", "entityKind") IN (('agent','DEVICE'),('contact','PERSON')));

-- ---------------------------------------------------------------------------------------------------------------
-- 3. Review workflow: proposals, decisions and quarantine of conflicting confirmations
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE "EntityLink" DROP CONSTRAINT "EntityLink_status_check";
ALTER TABLE "EntityLink" ADD CONSTRAINT "EntityLink_status_check" CHECK (status IN ('CANDIDATE','CONFIRMED','REJECTED','QUARANTINED'));
ALTER TABLE "EntityLink" ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
-- Proposer and reviewer are not invented for rows that predate this migration; the append-only client audit is the
-- authoritative trail of every decision made through the application.
ALTER TABLE "EntityLink" ADD COLUMN "createdBy" TEXT;
ALTER TABLE "EntityLink" ADD COLUMN "reviewedBy" TEXT;
ALTER TABLE "EntityLink" ADD COLUMN "reviewedAt" TIMESTAMP(3);
ALTER TABLE "EntityLink" ADD COLUMN "reasonCode" TEXT;
ALTER TABLE "EntityLink" ADD COLUMN "conflictsWithLinkId" TEXT;
-- Foreign-key target of the conflict pointer: the conflicting link must belong to the same scope AND the same external entity.
CREATE UNIQUE INDEX "EntityLink_external_link_key" ON "EntityLink"("workspaceId", "clientId", "externalEntityId", "id");
ALTER TABLE "EntityLink" ADD CONSTRAINT "EntityLink_conflictsWith_fkey"
  FOREIGN KEY ("workspaceId", "clientId", "externalEntityId", "conflictsWithLinkId")
  REFERENCES "EntityLink"("workspaceId", "clientId", "externalEntityId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "EntityLink" ADD CONSTRAINT "EntityLink_conflict_self_check" CHECK ("conflictsWithLinkId" IS NULL OR "conflictsWithLinkId" <> id);
ALTER TABLE "EntityLink" ADD CONSTRAINT "EntityLink_reason_code_check" CHECK ("reasonCode" IS NULL OR "reasonCode" ~ '^[A-Z][A-Z0-9_]{0,63}$');
ALTER TABLE "EntityLink" ADD CONSTRAINT "EntityLink_quarantine_check"
  CHECK (status <> 'QUARANTINED' OR ("reviewedBy" IS NOT NULL AND "reviewedAt" IS NOT NULL AND "reasonCode" IS NOT NULL
         AND ("reasonCode" <> 'CONFLICTS_WITH_CONFIRMED' OR "conflictsWithLinkId" IS NOT NULL)));

-- ---------------------------------------------------------------------------------------------------------------
-- 4. Permission vocabulary
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE "ClientMembership" DROP CONSTRAINT "ClientMembership_permissions_check";
ALTER TABLE "ClientMembership" ADD CONSTRAINT "ClientMembership_permissions_check"
  CHECK (array_position(permissions, NULL) IS NULL
         AND permissions <@ ARRAY['context:read','events:ingest','mapping:review','connections:manage']::TEXT[]);
